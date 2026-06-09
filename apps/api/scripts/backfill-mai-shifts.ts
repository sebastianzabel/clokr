/**
 * Migration artifact — committed 2026-06-08 for audit trail.
 * One-off operator script used during the 2026-06-08 prod saldo investigation.
 * NOT part of the production code path. Invocation requires explicit argv.
 * Related phase: 76.5 (see .planning/phases/76.5-shifts-saldo-trigger-fix/).
 *
 * One-off backfill: insert a small set of past shifts for ONE employee from
 * a JSON spec file, mirroring the existing weekly pattern. UI cannot create
 * past-dated shifts (Phase 47.2 SHIFT_PAST_IMMUTABLE); this script does it
 * directly via Prisma with full audit.
 *
 * The JSON spec file shape (array, all fields required):
 *   [
 *     { "date": "2026-05-26", "startTime": "09:45", "endTime": "20:00", "label": "Spätschicht" },
 *     ...
 *   ]
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
 *     scripts/backfill-mai-shifts.ts \
 *     --employee-id <uuid> \
 *     --actor-id <uuid> \
 *     --spec ./shifts.json \
 *     [--apply]
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { updateOvertimeAccount } from "../src/routes/time-entries";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    "employee-id": { type: "string" },
    "actor-id": { type: "string" },
    spec: { type: "string" },
    apply: { type: "boolean", default: false },
  },
});

const employeeId = values["employee-id"];
const actorId = values["actor-id"];
const specPath = values["spec"];
const APPLY = values["apply"] ?? false;

if (!employeeId || !actorId || !specPath) {
  console.error(
    "Usage: tsx scripts/backfill-mai-shifts.ts " +
      "--employee-id <uuid> --actor-id <uuid> --spec <path-to-json> [--apply]",
  );
  process.exit(1);
}

type ShiftSpec = {
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM
  endTime: string;
  label: string;
};

let SHIFTS: ShiftSpec[];
try {
  SHIFTS = JSON.parse(readFileSync(specPath, "utf8"));
  if (!Array.isArray(SHIFTS)) throw new Error("spec is not a JSON array");
  for (const s of SHIFTS) {
    if (!s.date || !s.startTime || !s.endTime || s.label === undefined) {
      throw new Error(
        `spec entry missing required field: ${JSON.stringify(s)} (need date, startTime, endTime, label)`,
      );
    }
  }
} catch (err) {
  console.error("Failed to load spec:", err);
  process.exit(1);
}

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

  // Resolve the target employee
  const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!emp) {
    console.error(`Employee not found: ${employeeId}`);
    process.exit(1);
  }

  // Pre-flight: detect any existing shifts on these dates
  console.log(`Target employee: ${emp.firstName} ${emp.lastName} (${employeeId})`);
  console.log("Checking for existing shifts on target dates...");
  const conflicts: ShiftSpec[] = [];
  for (const r of SHIFTS) {
    const existing = await prisma.shift.findFirst({
      where: {
        employeeId,
        date: new Date(r.date + "T00:00:00Z"),
        deletedAt: null,
      },
    });
    if (existing) {
      conflicts.push(r);
      console.log(
        `  CONFLICT  ${r.date} already has shift ${existing.startTime}-${existing.endTime}`,
      );
    }
  }
  if (conflicts.length > 0) {
    console.error(`\nAbort: ${conflicts.length} existing shifts would be duplicated.`);
    process.exit(1);
  }
  console.log("OK - no existing shifts on target dates.\n");

  // List what we'll insert
  console.log("Shifts to insert:");
  for (const r of SHIFTS) {
    console.log(`  ${r.date} ${r.startTime}-${r.endTime} ${r.label}`);
  }

  if (!APPLY) {
    console.log(`\nDry-run done. Re-run with --apply to write changes.`);
    return;
  }

  // Insert + audit in a single transaction
  const created = await prisma.$transaction(async (tx) => {
    const rows = [];
    for (const r of SHIFTS) {
      const shift = await tx.shift.create({
        data: {
          employeeId,
          date: new Date(r.date + "T00:00:00Z"),
          startTime: r.startTime,
          endTime: r.endTime,
          label: r.label,
          createdBy: actorId,
        },
      });
      await tx.auditLog.create({
        data: {
          userId: actorId,
          action: "CREATE",
          entity: "Shift",
          entityId: shift.id,
          newValue: {
            ...shift,
            reason: "backfill: past-dated shifts (UI cannot create past-dated shifts)",
          },
        },
      });
      rows.push(shift);
    }
    return rows;
  });

  console.log(`\nDone: ${created.length} shifts inserted.`);

  // Recompute saldo for the affected employee
  console.log(`\nRecomputing balance:`);
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
        reason: "recomputed after shift backfill",
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
