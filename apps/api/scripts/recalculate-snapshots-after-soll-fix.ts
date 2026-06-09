/**
 * Operator script — v1.8.4 Ø-Methode SaldoSnapshot recalculation.
 *
 * v1.8.4 fixed the broken Soll-reduction formula `weeklyHours × Kalendertage ÷ 7`
 * (which counts Sa+So) by replacing it with the BAG-konforme Ø-Methode
 * `weeklyHours ÷ workDaysPerWeek × workdaysInRange`. See BAG 9 AZR 406/17.
 *
 * Already-stored SaldoSnapshots (created by Monatsabschluss before v1.8.4
 * deploy) still hold the broken values. This script re-runs the math against
 * the now-fixed helpers and updates the snapshots. Each recalc gets exactly
 * 1 AuditLog row (action SALDO_RECALC_AFTER_SOLL_FIX) with the full oldValue
 * for restoration purposes.
 *
 * Invariants:
 *   - NEVER hard-deletes rows (Revisionssicherheit per CLAUDE.md).
 *   - NEVER writes to locked-month snapshots on --apply. They appear in the
 *     summary.skippedLocked array for operator review. Force-recalc of locked
 *     months would require a separate phase + tenant approval.
 *   - Idempotent: re-running --apply on already-recalced snapshots writes
 *     zero new AuditLog rows (noop detection compares all 4 numeric fields).
 *   - Soft-delete: queries the `superseded: false` SaldoSnapshot pool only.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
 *     scripts/recalculate-snapshots-after-soll-fix.ts \
 *     ( --tenant-id <uuid> | --all-tenants ) \
 *     [--year YYYY] \
 *     [--apply] \
 *     [--help]
 *
 * Without --apply: dry-run, prints the proposed changes as a JSON summary.
 * With    --apply: opens one $transaction per recalc (SaldoSnapshot.update +
 *                  AuditLog.create) for atomicity.
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { recomputeSnapshotValues } from "../src/utils/recompute-snapshot";
import { getTenantTimezone, monthRangeUtc } from "../src/utils/timezone";

const RECALC_REASON = "v1.8.4 Ø-Methode migration (BAG 9 AZR 406/17)";
const RECALC_ACTION = "SALDO_RECALC_AFTER_SOLL_FIX";
const RECALC_USER_AGENT = "script:recalculate-snapshots-after-soll-fix";

export type CliArgs = {
  tenantId: string | null;
  allTenants: boolean;
  year: number | null;
  apply: boolean;
  help: boolean;
};

export type RecalcSummary = {
  dryRun: boolean;
  tenantsScanned: number;
  snapshotsScanned: number;
  recalculated: number;
  unchanged: number;
  skippedLocked: Array<{
    snapshotId: string;
    employeeId: string;
    tenantId: string;
    periodStart: Date;
    deltaBalanceMinutes: number;
  }>;
  errors: Array<{
    snapshotId: string;
    employeeId: string;
    tenantId: string;
    error: string;
  }>;
};

const USAGE = `Usage: tsx scripts/recalculate-snapshots-after-soll-fix.ts \\
  ( --tenant-id <uuid> | --all-tenants ) \\
  [--year YYYY] \\
  [--apply] \\
  [--help]

  --tenant-id    Scope to a single tenant (UUID).
  --all-tenants  Scope to every tenant in the database.
                 (One of --tenant-id OR --all-tenants is REQUIRED — no silent default.)
  --year         Optional. Only recalc snapshots whose periodStart year matches.
  --apply        Opt-in flag. Without it the script runs dry-run (prints summary, writes nothing).
  --help         Print this usage block and exit 0.

Safety:
  - Locked-month snapshots are listed in the dry-run summary but SKIPPED on --apply
    (Revisionssicherheit per CLAUDE.md "Immutability after lock").
  - Idempotent: re-running --apply on already-recalced snapshots writes zero new AuditLog rows.
  - Every recalc produces exactly one AuditLog row (action ${RECALC_ACTION}).
`;

export function parseArgs2(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "tenant-id": { type: "string" },
      "all-tenants": { type: "boolean", default: false },
      year: { type: "string" },
      apply: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  const yearStr = values["year"];
  let year: number | null = null;
  if (yearStr !== undefined) {
    const n = Number(yearStr);
    if (!Number.isInteger(n) || n < 1970 || n > 9999) {
      throw new Error(`--year muss eine vierstellige Jahreszahl sein (erhalten: ${yearStr}).`);
    }
    year = n;
  }

  return {
    tenantId: values["tenant-id"] ?? null,
    allTenants: Boolean(values["all-tenants"]),
    year,
    apply: Boolean(values["apply"]),
    help: Boolean(values["help"]),
  };
}

/**
 * Determine whether a SaldoSnapshot is "locked" (= its month has been closed
 * and entries flipped to isLocked per CLAUDE.md "Immutability after lock").
 * Since SaldoSnapshot has no isLocked column, we use the canonical signal:
 * at least one TimeEntry in the period has isLocked: true.
 */
async function isSnapshotLocked(
  prisma: PrismaClient,
  employeeId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<boolean> {
  const lockedCount = await prisma.timeEntry.count({
    where: {
      employeeId,
      deletedAt: null,
      date: { gte: periodStart, lte: periodEnd },
      isLocked: true,
    },
  });
  return lockedCount > 0;
}

/**
 * Main entry point. Exported for unit-testability — pass a PrismaClient to
 * inject a test connection; without one the function creates its own.
 */
export async function main(argv: string[], injectedPrisma?: PrismaClient): Promise<RecalcSummary> {
  const args = parseArgs2(argv);

  if (args.help) {
    console.log(USAGE);
    return {
      dryRun: true,
      tenantsScanned: 0,
      snapshotsScanned: 0,
      recalculated: 0,
      unchanged: 0,
      skippedLocked: [],
      errors: [],
    };
  }

  if (!args.tenantId && !args.allTenants) {
    throw new Error(
      "Tenant-Auswahl erforderlich: bitte --tenant-id <uuid> ODER --all-tenants angeben.",
    );
  }

  const prisma = injectedPrisma ?? new PrismaClient();
  const ownsPrisma = !injectedPrisma;

  try {
    const summary: RecalcSummary = {
      dryRun: !args.apply,
      tenantsScanned: 0,
      snapshotsScanned: 0,
      recalculated: 0,
      unchanged: 0,
      skippedLocked: [],
      errors: [],
    };

    // ── Resolve tenant list ────────────────────────────────────────────
    const tenants = args.allTenants
      ? await prisma.tenant.findMany({ select: { id: true } })
      : [{ id: args.tenantId! }];
    summary.tenantsScanned = tenants.length;

    for (const t of tenants) {
      // WR-01: --year is timezone-dependent because SaldoSnapshot.periodStart
      // is produced via monthRangeUtc(year, month, tz) (auto-close-month.ts).
      // For Berlin (UTC+1) tenants, Jan 1 is stored as `prev-year-12-31T23:00Z`,
      // so a naive `Date.UTC(year, 0, 1)` window misses January and over-includes
      // the following January. Resolve the tenant TZ and build the window via
      // the same helper that produced the periodStart values.
      const tz = await getTenantTimezone(prisma, t.id);
      const yearStart = args.year ? monthRangeUtc(args.year, 1, tz).start : null;
      const yearEnd = args.year ? monthRangeUtc(args.year, 12, tz).end : null;

      // SaldoSnapshot has no tenantId column; resolve via employee relation.
      const snapshots = await prisma.saldoSnapshot.findMany({
        where: {
          superseded: false,
          employee: { tenantId: t.id },
          ...(yearStart && yearEnd
            ? { periodStart: { gte: yearStart, lte: yearEnd } }
            : {}),
        },
        orderBy: [{ employeeId: "asc" }, { periodStart: "asc" }],
      });

      summary.snapshotsScanned += snapshots.length;

      // Track running carry-over per employee so we can compute the new
      // carryOver chain consistently — same approach as recalculateSnapshots().
      const carryByEmployee = new Map<string, number>();

      for (const snap of snapshots) {
        // WR-02: wrap per-snapshot work in try/catch so a single failure
        // (corrupt schedule row, lost DB connection, constraint violation in
        // the audit insert) does NOT abort the entire run. Failures are
        // captured in summary.errors so the operator gets a usable post-mortem.
        // The $transaction below remains atomic — either both rows commit or
        // neither, preserving the "exactly one AuditLog row per recalc" invariant.
        try {
          const oldValues = {
            workedMinutes: snap.workedMinutes,
            expectedMinutes: snap.expectedMinutes,
            balanceMinutes: snap.balanceMinutes,
            carryOver: snap.carryOver,
          };

          // Determine prior carryOver: from in-memory chain or, for the first
          // snapshot we see for this employee, look up the immediately-prior
          // snapshot (if any).
          let priorCarry = carryByEmployee.get(snap.employeeId);
          if (priorCarry === undefined) {
            const prev = await prisma.saldoSnapshot.findFirst({
              where: {
                employeeId: snap.employeeId,
                periodType: snap.periodType,
                periodStart: { lt: snap.periodStart },
                superseded: false,
              },
              orderBy: { periodStart: "desc" },
            });
            priorCarry = prev?.carryOver ?? 0;
          }

          const newValues = await recomputeSnapshotValues(prisma, snap, priorCarry);
          carryByEmployee.set(snap.employeeId, newValues.carryOver);

          const noop =
            newValues.workedMinutes === oldValues.workedMinutes &&
            newValues.expectedMinutes === oldValues.expectedMinutes &&
            newValues.balanceMinutes === oldValues.balanceMinutes &&
            newValues.carryOver === oldValues.carryOver;

          if (noop) {
            summary.unchanged++;
            continue;
          }

          // D-18: locked months are never written on --apply; always listed.
          const locked = await isSnapshotLocked(
            prisma,
            snap.employeeId,
            snap.periodStart,
            snap.periodEnd,
          );
          if (locked) {
            summary.skippedLocked.push({
              snapshotId: snap.id,
              employeeId: snap.employeeId,
              tenantId: t.id,
              periodStart: snap.periodStart,
              deltaBalanceMinutes: newValues.balanceMinutes - oldValues.balanceMinutes,
            });
            continue;
          }

          if (!args.apply) {
            // dry-run: still count as recalculated for summary purposes.
            summary.recalculated++;
            continue;
          }

          // --apply: write SaldoSnapshot.update + AuditLog.create in one tx.
          await prisma.$transaction(async (tx) => {
            await tx.saldoSnapshot.update({
              where: { id: snap.id },
              data: {
                workedMinutes: newValues.workedMinutes,
                expectedMinutes: newValues.expectedMinutes,
                balanceMinutes: newValues.balanceMinutes,
                carryOver: newValues.carryOver,
              },
            });
            await tx.auditLog.create({
              data: {
                userId: null,
                action: RECALC_ACTION,
                entity: "SaldoSnapshot",
                entityId: snap.id,
                oldValue: oldValues,
                newValue: {
                  ...newValues,
                  reason: RECALC_REASON,
                },
                ipAddress: null,
                userAgent: RECALC_USER_AGENT,
              },
            });
          });
          summary.recalculated++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          summary.errors.push({
            snapshotId: snap.id,
            employeeId: snap.employeeId,
            tenantId: t.id,
            error: message,
          });
          console.error(`[recalc] snapshot ${snap.id} failed: ${message}`);
          continue;
        }
      }
    }

    console.log(JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    if (ownsPrisma) {
      await prisma.$disconnect();
    }
  }
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────
// Use the same pattern as cleanup-tz-duplicate-snapshots.ts: build a PrismaPg
// adapter from DATABASE_URL, call main() with process.argv, exit non-zero on
// any error. Skip when imported (require.main !== module).
const isMain =
  typeof require !== "undefined" && typeof module !== "undefined" && require.main === module;

if (isMain) {
  (async () => {
    if (!process.env.DATABASE_URL) {
      console.error("DATABASE_URL is required");
      process.exit(1);
    }

    // Allow --help to short-circuit before pool construction.
    if (process.argv.includes("--help")) {
      await main(process.argv.slice(2));
      process.exit(0);
    }

    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new PrismaPg(pool as any);
    const prisma = new PrismaClient({ adapter });

    try {
      await main(process.argv.slice(2), prisma);
    } catch (err) {
      console.error((err as Error).message ?? err);
      process.exit(1);
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }
  })();
}
