/**
 * Issue #848 — read-only audit: list every FIXED_SCHEDULE WorkSchedule row whose `weeklyHours`
 * differs from Σ `{day}Hours`.
 *
 * Background: until #848, `POST /api/v1/employees` stored the requested `weeklyHours` but left the
 * day hours at the column defaults (Mo–Fr 8 h), so a 32 h Di–Fr contract read 32 h in the month view
 * and 40 h Mo–Fr in the saldo chain and the reports. #848 closes the write paths (derivation on
 * create, a German 400 on PUT /settings/work/:employeeId and on the bulk apply). Existing rows are
 * NOT corrected: which half of a divergent row is right is a per-person decision for the owner
 * (Phase 95b, D-01; Revisionssicherheit) — a correction would be a deliberate new contract row via
 * the admin UI, never a data rewrite.
 *
 * Only FIXED_SCHEDULE is checked: for every other type the `{day}Hours` are placeholders (CLAUDE.md
 * "Schedule Types") and `weeklyHours` means something else.
 *
 * Output: ids and numbers only (no names — GitHub artifacts and logs must carry no PII).
 * Read-only. ZERO mutations. Exit 0 whether or not rows are found.
 *
 * Run (per stage):
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx scripts/audit-848-weekly-vs-day-hours.ts
 *
 * Exit codes: 0 — ran; 1 — DATABASE_URL missing or DB error.
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { pathToFileURL } from "node:url";
import { fixedScheduleHoursMismatch } from "../src/contexts/platform/fixed-schedule-hours";

export type WeeklyRow = {
  schedule_id: string;
  employee_id: string;
  tenant_id: string;
  valid_from: Date;
  weekly_hours: string | null;
  work_days: number[];
  monday_hours: string;
  tuesday_hours: string;
  wednesday_hours: string;
  thursday_hours: string;
  friday_hours: string;
  saturday_hours: string;
  sunday_hours: string;
};

function daySum(r: WeeklyRow): number {
  const cents = [
    r.monday_hours,
    r.tuesday_hours,
    r.wednesday_hours,
    r.thursday_hours,
    r.friday_hours,
    r.saturday_hours,
    r.sunday_hours,
  ].reduce((s, v) => s + Math.round(Number(v) * 100), 0);
  return cents / 100;
}

/** The FIXED_SCHEDULE rows of `rows` whose weeklyHours ≠ Σ day hours (the #848 write-path rule). */
export function weeklyMismatches(rows: WeeklyRow[]): Array<WeeklyRow & { day_sum: number }> {
  return rows
    .filter(
      (r) =>
        fixedScheduleHoursMismatch("FIXED_SCHEDULE", r.weekly_hours, {
          mondayHours: r.monday_hours,
          tuesdayHours: r.tuesday_hours,
          wednesdayHours: r.wednesday_hours,
          thursdayHours: r.thursday_hours,
          fridayHours: r.friday_hours,
          saturdayHours: r.saturday_hours,
          sundayHours: r.sunday_hours,
        }) !== null,
    )
    .map((r) => ({ ...r, day_sum: daySum(r) }));
}

export function renderReport(rows: WeeklyRow[]): string {
  const found = weeklyMismatches(rows);
  const lines: string[] = [];
  lines.push(
    `Checked ${rows.length} FIXED_SCHEDULE row(s); ${found.length} with weeklyHours ≠ Σ {day}Hours.`,
  );
  let tenant = "";
  for (const r of found) {
    if (r.tenant_id !== tenant) {
      lines.push(`\n== Tenant ${r.tenant_id} ==`);
      tenant = r.tenant_id;
    }
    lines.push(
      `  employee=${r.employee_id} schedule=${r.schedule_id} validFrom=${r.valid_from.toISOString().slice(0, 10)} ` +
        `weeklyHours=${r.weekly_hours ?? "null"} daySum=${r.day_sum} workDays=[${(r.work_days ?? []).join(",")}]`,
    );
  }
  lines.push("");
  lines.push(
    "Rows are NOT corrected (Phase 95b, D-01): the owner decides per person which half is right; a " +
      "correction is a new contract row through /admin/employees/{id}, never a data rewrite.",
  );
  return lines.join("\n");
}

async function run(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    return 1;
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
  try {
    const rows = await prisma.$queryRaw<WeeklyRow[]>`
      SELECT
        ws.id               AS schedule_id,
        ws."employeeId"     AS employee_id,
        e."tenantId"        AS tenant_id,
        ws."validFrom"      AS valid_from,
        ws."weeklyHours"::text AS weekly_hours,
        ws."workDays"       AS work_days,
        ws."mondayHours"::text    AS monday_hours,
        ws."tuesdayHours"::text   AS tuesday_hours,
        ws."wednesdayHours"::text AS wednesday_hours,
        ws."thursdayHours"::text  AS thursday_hours,
        ws."fridayHours"::text    AS friday_hours,
        ws."saturdayHours"::text  AS saturday_hours,
        ws."sundayHours"::text    AS sunday_hours
      FROM "WorkSchedule" ws
      JOIN "Employee" e ON e.id = ws."employeeId"
      WHERE ws.type = 'FIXED_SCHEDULE'
      ORDER BY e."tenantId" ASC, ws."employeeId" ASC, ws."validFrom" ASC;
    `;
    console.log(renderReport(rows));
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
