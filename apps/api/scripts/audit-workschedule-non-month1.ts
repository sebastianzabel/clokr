/**
 * Phase 60 (v1.6.5, GitHub #220) — audit: list every WorkSchedule row whose
 * `validFrom` is not the 1st of a calendar month.
 *
 * Read-only. Zero mutations. Surfaces existing non-1st rows for manual review.
 * The Phase 60 fix prevents new non-1st rows via Zod validation on POST/PUT,
 * but historical rows (pre-Phase-60) are preserved per CLAUDE.md
 * Revisionssicherheit — they MUST NOT be auto-migrated or deleted.
 *
 * No --dry-run flag — the script never writes.
 *
 * Run:
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx scripts/audit-workschedule-non-month1.ts
 *
 * Exit codes:
 *   0 — script ran (whether or not it found non-1st rows)
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
  // Raw SQL: pull every WorkSchedule whose validFrom day-of-month is NOT 1.
  // Postgres EXTRACT(DAY FROM ...) returns 1..31 in the column's timezone (UTC for Timestamptz).
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
      ws."validFrom"     AS valid_from
    FROM "WorkSchedule" ws
    JOIN "Employee" e ON e.id = ws."employeeId"
    JOIN "Tenant"   t ON t.id = e."tenantId"
    WHERE EXTRACT(DAY FROM ws."validFrom" AT TIME ZONE 'UTC') <> 1
    ORDER BY t.name ASC, e."lastName" ASC, ws."validFrom" ASC;
  `;

  if (rows.length === 0) {
    console.log("No non-month-1st WorkSchedule rows found.");
    return;
  }

  console.log(`Found ${rows.length} non-month-1st WorkSchedule row(s):\n`);

  let currentTenant = "";
  for (const r of rows) {
    if (r.tenant_id !== currentTenant) {
      console.log(`\n== Tenant: ${r.tenant_name} (${r.tenant_id}) ==`);
      currentTenant = r.tenant_id;
    }
    const iso = r.valid_from.toISOString();
    console.log(
      `  [${r.type.padEnd(15)}] ${r.employee_number.padEnd(12)} ` +
        `${r.employee_first_name} ${r.employee_last_name} ` +
        `— scheduleId=${r.schedule_id} validFrom=${iso}`,
    );
  }
  console.log(
    `\nReview these rows manually. Phase 60 preserves them (audit trail). ` +
      `To replace a row with a month-1st version, use the admin UI ` +
      `(/admin/employees/{id} → Arbeitszeit tab → 'Gültig ab' field).`,
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
