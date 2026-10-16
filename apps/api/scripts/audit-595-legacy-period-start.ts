/**
 * Audit tool - Issue #595 (P-08, D-03): which closed months does #595 change, per stage?
 *
 * Background. `SaldoSnapshot.periodStart` is a date column with two storage conventions in the
 * data: the API closer writes the tenant-time-zone-converted start of the month (for Europe/Berlin
 * the LAST day of the previous month), the old import scripts and the demo seed wrote the UTC
 * first of the month. Before #595 a month was read as closed only when its row carried the
 * converted date, so a month stored the legacy way printed as "Prognose" although its closed
 * figures existed. #595 reads the month under a window that covers both conventions, takes ONE
 * record per month (the first of `monthlySnapshotOrder`) and names a row's month with
 * `snapshotMonthOf`, never from the stored date.
 *
 * READS ONLY. This file issues `findMany` reads and prints; it contains no write call and takes
 * no write flag. It is a listing, not a gate: the exit code is 0 whenever the run succeeds.
 *
 * What it prints per tenant (active MONTHLY snapshots only, not superseded):
 *   - totals: rows, rows per storage convention (LEGACY = stored on the 1st of its month, TZ = the
 *     converted start date, OTHER = inside the window but neither, UNNAMED = in no month's window);
 *   - LEGACY rows: tenantId, employeeId, month, stored date;
 *   - duplicate months: an employee month with more than one active row, naming the row the
 *     account reads (the selected id) and the others;
 *   - "Status wechselt zu Bestaetigt": months whose record is a legacy row with no converted
 *     sibling - these printed as Prognose before #595 and read as confirmed with it;
 *   - "Monatsname korrigiert": converted rows whose stored UTC date lies in the month BEFORE
 *     their named month - the page label of such a row was one month early;
 *   - UNNAMED rows (no month can be named; never guessed).
 *
 * Output contains ids and calendar months only - no name, no employee number (DSGVO). Full
 * untruncated UUIDs so the owner can find every row.
 *
 * Usage (the owner runs it on int and prod; a read-only database role is enough):
 *   DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \
 *     scripts/audit-595-legacy-period-start.ts [--tenant <uuid>]
 *
 * Exit codes: 0 - listing printed; 1 - DATABASE_URL missing, bad CLI or a connection/query failure.
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  getTenantTimezone,
  monthRangeUtc,
  snapshotMonthOf,
  selectMonthlySnapshotPerMonth,
} from "../src/contexts/working-time-account";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;

/** The minimal row shape the classifier needs. */
export type SnapshotRow = {
  id: string;
  employeeId: string;
  periodStart: Date;
  closedAt: Date;
};

export type SnapshotKind = "LEGACY" | "TZ" | "OTHER" | "UNNAMED";

export type ClassifiedRow = {
  id: string;
  employeeId: string;
  kind: SnapshotKind;
  /** The calendar month the account files the row under ("YYYY-MM"), null when unnameable. */
  month: string | null;
  /** The stored date as "YYYY-MM-DD". */
  periodStart: string;
};

export type DuplicateGroup = {
  employeeId: string;
  month: string;
  /** The row the account reads (first of `monthlySnapshotOrder`). */
  selectedId: string;
  otherIds: string[];
};

export type Classification = {
  total: number;
  rows: ClassifiedRow[];
  legacy: ClassifiedRow[];
  tz: ClassifiedRow[];
  other: ClassifiedRow[];
  unnamed: ClassifiedRow[];
  duplicates: DuplicateGroup[];
  /** Months whose record is a legacy row without a converted sibling: Prognose before #595. */
  statusBecomesConfirmed: ClassifiedRow[];
  /** Converted rows whose stored UTC month differs from their named month. */
  monthNameCorrected: ClassifiedRow[];
};

const pad = (n: number): string => String(n).padStart(2, "0");
const dateStr = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Pure classification of one tenant's active MONTHLY snapshots. `tz` is the tenant's time zone.
 * The month of a row comes only from `snapshotMonthOf`, the record per month only from
 * `selectMonthlySnapshotPerMonth` (applied per employee) - nothing is derived from the stored
 * date here except the convention label, which is decided by comparing it with the window start.
 */
export function classifySnapshotRows(rows: SnapshotRow[], tz: string): Classification {
  const classified = new Map<string, ClassifiedRow>();
  for (const row of rows) {
    const named = snapshotMonthOf(row.periodStart, tz);
    const stored = dateStr(row.periodStart);
    if (named === null) {
      classified.set(row.id, {
        id: row.id,
        employeeId: row.employeeId,
        kind: "UNNAMED",
        month: null,
        periodStart: stored,
      });
      continue;
    }
    const windowStart = dateStr(monthRangeUtc(named.year, named.month, tz).start);
    const firstOfMonth = `${named.year}-${pad(named.month)}-01`;
    // The converted start date wins: where it equals the 1st (UTC, zones behind UTC) the two
    // conventions are the same stored value and nothing is legacy about it.
    const kind: SnapshotKind =
      stored === windowStart ? "TZ" : stored === firstOfMonth ? "LEGACY" : "OTHER";
    classified.set(row.id, {
      id: row.id,
      employeeId: row.employeeId,
      kind,
      month: `${named.year}-${pad(named.month)}`,
      periodStart: stored,
    });
  }

  const byEmployee = new Map<string, SnapshotRow[]>();
  for (const row of rows) {
    const list = byEmployee.get(row.employeeId) ?? [];
    list.push(row);
    byEmployee.set(row.employeeId, list);
  }

  const duplicates: DuplicateGroup[] = [];
  const statusBecomesConfirmed: ClassifiedRow[] = [];
  for (const [employeeId, list] of byEmployee) {
    const selected = selectMonthlySnapshotPerMonth(list, tz);
    const selectedIds = new Set(selected.map((r) => r.id));
    const monthRows = new Map<string, ClassifiedRow[]>();
    for (const row of list) {
      const c = classified.get(row.id)!;
      if (c.month === null) continue;
      const bucket = monthRows.get(c.month) ?? [];
      bucket.push(c);
      monthRows.set(c.month, bucket);
    }
    for (const [month, bucket] of monthRows) {
      const chosen = bucket.find((c) => selectedIds.has(c.id))!;
      if (bucket.length > 1) {
        duplicates.push({
          employeeId,
          month,
          selectedId: chosen.id,
          otherIds: bucket.filter((c) => c.id !== chosen.id).map((c) => c.id),
        });
      }
      if (chosen.kind === "LEGACY" && !bucket.some((c) => c.kind === "TZ")) {
        statusBecomesConfirmed.push(chosen);
      }
    }
  }

  const all = rows.map((r) => classified.get(r.id)!);
  const monthNameCorrected = all.filter((c) => {
    if (c.kind !== "TZ" || c.month === null) return false;
    return c.periodStart.slice(0, 7) !== c.month;
  });

  return {
    total: all.length,
    rows: all,
    legacy: all.filter((c) => c.kind === "LEGACY"),
    tz: all.filter((c) => c.kind === "TZ"),
    other: all.filter((c) => c.kind === "OTHER"),
    unnamed: all.filter((c) => c.kind === "UNNAMED"),
    duplicates,
    statusBecomesConfirmed,
    monthNameCorrected,
  };
}

export type TenantReport = { tenantId: string; timeZone: string; result: Classification };

export type MainOptions = {
  tenantId?: string;
  /** Line sink; defaults to console.info. */
  out?: (line: string) => void;
};

/**
 * Reads the active MONTHLY snapshots per tenant and prints the listing. `prisma` is injected so
 * the test can run against a worker database; the CLI below builds its own connection.
 */
export async function main(prisma: PrismaClient, opts: MainOptions = {}): Promise<TenantReport[]> {
  // eslint-disable-next-line no-console -- a listing script: stdout is its output
  const out = opts.out ?? ((line: string) => console.info(line));
  const tenants = opts.tenantId
    ? [{ id: opts.tenantId }]
    : await prisma.tenant.findMany({ select: { id: true }, orderBy: { id: "asc" } });

  const reports: TenantReport[] = [];
  for (const { id: tenantId } of tenants) {
    const timeZone = await getTenantTimezone(prisma, tenantId);
    const rows = await prisma.saldoSnapshot.findMany({
      where: { periodType: "MONTHLY", superseded: false, employee: { tenantId } },
      select: { id: true, employeeId: true, periodStart: true, closedAt: true },
      orderBy: [{ employeeId: "asc" }, { periodStart: "asc" }, { id: "asc" }],
    });
    const result = classifySnapshotRows(rows, timeZone);
    reports.push({ tenantId, timeZone, result });

    out(`tenant ${tenantId} timeZone=${timeZone}`);
    out(
      `  rows=${result.total} legacy=${result.legacy.length} tz=${result.tz.length} ` +
        `other=${result.other.length} unnamed=${result.unnamed.length}`,
    );
    out(`  LEGACY rows: ${result.legacy.length}`);
    for (const c of result.legacy) {
      out(
        `    tenantId=${tenantId} employeeId=${c.employeeId} month=${c.month} ` +
          `periodStart=${c.periodStart} snapshotId=${c.id}`,
      );
    }
    out(`  Duplicate months: ${result.duplicates.length}`);
    for (const d of result.duplicates) {
      out(
        `    tenantId=${tenantId} employeeId=${d.employeeId} month=${d.month} ` +
          `selectedId=${d.selectedId} otherIds=${d.otherIds.join(",")}`,
      );
    }
    out(`  Status wechselt zu Bestaetigt: ${result.statusBecomesConfirmed.length}`);
    for (const c of result.statusBecomesConfirmed) {
      out(
        `    tenantId=${tenantId} employeeId=${c.employeeId} month=${c.month} snapshotId=${c.id}`,
      );
    }
    out(`  Monatsname korrigiert: ${result.monthNameCorrected.length}`);
    for (const c of result.monthNameCorrected) {
      out(
        `    tenantId=${tenantId} employeeId=${c.employeeId} month=${c.month} ` +
          `periodStart=${c.periodStart} snapshotId=${c.id}`,
      );
    }
    out(`  UNNAMED rows: ${result.unnamed.length}`);
    for (const c of result.unnamed) {
      out(
        `    tenantId=${tenantId} employeeId=${c.employeeId} periodStart=${c.periodStart} ` +
          `snapshotId=${c.id}`,
      );
    }
  }
  return reports;
}

async function cli(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { tenant: { type: "string" } },
    strict: true,
  });
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    return EXIT_ERROR;
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
  try {
    await main(prisma, { tenantId: values.tenant });
    return EXIT_OK;
  } catch (err) {
    console.error(err);
    return EXIT_ERROR;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

// Import has no side effect: the CLI runs only when this file is the entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void cli().then((code) => process.exit(code));
}
