/**
 * Migration artifact — committed 2026-06-08 for audit trail.
 * One-off operator script used during the 2026-06-08 prod saldo investigation.
 * NOT part of the production code path. Invocation requires explicit argv.
 * Related phase: 76.5 (see .planning/phases/76.5-shifts-saldo-trigger-fix/).
 *
 * One-off: set the opening saldo carryOver from the old time-tracking system
 * onto the pre-tracking reset snapshot for ONE employee. updateOvertimeAccount
 * adds this to the open-period balance for the live
 * OvertimeAccount.balanceHours.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
 *     scripts/set-opening-balance.ts \
 *     --employee-id <uuid> \
 *     --balance <hours-decimal> \
 *     --actor-id <uuid> \
 *     --cutoff <YYYY-MM-DD> \
 *     [--apply]
 *
 *   --balance is decimal hours (e.g. "10" for +10h, "8.5" for +8h30min,
 *     negative values supported, e.g. "-3.25").
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
    "employee-id": { type: "string" },
    balance: { type: "string" },
    "actor-id": { type: "string" },
    cutoff: { type: "string" },
    apply: { type: "boolean", default: false },
  },
});

const employeeId = values["employee-id"];
const balanceArg = values["balance"];
const actorId = values["actor-id"];
const cutoffArg = values["cutoff"];
const APPLY = values["apply"] ?? false;

const balanceHours = balanceArg !== undefined ? Number(balanceArg) : NaN;

if (
  !employeeId ||
  !actorId ||
  !cutoffArg ||
  !/^\d{4}-\d{2}-\d{2}$/.test(cutoffArg) ||
  Number.isNaN(balanceHours)
) {
  console.error(
    "Usage: tsx scripts/set-opening-balance.ts " +
      "--employee-id <uuid> --balance <hours> --actor-id <uuid> " +
      "--cutoff <YYYY-MM-DD> [--apply]",
  );
  process.exit(1);
}

const CUTOFF = new Date(cutoffArg + "T00:00:00Z");
const balanceMinutes = Math.round(balanceHours * 60);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adapter = new PrismaPg(pool as any);
const prisma = new PrismaClient({ adapter });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const appShim: any = {
  prisma,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log: { warn: (...a: any[]) => console.warn(...a), info: (...a: any[]) => console.info(...a) },
};

async function main() {
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}\n`);

  const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!emp) {
    console.error(`Employee not found: ${employeeId}`);
    process.exit(1);
  }

  // Latest snapshot before the cutoff
  const snap = await prisma.saldoSnapshot.findFirst({
    where: {
      employeeId,
      periodType: "MONTHLY",
      periodEnd: { lte: CUTOFF },
    },
    orderBy: { periodStart: "desc" },
  });
  if (!snap) {
    console.error(`No pre-cutoff snapshot for employee ${employeeId}`);
    process.exit(1);
  }

  const oldCarry = snap.carryOver;
  console.log(
    `${emp.firstName} ${emp.lastName}: snapshot ` +
      `${snap.periodStart.toISOString().slice(0, 10)}..${snap.periodEnd.toISOString().slice(0, 10)} ` +
      `carryOver ${oldCarry} -> ${balanceMinutes} (${balanceHours}h)`,
  );

  if (!APPLY) {
    console.log(`\nDry-run done. Re-run with --apply to write changes.`);
    return;
  }

  // Apply in a transaction
  await prisma.$transaction(async (tx) => {
    await tx.auditLog.create({
      data: {
        userId: actorId,
        action: "UPDATE",
        entity: "SaldoSnapshot",
        entityId: snap.id,
        oldValue: { carryOver: oldCarry },
        newValue: {
          carryOver: balanceMinutes,
          reason: "opening balance from old time-tracking system",
        },
      },
    });
    await tx.saldoSnapshot.update({
      where: { id: snap.id },
      data: { carryOver: balanceMinutes },
    });
  });

  console.log(`\nDone: snapshot updated.`);

  // Recompute live balance
  console.log(`\nRecomputing live balance:`);
  const prev = await prisma.overtimeAccount.findUnique({ where: { employeeId } });
  const prevBal = Number(prev?.balanceHours ?? 0);

  await updateOvertimeAccount(appShim, employeeId);

  const after = await prisma.overtimeAccount.findUnique({ where: { employeeId } });
  const newBal = Number(after?.balanceHours ?? 0);

  await prisma.auditLog.create({
    data: {
      userId: actorId,
      action: "UPDATE",
      entity: "OvertimeAccount",
      entityId: employeeId,
      oldValue: { balanceHours: prevBal },
      newValue: {
        balanceHours: newBal,
        reason: "recomputed after opening-balance set",
      },
    },
  });

  console.log(`  ${emp.firstName} ${emp.lastName}: ${prevBal}h -> ${newBal}h`);

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
