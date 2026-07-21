/**
 * Phase 76.32.1 — Half-Day Absence Saldo Correctness: read-only exposure probe.
 *
 * Read-only. Zero mutations. No --apply flag. No writes to the DB or to any file.
 *
 * Finds non-deleted, non-VOCATIONAL_SCHOOL Absence rows whose `days` value is
 * fractional (i.e. Number(days) !== Math.round(Number(days))). These rows, if
 * they fall in a CLOSED month, may have caused saldo over-credit under the old
 * full-day logic (research §4: +half-daily-Soll per affected half-day absence).
 *
 * Output (console only, NO file write, NO committed PII):
 *   - Total fractional absence count.
 *   - Per-employeeId count breakdown (ids stay on local console; never persisted).
 *   - A clear "0 → forward-only, no backfill needed" message when count is 0.
 *
 * Run:
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx scripts/audit-fractional-absences.ts
 *
 * Exit codes:
 *   0 — script ran successfully (regardless of whether fractional rows were found)
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
  // Fetch all non-deleted, non-VOCATIONAL_SCHOOL absence rows.
  // Select only the fields needed for the probe — no names, no notes, no PII.
  const candidates = await prisma.absence.findMany({
    where: {
      deletedAt: null,
      type: { not: "VOCATIONAL_SCHOOL" },
    },
    select: {
      id: true,
      employeeId: true,
      type: true,
      startDate: true,
      endDate: true,
      days: true,
    },
    orderBy: [{ employeeId: "asc" }, { startDate: "asc" }],
  });

  // Filter to fractional days (days value is not a whole number).
  const fractional = candidates.filter((a) => Number(a.days) !== Math.round(Number(a.days)));

  if (fractional.length === 0) {
    console.log(
      "audit-fractional-absences: 0 fractional Absence rows found.\n" +
        "→ No backfill needed. The Phase 76.32.1 fix is forward-only.\n" +
        "→ All existing Absence rows have whole-number days values.",
    );
    return;
  }

  // Aggregate per employee (ids are acceptable in local console output; never written to disk).
  const byEmployee = new Map<string, number>();
  for (const a of fractional) {
    byEmployee.set(a.employeeId, (byEmployee.get(a.employeeId) ?? 0) + 1);
  }

  console.log(
    `audit-fractional-absences: ${fractional.length} fractional Absence row(s) found across ${byEmployee.size} employee(s).\n`,
  );

  console.log("Per-employee breakdown (count):");
  for (const [empId, count] of byEmployee.entries()) {
    console.log(`  employeeId=${empId}  fractional_rows=${count}`);
  }

  console.log("\nMonths affected (by startDate month, no-PII shape only):");
  const monthSet = new Set<string>();
  for (const a of fractional) {
    const d = new Date(a.startDate);
    monthSet.add(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  for (const m of [...monthSet].sort()) {
    console.log(`  ${m}`);
  }

  console.log(
    "\n→ Backfill MAY be needed for these employees. See docs/half-day-absence-backfill.md for\n" +
      "  the owner-gated dry-run → sign-off → --apply procedure. Do NOT run --apply here.\n" +
      "  MA-ids above: local console only — do NOT commit or persist them.",
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
