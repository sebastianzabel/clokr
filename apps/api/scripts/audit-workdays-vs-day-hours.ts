/**
 * Phase 61 (v1.6.5) — audit: list every WorkSchedule row whose `workDays`
 * disagrees with the set of weekday indices where the corresponding
 * `{day}Hours` value is > 0.
 *
 * Background: an employee's 2026-05-27 incident traced to WorkSchedule rows
 * stored with `workDays=[1,2,3,4,5]` even though `mondayHours=0`. Phase 61's
 * `normalizeWorkDays()` (apps/api/src/utils/calculate-work-days.ts) prevents
 * new rows from diverging, but legacy rows are preserved per CLAUDE.md
 * Revisionssicherheit — they MUST NOT be auto-migrated or deleted.
 *
 * Read-only. ZERO mutations. Exit 0 even if divergent rows are found.
 *
 * Run:
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx scripts/audit-workdays-vs-day-hours.ts
 *
 * Exit codes:
 *   0 — script ran (whether or not it found divergent rows)
 *   1 — DATABASE_URL missing or DB connection failed
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adapter = new PrismaPg(pool as any);
const prisma = new PrismaClient({ adapter });

async function main() {
  // Pull every WorkSchedule row with its per-day-hours and join Employee +
  // Tenant for context. Comparison of `workDays` against the derived set is
  // done in JS (array-equality predicate in SQL is awkward across PG versions).
  const rows = await prisma.$queryRaw<
    Array<{
      schedule_id: string;
      employee_id: string;
      employee_first_name: string;
      employee_last_name: string;
      employee_number: string;
      tenant_id: string;
      tenant_name: string;
      type: string;
      valid_from: Date;
      work_days: number[];
      monday_hours: string;
      tuesday_hours: string;
      wednesday_hours: string;
      thursday_hours: string;
      friday_hours: string;
      saturday_hours: string;
      sunday_hours: string;
    }>
  >`
    SELECT
      ws.id              AS schedule_id,
      ws."employeeId"    AS employee_id,
      e."firstName"      AS employee_first_name,
      e."lastName"       AS employee_last_name,
      e."employeeNumber" AS employee_number,
      e."tenantId"       AS tenant_id,
      t.name             AS tenant_name,
      ws.type            AS type,
      ws."validFrom"     AS valid_from,
      ws."workDays"      AS work_days,
      ws."mondayHours"    AS monday_hours,
      ws."tuesdayHours"   AS tuesday_hours,
      ws."wednesdayHours" AS wednesday_hours,
      ws."thursdayHours"  AS thursday_hours,
      ws."fridayHours"    AS friday_hours,
      ws."saturdayHours"  AS saturday_hours,
      ws."sundayHours"    AS sunday_hours
    FROM "WorkSchedule" ws
    JOIN "Employee" e ON e.id = ws."employeeId"
    JOIN "Tenant"   t ON t.id = e."tenantId"
    ORDER BY t.name ASC, e."lastName" ASC, ws."validFrom" ASC;
  `;

  type Divergent = (typeof rows)[number] & { derived: number[] };
  const divergent: Divergent[] = [];

  for (const r of rows) {
    const derived = [
      [0, Number(r.sunday_hours)],
      [1, Number(r.monday_hours)],
      [2, Number(r.tuesday_hours)],
      [3, Number(r.wednesday_hours)],
      [4, Number(r.thursday_hours)],
      [5, Number(r.friday_hours)],
      [6, Number(r.saturday_hours)],
    ]
      .filter(([, h]) => (h as number) > 0)
      .map(([d]) => d as number)
      .sort((a, b) => a - b);

    const stored = (r.work_days ?? []).slice().sort((a, b) => a - b);

    const sameLength = stored.length === derived.length;
    const sameContents = sameLength && stored.every((v, i) => v === derived[i]);

    // Divergence rule:
    //   - If derived is empty (all per-day-hours = 0, e.g. MONTHLY_HOURS), do
    //     NOT flag — there's nothing to derive from. The schema default and
    //     tenant fallback both apply legitimately in that case.
    //   - Otherwise flag whenever stored != derived.
    if (derived.length > 0 && !sameContents) {
      divergent.push({ ...r, derived });
    }
  }

  if (divergent.length === 0) {
    console.log("No WorkSchedule rows with workDays diverging from per-day-hours.");
    return;
  }

  console.log(`Found ${divergent.length} divergent WorkSchedule row(s):\n`);

  let currentTenant = "";
  for (const r of divergent) {
    if (r.tenant_id !== currentTenant) {
      console.log(`\n== Tenant: ${r.tenant_name} (${r.tenant_id}) ==`);
      currentTenant = r.tenant_id;
    }

    // Identify which per-day-hour columns disagree with workDays for the trace.
    const offendingDetails: string[] = [];
    const stored = new Set(r.work_days ?? []);
    const derived = new Set(r.derived);
    for (const d of stored) {
      if (!derived.has(d)) {
        const hourCol = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][d];
        const hourVal = [
          r.sunday_hours,
          r.monday_hours,
          r.tuesday_hours,
          r.wednesday_hours,
          r.thursday_hours,
          r.friday_hours,
          r.saturday_hours,
        ][d];
        offendingDetails.push(`workDays-has-${d}-but-${hourCol}Hours=${hourVal}`);
      }
    }
    for (const d of derived) {
      if (!stored.has(d)) {
        const hourCol = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][d];
        const hourVal = [
          r.sunday_hours,
          r.monday_hours,
          r.tuesday_hours,
          r.wednesday_hours,
          r.thursday_hours,
          r.friday_hours,
          r.saturday_hours,
        ][d];
        offendingDetails.push(`workDays-missing-${d}-but-${hourCol}Hours=${hourVal}`);
      }
    }

    console.log(
      `  [${r.type.padEnd(15)}] ${r.employee_number.padEnd(12)} ` +
        `${r.employee_first_name} ${r.employee_last_name} ` +
        `— scheduleId=${r.schedule_id} ` +
        `stored=[${(r.work_days ?? []).join(",")}] derived=[${r.derived.join(",")}] ` +
        `validFrom=${r.valid_from.toISOString()} ` +
        `(${offendingDetails.join(", ")})`,
    );
  }
  console.log(
    `\nReview manually via /admin/employees/{id}. Phase 61 prevents new ` +
      `divergent rows but does NOT auto-migrate (Revisionssicherheit).`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
