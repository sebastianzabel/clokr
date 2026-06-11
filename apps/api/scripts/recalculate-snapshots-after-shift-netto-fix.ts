/**
 * Migration artifact — committed 2026-06-11 for audit trail.
 * Operator script for the v1.8.9 SHIFT_BASED netto-saldo retro-fix.
 * NOT part of the production code path. Invocation requires explicit argv.
 * Related quick task: 260611-gap (see .planning/quick/).
 *
 * v1.8.9 fixed brutto/netto mismatch in SHIFT_BASED saldo calculation
 * (apps/api/src/routes/time-entries.ts updateOvertimeAccount +
 *  apps/api/src/routes/overtime.ts close-month).
 * Already-stored SaldoSnapshots created by Monatsabschluss before v1.8.9
 * deploy still hold the brutto-bias expectedMinutes. This script re-runs the
 * now-netto math against each closed SHIFT_BASED snapshot and updates the
 * persisted numbers.
 *
 * Invariants (mirrors recalculate-snapshots-after-soll-fix.ts):
 *   - NEVER hard-deletes rows (Revisionssicherheit per CLAUDE.md)
 *   - NEVER writes to locked-month snapshots on --apply. Locked rows appear in
 *     summary.skippedLocked for operator review. Force-recalc of locked months
 *     would require a separate phase + tenant approval.
 *   - Idempotent: re-running --apply on already-recalced snapshots writes zero
 *     new AuditLog rows (noop detection compares all 4 numeric fields).
 *   - Soft-delete: queries the `superseded: false` SaldoSnapshot pool only.
 *   - Scope: ONLY SHIFT_BASED employees. Other schedule types are unaffected
 *     by v1.8.9 and SKIPPED.
 *   - PII-CLEAN: no hardcoded employee/tenant UUIDs. All identity is argv-driven.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
 *     scripts/recalculate-snapshots-after-shift-netto-fix.ts \
 *     ( --tenant-id <uuid> | --all-tenants ) \
 *     --actor-id <uuid> \
 *     [--year YYYY] \
 *     [--apply]
 *
 * Without --apply: dry-run. With --apply: $transaction per recalc.
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import {
  getEffectiveBreakDuration,
  type BreakEmployeeShape,
  type BreakTenantConfigShape,
} from "../src/utils/break-effective";

const RECALC_REASON = "v1.8.9 SHIFT_BASED netto migration (brutto - getEffectiveBreakDuration)";
const RECALC_ACTION = "SALDO_RECALC_AFTER_SHIFT_NETTO_FIX";
const RECALC_USER_AGENT = "script:recalculate-snapshots-after-shift-netto-fix";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

type CliArgs = {
  tenantId: string | null;
  allTenants: boolean;
  actorId: string;
  year: number | null;
  apply: boolean;
};

function parseCliArgs(): CliArgs {
  const { values } = parseArgs({
    options: {
      "tenant-id": { type: "string" },
      "all-tenants": { type: "boolean", default: false },
      "actor-id": { type: "string" },
      year: { type: "string" },
      apply: { type: "boolean", default: false },
    },
  });
  if (!values["actor-id"]) {
    console.error("Required: --actor-id <uuid>");
    process.exit(1);
  }
  if (!values["tenant-id"] && !values["all-tenants"]) {
    console.error("Required: --tenant-id <uuid> OR --all-tenants");
    process.exit(1);
  }
  const yearStr = values["year"];
  let year: number | null = null;
  if (yearStr !== undefined) {
    const n = Number(yearStr);
    if (!Number.isInteger(n) || n < 1970 || n > 9999) {
      console.error(`--year must be 4-digit year (got: ${yearStr})`);
      process.exit(1);
    }
    year = n;
  }
  return {
    tenantId: values["tenant-id"] ?? null,
    allTenants: Boolean(values["all-tenants"]),
    actorId: values["actor-id"]!,
    year,
    apply: Boolean(values["apply"]),
  };
}

function hmToMin(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

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

async function main() {
  const args = parseCliArgs();
  console.log(`Mode: ${args.apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Scope: ${args.allTenants ? "ALL TENANTS" : `tenant=${args.tenantId}`}`);
  if (args.year) console.log(`Year filter: ${args.year}`);
  console.log("");

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter = new PrismaPg(pool as any);
  const prisma = new PrismaClient({ adapter });

  try {
    const actor = await prisma.user.findUnique({ where: { id: args.actorId } });
    if (!actor) {
      console.error(`Actor user not found: ${args.actorId}`);
      process.exit(1);
    }

    const tenants = args.allTenants
      ? await prisma.tenant.findMany({ select: { id: true } })
      : [{ id: args.tenantId! }];

    const summary = {
      tenantsScanned: tenants.length,
      employeesScanned: 0,
      snapshotsScanned: 0,
      recalculated: 0,
      unchanged: 0,
      skippedLocked: [] as Array<{ snapshotId: string; periodStart: string; delta: number }>,
      errors: [] as Array<{ snapshotId: string; error: string }>,
    };

    for (const t of tenants) {
      // Find all SHIFT_BASED employees with closed monthly snapshots in this tenant.
      const employees = await prisma.employee.findMany({
        where: {
          tenantId: t.id,
          workSchedules: { some: { type: "SHIFT_BASED" } },
        },
        select: {
          id: true,
          breakOver6hOverride: true,
          breakOver9hOverride: true,
        },
      });
      summary.employeesScanned += employees.length;
      if (employees.length === 0) continue;

      // TenantConfig once per tenant.
      const tenantConfig = await prisma.tenantConfig.findUnique({
        where: { tenantId: t.id },
        select: { defaultBreakOver6h: true, defaultBreakOver9h: true },
      });
      if (!tenantConfig) {
        console.warn(`Tenant ${t.id}: no TenantConfig — skipping.`);
        continue;
      }
      const tenantShape: BreakTenantConfigShape = {
        defaultBreakOver6h: tenantConfig.defaultBreakOver6h,
        defaultBreakOver9h: tenantConfig.defaultBreakOver9h,
      };

      for (const emp of employees) {
        const empShape: BreakEmployeeShape = {
          breakOver6hOverride: emp.breakOver6hOverride,
          breakOver9hOverride: emp.breakOver9hOverride,
        };

        // Read MONTHLY snapshots, earliest first.
        const snapshots = await prisma.saldoSnapshot.findMany({
          where: {
            employeeId: emp.id,
            periodType: "MONTHLY",
            superseded: false,
            ...(args.year
              ? {
                  periodStart: {
                    gte: new Date(`${args.year}-01-01T00:00:00Z`),
                    lte: new Date(`${args.year}-12-31T23:59:59Z`),
                  },
                }
              : {}),
          },
          orderBy: { periodStart: "asc" },
        });

        summary.snapshotsScanned += snapshots.length;

        // Resolve prior carryOver from the snapshot immediately before the earliest in scope.
        let priorCarry = 0;
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
          try {
            // Re-compute SHIFT_BASED expectedMinutes for this snapshot's period:
            // sum netto over all non-deleted Shifts in [periodStart, periodEnd].
            const shifts = await prisma.shift.findMany({
              where: {
                employeeId: emp.id,
                deletedAt: null,
                date: { gte: snap.periodStart, lte: snap.periodEnd },
              },
              select: { startTime: true, endTime: true },
            });

            let newExpected = 0;
            for (const s of shifts) {
              let brutto = hmToMin(s.endTime) - hmToMin(s.startTime);
              if (brutto < 0) brutto += 1440; // cross-midnight
              if (brutto <= 0) continue;
              const breakMin = getEffectiveBreakDuration(empShape, tenantShape, brutto);
              const netto = Math.max(0, brutto - breakMin);
              newExpected += netto;
            }

            const newBalanceMin = snap.workedMinutes - newExpected;
            const newCarry = priorCarry + newBalanceMin;

            const noop =
              newExpected === snap.expectedMinutes &&
              newBalanceMin === snap.balanceMinutes &&
              newCarry === snap.carryOver;

            // Chain priorCarry for the next iteration regardless of whether we write.
            priorCarry = newCarry;

            if (noop) {
              summary.unchanged++;
              continue;
            }

            const locked = await isSnapshotLocked(prisma, emp.id, snap.periodStart, snap.periodEnd);
            if (locked) {
              summary.skippedLocked.push({
                snapshotId: snap.id,
                periodStart: snap.periodStart.toISOString().slice(0, 10),
                delta: newBalanceMin - snap.balanceMinutes,
              });
              continue;
            }

            console.log(
              `  ${snap.periodStart.toISOString().slice(0, 10)} ` +
                `expected=${snap.expectedMinutes}→${newExpected} ` +
                `balance=${snap.balanceMinutes}→${newBalanceMin} ` +
                `carry=${snap.carryOver}→${newCarry}`,
            );

            summary.recalculated++;

            if (!args.apply) continue;

            await prisma.$transaction(async (tx) => {
              await tx.auditLog.create({
                data: {
                  userId: args.actorId,
                  action: RECALC_ACTION,
                  entity: "SaldoSnapshot",
                  entityId: snap.id,
                  oldValue: {
                    workedMinutes: snap.workedMinutes,
                    expectedMinutes: snap.expectedMinutes,
                    balanceMinutes: snap.balanceMinutes,
                    carryOver: snap.carryOver,
                  },
                  newValue: {
                    workedMinutes: snap.workedMinutes,
                    expectedMinutes: newExpected,
                    balanceMinutes: newBalanceMin,
                    carryOver: newCarry,
                    reason: RECALC_REASON,
                  },
                  userAgent: RECALC_USER_AGENT,
                },
              });
              await tx.saldoSnapshot.update({
                where: { id: snap.id },
                data: {
                  expectedMinutes: newExpected,
                  balanceMinutes: newBalanceMin,
                  carryOver: newCarry,
                },
              });
            });
          } catch (err) {
            summary.errors.push({
              snapshotId: snap.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    console.log("\n=== Summary ===");
    console.log(JSON.stringify(summary, null, 2));

    if (!args.apply) {
      console.log("\nDry-run done. Re-run with --apply to write changes.");
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
