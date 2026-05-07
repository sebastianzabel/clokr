/**
 * Backfill: clear isInvalid on TimeEntries that were corrected before the
 * auto-revalidate fix shipped (the PUT /time-entries/:id handler now clears
 * isInvalid automatically when endTime is added to an entry whose
 * invalidReason is "Ausstempeln fehlt", but entries corrected BEFORE that
 * change stay flagged forever and contribute 0h to saldo).
 *
 * Pattern matched (idempotent — safe to re-run):
 *   isInvalid = true
 *   AND invalidReason = 'Ausstempeln fehlt'
 *   AND endTime IS NOT NULL
 *   AND deletedAt IS NULL
 *
 * Each fix is logged to AuditLog with action=BACKFILL_REVALIDATE so the
 * Revisionssicherheits-Trail stays intact (CLAUDE.md audit rules).
 *
 * Saldo recalculates lazily on the next GET /overtime/:employeeId for each
 * affected employee — this script does not call updateOvertimeAccount itself,
 * so it does not need the full Fastify app to be built.
 *
 * Run:
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx scripts/backfill-auto-revalidate.ts
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx scripts/backfill-auto-revalidate.ts --dry-run
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
  const dryRun = process.argv.includes("--dry-run");

  const stuck = await prisma.timeEntry.findMany({
    where: {
      isInvalid: true,
      invalidReason: "Ausstempeln fehlt",
      endTime: { not: null },
      deletedAt: null,
    },
    select: {
      id: true,
      employeeId: true,
      date: true,
      employee: { select: { firstName: true, lastName: true } },
    },
    orderBy: [{ employeeId: "asc" }, { date: "asc" }],
  });

  if (stuck.length === 0) {
    console.log("No stuck entries found. Nothing to do.");
    return;
  }

  console.log(`Found ${stuck.length} stuck entr${stuck.length === 1 ? "y" : "ies"}:`);
  for (const e of stuck) {
    const dateStr = e.date.toISOString().slice(0, 10);
    console.log(`  - ${e.employee.lastName}, ${e.employee.firstName} on ${dateStr} (${e.id})`);
  }

  if (dryRun) {
    console.log("\n--dry-run: no changes applied.");
    return;
  }

  const employeeIds = new Set<string>();
  let updated = 0;
  let auditFailures = 0;
  for (const e of stuck) {
    await prisma.timeEntry.update({
      where: { id: e.id },
      data: { isInvalid: false, invalidReason: null },
    });
    try {
      await prisma.auditLog.create({
        data: {
          userId: null,
          action: "BACKFILL_REVALIDATE",
          entity: "TimeEntry",
          entityId: e.id,
          oldValue: { isInvalid: true, invalidReason: "Ausstempeln fehlt" },
          newValue: { isInvalid: false, invalidReason: null },
        },
      });
    } catch (err) {
      auditFailures++;
      console.warn(`  ! Audit log failed for ${e.id}: ${(err as Error).message}`);
    }
    employeeIds.add(e.employeeId);
    updated++;
  }

  console.log(
    `\n✓ Revalidated ${updated} entr${updated === 1 ? "y" : "ies"} across ${employeeIds.size} employee${employeeIds.size === 1 ? "" : "s"}.`,
  );
  if (auditFailures > 0) {
    console.warn(`! ${auditFailures} audit log entr${auditFailures === 1 ? "y" : "ies"} failed.`);
  }
  console.log(
    "Saldo will recalculate on the next GET /overtime/:employeeId for each affected employee.",
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
