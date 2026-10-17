/**
 * Audit tool — Issue #613 (Phase 613, D-03).
 *
 * Owner decision 16.10.2026: the auto-close cron (`plugins/auto-close-month.ts`) and the deferred
 * close (`deferred-month-close.ts`) keep selecting persons by LOGIN state — changing whom payroll
 * months are closed for is a behaviour change on write paths and needs its own decision. Since
 * Issue #613 every report, status and overview selects by EMPLOYMENT (`reportPopulationWhere`:
 * employed in the period, never anonymised). This script measures how far the two populations
 * differ, per active tenant and month, so the follow-up decision can be taken on data.
 *
 * What it lists, per active tenant and month (default: the previous month in the tenant's time
 * zone, exactly the cron's ceiling): one line for every person that exactly one of the two
 * selections contains (exempt persons are in neither):
 *
 *   tenant=<id> month=YYYY-MM employee=<id> reason=<CODE> monthClosed=<yes|no>
 *
 *   EMPLOYED_LOGIN_INACTIVE     the rule selects the person (employed in the month), the cron does not
 *                               (login switched off - for example after "Deaktivieren")
 *   NOT_EMPLOYED_LOGIN_ACTIVE   the cron selects the person (active login), the rule does not (hired
 *                               after the month, or left before it)
 *   ANONYMIZED_LOGIN_ACTIVE     the cron selects an anonymised person (an inconsistent legacy state:
 *                               anonymisation switches the login off)
 *
 * `monthClosed` says whether the person already has a non-superseded MONTHLY snapshot for the month.
 * Per tenant a count line follows (`differences=<n>`), then
 * `tenant=<id> exitedOpenFinalSaldo=<n>`: the number of not-anonymised persons who have left (exit
 * before today) and whose exit month is not closed yet - decided with the SAME functions the
 * Saldo-Übersicht uses (`getConfirmedCarryOverBulk` + `finalSaldoOpen`). That line is informational
 * and does not change the exit code.
 *
 * READ-ONLY. ZERO mutations: only Prisma reads run, there is no write flag, and none may ever be
 * added. The output carries tenant ids, employee ids, reason codes and counts only - never a name,
 * an employee number or an e-mail address (DSGVO). Full, untruncated UUIDs.
 *
 * Operator step: run it on int and on prod with the operator's own DATABASE_URL BEFORE the follow-up
 * decision (the issue named in scripts/README.md):
 *   DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \
 *     scripts/audit-613-month-close-population.ts [--tenant-id <uuid>] [--year <YYYY> --month <M>] [--help]
 *
 * Exit codes:
 *   0 - the two selections agree for every checked tenant and month
 *   1 - DATABASE_URL missing, bad CLI, or a DB connection/query failure
 *   2 - one or more differences were listed
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  ACTIVE_TENANT_WHERE,
  NOT_ANONYMIZED_EMPLOYEE_WHERE,
  isAnonymizedEmployee,
  reportPopulationWhere,
} from "../src/contexts/platform";
import {
  dateStrInTz,
  dayRangeUtc,
  finalSaldoOpen,
  getConfirmedCarryOverBulk,
  isMonthClosed,
  monthRangeUtc,
} from "../src/contexts/working-time-account";

// ── Exit codes ──────────────────────────────────────────────────────────────
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_FINDINGS = 2;

export type DifferenceReason =
  "EMPLOYED_LOGIN_INACTIVE" | "NOT_EMPLOYED_LOGIN_ACTIVE" | "ANONYMIZED_LOGIN_ACTIVE";

// ── CLI parsing ───────────────────────────────────────────────────────────────
export type CliArgs = {
  help: boolean;
  tenantId: string | null;
  year: number | null;
  month: number | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", default: false },
      "tenant-id": { type: "string" },
      year: { type: "string" },
      month: { type: "string" },
    },
    strict: true, // rejects any unknown flag, in particular --confirm / --apply
  });
  const tenantId = values["tenant-id"] ?? null;
  if (tenantId !== null && !UUID.test(tenantId)) throw new Error("--tenant-id must be a UUID");
  const hasYear = values.year !== undefined;
  const hasMonth = values.month !== undefined;
  if (hasYear !== hasMonth) throw new Error("--year and --month must be given together");
  let year: number | null = null;
  let month: number | null = null;
  if (hasYear && hasMonth) {
    if (!/^\d{4}$/.test(values.year as string)) throw new Error("--year must be YYYY");
    if (!/^\d{1,2}$/.test(values.month as string)) throw new Error("--month must be 1-12");
    year = Number(values.year);
    month = Number(values.month);
    if (month < 1 || month > 12) throw new Error("--month must be 1-12");
  }
  return { help: Boolean(values.help), tenantId, year, month };
}

export const USAGE = `
Usage:
  DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \\
    scripts/audit-613-month-close-population.ts [--tenant-id <uuid>] [--year <YYYY> --month <M>] [--help]

READ-ONLY - lists, per active tenant and month (default: the previous month in the tenant's time
zone), every person the auto-close cron / deferred close (active login, not exempt) and the report
population rule of Issue #613 (employed in the month, never anonymised, not exempt) disagree on,
with a reason code and whether the month is already closed; plus per tenant the number of exited
persons whose exit month is still open. Ids and counts only, no personal data. Exit 2 on differences.
`;

/** The previous calendar month in `tz` - the ceiling the cron closes. */
function previousMonth(now: Date, tz: string): { year: number; month: number } {
  const zonedNow = new Date(dateStrInTz(now, tz) + "T12:00:00Z");
  let year = zonedNow.getUTCFullYear();
  let month = zonedNow.getUTCMonth(); // 0-based getter on a 1-based month -> the previous month
  if (month === 0) {
    month = 12;
    year -= 1;
  }
  return { year, month };
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Exported for unit-testability - pass a PrismaClient to inject a test connection (run against the
 * worker test DB only); without one the CLI entrypoint below bootstraps its own connection from
 * DATABASE_URL.
 */
export async function main(argv: string[], injectedPrisma?: PrismaClient): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCli(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return EXIT_ERROR;
  }

  if (args.help) {
    console.info(USAGE);
    return EXIT_OK;
  }

  if (!injectedPrisma && !process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    return EXIT_ERROR;
  }

  let pool: pg.Pool | undefined;
  let prisma: PrismaClient;
  if (injectedPrisma) {
    prisma = injectedPrisma;
  } else {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new PrismaPg(pool as any);
    prisma = new PrismaClient({ adapter });
  }

  try {
    const now = new Date();
    // Active tenants only, like the cron (Phase 88, D-05a).
    const tenants = await prisma.tenant.findMany({
      where: { ...ACTIVE_TENANT_WHERE, ...(args.tenantId !== null ? { id: args.tenantId } : {}) },
      select: { id: true, config: { select: { timezone: true } } },
      orderBy: { id: "asc" },
    });

    let differences = 0;
    for (const tenant of tenants) {
      const tz = tenant.config?.timezone ?? "Europe/Berlin";
      const { year, month } =
        args.year !== null && args.month !== null
          ? { year: args.year, month: args.month }
          : previousMonth(now, tz);
      const { start, end } = monthRangeUtc(year, month, tz);
      const monthLabel = `${year}-${String(month).padStart(2, "0")}`;

      // CRON set: the population query of `plugins/auto-close-month.ts` and
      // `deferred-month-close.ts`, copied verbatim (login state, not exempt).
      const cronPeople = await prisma.employee.findMany({
        where: { tenantId: tenant.id, user: { isActive: true }, isTimeTrackingExempt: false },
        select: { id: true, firstName: true, lastName: true },
      });
      // RULE set: what every report selects since Issue #613 (not exempt, like the cron).
      const rulePeople = await prisma.employee.findMany({
        where: {
          tenantId: tenant.id,
          isTimeTrackingExempt: false,
          AND: [reportPopulationWhere(start, end)],
        },
        select: { id: true },
      });
      const ruleIds = new Set(rulePeople.map((p) => p.id));
      const cronIds = new Set(cronPeople.map((p) => p.id));

      const differing: Array<{ id: string; reason: DifferenceReason }> = [];
      for (const person of cronPeople) {
        if (ruleIds.has(person.id)) continue;
        differing.push({
          id: person.id,
          reason: isAnonymizedEmployee(person)
            ? "ANONYMIZED_LOGIN_ACTIVE"
            : "NOT_EMPLOYED_LOGIN_ACTIVE",
        });
      }
      for (const person of rulePeople) {
        if (cronIds.has(person.id)) continue;
        differing.push({ id: person.id, reason: "EMPLOYED_LOGIN_INACTIVE" });
      }
      differing.sort((a, b) => compareIds(a.id, b.id));

      for (const row of differing) {
        const closed = await isMonthClosed(prisma, row.id, tenant.id, start);
        console.info(
          `tenant=${tenant.id} month=${monthLabel} employee=${row.id} reason=${row.reason} ` +
            `monthClosed=${closed ? "yes" : "no"}`,
        );
      }
      differences += differing.length;
      console.info(`tenant=${tenant.id} month=${monthLabel} differences=${differing.length}`);

      // Informational: persons who have left whose exit month is not closed yet (the Saldo-Übersicht
      // section "Ausgetreten, offener Endsaldo"), decided by the same two functions.
      const today = dayRangeUtc(dateStrInTz(now, tz), tz);
      const leavers = await prisma.employee.findMany({
        where: {
          tenantId: tenant.id,
          AND: [
            reportPopulationWhere(new Date(0), today.end),
            NOT_ANONYMIZED_EMPLOYEE_WHERE,
            { exitDate: { lt: today.start } },
          ],
        },
        select: { id: true, exitDate: true },
      });
      const confirmed = await getConfirmedCarryOverBulk(
        prisma,
        leavers.map((l) => l.id),
        tenant.id,
      );
      const openFinalSaldo = leavers.filter(
        (l) =>
          l.exitDate !== null &&
          finalSaldoOpen({
            exitDate: l.exitDate,
            latestClosedPeriodEnd: confirmed.get(l.id)?.periodEnd ?? null,
            tz,
          }),
      ).length;
      console.info(`tenant=${tenant.id} exitedOpenFinalSaldo=${openFinalSaldo}`);
    }

    console.info(`Totals: tenants=${tenants.length} differences=${differences}`);
    if (differences === 0) {
      console.info("The cron population and the report population agree.");
    } else {
      console.info(
        "Each listed person is selected by exactly one of the two rules. This script writes nothing.",
      );
    }
    return differences > 0 ? EXIT_FINDINGS : EXIT_OK;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return EXIT_ERROR;
  } finally {
    if (!injectedPrisma) {
      await prisma.$disconnect();
      await pool?.end();
    }
  }
}

// Run-guard: only bootstrap the DB + execute when invoked as a script, so importing the module
// for unit tests is side-effect-free (no connection, no process.exit).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = EXIT_ERROR;
    });
}
