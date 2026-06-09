/**
 * Migration artifact — committed 2026-06-08 for audit trail.
 * One-off operator script for the 2026-06-08 prod SaldoSnapshot TZ-duplicate cleanup.
 * NOT part of the production code path. Invocation requires explicit argv.
 * Related phase: 76.6 (see .planning/phases/76.6-tz-duplicate-snapshots-cleanup/).
 *
 * What this script does:
 *  1. Scan SaldoSnapshot for (employeeId, periodType, calendar-month-in-tenant-TZ) groups
 *     containing 2+ non-superseded rows.
 *  2. Identify the canonical row per group = the one whose periodStart matches
 *     monthRangeUtc(year, month, tenantTz).start.
 *  3. Mark every non-canonical row `superseded: true` with `supersededReason` set
 *     to the documented bulk-cleanup string.
 *  4. Write an AuditLog row per supersede (action=UPDATE, full oldValue, newValue
 *     with superseded marker). AuditLog written BEFORE the UPDATE in the same tx.
 *
 * NEVER hard-deletes rows (Revisionssicherheit per CLAUDE.md).
 *
 * Origin of the duplicates: the May 2026 pre-tracking-reset script used
 * `new Date("YYYY-MM-01")` (UTC midnight) instead of the tenant-TZ-anchored
 * `monthRangeUtc(year, month, tz).start`. For Europe/Berlin (UTC+1 winter / UTC+2 summer)
 * this is off by ~22-23h, so the snapshot ended up stored on the PREVIOUS calendar day,
 * shadowing the legitimate tenant-TZ-anchored row in findFirst(orderBy: periodStart desc).
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
 *     scripts/cleanup-tz-duplicate-snapshots.ts \
 *     --actor-id <uuid> \
 *     [--tenant-id <uuid>] \
 *     [--apply]
 *
 * Without --apply: dry-run, prints the cleanup report.
 * With    --apply: runs cleanup inside per-tenant $transactions (audit-proof).
 *
 * Idempotent: re-running after --apply produces zero changes (groups with already-superseded
 * rows are skipped per the canonical-row picker).
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import {
  cleanupTzDuplicateSnapshots,
  SUPERSEDED_REASON,
} from "../src/utils/saldo-snapshot-cleanup";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    "actor-id": { type: "string" },
    "tenant-id": { type: "string" },
    apply: { type: "boolean", default: false },
  },
});

const actorId = values["actor-id"];
const tenantId = values["tenant-id"];
const APPLY = values["apply"] ?? false;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (!actorId || !UUID_RE.test(actorId)) {
  console.error(
    "Usage: tsx scripts/cleanup-tz-duplicate-snapshots.ts --actor-id <uuid> " +
      "[--tenant-id <uuid>] [--apply]",
  );
  console.error("  --actor-id is REQUIRED and must be a valid UUID (used as AuditLog.userId).");
  process.exit(1);
}

if (tenantId && !UUID_RE.test(tenantId)) {
  console.error("--tenant-id must be a valid UUID if provided");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adapter = new PrismaPg(pool as any);
const prisma = new PrismaClient({ adapter });

async function main() {
  // T-76.6-01 mitigation: refuse to run if actor-id doesn't exist as a User.
  const actor = await prisma.user.findUnique({ where: { id: actorId! } });
  if (!actor) {
    console.error(
      `--actor-id ${actorId} does not match any User. Refusing to write AuditLog rows.`,
    );
    process.exit(1);
  }

  console.log(`Mode:      ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`Actor:     ${actor.email} (${actorId})`);
  console.log(`Tenant:    ${tenantId ?? "(all tenants)"}`);
  console.log(`Reason:    ${SUPERSEDED_REASON}\n`);

  const report = await cleanupTzDuplicateSnapshots(
    prisma,
    { actorId: actorId!, tenantId, dryRun: !APPLY },
    console,
  );

  console.log(`\n── Cleanup report ──`);
  console.log(`  Snapshots scanned:        ${report.scannedRowCount}`);
  console.log(`  Groups examined:          ${report.groupsExamined}`);
  console.log(`  Duplicate groups found:   ${report.duplicateGroups.length}`);
  console.log(`  Rows to supersede:        ${report.supersededRowCount}`);
  console.log(`  AuditLog rows written:    ${report.auditLogRowCount}`);
  console.log(`  Applied:                  ${report.applied}\n`);

  if (report.duplicateGroups.length > 0) {
    console.log(`── Duplicate groups ──`);
    for (const g of report.duplicateGroups) {
      console.log(
        `  emp=${g.employeeId} tenant=${g.tenantId} tz=${g.tenantTz} ` +
          `${g.periodType} ${g.year}-${String(g.month).padStart(2, "0")}`,
      );
      console.log(
        `    canonical:  ${g.canonicalRowId} periodStart=${g.canonicalPeriodStart.toISOString()}`,
      );
      for (let i = 0; i < g.supersededRowIds.length; i++) {
        console.log(
          `    superseded: ${g.supersededRowIds[i]} periodStart=${g.supersededPeriodStarts[i].toISOString()}`,
        );
      }
    }
  }

  if (!APPLY && report.supersededRowCount > 0) {
    console.log(`\nDry-run done. Re-run with --apply to write changes.`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
