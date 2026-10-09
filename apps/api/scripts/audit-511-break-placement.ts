/**
 * Audit tool — Issue #511 (AK-5, D-14).
 *
 * Issue #511 adds § 4 Satz 2 and Satz 3 ArbZG (a Ruhepause of at least 15 minutes, work never
 * longer than six hours in a row) and the § 11 JArbSchG regime for minors to the break check, and
 * makes every such finding with a certainty a blocker of the Monatsabschluss under
 * `blockMonthCloseOnUnconfirmedBreak`. Days that were fine yesterday can be findings after the
 * deploy. This script is the pre-deploy step of the release notes: it lists those days so the owner
 * sees the volume per tenant, month and month state before deploying — and before keeping the
 * block-flag on.
 *
 * What it lists: for every non-exempt employee and every day in the range, the findings of the
 * production detector (`evaluateBreakFindingDays` → `evaluateDayBreaks`, the same code the
 * Monatsabschluss, the next-day job and the entry form run). Per finding day one line with tenant,
 * employee, date, code, certainty, month, closed and wouldBlock. `closed` is true when an entry of
 * the day is locked or the employee's month has a closed snapshot; `wouldBlock` is true when the
 * day is an unacknowledged, un-waived finding of a month that is still open — exactly the days a
 * Monatsabschluss would stop at. There is no rule of its own in this file.
 *
 * Counted separately, never as findings: `BREAK_POSITION_UNKNOWN` (legacy entries that only carry
 * a stored break sum — informational, A5) and entries whose Break rows sum to more than their
 * stored `breakMinutes` (divergent, Pitfall 6 — counted, never corrected or guessed).
 *
 * READ-ONLY. ZERO mutations. There is no write flag anywhere in this file and none may ever be
 * added. Closed months are listed but never re-evaluated into anything: the counts tell the owner
 * what a deliberate decision would concern; they change no data.
 *
 * Output contains ids only — no employee name, no employee number (DSGVO). Full, untruncated
 * UUIDs, so the owner can locate each row directly.
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { evaluateBreakFindingDays, getWorkedEntriesInRange } from "../src/contexts/time-tracking";
import { hasAckableFinding } from "../src/contexts/time-tracking/day-break-rule";
import { isMinorAtDate } from "../src/contexts/absence";
import {
  getTenantTimezone,
  isMonthClosed,
  monthRangeUtc,
} from "../src/contexts/working-time-account";
import { accessContextForJob, employeeScopeFor } from "../src/contexts/platform";

// ── Exit codes ──────────────────────────────────────────────────────────────
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_FINDINGS = 2;

// ── CLI parsing ───────────────────────────────────────────────────────────────
export type CliArgs = {
  tenantId: string | null;
  allTenants: boolean;
  from: string | null;
  to: string | null;
  help: boolean;
};

export function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "tenant-id": { type: "string" },
      "all-tenants": { type: "boolean", default: false },
      from: { type: "string" },
      to: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true, // rejects any unknown flag, in particular --confirm / --apply
  });

  return {
    tenantId: values["tenant-id"] ?? null,
    allTenants: Boolean(values["all-tenants"]),
    from: values.from ?? null,
    to: values.to ?? null,
    help: Boolean(values.help),
  };
}

export const USAGE = `
Usage:
  DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \\
    scripts/audit-511-break-placement.ts \\
    ( --tenant-id <uuid> | --all-tenants ) --from <YYYY-MM-DD> --to <YYYY-MM-DD> \\
    [--help]

READ-ONLY — lists the days the Satz-2/3 ArbZG and § 11 JArbSchG break rules flag (Issue #511).
No write flag exists.

Exit codes:
  0 — no finding for the given scope
  1 — DATABASE_URL missing, bad CLI, or a DB connection/query failure
  2 — one or more findings
`;

// ── Output shapes ─────────────────────────────────────────────────────────────
export type Finding = {
  tenantId: string;
  employeeId: string;
  date: string; // YYYY-MM-DD, tenant-local calendar day
  code: string;
  certainty: string;
  month: string; // YYYY-MM
  closed: boolean;
  wouldBlock: boolean;
};

/** Full UUIDs — DSGVO-safe (no name, no employee number), but locatable by the owner. */
export function formatFindingLine(f: Finding): string {
  return (
    `finding tenantId=${f.tenantId} employeeId=${f.employeeId} date=${f.date} ` +
    `code=${f.code} certainty=${f.certainty} month=${f.month} closed=${f.closed} ` +
    `wouldBlock=${f.wouldBlock}`
  );
}

// ── Month chunking ────────────────────────────────────────────────────────────
type MonthChunk = { month: string; first: string; last: string };

/**
 * The calendar months overlapping [from, to] (both "YYYY-MM-DD"), each clipped to the range.
 * `TimeEntry.date` is a `@db.Date` column, so the bounds are calendar days, never month instants
 * (CLAUDE.md, Issue #493).
 */
export function monthChunks(from: string, to: string): MonthChunk[] {
  const chunks: MonthChunk[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const lastYear = Number(to.slice(0, 4));
  const lastMonth = Number(to.slice(5, 7));
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    const label = `${year}-${String(month).padStart(2, "0")}`;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const monthFirst = `${label}-01`;
    const monthLast = `${label}-${String(lastDay).padStart(2, "0")}`;
    chunks.push({
      month: label,
      first: monthFirst < from ? from : monthFirst,
      last: monthLast > to ? to : monthLast,
    });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return chunks;
}

// ── Main entry point ─────────────────────────────────────────────────────────
/**
 * Exported for unit-testability — pass a PrismaClient to inject a test connection (run against
 * the worker test DB only); without one the CLI entrypoint below bootstraps its own connection
 * from DATABASE_URL.
 */
export async function main(argv: string[], injectedPrisma?: PrismaClient): Promise<number> {
  const args = parseCli(argv);

  if (args.help) {
    console.info(USAGE);
    return EXIT_OK;
  }

  if ((!args.tenantId && !args.allTenants) || (args.tenantId && args.allTenants)) {
    throw new Error(
      "Tenant-Auswahl erforderlich: bitte --tenant-id <uuid> ODER --all-tenants angeben.",
    );
  }
  if (!args.from || !args.to) {
    throw new Error(
      "Zeitraum erforderlich: bitte --from <YYYY-MM-DD> UND --to <YYYY-MM-DD> angeben.",
    );
  }
  const { from, to } = { from: args.from, to: args.to };

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
    const tenants = args.allTenants
      ? await prisma.tenant.findMany({ select: { id: true }, orderBy: { id: "asc" } })
      : [{ id: args.tenantId! }];

    const findings: Finding[] = [];

    for (const tenant of tenants) {
      const tz = await getTenantTimezone(prisma, tenant.id);
      // Exempt employees are skipped, exactly as `checkArbZG` does.
      const employees = await prisma.employee.findMany({
        where: { tenantId: tenant.id, isTimeTrackingExempt: false },
        select: { id: true, birthDate: true },
      });
      const exemptFree = new Set(employees.map((e) => e.id));
      const birthDates = new Map(employees.map((e) => [e.id, e.birthDate]));
      const scope = employeeScopeFor(
        accessContextForJob(tenant.id, "audit-511-break-placement"),
        {},
      );
      const closedMemo = new Map<string, boolean>();

      for (const chunk of monthChunks(from, to)) {
        const allRows = await getWorkedEntriesInRange(
          prisma,
          scope,
          new Date(`${chunk.first}T00:00:00Z`),
          new Date(`${chunk.last}T00:00:00Z`),
        );
        const rows = allRows.filter((r) => exemptFree.has(r.employeeId));
        const evaluated = await evaluateBreakFindingDays(prisma, {
          tenantId: tenant.id,
          rows,
          tz,
          birthDates,
          isMinorAt: isMinorAtDate,
          includeLocked: true,
        });

        for (const day of evaluated) {
          const certain = day.evaluation.placement.findings.filter((f) => f.certainty !== null);
          if (certain.length === 0) continue;
          const month = day.date.slice(0, 7);
          const memoKey = `${day.employeeId}\u0000${month}`;
          let monthClosed = closedMemo.get(memoKey);
          if (monthClosed === undefined) {
            const { start } = monthRangeUtc(
              Number(month.slice(0, 4)),
              Number(month.slice(5, 7)),
              tz,
            );
            monthClosed = await isMonthClosed(prisma, day.employeeId, tenant.id, start);
            closedMemo.set(memoKey, monthClosed);
          }
          const closed = day.locked || monthClosed;
          const wouldBlock = hasAckableFinding(day.evaluation) && !day.evaluation.waived && !closed;
          for (const f of certain) {
            findings.push({
              tenantId: tenant.id,
              employeeId: day.employeeId,
              date: day.date,
              code: f.code,
              certainty: f.certainty!,
              month,
              closed,
              wouldBlock,
            });
          }
        }
      }
    }

    findings.sort(
      (a, b) =>
        a.tenantId.localeCompare(b.tenantId) ||
        a.date.localeCompare(b.date) ||
        a.employeeId.localeCompare(b.employeeId) ||
        a.code.localeCompare(b.code),
    );
    for (const f of findings) console.info(formatFindingLine(f));

    return findings.length > 0 ? EXIT_FINDINGS : EXIT_OK;
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
