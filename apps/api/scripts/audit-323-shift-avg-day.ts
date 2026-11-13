/**
 * Issue #323 - read-only audit: SHIFT_BASED contracts whose `contractWorkDaysPerWeek` differs from the
 * workDays cardinality, with the OPEN-month contract Soll before and after the fix.
 *
 * Per affected employee it prints ids and minutes only (no names): the Soll of the current tenant-local
 * month computed with the pre-#323 rule (the stored count ignored) and with the current rule, both through
 * `calcExpectedMinutesTz()` with no holiday set. Closed months are never recomputed by anything - this
 * script shows only what an OPEN month would read. A control line gives the total number of SHIFT_BASED
 * rows so a zero never stands on an empty set.
 *
 * Read-only. ZERO mutations. Exit 0 whether or not rows are found.
 *
 * Run:
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx scripts/audit-323-shift-avg-day.ts
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { pathToFileURL } from "node:url";
import {
  calcExpectedMinutesTz,
  monthRangeUtc,
} from "../src/contexts/working-time-account/timezone";

export type ShiftScheduleRow = {
  schedule_id: string;
  employee_id: string;
  tenant_id: string;
  timezone: string;
  weekly_hours: string | null;
  contract_work_days_per_week: number | null;
  work_days: number[];
};

export type AuditLine = {
  scheduleId: string;
  employeeId: string;
  tenantId: string;
  contractWorkDaysPerWeek: number;
  workDaysCount: number;
  oldSollMinutes: number;
  newSollMinutes: number;
  deltaMinutes: number;
};

/** True when the row is a finding: a stored contractual count that differs from workDays.length. */
export function isDivergent(row: ShiftScheduleRow): boolean {
  return (
    row.contract_work_days_per_week != null &&
    row.contract_work_days_per_week !== (row.work_days ?? []).length
  );
}

/** Open-month contract Soll, old rule (count ignored) vs new rule, for the month containing `now`. */
export function auditLineFor(row: ShiftScheduleRow, now: Date): AuditLine {
  const [y, m] = new Intl.DateTimeFormat("en-CA", {
    timeZone: row.timezone,
    year: "numeric",
    month: "2-digit",
  })
    .format(now)
    .split("-")
    .map(Number);
  const { start, end } = monthRangeUtc(y, m, row.timezone);
  const base = {
    type: "SHIFT_BASED",
    weeklyHours: row.weekly_hours == null ? null : Number(row.weekly_hours),
    workDays: row.work_days,
  };
  const oldSoll = calcExpectedMinutesTz(
    { ...base, contractWorkDaysPerWeek: null },
    start,
    end,
    row.timezone,
  );
  const newSoll = calcExpectedMinutesTz(
    { ...base, contractWorkDaysPerWeek: row.contract_work_days_per_week },
    start,
    end,
    row.timezone,
  );
  return {
    scheduleId: row.schedule_id,
    employeeId: row.employee_id,
    tenantId: row.tenant_id,
    contractWorkDaysPerWeek: row.contract_work_days_per_week as number,
    workDaysCount: (row.work_days ?? []).length,
    oldSollMinutes: oldSoll,
    newSollMinutes: newSoll,
    deltaMinutes: newSoll - oldSoll,
  };
}

async function run(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    return 1;
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter = new PrismaPg(pool as any);
  const prisma = new PrismaClient({ adapter });
  try {
    // The contract valid today per employee (newest validFrom <= now); later rows are not yet in force.
    const rows = await prisma.$queryRaw<ShiftScheduleRow[]>`
      SELECT DISTINCT ON (ws."employeeId")
        ws.id AS schedule_id, ws."employeeId" AS employee_id, e."tenantId" AS tenant_id,
        tc.timezone AS timezone, ws."weeklyHours"::text AS weekly_hours,
        ws."contractWorkDaysPerWeek" AS contract_work_days_per_week, ws."workDays" AS work_days
      FROM "WorkSchedule" ws
      JOIN "Employee" e ON e.id = ws."employeeId"
      JOIN "TenantConfig" tc ON tc."tenantId" = e."tenantId"
      WHERE ws.type = 'SHIFT_BASED' AND ws."validFrom" <= now()
      ORDER BY ws."employeeId", ws."validFrom" DESC;
    `;
    const now = new Date();
    const lines = rows.filter(isDivergent).map((r) => auditLineFor(r, now));
    console.info(`Control: ${rows.length} SHIFT_BASED employees with a contract in force`);
    console.info(`Divergent (contractWorkDaysPerWeek <> workDays.length): ${lines.length}`);
    for (const l of lines) {
      console.info(
        `tenant=${l.tenantId} employee=${l.employeeId} schedule=${l.scheduleId} ` +
          `contractDays=${l.contractWorkDaysPerWeek} workDays=${l.workDaysCount} ` +
          `openMonthSollOld=${l.oldSollMinutes} openMonthSollNew=${l.newSollMinutes} delta=${l.deltaMinutes}`,
      );
    }
    return 0;
  } catch (err) {
    console.error(err);
    return 1;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run().then((code) => {
    process.exitCode = code;
  });
}
