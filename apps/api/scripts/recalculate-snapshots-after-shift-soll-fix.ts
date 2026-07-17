/**
 * Operator script — v1.8.16 SHIFT_BASED Model B Vertrags-Soll retro-recalculation.
 *
 * v1.8.16 fixes the SHIFT_BASED saldo formula: the previous implementation set
 * `expectedMinutes = Σ netto shifts` (Model A — roster-anchored). The correct
 * formula is Model B + § 615 (Phase 76.22, D-01):
 *
 *   C_net = calcExpectedMinutesTz(schedule, effectiveStart, periodEnd, tz)
 *           − leaveCredit − absenceCredit + bsExpectedMinutes
 *   R     = Σ netto active shifts (deletedAt=null, coveredDates excluded)
 *   W     = Σ TimeEntry netto (isInvalid=false, type=WORK, deletedAt=null)
 *
 *   balance = max(0, W−C_net) − max(0, R−W)          [§ 615 BGB guard]
 *
 * Already-stored SaldoSnapshots (created before v1.8.16 deploy) still hold
 * Model A values. This script re-runs Model B math and updates open-month
 * snapshots. Each recompute gets exactly 1 AuditLog row
 * (action SALDO_RECALC_AFTER_SHIFT_SOLL_FIX) with full oldValue for restoration.
 *
 * Invariants:
 *   - NEVER hard-deletes rows (Revisionssicherheit per CLAUDE.md).
 *   - NEVER writes to locked-month snapshots on --apply. They appear in the
 *     summary.skippedLocked array for operator review.
 *   - Idempotent: re-running --apply on already-recalced snapshots writes zero
 *     new AuditLog rows (noop detection compares all 4 numeric fields).
 *   - Opening-balance bridge snapshots are preserved as chain-start values
 *     and are NOT overwritten (D-08 protection — see bridge heuristic below).
 *     Limitation (A2): heuristic detects bridges via shape
 *     (expectedMinutes==0 && workedMinutes==0 && balanceMinutes==0 && carryOver!=0).
 *     A future schema change adding `SaldoSnapshot.bridgeSnapshot: boolean` would
 *     be cleaner but is out of scope for this phase.
 *   - Soft-delete: queries the `superseded: false` SaldoSnapshot pool only.
 *   - Scope: SHIFT_BASED employees only.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
 *     scripts/recalculate-snapshots-after-shift-soll-fix.ts \
 *     ( --tenant-id <uuid> | --all-tenants ) \
 *     [--year YYYY] \
 *     [--apply] \
 *     [--help]
 *
 * Without --apply: dry-run (prints proposed changes as JSON summary, zero writes).
 * With    --apply: opens one $transaction per recompute (SaldoSnapshot.update +
 *                  AuditLog.create) for atomicity.
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import {
  getTenantTimezone,
  monthRangeUtc,
  dateStrInTz,
  monthDayBounds,
  calcExpectedMinutesTz,
  calcLeaveAbsenceMinutesTz,
} from "../src/utils/timezone";
import { getEffectiveBreakDuration } from "../src/utils/break-effective";
import {
  getVocationalSchoolMinutesForDate,
  type VocationalSchoolTenantConfig,
} from "../src/utils/vocational-school-saldo";
import { calcShiftBasedSaldo } from "../src/utils/shift-based-saldo";

// ── Audit constants ─────────────────────────────────────────────────────────
const RECALC_REASON = "v1.8.16 SHIFT_BASED Model B Soll (contract-anchored, § 615 guard)";
const RECALC_ACTION = "SALDO_RECALC_AFTER_SHIFT_SOLL_FIX";
const RECALC_USER_AGENT = "script:recalculate-snapshots-after-shift-soll-fix";

// ── Exported types ──────────────────────────────────────────────────────────
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

// ── Usage block ─────────────────────────────────────────────────────────────
const USAGE = `Usage: tsx scripts/recalculate-snapshots-after-shift-soll-fix.ts \\
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
  - Scope: SHIFT_BASED employees only — other schedule types are unaffected.
  - Locked-month snapshots are listed in the dry-run summary but SKIPPED on --apply
    (Revisionssicherheit per CLAUDE.md "Immutability after lock").
  - Opening-balance bridge snapshots (carryOver set manually by operator) are preserved —
    their carryOver becomes the chain start for downstream snapshots.
  - Idempotent: re-running --apply on already-recalced snapshots writes zero new AuditLog rows.
  - Every recompute produces exactly one AuditLog row (action ${RECALC_ACTION}).
`;

// ── CLI parsing ─────────────────────────────────────────────────────────────
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

// ── Locked-month detection ──────────────────────────────────────────────────
/**
 * Determine whether a SaldoSnapshot is "locked" (= its month has been closed
 * and entries flipped to isLocked per CLAUDE.md "Immutability after lock").
 * SaldoSnapshot has no isLocked column; the canonical signal is at least one
 * TimeEntry in the period having isLocked: true.
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

// ── Bridge-snapshot detection (D-08 heuristic) ─────────────────────────────
/**
 * Returns true if the snapshot is an opening-balance bridge row.
 *
 * Heuristic (assumption A2 per RESEARCH.md): a bridge has all three work/expected/balance
 * fields zero but a non-zero carryOver — it was set by a human operator as a carry-in
 * value for a previously-untracked period and must NOT be overwritten or used as a
 * recalculation candidate.
 *
 * Limitation: a legitimate "no activity, zero carry" snapshot satisfies the same check
 * (carryOver==0) and is correctly excluded. A bridge row with non-zero activity is not
 * detectable by this heuristic — the operator must add a `bridgeSnapshot` column
 * (out of scope for this phase) for a more robust solution.
 */
function isBridgeSnapshot(snap: {
  expectedMinutes: number;
  workedMinutes: number;
  balanceMinutes: number;
  carryOver: number;
}): boolean {
  return (
    snap.expectedMinutes === 0 &&
    snap.workedMinutes === 0 &&
    snap.balanceMinutes === 0 &&
    snap.carryOver !== 0
  );
}

// ── hmToMin helper ──────────────────────────────────────────────────────────
function hmToMin(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

// ── Main entry point ────────────────────────────────────────────────────────
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

    // ── Resolve tenant list ──────────────────────────────────────────────
    const tenants = args.allTenants
      ? await prisma.tenant.findMany({ select: { id: true } })
      : [{ id: args.tenantId! }];
    summary.tenantsScanned = tenants.length;

    for (const t of tenants) {
      // WR-01: --year is timezone-dependent (see v1.8.4 script commentary).
      // Build the year window via monthRangeUtc using the tenant's TZ so that
      // UTC-offset periodStart values (e.g. 2025-12-31T23:00Z for Jan Berlin)
      // are correctly included/excluded.
      const tz = await getTenantTimezone(prisma, t.id);
      const yearStart = args.year ? monthRangeUtc(args.year, 1, tz).start : null;
      const yearEnd = args.year ? monthRangeUtc(args.year, 12, tz).end : null;

      // Load TenantConfig once per tenant (break policy + BS schedule).
      const tenantConfig = await prisma.tenantConfig.findUnique({
        where: { tenantId: t.id },
        select: {
          defaultBreakOver6h: true,
          defaultBreakOver9h: true,
          vocationalSchoolMinutesPerDay: true,
          vocationalSchoolBlockMinutesPerWeek: true,
        },
      });
      if (!tenantConfig) {
        console.warn(`[recalc] tenant ${t.id}: no TenantConfig — skipping.`);
        continue;
      }

      // Scope: SHIFT_BASED employees only (v1.8.9 pattern).
      // Employee has no deletedAt (DSGVO deletion = anonymization, not soft-delete).
      const employees = await prisma.employee.findMany({
        where: {
          tenantId: t.id,
          workSchedules: { some: { type: "SHIFT_BASED" } },
        },
        select: {
          id: true,
          hireDate: true,
          breakOver6hOverride: true,
          breakOver9hOverride: true,
        },
      });

      if (employees.length === 0) continue;

      for (const emp of employees) {
        // Snapshots in ascending period order so carry-over chains correctly.
        const snapshots = await prisma.saldoSnapshot.findMany({
          where: {
            employeeId: emp.id,
            periodType: "MONTHLY",
            superseded: false,
            ...(yearStart && yearEnd ? { periodStart: { gte: yearStart, lte: yearEnd } } : {}),
          },
          orderBy: [{ periodStart: "asc" }],
        });

        summary.snapshotsScanned += snapshots.length;

        // Determine running carry-over from the snapshot immediately before the
        // first one in scope (same chain strategy as v1.8.4 script).
        let priorCarry: number | undefined = undefined;

        if (snapshots.length > 0) {
          const prev = await prisma.saldoSnapshot.findFirst({
            where: {
              employeeId: emp.id,
              periodType: "MONTHLY",
              periodStart: { lt: snapshots[0].periodStart },
              superseded: false,
            },
            orderBy: { periodStart: "desc" },
          });
          priorCarry = prev?.carryOver ?? 0;
        }

        for (const snap of snapshots) {
          // WR-02: per-snapshot try/catch — a single failure does NOT abort the run.
          try {
            // ── D-08 BRIDGE-SNAPSHOT guard ───────────────────────────────
            // An opening-balance bridge is a human-set carryOver with zero
            // activity. Preserve it without overwriting and use its carryOver
            // as the chain start for subsequent snapshots.
            if (isBridgeSnapshot(snap)) {
              console.log(
                `[BRIDGE-SNAPSHOT] preserved — employeeId=${emp.id} ` +
                  `periodStart=${snap.periodStart.toISOString().slice(0, 10)} ` +
                  `carryOver=${snap.carryOver}`,
              );
              // Always chain the bridge's carryOver as the next priorCarry.
              priorCarry = snap.carryOver;
              continue;
            }

            // Ensure priorCarry is resolved even if the bridge guard above
            // never fired (edge case: first snapshot in the DB, no prev row).
            if (priorCarry === undefined) priorCarry = 0;

            const oldValues = {
              workedMinutes: snap.workedMinutes,
              expectedMinutes: snap.expectedMinutes,
              balanceMinutes: snap.balanceMinutes,
              carryOver: snap.carryOver,
            };

            // ── Resolve effective schedule (getEffectiveSchedule equivalent) ─
            // Find the WorkSchedule valid as of mid-month (same strategy as
            // auto-close-month.ts and recalculate-snapshots.ts).
            const midMonth = new Date((snap.periodStart.getTime() + snap.periodEnd.getTime()) / 2);
            const { start: monthStart, end: monthEnd } = monthRangeUtc(
              midMonth.getUTCFullYear(),
              midMonth.getUTCMonth() + 1,
              tz,
            );
            const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
              monthStart,
              monthEnd,
              tz,
            );

            const schedule = await prisma.workSchedule.findFirst({
              where: { employeeId: emp.id, validFrom: { lte: midMonth } },
              orderBy: { validFrom: "desc" },
            });
            // Skip if no SHIFT_BASED schedule found at this point in time.
            if (!schedule || String(schedule.type ?? "") !== "SHIFT_BASED") {
              // Not SHIFT_BASED at this period — leave unchanged.
              priorCarry = snap.carryOver;
              continue;
            }

            // ── Effective start: hire date or first day of month ─────────
            const hireDateNorm = emp.hireDate
              ? new Date(dateStrInTz(emp.hireDate, tz) + "T00:00:00Z")
              : null;
            const effectiveStart =
              hireDateNorm && hireDateNorm > monthFirstDay ? hireDateNorm : monthFirstDay;

            // ── Phase 1: Fetch leave + absences ─────────────────────────
            const approvedLeave = await prisma.leaveRequest.findMany({
              where: {
                employeeId: emp.id,
                deletedAt: null,
                status: "APPROVED",
                startDate: { lte: monthEnd },
                endDate: { gte: effectiveStart },
              },
            });
            const absences = await prisma.absence.findMany({
              where: {
                employeeId: emp.id,
                deletedAt: null,
                startDate: { lte: monthEnd },
                endDate: { gte: effectiveStart },
              },
            });

            // ── Build coveredDates (for R exclusion) ─────────────────────
            const coveredDates = new Set<string>();
            const addRange = (s: Date, e: Date) => {
              const cur = new Date(dateStrInTz(s, tz) + "T00:00:00Z");
              const end = new Date(dateStrInTz(e, tz) + "T00:00:00Z");
              while (cur <= end) {
                coveredDates.add(dateStrInTz(cur, tz));
                cur.setUTCDate(cur.getUTCDate() + 1);
              }
            };
            for (const lr of approvedLeave) {
              const s = lr.startDate < effectiveStart ? effectiveStart : lr.startDate;
              const e = lr.endDate > monthEnd ? monthEnd : lr.endDate;
              if (s <= e) addRange(s, e);
            }
            for (const ab of absences) {
              const s = ab.startDate < effectiveStart ? effectiveStart : ab.startDate;
              const e = ab.endDate > monthEnd ? monthEnd : ab.endDate;
              if (s <= e) addRange(s, e);
            }

            // ── Re-derive R (Σ netto active shifts, coveredDates excluded) ─
            const shifts = await prisma.shift.findMany({
              where: {
                employeeId: emp.id,
                date: { gte: effectiveStart, lte: monthLastDay },
                deletedAt: null,
              },
              select: { date: true, startTime: true, endTime: true },
            });
            const empBreakShape = {
              breakOver6hOverride: emp.breakOver6hOverride ?? null,
              breakOver9hOverride: emp.breakOver9hOverride ?? null,
            };
            const tenantBreakShape = {
              defaultBreakOver6h: tenantConfig.defaultBreakOver6h,
              defaultBreakOver9h: tenantConfig.defaultBreakOver9h,
            };
            let rosterMinutes = 0; // R
            for (const sh of shifts) {
              if (coveredDates.has(dateStrInTz(sh.date, tz))) continue;
              let brutto = hmToMin(sh.endTime) - hmToMin(sh.startTime);
              if (brutto < 0) brutto += 24 * 60; // cross-midnight
              if (brutto <= 0) continue;
              const breakMin = getEffectiveBreakDuration(empBreakShape, tenantBreakShape, brutto);
              rosterMinutes += Math.max(0, brutto - breakMin);
            }

            // ── Re-derive W (Σ TimeEntry netto) ─────────────────────────
            const entries = await prisma.timeEntry.findMany({
              where: {
                employeeId: emp.id,
                deletedAt: null,
                date: { gte: effectiveStart, lte: monthLastDay },
                endTime: { not: null },
                type: "WORK",
                isInvalid: false,
              },
            });
            const workedMinutes = entries.reduce((sum, e) => {
              if (!e.endTime) return sum;
              return (
                sum + (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes)
              );
            }, 0); // W

            // ── Re-derive C_net (contract Soll pre-BS) ──────────────────
            const contractSoll = calcExpectedMinutesTz(schedule, effectiveStart, monthEnd, tz);
            const leaveCredit = approvedLeave.reduce((sum, lr) => {
              const leaveStart = lr.startDate < effectiveStart ? effectiveStart : lr.startDate;
              const leaveEnd = lr.endDate > monthEnd ? monthEnd : lr.endDate;
              if (leaveStart > leaveEnd) return sum;
              return (
                sum +
                calcLeaveAbsenceMinutesTz(schedule, leaveStart, leaveEnd, tz, {
                  halfDay: Boolean(lr.halfDay),
                })
              );
            }, 0);
            const absenceCredit = absences.reduce((sum, ab) => {
              // VOCATIONAL_SCHOOL + PATTERN excluded from credit (Phase 76.22 D-06).
              if (ab.type === "VOCATIONAL_SCHOOL" || ab.source === "PATTERN") return sum;
              const absStart = ab.startDate < effectiveStart ? effectiveStart : ab.startDate;
              const absEnd = ab.endDate > monthEnd ? monthEnd : ab.endDate;
              if (absStart > absEnd) return sum;
              return sum + calcLeaveAbsenceMinutesTz(schedule, absStart, absEnd, tz);
            }, 0);
            const cNetPreBS = Math.max(0, contractSoll - leaveCredit - absenceCredit);

            // ── Phase 2: BS (Berufsschule) doubling (Phase 63 parity) ───
            // VOCATIONAL_SCHOOL absences are doubled: the day's target is added
            // to both expected (C_net) and worked (W) to keep the balance neutral.
            const bsAbsences = await prisma.absence.findMany({
              where: {
                employeeId: emp.id,
                deletedAt: null,
                type: "VOCATIONAL_SCHOOL",
                startDate: { lte: monthEnd },
                endDate: { gte: effectiveStart },
              },
            });
            let bsWorkedMinutes = 0;
            let bsExpectedMinutes = 0;
            for (const ab of bsAbsences) {
              const start = ab.startDate < effectiveStart ? effectiveStart : ab.startDate;
              const end = ab.endDate > monthEnd ? monthEnd : ab.endDate;
              const cur = new Date(start);
              while (cur <= end) {
                const bsMin = await getVocationalSchoolMinutesForDate(
                  prisma,
                  emp.id,
                  cur,
                  tenantConfig as VocationalSchoolTenantConfig,
                );
                bsWorkedMinutes += bsMin;
                bsExpectedMinutes += bsMin;
                cur.setUTCDate(cur.getUTCDate() + 1);
              }
            }

            const finalCNet = cNetPreBS + bsExpectedMinutes;

            // ── D-01 Model B + § 615 formula ────────────────────────────
            const sbResult = calcShiftBasedSaldo({
              contractSollMinutes: finalCNet,
              rosterMinutes,
              workedMinutes,
            });
            const newExpected = sbResult.expectedMinutes; // = finalCNet (stored C, not R)
            const newBalance = Math.round(sbResult.balanceDelta + bsWorkedMinutes);
            const newCarry = priorCarry + newBalance;

            // ── Noop detection (idempotency) ─────────────────────────────
            // Compares all 4 numeric fields. If the stored values already reflect
            // Model B (e.g. script has already run), write nothing.
            const newWorked = Math.round(workedMinutes + bsWorkedMinutes);
            const noop =
              newWorked === oldValues.workedMinutes &&
              newExpected === oldValues.expectedMinutes &&
              newBalance === oldValues.balanceMinutes &&
              newCarry === oldValues.carryOver;

            // Chain carry-over regardless of noop/locked/dryrun (after all guards).
            // Will be overwritten below if the row is processed.

            if (noop) {
              summary.unchanged++;
              priorCarry = snap.carryOver; // chain from stored value (identical)
              continue;
            }

            // ── Locked-month guard (D-18 / Revisionssicherheit) ─────────
            const locked = await isSnapshotLocked(prisma, emp.id, snap.periodStart, snap.periodEnd);
            if (locked) {
              summary.skippedLocked.push({
                snapshotId: snap.id,
                employeeId: emp.id,
                tenantId: t.id,
                periodStart: snap.periodStart,
                deltaBalanceMinutes: newBalance - oldValues.balanceMinutes,
              });
              // Chain from STORED value (we cannot update it).
              priorCarry = snap.carryOver;
              continue;
            }

            if (!args.apply) {
              // Dry-run: count proposed change but write nothing.
              console.log(
                `[DRY-RUN] ${snap.periodStart.toISOString().slice(0, 10)} ` +
                  `employeeId=${emp.id} ` +
                  `expected=${oldValues.expectedMinutes}→${newExpected} ` +
                  `balance=${oldValues.balanceMinutes}→${newBalance} ` +
                  `carry=${oldValues.carryOver}→${newCarry}`,
              );
              summary.recalculated++;
              priorCarry = newCarry; // project the chain forward in dry-run
              continue;
            }

            // ── --apply: atomic $transaction (SaldoSnapshot.update + AuditLog.create) ─
            await prisma.$transaction(async (tx) => {
              await tx.saldoSnapshot.update({
                where: { id: snap.id },
                data: {
                  workedMinutes: newWorked,
                  expectedMinutes: newExpected,
                  balanceMinutes: newBalance,
                  carryOver: newCarry,
                },
              });
              await tx.auditLog.create({
                data: {
                  userId: null, // system-initiated (no human actor)
                  action: RECALC_ACTION,
                  entity: "SaldoSnapshot",
                  entityId: snap.id,
                  oldValue: oldValues,
                  newValue: {
                    workedMinutes: newWorked,
                    expectedMinutes: newExpected,
                    balanceMinutes: newBalance,
                    carryOver: newCarry,
                    reason: RECALC_REASON,
                  },
                  ipAddress: null,
                  userAgent: RECALC_USER_AGENT,
                },
              });
            });
            summary.recalculated++;
            priorCarry = newCarry;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            summary.errors.push({
              snapshotId: snap.id,
              employeeId: emp.id,
              tenantId: t.id,
              error: message,
            });
            console.error(`[recalc] snapshot ${snap.id} failed: ${message}`);
            // Chain from stored value to avoid corrupting the downstream chain.
            if (priorCarry === undefined) priorCarry = snap.carryOver;
          }
        } // end snapshot loop
      } // end employee loop
    } // end tenant loop

    console.log(JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    if (ownsPrisma) {
      await prisma.$disconnect();
    }
  }
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────
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
