/**
 * Batch PSEUDONYMIZER for the prod → int data refresh (v1.8.24).
 *
 * UNLIKE `anonymize-dump.ts` (full DSGVO erasure: firstName="Gelöscht",
 * lastName="GELÖSCHT-XXX" for EVERY employee → indistinguishable in reports),
 * this script replaces each employee's name with a DISTINCT, realistic FAKE
 * name so the operator can still tell employees apart in reports/dropdowns on
 * int — while removing the direct identifiers that must not live on the
 * internet-reachable int environment.
 *
 * Per operator decision (2026-07-23):
 *   - Employee.firstName / lastName → distinct realistic fake name (pool-based,
 *     deterministic by stable id order so re-runs are idempotent)
 *   - Employee.nfcCardId            → null
 *   - User.email                    → int-{employeeNumber-or-id8}@example.invalid
 *   - User.passwordHash             → "ANONYMIZED" (no real login possible)
 *   - Auth tokens (Invitation/OtpToken/RefreshToken) → hard-deleted (not needed on int)
 *
 * DELIBERATELY PRESERVED (so int reports stay complete + employees stay visible):
 *   - Employee.id            (unchanged — reports/links must keep working)
 *   - Employee.employeeNumber (unchanged — same reason)
 *   - User.isActive          (unchanged — do NOT hide them from active lists)
 *   - TimeEntry/LeaveRequest/Absence NOTES + all time/leave/absence/schedule/
 *     overtime data (unchanged)
 *   - AuditLog (unchanged)
 *
 * Run against a STAGING copy of a prod dump (never against prod):
 *   DATABASE_URL=postgresql://clokr:...@localhost:5433/clokr_staging \
 *     pnpm --filter @clokr/api exec tsx scripts/pseudonymize-dump.ts
 *
 * Exits 0 on success (after an inline verification pass), 1 on any failure.
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

// Safety rail: refuse to run against an obviously-production DSN.
if (/@clokr-db|prod-host|zeit\.a-tenant/i.test(process.env.DATABASE_URL)) {
  console.error("[pseudonymize] refusing to run against what looks like a production DSN");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adapter = new PrismaPg(pool as any);
const prisma = new PrismaClient({ adapter });

// Distinct, obviously-fake but realistic German name pools. F*L = 576 unique
// pairs — far more than any single tenant's headcount.
const FIRST_NAMES = [
  "Anna",
  "Bernd",
  "Carla",
  "David",
  "Elena",
  "Frank",
  "Greta",
  "Hendrik",
  "Ida",
  "Jonas",
  "Katrin",
  "Lars",
  "Marlene",
  "Nils",
  "Petra",
  "Quirin",
  "Rosa",
  "Stefan",
  "Tanja",
  "Uwe",
  "Vera",
  "Wolfgang",
  "Xenia",
  "Yannick",
];
const LAST_NAMES = [
  "Beispiel",
  "Muster",
  "Probst",
  "Test",
  "Fischer",
  "Hoffmann",
  "Krause",
  "Lehmann",
  "Neumann",
  "Otto",
  "Peters",
  "Richter",
  "Schuster",
  "Thiel",
  "Ullrich",
  "Vogel",
  "Weber",
  "Zimmer",
  "Adler",
  "Brandt",
  "Conrad",
  "Dietrich",
  "Engel",
  "Franke",
];

function fakeName(index: number): { firstName: string; lastName: string } {
  const first = FIRST_NAMES[index % FIRST_NAMES.length];
  const last = LAST_NAMES[Math.floor(index / FIRST_NAMES.length) % LAST_NAMES.length];
  // If the pool ever wraps, append the index to keep names distinct.
  const suffix = index >= FIRST_NAMES.length * LAST_NAMES.length ? ` ${index}` : "";
  return { firstName: first, lastName: `${last}${suffix}` };
}

async function main() {
  const startedAt = Date.now();
  const runId = `pseudonymize-${new Date(startedAt).toISOString()}`;
  console.log(`[pseudonymize] starting run ${runId}`);

  // Stable order → deterministic name assignment across re-runs.
  const employees = await prisma.employee.findMany({
    select: { id: true, userId: true, employeeNumber: true },
    orderBy: { id: "asc" },
  });
  console.log(`[pseudonymize] found ${employees.length} employees`);

  let processed = 0;
  for (let i = 0; i < employees.length; i++) {
    const emp = employees[i];
    const { firstName, lastName } = fakeName(i);
    await prisma.$transaction(async (tx) => {
      // Employee: fake name + drop NFC. id + employeeNumber left UNTOUCHED.
      await tx.employee.update({
        where: { id: emp.id },
        data: { firstName, lastName, nfcCardId: null },
      });

      // User (if any): pseudo email + disable login. isActive PRESERVED.
      if (emp.userId) {
        const handle = emp.employeeNumber || emp.id.slice(0, 8);
        await tx.user.update({
          where: { id: emp.userId },
          data: {
            email: `int-${handle}@example.invalid`,
            passwordHash: "ANONYMIZED",
          },
        });
        // Auth tokens — not retention-relevant, must not travel to int.
        await tx.otpToken.deleteMany({ where: { userId: emp.userId } });
        await tx.refreshToken.deleteMany({ where: { userId: emp.userId } });
      }
      await tx.invitation.deleteMany({ where: { employeeId: emp.id } });
    });
    processed++;
  }

  // ── Inline verification ──────────────────────────────────────────────────
  const realEmail = await prisma.user.count({
    where: { NOT: { email: { endsWith: "@example.invalid" } } },
  });
  const livePw = await prisma.user.count({ where: { NOT: { passwordHash: "ANONYMIZED" } } });
  const withNfc = await prisma.employee.count({ where: { NOT: { nfcCardId: null } } });
  const geloescht = await prisma.employee.count({ where: { firstName: "Gelöscht" } });

  const durationMs = Date.now() - startedAt;
  await prisma.auditLog.create({
    data: {
      userId: null,
      action: "PSEUDONYMIZATION_RUN",
      entity: "Database",
      entityId: runId,
      newValue: {
        processed,
        durationMs,
        checks: {
          residualRealEmails: realEmail,
          residualLivePasswords: livePw,
          residualNfc: withNfc,
        },
      } as unknown as object,
    },
  });

  console.log(
    `[pseudonymize] pseudonymized ${processed}/${employees.length} employees in ${durationMs}ms`,
  );
  console.log(
    `[pseudonymize] verify → residual real emails=${realEmail}, live passwords=${livePw}, ` +
      `nfc set=${withNfc}, still-"Gelöscht"=${geloescht}`,
  );

  if (realEmail > 0 || livePw > 0 || withNfc > 0) {
    console.error("[pseudonymize] VERIFICATION FAILED — residual identifiers remain. Do NOT swap.");
    process.exitCode = 1;
  } else {
    console.log("[pseudonymize] ✓ PASS — names pseudonymized, logins/NFC disabled, IDs preserved.");
  }
}

main()
  .catch((err) => {
    console.error("[pseudonymize] fatal error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
