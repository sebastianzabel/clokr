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
 *   - Employee.wifiMacs             → [] and PresenceDevice rows → deleted (Issue #388)
 *   - User.email                    → int-{employeeNumber-or-id8}@example.invalid
 *   - User.passwordHash             → "ANONYMIZED" (no real login possible)
 *   - Auth tokens (Invitation/OtpToken/RefreshToken) → hard-deleted (not needed on int)
 *   - OperatorAccount (Phase 88, D-11): EVERY operator account is neutralised — email →
 *     operator-{id8}@example.invalid, passwordHash → "ANONYMIZED", isActive → false, TOTP secret /
 *     enrolment / replay step → null, recovery-code hashes → empty, lockout state reset. Prod operator
 *     credentials must never reach the internet-reachable int environment; an int operator is re-created
 *     with scripts/operator-account.ts. Rows are updated, never deleted (audit rows reference them).
 *
 * DELIBERATELY PRESERVED (so int reports stay complete + employees stay visible):
 *   - DSGVO-anonymized employees (Issue #805): a person for whom the app's own rule
 *     `isAnonymizedEmployee()` / `ANONYMIZED_EMPLOYEE_WHERE` holds keeps name, employee number and the
 *     already-anonymized user (email / password hash) UNCHANGED, so int still recognises them as
 *     anonymized (they stay out of the lists that hide anonymized persons). The rule is imported from
 *     the app module, never re-spelled here. The inline verification compares the number of such
 *     persons before and after the run and fails if it differs.
 *   - Employee.id            (unchanged — reports/links must keep working)
 *   - Employee.employeeNumber (unchanged — same reason)
 *   - User.isActive          (unchanged — do NOT hide them from active lists)
 *   - TimeEntry/LeaveRequest/Absence NOTES (and TimeEntry.breakWaivedReason, Issue #508: kept
 *     like the notes, int is not an erasure) + all time/leave/absence/schedule/
 *     overtime data (unchanged)
 *   - AuditLog (unchanged)
 *   - OperatorAuditLog (unchanged, Phase 88): append-only by trigger, holds no credentials, and failed
 *     logins carry only a keyed hash of the attempted address, never the address itself
 *   - SupportAccess (unchanged, Issue #93): immutable by trigger, holds no credentials and no employee
 *     data; its reason is operator-authored text, kept like AuditLog and OperatorAuditLog
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
import { pathToFileURL } from "node:url";

import {
  ANONYMIZED_EMPLOYEE_WHERE,
  isAnonymizedEmployee,
} from "../src/contexts/platform/employee-anonymization-filter";

/** Email domain the app's anonymization writes (`platform/anonymize.ts`). */
const ANONYMIZED_EMAIL_DOMAIN = "@anonymized.local";

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

export function fakeName(index: number): { firstName: string; lastName: string } {
  const first = FIRST_NAMES[index % FIRST_NAMES.length];
  const last = LAST_NAMES[Math.floor(index / FIRST_NAMES.length) % LAST_NAMES.length];
  // If the pool ever wraps, append the index to keep names distinct.
  const suffix = index >= FIRST_NAMES.length * LAST_NAMES.length ? ` ${index}` : "";
  return { firstName: first, lastName: `${last}${suffix}` };
}

/** One employee row as the sweep reads it. */
export interface PseudonymizeTarget {
  id: string;
  userId: string | null;
  employeeNumber: string | null;
  firstName: string;
  lastName: string;
}

export interface PseudonymizeSweepResult {
  /** Employees that received a fake name. */
  processed: number;
  /** DSGVO-anonymized employees left with their name and employee number (Issue #805). */
  preserved: number;
}

/**
 * Pseudonymizes the given employees in stable order, one transaction each. A DSGVO-anonymized
 * employee (`isAnonymizedEmployee()`, the app's own rule) keeps name, employee number and its
 * already-anonymized user; only the leftover identifiers every employee loses (NFC id, WLAN MACs,
 * presence devices, auth tokens) are cleared for it as well.
 */
export async function pseudonymizeEmployees(
  prisma: PrismaClient,
  employees: PseudonymizeTarget[],
): Promise<PseudonymizeSweepResult> {
  let processed = 0;
  let preserved = 0;
  for (let i = 0; i < employees.length; i++) {
    const emp = employees[i];
    const keep = isAnonymizedEmployee(emp);
    // The index runs over ALL employees so a name stays stable whether or not a neighbour is preserved.
    const { firstName, lastName } = fakeName(i);
    await prisma.$transaction(async (tx) => {
      // Employee: fake name (unless anonymized) + drop NFC. id + employeeNumber left UNTOUCHED.
      await tx.employee.update({
        where: { id: emp.id },
        data: keep
          ? { nfcCardId: null, wifiMacs: [] }
          : { firstName, lastName, nfcCardId: null, wifiMacs: [] },
      });

      // Issue #388: enrolled WLAN devices (MAC addresses) must not travel to int either.
      await tx.presenceDevice.deleteMany({ where: { employeeId: emp.id } });

      // User (if any): pseudo email + disable login. isActive PRESERVED.
      if (emp.userId) {
        if (!keep) {
          const handle = emp.employeeNumber || emp.id.slice(0, 8);
          await tx.user.update({
            where: { id: emp.userId },
            data: {
              email: `int-${handle}@example.invalid`,
              passwordHash: "ANONYMIZED",
            },
          });
        } else {
          // Never re-personalize an anonymized user: keep its anonymized email. Only a legacy row
          // that still carries something else is brought to the app's anonymized form.
          const user = await tx.user.findUnique({
            where: { id: emp.userId },
            select: { email: true, passwordHash: true },
          });
          if (
            user &&
            (!user.email.endsWith(ANONYMIZED_EMAIL_DOMAIN) || user.passwordHash !== "ANONYMIZED")
          ) {
            await tx.user.update({
              where: { id: emp.userId },
              data: {
                email: `deleted-${emp.id.slice(0, 8)}${ANONYMIZED_EMAIL_DOMAIN}`,
                passwordHash: "ANONYMIZED",
              },
            });
          }
        }
        // Auth tokens — not retention-relevant, must not travel to int.
        await tx.otpToken.deleteMany({ where: { userId: emp.userId } });
        await tx.refreshToken.deleteMany({ where: { userId: emp.userId } });
      }
      await tx.invitation.deleteMany({ where: { employeeId: emp.id } });
    });
    if (keep) preserved++;
    else processed++;
  }
  return { processed, preserved };
}

async function main(prisma: PrismaClient) {
  const startedAt = Date.now();
  const runId = `pseudonymize-${new Date(startedAt).toISOString()}`;
  console.log(`[pseudonymize] starting run ${runId}`);

  // Anonymized persons before the run (same rule as the app) — must equal the count after.
  const anonymizedBefore = await prisma.employee.count({ where: ANONYMIZED_EMPLOYEE_WHERE });

  // Stable order → deterministic name assignment across re-runs.
  const employees = await prisma.employee.findMany({
    select: {
      id: true,
      userId: true,
      employeeNumber: true,
      firstName: true,
      lastName: true,
    },
    orderBy: { id: "asc" },
  });
  console.log(`[pseudonymize] found ${employees.length} employees`);

  const { processed, preserved } = await pseudonymizeEmployees(prisma, employees);

  // Operator accounts (Phase 88, D-11): neutralise every one. Per-row because the pseudonymous
  // email derives from the id; no delete, audit rows reference the accounts with onDelete Restrict.
  const operators = await prisma.operatorAccount.findMany({
    select: { id: true },
    orderBy: { id: "asc" },
  });
  for (const operator of operators) {
    await prisma.operatorAccount.update({
      where: { id: operator.id },
      data: {
        email: `operator-${operator.id.slice(0, 8)}@example.invalid`,
        passwordHash: "ANONYMIZED",
        isActive: false,
        totpSecretEnc: null,
        totpEnabledAt: null,
        lastTotpStep: null,
        recoveryCodeHashes: [],
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });
  }
  console.log(`[pseudonymize] neutralised ${operators.length} operator account(s)`);

  // ── Inline verification ──────────────────────────────────────────────────
  const realEmail = await prisma.user.count({
    where: {
      AND: [
        { NOT: { email: { endsWith: "@example.invalid" } } },
        // Users of preserved anonymized persons carry the app's anonymized email, no real address.
        { NOT: { email: { endsWith: ANONYMIZED_EMAIL_DOMAIN } } },
      ],
    },
  });
  const livePw = await prisma.user.count({ where: { NOT: { passwordHash: "ANONYMIZED" } } });
  const withNfc = await prisma.employee.count({ where: { NOT: { nfcCardId: null } } });
  const anonymizedAfter = await prisma.employee.count({ where: ANONYMIZED_EMPLOYEE_WHERE });
  const realOperatorEmails = await prisma.operatorAccount.count({
    where: { NOT: { email: { endsWith: "@example.invalid" } } },
  });
  const liveOperatorPasswords = await prisma.operatorAccount.count({
    where: { NOT: { passwordHash: "ANONYMIZED" } },
  });

  const durationMs = Date.now() - startedAt;
  await prisma.auditLog.create({
    data: {
      userId: null,
      action: "PSEUDONYMIZATION_RUN",
      entity: "Database",
      entityId: runId,
      newValue: {
        processed,
        preservedAnonymized: preserved,
        anonymizedBefore,
        anonymizedAfter,
        durationMs,
        checks: {
          residualRealEmails: realEmail,
          residualLivePasswords: livePw,
          residualNfc: withNfc,
          residualOperatorEmails: realOperatorEmails,
          residualOperatorPasswords: liveOperatorPasswords,
        },
      } as unknown as object,
    },
  });

  console.log(
    `[pseudonymize] pseudonymized ${processed}/${employees.length} employees in ${durationMs}ms`,
  );
  console.log(
    `[pseudonymize] verify → residual real emails=${realEmail}, live passwords=${livePw}, ` +
      `nfc set=${withNfc}`,
  );
  console.log(
    `[pseudonymize] verify → anonymized persons preserved=${preserved}, before=${anonymizedBefore}, ` +
      `after=${anonymizedAfter}`,
  );
  console.log(
    `[pseudonymize] verify → residual operator emails=${realOperatorEmails}, ` +
      `live operator passwords=${liveOperatorPasswords}`,
  );

  if (
    realEmail > 0 ||
    livePw > 0 ||
    withNfc > 0 ||
    realOperatorEmails > 0 ||
    liveOperatorPasswords > 0 ||
    anonymizedAfter !== anonymizedBefore ||
    preserved !== anonymizedBefore
  ) {
    console.error(
      "[pseudonymize] VERIFICATION FAILED — residual identifiers remain or the anonymized-person count changed. Do NOT swap.",
    );
    process.exitCode = 1;
  } else {
    console.log("[pseudonymize] ✓ PASS — names pseudonymized, logins/NFC disabled, IDs preserved.");
  }
}

async function run() {
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

  await main(prisma)
    .catch((err) => {
      console.error("[pseudonymize] fatal error:", err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
      await pool.end();
    });
}

// Run-guard: importing the module for tests opens no connection and pseudonymizes nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run();
}
