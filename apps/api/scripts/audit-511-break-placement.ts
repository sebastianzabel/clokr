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
 * stored `breakMinutes` (divergent, Pitfall 6 — counted, never corrected or guessed). Both counters
 * cover the days the detector evaluates: a day that cannot carry a finding (one salon, at most
 * 4 h 30 min from the first start to the last end) is not read.
 *
 * Stale acknowledgements (A8): an acknowledgement stores the day as it was; since Issue #511 that
 * snapshot also carries the placement key of the day's Satz-2/3 findings. An acknowledgement that
 * was stored before has no key, so on a day that now has such a finding it no longer matches and
 * the day re-opens. `staleAck` counts, per tenant and month, the acknowledgement rows that match
 * the day in every OLD field and differ ONLY by the new key (decided with the production
 * comparator `isAckSnapshotCurrent`), on days no current acknowledgement covers. `openDays` are the
 * days a manager has to look at again; `closedDays` lie in a closed month and stay as they are.
 *
 * READ-ONLY. ZERO mutations. There is no write flag anywhere in this file and none may ever be
 * added. The counts never change data; the owner reads them before enabling or keeping
 * `blockMonthCloseOnUnconfirmedBreak`, and closed months are listed but never touched.
 *
 * Output contains ids only — no employee name, no employee number (DSGVO). Full, untruncated
 * UUIDs, so the owner can locate each row directly.
 *
 * Usage in a checkout:
 *   DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \
 *     scripts/audit-511-break-placement.ts \
 *     ( --tenant-id <uuid> | --all-tenants ) --from <YYYY-MM-DD> --to <YYYY-MM-DD> \
 *     [--help]
 * Usage inside the API container (int/prod; there is no npx or pnpm there, the DATABASE_URL is set):
 *   cd /app && ./node_modules/.bin/tsx apps/api/scripts/audit-511-break-placement.ts \
 *     --all-tenants --from <YYYY-MM-DD> --to <YYYY-MM-DD>
 *
 * Exit codes:
 *   0 — no finding for the given scope
 *   1 — DATABASE_URL missing, bad CLI, or a DB connection/query failure
 *   2 — one or more findings
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  entryDurations,
  evaluateBreakFindingDays,
  getWorkedEntriesInRange,
} from "../src/contexts/time-tracking";
import {
  hasAckableFinding,
  isAckSnapshotCurrent,
  type DaySnapshot,
} from "../src/contexts/time-tracking/day-break-rule";
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

/** The longest range one run accepts: one read per model per month chunk stays small. */
const MAX_RANGE_DAYS = 366;

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
  DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx scripts/audit-511-break-placement.ts \\
    ( --tenant-id <uuid> | --all-tenants ) --from <YYYY-MM-DD> --to <YYYY-MM-DD> \\
    [--help]
  In the API container: cd /app && ./node_modules/.bin/tsx apps/api/scripts/audit-511-break-placement.ts ...

READ-ONLY — lists the days the Satz-2/3 ArbZG and § 11 JArbSchG break rules flag (Issue #511) and
counts them per code, month and month state. No write flag exists. The range is at most
${MAX_RANGE_DAYS} days. Output carries ids only, never names.

Output lines:
  tenant tenantId=<uuid> blockMonthCloseOnUnconfirmedBreak=<true|false|unknown> employees=<n>
      one per tenant: the block flag as stored and the number of non-exempt employees read
  finding tenantId=<uuid> employeeId=<uuid> date=<YYYY-MM-DD> code=<CODE> certainty=<VIOLATION|UNCLEAR>
          month=<YYYY-MM> closed=<bool> wouldBlock=<bool>
      one per finding of a day. closed = an entry is locked or the month has a closed snapshot.
      wouldBlock = unacknowledged, un-waived finding in a month that is still open.
  summary code=<CODE> month=<YYYY-MM> open=<n> closed=<n>
      findings per code and month, split by month state
  hint BREAK_POSITION_UNKNOWN month=<YYYY-MM> open=<n> closed=<n>
      legacy days that only carry a stored break sum — informational, never a finding
  summary divergent=<n>
      entries whose Break rows sum to more than their stored breakMinutes
  summary wouldBlock=<n>
      distinct employee days a Monatsabschluss would stop at
  staleAck tenantId=<uuid> month=<YYYY-MM> ackRows=<n> days=<n> openDays=<n> closedDays=<n>
  staleAckTotal tenantId=<uuid> ackRows=<n> days=<n> openDays=<n> closedDays=<n>
      acknowledgements that read as stale only because they predate the placement key (A8); one
      total line per tenant, also when it is zero

Exit codes:
  0 — no finding for the given scope
  1 — DATABASE_URL missing, bad CLI, or a DB connection/query failure
  2 — one or more findings
`;

// ── Range validation ──────────────────────────────────────────────────────────
/** A real calendar day "YYYY-MM-DD": the round trip rejects 2026-02-30 and 2026-3-1. */
function assertIsoDay(value: string, flag: "--from" | "--to"): void {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`Ungültiges Datum für ${flag}: "${value}" (erwartet YYYY-MM-DD).`);
  }
}

/** Throws a German message unless `from`/`to` are real days, ordered, and at most 366 days apart. */
export function validateRange(from: string, to: string): void {
  assertIsoDay(from, "--from");
  assertIsoDay(to, "--to");
  if (from > to) {
    throw new Error(`Ungültiger Zeitraum: --from (${from}) darf nicht nach --to (${to}) liegen.`);
  }
  const days =
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000 +
    1;
  if (days > MAX_RANGE_DAYS) {
    throw new Error(
      `Ungültiger Zeitraum: höchstens ${MAX_RANGE_DAYS} Tage pro Lauf erlaubt (angefragt: ${days}).`,
    );
  }
}

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

type OpenClosed = { open: number; closed: number };
type StaleCount = { ackRows: number; days: number; openDays: number; closedDays: number };

function bump(map: Map<string, OpenClosed>, key: string, closed: boolean): void {
  const counter = map.get(key) ?? { open: 0, closed: 0 };
  if (closed) counter.closed += 1;
  else counter.open += 1;
  map.set(key, counter);
}

const emptyStale = (): StaleCount => ({ ackRows: 0, days: 0, openDays: 0, closedDays: 0 });
const formatStale = (c: StaleCount): string =>
  `ackRows=${c.ackRows} days=${c.days} openDays=${c.openDays} closedDays=${c.closedDays}`;

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
  validateRange(from, to);

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

    const tenantLines: string[] = [];
    const findings: Finding[] = [];
    const byCodeMonth = new Map<string, OpenClosed>();
    const hintByMonth = new Map<string, OpenClosed>();
    const staleByTenantMonth = new Map<string, StaleCount>();
    const staleTotals = new Map<string, StaleCount>();
    const blockingDays = new Set<string>();
    let divergent = 0;

    for (const tenant of tenants) {
      const tz = await getTenantTimezone(prisma, tenant.id);
      const config = await prisma.tenantConfig.findFirst({
        where: { tenantId: tenant.id },
        select: { blockMonthCloseOnUnconfirmedBreak: true },
      });
      // Exempt employees are skipped, exactly as `checkArbZG` does.
      const employees = await prisma.employee.findMany({
        where: { tenantId: tenant.id, isTimeTrackingExempt: false },
        select: { id: true, birthDate: true },
      });
      tenantLines.push(
        `tenant tenantId=${tenant.id} blockMonthCloseOnUnconfirmedBreak=` +
          `${config ? config.blockMonthCloseOnUnconfirmedBreak : "unknown"} ` +
          `employees=${employees.length}`,
      );
      const nonExempt = new Set(employees.map((e) => e.id));
      const birthDates = new Map(employees.map((e) => [e.id, e.birthDate]));
      const scope = employeeScopeFor(
        accessContextForJob(tenant.id, "audit-511-break-placement"),
        {},
      );
      const closedMemo = new Map<string, boolean>();
      const total = emptyStale();
      staleTotals.set(tenant.id, total);

      const monthClosed = async (employeeId: string, month: string): Promise<boolean> => {
        const memoKey = `${employeeId}\u0000${month}`;
        let closed = closedMemo.get(memoKey);
        if (closed === undefined) {
          const { start } = monthRangeUtc(Number(month.slice(0, 4)), Number(month.slice(5, 7)), tz);
          closed = await isMonthClosed(prisma, employeeId, tenant.id, start);
          closedMemo.set(memoKey, closed);
        }
        return closed;
      };

      for (const chunk of monthChunks(from, to)) {
        const chunkFirst = new Date(`${chunk.first}T00:00:00Z`);
        const chunkLast = new Date(`${chunk.last}T00:00:00Z`);
        const rows = (await getWorkedEntriesInRange(prisma, scope, chunkFirst, chunkLast)).filter(
          (r) => nonExempt.has(r.employeeId),
        );
        const rowById = new Map(rows.map((r) => [r.id, r]));
        const evaluated = await evaluateBreakFindingDays(prisma, {
          tenantId: tenant.id,
          rows,
          tz,
          birthDates,
          isMinorAt: isMinorAtDate,
          includeLocked: true,
        });

        // One acknowledgement read per chunk, and only when some day carries a placement key at
        // all (only then can an old acknowledgement differ by the key).
        const withKey = evaluated.filter((d) => d.evaluation.snapshot.placementKey);
        const acksByDay = new Map<string, Array<{ snapshot: unknown }>>();
        if (withKey.length > 0) {
          const acks = await prisma.dayBreakAck.findMany({
            where: {
              deletedAt: null,
              employee: { tenantId: tenant.id },
              employeeId: { in: [...new Set(withKey.map((d) => d.employeeId))] },
              date: { gte: chunkFirst, lte: chunkLast },
            },
            select: { employeeId: true, date: true, snapshot: true },
          });
          for (const ack of acks) {
            const key = `${ack.employeeId}\u0000${ack.date.toISOString().slice(0, 10)}`;
            acksByDay.set(key, [...(acksByDay.get(key) ?? []), ack]);
          }
        }

        for (const day of evaluated) {
          const month = day.date.slice(0, 7);
          const placement = day.evaluation.placement.findings;
          const certain = placement.filter((f) => f.certainty !== null);
          const hints = placement.filter((f) => f.certainty === null);

          // Pitfall 6: Break rows that sum to more than the stored break are counted, not guessed.
          for (const r of day.rows) {
            const source = rowById.get(r.id);
            if (!source) continue;
            const placed = day.evaluation.breakSegments
              .filter((s) => s.source === "entry-break" && s.entryId === r.id)
              .reduce((sum, s) => sum + s.minutes, 0);
            if (placed > entryDurations(source).breakMinutes) divergent += 1;
          }

          const hasKey = Boolean(day.evaluation.snapshot.placementKey);
          if (certain.length === 0 && hints.length === 0 && !hasKey) continue;

          const closed = day.locked || (await monthClosed(day.employeeId, month));

          for (const h of hints) bump(hintByMonth, `${h.code}\u0000${month}`, closed);

          if (certain.length > 0) {
            const wouldBlock =
              hasAckableFinding(day.evaluation) && !day.evaluation.waived && !closed;
            if (wouldBlock)
              blockingDays.add(`${tenant.id}\u0000${day.employeeId}\u0000${day.date}`);
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
              bump(byCodeMonth, `${f.code}\u0000${month}`, closed);
            }
          }

          // A8: an acknowledgement that matches in every old field and differs only by the new
          // placement key. A day another acknowledgement still covers does not re-open.
          if (hasKey && !day.evaluation.acknowledged) {
            const snapshot = day.evaluation.snapshot;
            const withoutKey: DaySnapshot = {
              entryIds: snapshot.entryIds,
              salonIds: snapshot.salonIds,
              netWorkedMin: snapshot.netWorkedMin,
              totalBreakMin: snapshot.totalBreakMin,
            };
            const ackKey = `${day.employeeId}\u0000${day.rows[0].date.toISOString().slice(0, 10)}`;
            const staleRows = (acksByDay.get(ackKey) ?? []).filter(
              (a) =>
                !isAckSnapshotCurrent(a.snapshot, snapshot) &&
                isAckSnapshotCurrent(a.snapshot, withoutKey),
            ).length;
            if (staleRows > 0) {
              const monthKey = `${tenant.id}\u0000${month}`;
              const perMonth = staleByTenantMonth.get(monthKey) ?? emptyStale();
              for (const c of [perMonth, total]) {
                c.ackRows += staleRows;
                c.days += 1;
                if (closed) c.closedDays += 1;
                else c.openDays += 1;
              }
              staleByTenantMonth.set(monthKey, perMonth);
            }
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

    for (const line of tenantLines) console.info(line);
    for (const f of findings) console.info(formatFindingLine(f));

    // Summary block: counts never change data; the owner reads them before deploying.
    const sortedKeys = (m: Map<string, unknown>) =>
      [...m.keys()].sort((a, b) => a.localeCompare(b));
    for (const key of sortedKeys(byCodeMonth)) {
      const [code, month] = key.split("\u0000");
      const c = byCodeMonth.get(key)!;
      console.info(`summary code=${code} month=${month} open=${c.open} closed=${c.closed}`);
    }
    for (const key of sortedKeys(hintByMonth)) {
      const [code, month] = key.split("\u0000");
      const c = hintByMonth.get(key)!;
      console.info(`hint ${code} month=${month} open=${c.open} closed=${c.closed}`);
    }
    console.info(`summary divergent=${divergent}`);
    console.info(`summary wouldBlock=${blockingDays.size}`);
    for (const key of sortedKeys(staleByTenantMonth)) {
      const [tenantId, month] = key.split("\u0000");
      console.info(
        `staleAck tenantId=${tenantId} month=${month} ${formatStale(staleByTenantMonth.get(key)!)}`,
      );
    }
    for (const [tenantId, total] of staleTotals) {
      console.info(`staleAckTotal tenantId=${tenantId} ${formatStale(total)}`);
    }

    if (findings.length === 0) {
      console.info("No Satz-2/3 or JArbSchG 11 break finding for the given scope.");
    } else {
      console.info(
        `\nSummary: ${findings.length} finding(s), ${blockingDays.size} day(s) would block a ` +
          `Monatsabschluss across ${tenants.length} tenant(s). This script writes nothing.`,
      );
    }

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
