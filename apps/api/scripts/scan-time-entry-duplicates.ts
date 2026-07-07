/**
 * scan-time-entry-duplicates.ts — DATA-V1814-04 pre-migration gate (D-05).
 *
 * Read-only. ZERO mutations. Surfaces non-deleted duplicate (employeeId, date)
 * TimeEntry pairs for HUMAN review before the partial-unique-index migration ships.
 * Audit-proof (Revisionssicherheit): duplicates are reported, NEVER auto-deleted.
 *
 * Run:  DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx scripts/scan-time-entry-duplicates.ts
 * Exit: 0 = [OK] no duplicates → safe to run migration on this DB.
 *       1 = [BLOCKED] duplicates found → resolve manually, do NOT run migration.
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
  const rows = await prisma.$queryRaw<Array<{ employeeId: string; date: string; cnt: number }>>`
    SELECT "employeeId", "date"::text AS date, COUNT(*)::int AS cnt
    FROM "TimeEntry"
    WHERE "deletedAt" IS NULL
    GROUP BY "employeeId", "date"
    HAVING COUNT(*) > 1
    ORDER BY "employeeId", "date";
  `;

  if (rows.length === 0) {
    console.log(
      "[OK] No duplicate non-deleted TimeEntry (employeeId, date) pairs found. Safe to run migration.",
    );
    return 0;
  }

  for (const r of rows) {
    console.error(`  employeeId=${r.employeeId} date=${r.date} count=${r.cnt}`);
  }
  console.error(
    `[BLOCKED] ${rows.length} duplicate pair(s) found. Do NOT run migration until resolved (manual, no auto-delete).`,
  );
  return 1;
}

main()
  .then(async (code) => {
    await pool.end();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error("[ERROR] scan failed:", err);
    await pool.end();
    process.exit(1);
  });
