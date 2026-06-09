/**
 * Migration artifact — committed 2026-06-08 for audit trail.
 * One-off operator script used during the 2026-06-08 prod saldo investigation.
 * NOT part of the production code path. Invocation requires explicit argv.
 * Related phase: 76.5 (see .planning/phases/76.5-shifts-saldo-trigger-fix/).
 *
 * One-off data fix: zero out bogus pre-tracking reset snapshots.
 *
 * Background: a reset script was run to neutralize the pre-tracking phase
 * for employees imported with hireDate=2026-01-01. That script left
 * non-zero worked/expected/balance/carryOver on some snapshots, which
 * leaked into the live OvertimeAccount via snapshotCarryOver.
 *
 * What this script does (single transaction):
 *  1. Find every SaldoSnapshot with periodEnd <= --cutoff that has a
 *     non-zero value AND the employee is NOT in --keep-first-names.
 *  2. Write an AuditLog row (UPDATE, oldValue=current numbers) per snapshot
 *     under --actor-id.
 *  3. UPDATE the snapshots to all zeros.
 *  4. Recompute OvertimeAccount.balanceHours by calling the real
 *     `updateOvertimeAccount` from time-entries.ts with a minimal app shim,
 *     so all schedule types get the same math the live punch path uses.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
 *     scripts/fix-bogus-reset-snapshots.ts \
 *     --actor-id <uuid> \
 *     --cutoff 2026-05-27 \
 *     [--keep-first-names "First1,First2"] \
 *     [--apply]
 *
 * Without --apply: dry-run, prints what WOULD change.
 * With    --apply: writes inside a single transaction.
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { updateOvertimeAccount } from "../src/routes/time-entries";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    "actor-id": { type: "string" },
    cutoff: { type: "string" },
    "keep-first-names": { type: "string" },
    apply: { type: "boolean", default: false },
  },
});

const actorId = values["actor-id"];
const cutoffArg = values["cutoff"];
const keepFirstNames = (values["keep-first-names"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const APPLY = values["apply"] ?? false;

if (!actorId || !cutoffArg || !/^\d{4}-\d{2}-\d{2}$/.test(cutoffArg)) {
  console.error(
    "Usage: tsx scripts/fix-bogus-reset-snapshots.ts --actor-id <uuid> --cutoff <YYYY-MM-DD> " +
      '[--keep-first-names "First1,First2"] [--apply]',
  );
  process.exit(1);
}

const CUTOFF = new Date(cutoffArg + "T00:00:00Z");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adapter = new PrismaPg(pool as any);
const prisma = new PrismaClient({ adapter });

// Minimal FastifyInstance shim for updateOvertimeAccount — it only touches
// app.prisma and app.log.warn (no audit() calls in the recalc path).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const appShim: any = {
  prisma,
  log: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    warn: (...args: any[]) => console.warn(...args),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    info: (...args: any[]) => console.info(...args),
  },
};

async function main() {
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`Cutoff: snapshots with periodEnd <= ${CUTOFF.toISOString()}`);
  console.log(
    `Keep first-names (skipped): ${keepFirstNames.length ? keepFirstNames.join(", ") : "(none)"}\n`,
  );

  const keepClause = keepFirstNames.length
    ? `AND e."firstName" NOT IN (${keepFirstNames.map((n) => `'${n.replace(/'/g, "''")}'`).join(",")})`
    : "";

  const bogus = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      employeeId: string;
      firstName: string;
      lastName: string;
      periodStart: Date;
      periodEnd: Date;
      workedMinutes: number;
      expectedMinutes: number;
      balanceMinutes: number;
      carryOver: number;
      scheduleType: string | null;
    }>
  >(
    `
    SELECT s.id, s."employeeId", e."firstName", e."lastName",
           s."periodStart", s."periodEnd",
           s."workedMinutes", s."expectedMinutes",
           s."balanceMinutes", s."carryOver",
           (SELECT type::text FROM "WorkSchedule"
             WHERE "employeeId" = e.id AND "validFrom" <= NOW()
             ORDER BY "validFrom" DESC LIMIT 1) AS "scheduleType"
    FROM "SaldoSnapshot" s
    JOIN "Employee" e ON e.id = s."employeeId"
    WHERE s."periodEnd" <= $1
      AND (s."workedMinutes" != 0 OR s."expectedMinutes" != 0
           OR s."balanceMinutes" != 0 OR s."carryOver" != 0)
      ${keepClause}
    ORDER BY e."lastName", s."periodStart"
  `,
    CUTOFF,
  );

  if (bogus.length === 0) {
    console.log("Nothing to fix.");
    return;
  }

  console.log(`Snapshots to fix: ${bogus.length}`);
  for (const b of bogus) {
    console.log(
      `  ${b.firstName} ${b.lastName} (${b.scheduleType}) ` +
        `${b.periodStart.toISOString().slice(0, 10)}..${b.periodEnd.toISOString().slice(0, 10)} ` +
        `worked=${b.workedMinutes} expected=${b.expectedMinutes} ` +
        `balance=${b.balanceMinutes} carryOver=${b.carryOver}`,
    );
  }

  const affectedEmployeeIds = [...new Set(bogus.map((b) => b.employeeId))];

  if (!APPLY) {
    console.log(`\nDry-run done. Re-run with --apply to write changes.`);
    return;
  }

  // ── Apply ─────────────────────────────────────────────────────────────────
  await prisma.$transaction(async (tx) => {
    // AuditLog rows
    for (const b of bogus) {
      await tx.auditLog.create({
        data: {
          userId: actorId,
          action: "UPDATE",
          entity: "SaldoSnapshot",
          entityId: b.id,
          oldValue: {
            workedMinutes: b.workedMinutes,
            expectedMinutes: b.expectedMinutes,
            balanceMinutes: b.balanceMinutes,
            carryOver: b.carryOver,
          },
          newValue: {
            workedMinutes: 0,
            expectedMinutes: 0,
            balanceMinutes: 0,
            carryOver: 0,
            reason:
              "bulk fix: bogus pre-tracking reset snapshots leaking carryOver into live saldo",
          },
        },
      });
    }

    // Zero the snapshots
    await tx.saldoSnapshot.updateMany({
      where: { id: { in: bogus.map((b) => b.id) } },
      data: { workedMinutes: 0, expectedMinutes: 0, balanceMinutes: 0, carryOver: 0 },
    });
  });

  console.log(`\nDone: ${bogus.length} snapshots zeroed.`);

  // Recompute OvertimeAccount.balanceHours by calling the real
  // updateOvertimeAccount — same code path as a real punch/edit.
  console.log(`\nRecomputing live balances via updateOvertimeAccount:`);
  for (const empId of affectedEmployeeIds) {
    const emp = await prisma.employee.findUnique({ where: { id: empId } });
    const prev = await prisma.overtimeAccount.findUnique({ where: { employeeId: empId } });
    const prevBal = Number(prev?.balanceHours ?? 0);

    await updateOvertimeAccount(appShim, empId);

    const after = await prisma.overtimeAccount.findUnique({ where: { employeeId: empId } });
    const newBal = Number(after?.balanceHours ?? 0);

    await prisma.auditLog.create({
      data: {
        userId: actorId,
        action: "UPDATE",
        entity: "OvertimeAccount",
        entityId: empId,
        oldValue: { balanceHours: prevBal },
        newValue: {
          balanceHours: newBal,
          reason: "recomputed after bulk snapshot-fix via updateOvertimeAccount",
        },
      },
    });

    console.log(`  ${emp?.firstName} ${emp?.lastName}: ${prevBal}h -> ${newBal}h`);
  }

  console.log("\nDone.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
