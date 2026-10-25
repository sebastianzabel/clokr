/**
 * Audit tool — Issue #613 (Phase 613, D-03).
 *
 * Until Issue #668 the auto-close cron (`plugins/auto-close-month.ts`) and the deferred close
 * (`deferred-month-close.ts`) selected persons by LOGIN state; since #668 (owner decision
 * 19.10.2026) they select by EMPLOYMENT (`monthClosePopulationWhere`: employed in the month, an
 * anonymised person only with an exit date). This script is the PRE-DEPLOY DRY RUN of that switch:
 * it measures how far the old and the new population differ, per active tenant and month, i.e.
 * whom the cron will newly close (or stop closing).
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
 * Backfill section (Issue #668, review finding 4). The cron does not close one month, it closes
 * EVERY open month of a person from the month after their last snapshot (or the hire month) up to
 * the previous month, capped at the exit month. So per tenant a second block lists, for every
 * person the new rule adds (selected now, not by the old login rule), what the NEXT cron run would
 * write, with the cron's own month range and gap decision (`decideGapMonth`, `detectMonthGaps`):
 *
 *   tenant=<id> backfill employee=<id> reason=<CODE> openMonths=<n> wouldClose=<n> wouldDefer=<0|1> deferredAt=<YYYY-MM|none>
 *   tenant=<id> backfill newlyIncluded=<n> wouldClose=<n> wouldDefer=<n> exitDateMissing=<n>
 *
 *   EMPLOYED_LOGIN_INACTIVE   login off, exit date set (or still employed)
 *   ANONYMIZED_LEAVER         anonymised after leaving (exit date set)
 *   EXIT_DATE_MISSING         login off and NO exit date: months with gap days are never force-closed
 *                             and stop the run (`wouldDefer=1`); months without gaps still close.
 *                             Reported separately; an admin should set the exit date first.
 *
 * A person with no open month in range is not listed. `openMonths` counts the open months up to and
 * including the first deferred one. `wouldClose` counts the months that would be written (the cron stops at the first deferred month);
 * deferrals through unconfirmed breaks or § 4 ArbZG findings (tenant opt-in) are not predicted.
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
 *   0 - the two selections agree for every checked tenant and month and no person is newly included
 *   1 - DATABASE_URL missing, bad CLI, or a DB connection/query failure
 *   2 - one or more differences or newly included persons were listed
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
  monthClosePopulationWhere,
  isInMonthClosePopulation,
  isExitDateMissing,
  decideGapMonth,
} from "../src/contexts/working-time-account/month-close-population";
import {
  DEFAULT_RETRO_ENTRY_WINDOW_DAYS,
  buildMonthRange,
  computeFirstOpenMonth,
  isMonthPastItsWindow,
} from "../src/contexts/working-time-account/month-close-window";
import { detectMonthGaps } from "../src/contexts/working-time-account/month-gap-check";
import { periodStartWindow } from "../src/contexts/working-time-account/snapshot-period";
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

export type BackfillReason = "EMPLOYED_LOGIN_INACTIVE" | "ANONYMIZED_LEAVER" | "EXIT_DATE_MISSING";

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

type BackfillPerson = {
  id: string;
  firstName: string;
  lastName: string;
  hireDate: Date;
  exitDate: Date | null;
  user: { isActive: boolean };
  workSchedules: Array<{ validFrom: Date } & Record<string, unknown>>;
};

/**
 * What the next cron run writes for one person: the cron's month range (lastSnap+1 or the hire
 * month up to the ceiling, only months of employment, existing snapshots skipped) and its gap
 * decision, month by month, stopping at the first deferral exactly like the cron's `break`.
 */
async function planBackfill(
  prisma: PrismaClient,
  tenantId: string,
  emp: BackfillPerson,
  ctx: {
    tz: string;
    ceiling: { year: number; month: number };
    now: Date;
    retroWindowDays: number;
    closeAllowed: boolean;
  },
): Promise<{ openMonths: number; wouldClose: number; deferredAt: string | null }> {
  const lastSnap = await prisma.saldoSnapshot.findFirst({
    where: { employeeId: emp.id, periodType: "MONTHLY", superseded: false },
    orderBy: { periodStart: "desc" },
    select: { periodStart: true },
  });
  const range = buildMonthRange(computeFirstOpenMonth(emp.hireDate, lastSnap, ctx.tz), ctx.ceiling);
  let openMonths = 0;
  let wouldClose = 0;
  let deferredAt: string | null = null;
  for (const monthKey of range) {
    const { start, end } = monthRangeUtc(monthKey.year, monthKey.month, ctx.tz);
    const existing = await prisma.saldoSnapshot.count({
      where: {
        employeeId: emp.id,
        periodType: "MONTHLY",
        superseded: false,
        periodStart: periodStartWindow(start),
      },
    });
    if (existing > 0) continue;
    if (!isInMonthClosePopulation(emp, start, end)) continue;
    openMonths += 1;

    const schedule = emp.workSchedules.find((ws) => ws.validFrom <= end);
    let gapCount = 0;
    if (schedule) {
      const gaps = await detectMonthGaps(prisma, {
        tenantId,
        employeeId: emp.id,
        hireDate: emp.hireDate,
        exitDate: emp.exitDate,
        schedule,
        month: monthKey,
        tz: ctx.tz,
      });
      gapCount = gaps.gapRuleApplies ? gaps.gapDates.length : 0;
    }
    const decision = decideGapMonth({
      gapCount,
      pastWindow: isMonthPastItsWindow(
        monthKey.year,
        monthKey.month,
        ctx.tz,
        ctx.retroWindowDays,
        ctx.now,
      ),
      closeAllowed: ctx.closeAllowed,
      exitDateMissing: isExitDateMissing(emp),
    });
    if (decision !== "CLOSE") {
      deferredAt = `${monthKey.year}-${String(monthKey.month).padStart(2, "0")}`;
      break;
    }
    wouldClose += 1;
  }
  return { openMonths, wouldClose, deferredAt };
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
      select: {
        id: true,
        config: {
          select: { timezone: true, retroEntryWindowDays: true, closeMonthWithGapsAllowed: true },
        },
      },
      orderBy: { id: "asc" },
    });

    let differences = 0;
    const totals = { newlyIncluded: 0, wouldClose: 0, wouldDefer: 0, exitDateMissing: 0 };
    for (const tenant of tenants) {
      const tz = tenant.config?.timezone ?? "Europe/Berlin";
      const { year, month } =
        args.year !== null && args.month !== null
          ? { year: args.year, month: args.month }
          : previousMonth(now, tz);
      const { start, end } = monthRangeUtc(year, month, tz);
      const monthLabel = `${year}-${String(month).padStart(2, "0")}`;

      // OLD set: the population query the cron and the deferred close used BEFORE Issue #668,
      // copied verbatim (login state, not exempt) - kept here so the dry run still lists who the
      // switch to employment adds or drops.
      const cronPeople = await prisma.employee.findMany({
        where: { tenantId: tenant.id, user: { isActive: true }, isTimeTrackingExempt: false },
        select: { id: true, firstName: true, lastName: true },
      });
      // NEW set: what the cron and the deferred close select since Issue #668 (employed in the
      // month; an anonymised person only with an exit date; not exempt).
      const rulePeople = await prisma.employee.findMany({
        where: {
          tenantId: tenant.id,
          isTimeTrackingExempt: false,
          AND: [monthClosePopulationWhere(start, end)],
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

      // ── Backfill: what the NEXT cron run writes for every person the new rule adds ──────────
      const ceiling = previousMonth(now, tz);
      const { end: ceilingEnd } = monthRangeUtc(ceiling.year, ceiling.month, tz);
      const added = (await prisma.employee.findMany({
        where: {
          tenantId: tenant.id,
          isTimeTrackingExempt: false,
          user: { isActive: false },
          AND: [monthClosePopulationWhere(new Date(0), ceilingEnd)],
        },
        include: {
          user: { select: { isActive: true } },
          workSchedules: { orderBy: { validFrom: "desc" } },
        },
      })) as unknown as BackfillPerson[];
      added.sort((a, b) => compareIds(a.id, b.id));
      const tenantTotals = { wouldClose: 0, wouldDefer: 0, exitDateMissing: 0 };
      let newlyIncluded = 0;
      for (const emp of added) {
        const plan = await planBackfill(prisma, tenant.id, emp, {
          tz,
          ceiling,
          now,
          retroWindowDays: tenant.config?.retroEntryWindowDays ?? DEFAULT_RETRO_ENTRY_WINDOW_DAYS,
          closeAllowed: tenant.config?.closeMonthWithGapsAllowed ?? true,
        });
        // A person with no open month in range is not touched by the next run: no line.
        if (plan.openMonths === 0) continue;
        newlyIncluded += 1;
        const reason: BackfillReason = isExitDateMissing(emp)
          ? "EXIT_DATE_MISSING"
          : isAnonymizedEmployee(emp)
            ? "ANONYMIZED_LEAVER"
            : "EMPLOYED_LOGIN_INACTIVE";
        console.info(
          `tenant=${tenant.id} backfill employee=${emp.id} reason=${reason} ` +
            `openMonths=${plan.openMonths} wouldClose=${plan.wouldClose} ` +
            `wouldDefer=${plan.deferredAt !== null ? 1 : 0} deferredAt=${plan.deferredAt ?? "none"}`,
        );
        tenantTotals.wouldClose += plan.wouldClose;
        tenantTotals.wouldDefer += plan.deferredAt !== null ? 1 : 0;
        tenantTotals.exitDateMissing += reason === "EXIT_DATE_MISSING" ? 1 : 0;
      }
      console.info(
        `tenant=${tenant.id} backfill newlyIncluded=${newlyIncluded} wouldClose=${tenantTotals.wouldClose} ` +
          `wouldDefer=${tenantTotals.wouldDefer} exitDateMissing=${tenantTotals.exitDateMissing}`,
      );
      totals.newlyIncluded += newlyIncluded;
      totals.wouldClose += tenantTotals.wouldClose;
      totals.wouldDefer += tenantTotals.wouldDefer;
      totals.exitDateMissing += tenantTotals.exitDateMissing;
    }

    console.info(
      `Totals: tenants=${tenants.length} differences=${differences} newlyIncluded=${totals.newlyIncluded} ` +
        `wouldClose=${totals.wouldClose} wouldDefer=${totals.wouldDefer} exitDateMissing=${totals.exitDateMissing}`,
    );
    if (differences === 0 && totals.newlyIncluded === 0) {
      console.info("The cron population and the report population agree.");
    } else {
      console.info(
        "Each listed person is selected by exactly one of the two rules. This script writes nothing.",
      );
    }
    return differences > 0 || totals.newlyIncluded > 0 ? EXIT_FINDINGS : EXIT_OK;
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
