/**
 * Migration artifact — committed 2026-06-08 for audit trail.
 * One-off operator script for the 2026-06-08 prod § 18 ArbZG-exemption flip.
 * NOT part of the production code path. Invocation requires explicit argv.
 * Related phase: 76.7 (see .planning/phases/76.7-tracking-exemption-arbzg/).
 *
 * What this script does:
 *  1. Validate --employee-id, --actor-id (UUID format) and --exempt (true|false).
 *  2. Verify the actor exists in the User table (refuses to run otherwise —
 *     mirrors the T-76.6-01 mitigation applied to AuditLog.userId).
 *  3. Verify the target employee exists in the Employee table.
 *  4. Print the intended change (current value → new value).
 *  5. With --apply: open prisma.$transaction([...]) with TWO operations:
 *       (a) AuditLog row (action=SET_TIME_TRACKING_EXEMPT, oldValue, newValue, userId)
 *       (b) Employee.update setting isTimeTrackingExempt
 *     AuditLog is written FIRST per CLAUDE.md "AuditLog write BEFORE Employee.update".
 *
 * NEVER hard-deletes rows (Revisionssicherheit per CLAUDE.md).
 *
 * PII-CLEAN: no hardcoded employee/tenant/user UUIDs in this file (per
 * feedback_no_pii_in_github). All identity is argv-driven.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
 *     scripts/set-time-tracking-exempt.ts \
 *     --employee-id <uuid> \
 *     --actor-id <uuid> \
 *     --exempt true|false \
 *     [--apply]
 *
 * Without --apply: dry-run, prints intended change.
 * With    --apply: writes the AuditLog row + persists the Employee.update inside one tx.
 *
 * Idempotent: re-running with the same target value is a no-op for the Employee row
 * (update writes the same value back). One AuditLog row is still written per --apply
 * invocation for operator visibility — matches the 76.5/76.6 sibling convention of
 * one AuditLog row per mutation attempt.
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
    "actor-id": { type: "string" },
    exempt: { type: "string" },
    apply: { type: "boolean", default: false },
  },
});

const employeeId = values["employee-id"];
const actorId = values["actor-id"];
const exemptArg = values["exempt"];
const APPLY = values["apply"] ?? false;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usage(): never {
  console.error(
    "Usage: tsx scripts/set-time-tracking-exempt.ts " +
      "--employee-id <uuid> --actor-id <uuid> --exempt true|false [--apply]",
  );
  console.error("  --employee-id REQUIRED, must be a valid UUID");
  console.error("  --actor-id    REQUIRED, must be a valid UUID matching an existing User");
  console.error("  --exempt      REQUIRED, must be 'true' or 'false'");
  console.error("  --apply       opt-in flag; without it the script runs dry-run");
  process.exit(1);
}

if (!employeeId || !UUID_RE.test(employeeId)) usage();
if (!actorId || !UUID_RE.test(actorId)) usage();
if (exemptArg !== "true" && exemptArg !== "false") usage();

const newExempt = exemptArg === "true";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adapter = new PrismaPg(pool as any);
const prisma = new PrismaClient({ adapter });

async function main() {
  // Mirrors the T-76.6-01 mitigation: refuse to run if actor-id doesn't match a User.
  const actor = await prisma.user.findUnique({ where: { id: actorId! } });
  if (!actor) {
    console.error(
      `--actor-id ${actorId} does not match any User. Refusing to write AuditLog rows.`,
    );
    process.exit(1);
  }

  const employee = await prisma.employee.findUnique({
    where: { id: employeeId! },
    select: {
      id: true,
      employeeNumber: true,
      isTimeTrackingExempt: true,
      tenantId: true,
    },
  });
  if (!employee) {
    console.error(`--employee-id ${employeeId} not found.`);
    process.exit(1);
  }

  console.log(`Mode:          ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`Actor:         ${actor.email} (${actorId})`);
  console.log(`Employee:      ${employee.employeeNumber} (${employee.id})`);
  console.log(`Tenant:        ${employee.tenantId}`);
  console.log(`Current value: isTimeTrackingExempt = ${employee.isTimeTrackingExempt}`);
  console.log(`New value:     isTimeTrackingExempt = ${newExempt}`);

  if (employee.isTimeTrackingExempt === newExempt) {
    console.log("");
    console.log(
      "No-op: target value matches current. AuditLog row will still be written on --apply.",
    );
  }

  if (!APPLY) {
    console.log("");
    console.log("Dry-run only. Re-run with --apply to persist.");
    return;
  }

  // ── AuditLog BEFORE Employee.update inside one transaction ──────────────
  // Order is mandatory per CLAUDE.md "AuditLog write BEFORE Employee update".
  const [auditRow] = await prisma.$transaction([
    prisma.auditLog.create({
      data: {
        userId: actorId!,
        action: "SET_TIME_TRACKING_EXEMPT",
        entity: "Employee",
        entityId: employee.id,
        oldValue: { isTimeTrackingExempt: employee.isTimeTrackingExempt },
        newValue: { isTimeTrackingExempt: newExempt },
        ipAddress: "ops-script",
        userAgent: "tsx scripts/set-time-tracking-exempt.ts",
      },
    }),
    prisma.employee.update({
      where: { id: employee.id },
      data: { isTimeTrackingExempt: newExempt },
    }),
  ]);

  console.log("");
  console.log(
    `Applied. AuditLog row ${auditRow.id} + Employee.update committed in one transaction.`,
  );
}

main()
  .catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
