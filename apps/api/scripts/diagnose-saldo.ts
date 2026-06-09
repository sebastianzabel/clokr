/**
 * Migration artifact — committed 2026-06-08 for audit trail.
 * One-off operator script used during the 2026-06-08 prod saldo investigation.
 * NOT part of the production code path. Invocation requires explicit argv.
 * Related phase: 76.5 (see .planning/phases/76.5-shifts-saldo-trigger-fix/).
 *
 * Read-only diagnostic: prints every input that `updateOvertimeAccount`
 * consumes for ONE employee, so we can see *why* a Live-Saldo value is what
 * it is.
 *
 * Read-only. ZERO mutations.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
 *     scripts/diagnose-saldo.ts --employee-id <uuid>
 *
 * Tip: get the employeeId from psql via the Employee table.
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    "employee-id": { type: "string" },
  },
});
const employeeId = values["employee-id"];
if (!employeeId) {
  console.error("Usage: tsx scripts/diagnose-saldo.ts --employee-id <uuid>");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adapter = new PrismaPg(pool as any);
const prisma = new PrismaClient({ adapter });

const TZ = "Europe/Berlin";

function fmt(d: Date | null | undefined): string {
  if (!d) return "(null)";
  return d.toISOString();
}

async function main() {
  const emp = await prisma.employee.findUnique({
    where: { id: employeeId },
    include: {
      tenant: { select: { id: true, name: true, timezone: true } },
      workSchedules: { orderBy: { validFrom: "desc" } },
    },
  });
  if (!emp) {
    console.error("Employee not found");
    process.exit(1);
  }

  console.log("\n=== EMPLOYEE ===");
  console.log(`id=${emp.id}`);
  console.log(`hireDate=${fmt(emp.hireDate)}  exitDate=${fmt(emp.exitDate)}`);
  console.log(`tenant=${emp.tenant.name} tz=${emp.tenant.timezone ?? TZ}`);

  console.log("\n=== WORK SCHEDULES (most recent first) ===");
  for (const s of emp.workSchedules) {
    console.log(
      `[${fmt(s.validFrom)}] type=${s.type} weekly=${s.weeklyHours} monthly=${s.monthlyHours} ` +
        `workDays=[${s.workDays}] ` +
        `Mo=${s.mondayHours} Di=${s.tuesdayHours} Mi=${s.wednesdayHours} Do=${s.thursdayHours} ` +
        `Fr=${s.fridayHours} Sa=${s.saturdayHours} So=${s.sundayHours} ` +
        `overtimeMode=${s.overtimeMode}`,
    );
  }

  const effectiveSchedule = emp.workSchedules.find((s) => s.validFrom <= new Date());
  console.log(`\nEFFECTIVE SCHEDULE TODAY: type=${effectiveSchedule?.type ?? "(none)"}`);

  console.log("\n=== SNAPSHOTS (most recent first) ===");
  const snaps = await prisma.saldoSnapshot.findMany({
    where: { employeeId },
    orderBy: { periodStart: "desc" },
    take: 6,
  });
  for (const s of snaps) {
    console.log(
      `[${fmt(s.periodStart)} .. ${fmt(s.periodEnd)}] ${s.periodType} ` +
        `worked=${s.workedMinutes}min expected=${s.expectedMinutes}min ` +
        `balance=${s.balanceMinutes}min carryOver=${s.carryOver}min`,
    );
  }
  if (snaps.length === 0)
    console.log("(no snapshots — current month is open, Live-Saldo starts from month-1)");

  console.log("\n=== OVERTIME ACCOUNT (the stored value the dashboard shows) ===");
  const acct = await prisma.overtimeAccount.findUnique({ where: { employeeId } });
  console.log(`balanceHours=${acct?.balanceHours ?? "(none)"} updatedAt=${fmt(acct?.updatedAt)}`);

  // ── Reproduce rangeStart computation from updateOvertimeAccount ─────────────
  const now = new Date();
  const lastSnap = snaps[0];
  let rangeStart: Date;
  if (lastSnap) {
    rangeStart = new Date(lastSnap.periodEnd.getTime() + 86400000);
    console.log(`\nrangeStart from snapshot+1d = ${fmt(rangeStart)}`);
  } else {
    // monthStart in tz → UTC (simplified, Berlin = UTC+1/+2)
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth(); // 0-based
    const monthStartLocal = new Date(Date.UTC(y, m, 1, 0, 0, 0));
    // crude: subtract 2h for summer Berlin → UTC
    rangeStart = new Date(monthStartLocal.getTime() - 2 * 3600 * 1000);
    const hireNorm = emp.hireDate;
    if (hireNorm && hireNorm > rangeStart) rangeStart = hireNorm;
    console.log(`\nrangeStart from monthStart/hireDate = ${fmt(rangeStart)}`);
  }

  console.log("\n=== TIME ENTRIES in [rangeStart .. today] (these feed worked-minutes) ===");
  const entries = await prisma.timeEntry.findMany({
    where: {
      employeeId,
      deletedAt: null,
      type: "WORK",
      date: { gte: rangeStart },
    },
    orderBy: { date: "asc" },
    include: { breaks: true },
  });
  let totalWorked = 0;
  for (const e of entries) {
    const dur = e.endTime
      ? (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes)
      : 0;
    totalWorked += dur;
    console.log(
      `${fmt(e.date).slice(0, 10)} ${fmt(e.startTime).slice(11, 16)}-${fmt(e.endTime).slice(11, 16)} ` +
        `breakMin=${e.breakMinutes} (breakRows=${e.breaks.length}) ` +
        `invalid=${e.isInvalid} locked=${e.isLocked} net=${dur.toFixed(0)}min`,
    );
  }
  console.log(
    `\nTOTAL worked minutes in window: ${totalWorked.toFixed(0)} (= ${(totalWorked / 60).toFixed(2)}h)`,
  );

  console.log("\n=== SHIFTS in [rangeStart .. today] (these feed expected for SHIFT_BASED) ===");
  const shifts = await prisma.shift.findMany({
    where: {
      employeeId,
      date: { gte: rangeStart },
      deletedAt: null,
    },
    orderBy: { date: "asc" },
  });
  let totalShift = 0;
  for (const sh of shifts) {
    const [sh1, sm1] = sh.startTime.split(":").map(Number);
    const [sh2, sm2] = sh.endTime.split(":").map(Number);
    const dur = (sh2 - sh1) * 60 + (sm2 - sm1);
    totalShift += dur;
    console.log(
      `${fmt(sh.date).slice(0, 10)} ${sh.startTime}-${sh.endTime} ` +
        `conflictsWithLeave=${sh.conflictsWithLeave} label=${sh.label ?? ""} dur=${dur}min`,
    );
  }
  console.log(
    `\nTOTAL shift minutes in window: ${totalShift} (= ${(totalShift / 60).toFixed(2)}h)`,
  );
  if (shifts.length === 0)
    console.log("(no shifts → expected = 0 → all worked time becomes overtime)");

  console.log("\n=== APPROVED LEAVE in window ===");
  const leaves = await prisma.leaveRequest.findMany({
    where: {
      employeeId,
      deletedAt: null,
      status: "APPROVED",
      startDate: { lte: now },
      endDate: { gte: rangeStart },
    },
  });
  for (const l of leaves) {
    console.log(`${fmt(l.startDate).slice(0, 10)} .. ${fmt(l.endDate).slice(0, 10)}`);
  }
  if (leaves.length === 0) console.log("(none)");

  console.log("\n=== ABSENCES in window ===");
  const abs = await prisma.absence.findMany({
    where: { employeeId, deletedAt: null, startDate: { lte: now }, endDate: { gte: rangeStart } },
  });
  for (const a of abs) {
    console.log(
      `${fmt(a.startDate).slice(0, 10)} .. ${fmt(a.endDate).slice(0, 10)} type=${a.type}`,
    );
  }
  if (abs.length === 0) console.log("(none)");

  console.log("\n=== INTERPRETATION ===");
  if (effectiveSchedule?.type === "SHIFT_BASED") {
    const bal = totalWorked - totalShift;
    console.log(
      `SHIFT_BASED → live balance ≈ worked(${totalWorked.toFixed(0)}) − shifts(${totalShift}) ` +
        `= ${bal.toFixed(0)}min = ${(bal / 60).toFixed(2)}h`,
    );
  } else if (effectiveSchedule) {
    console.log(
      `Type=${effectiveSchedule.type} → expected wird NICHT aus Schichten gebildet, ` +
        `sondern aus den day-Hours / weeklyHours / monthlyHours-Feldern.`,
    );
    const wd = effectiveSchedule.workDays as number[];
    const allZero =
      effectiveSchedule.mondayHours === 0 &&
      effectiveSchedule.tuesdayHours === 0 &&
      effectiveSchedule.wednesdayHours === 0 &&
      effectiveSchedule.thursdayHours === 0 &&
      effectiveSchedule.fridayHours === 0;
    if (allZero) {
      console.log(
        "WARNING: All weekday hours = 0 → expected = 0 → jede gearbeitete Minute wird zu Überstunden",
      );
    }
    if (wd.length === 0) console.log("WARNING: workDays=[] → kein Arbeitstag konfiguriert");
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
