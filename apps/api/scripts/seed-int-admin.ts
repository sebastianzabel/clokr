/**
 * Restores a usable ADMIN login after a prod → int data refresh.
 *
 * `pseudonymize-dump.ts` sets EVERY `User.passwordHash` to the literal
 * "ANONYMIZED" so no real prod credential survives onto the internet-reachable
 * int environment. That is correct — but it also means nobody can log in to int
 * afterwards. This script closes that gap; it is step 8 ("Restore an admin
 * login") of `docs/data-refresh-process.md`.
 *
 * It does NOT create a new person: it re-enables an EXISTING ADMIN user, so the
 * employee/tenant wiring stays exactly as the refreshed data has it. Which user
 * is picked is deterministic (lowest id among active ADMINs) unless --email pins
 * one explicitly.
 *
 * If the picked admin's tenant has 2FA enabled, a fresh password alone will not
 * be enough to log in (`POST /auth/login` returns 202 `{ requiresOtp: true }`
 * and mails the code to the pseudonymized, undeliverable `@example.invalid`
 * address). Pass --disable-2fa to turn the tenant's 2FA off as part of this run
 * (logged via AuditLog) — otherwise the script only warns and leaves it alone.
 *
 * Usage — against the int DB via the port-forward from the refresh process:
 *   DATABASE_URL=postgresql://clokr:...@localhost:5433/clokr \
 *     pnpm --filter @clokr/api exec tsx scripts/seed-int-admin.ts
 *
 *   # pin a specific admin, and/or supply the password instead of generating one
 *   ... scripts/seed-int-admin.ts --email int-admin@example.invalid --password 'hunter2'
 *
 *   # also disable the tenant's 2FA requirement so the restored password works alone
 *   ... scripts/seed-int-admin.ts --disable-2fa
 *
 * Prints the resulting email + password once. Exits 0 on success, 1 on failure.
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import pg from "pg";

if (!process.env.DATABASE_URL) {
  console.error("[seed-int-admin] DATABASE_URL is required");
  process.exit(1);
}

// Safety rail: same shape as pseudonymize-dump.ts. This script WRITES a known
// password — running it against production would hand out a live credential.
if (/@clokr-db|prod-host|zeit\.a-tenant/i.test(process.env.DATABASE_URL)) {
  console.error("[seed-int-admin] refusing to run against what looks like a production DSN");
  process.exit(1);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Boolean flags have no following value — `arg()` would read the next flag/argv item instead. */
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** 24 chars of url-safe entropy — long enough that it need not be rotated in a hurry. */
function generatePassword(): string {
  return crypto.randomBytes(18).toString("base64url");
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    const pinnedEmail = arg("email");
    const password = arg("password") ?? generatePassword();
    const disable2fa = hasFlag("disable-2fa");

    const user = pinnedEmail
      ? await prisma.user.findUnique({
          where: { email: pinnedEmail },
          include: {
            employee: {
              select: {
                tenantId: true,
                tenant: { select: { config: { select: { twoFaEnabled: true } } } },
              },
            },
          },
        })
      : await prisma.user.findFirst({
          where: { role: "ADMIN", isActive: true },
          orderBy: { id: "asc" },
          include: {
            employee: {
              select: {
                tenantId: true,
                tenant: { select: { config: { select: { twoFaEnabled: true } } } },
              },
            },
          },
        });

    if (!user) {
      console.error(
        pinnedEmail
          ? `[seed-int-admin] no user with email ${pinnedEmail}`
          : "[seed-int-admin] no active ADMIN user found — is the database refreshed?",
      );
      process.exitCode = 1;
      return;
    }
    if (user.role !== "ADMIN") {
      console.error(`[seed-int-admin] ${user.email} has role ${user.role}, expected ADMIN`);
      process.exitCode = 1;
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await bcrypt.hash(password, 12),
        isActive: true,
        // `lockedUntil` is checked BEFORE the password comparison and returns 423
        // regardless of how correct the new password is (auth.ts) — a locked
        // prod admin would otherwise stay locked out after this script "succeeds".
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    // Prove the stored hash actually validates, rather than trusting the write.
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!(await bcrypt.compare(password, stored.passwordHash))) {
      console.error("[seed-int-admin] verification failed — stored hash does not match");
      process.exitCode = 1;
      return;
    }

    console.log("[seed-int-admin] ✓ login restored");
    console.log(`  email:    ${stored.email}`);
    console.log(`  password: ${password}`);
    console.log("  Change it in the app if this environment is shared.");

    const tenantId = user.employee?.tenantId;
    const twoFaEnabled = user.employee?.tenant?.config?.twoFaEnabled ?? false;

    if (twoFaEnabled && !disable2fa) {
      console.warn("");
      console.warn("[seed-int-admin] WARNING: this admin's tenant has 2FA enabled.");
      console.warn("  The restored password alone will NOT log you in — POST /auth/login");
      console.warn("  returns 202 { requiresOtp: true } and mails the code to the pseudonymized,");
      console.warn("  undeliverable *@example.invalid address, so the code cannot arrive.");
      console.warn("  Two ways forward:");
      console.warn("    1. Re-run this script with --disable-2fa, or");
      console.warn("    2. Read the OTP code hash out of the OtpToken table directly.");
      console.warn("");
    } else if (disable2fa) {
      if (!twoFaEnabled) {
        console.log(
          "[seed-int-admin] --disable-2fa given, but 2FA is already off — nothing changed.",
        );
      } else if (!tenantId) {
        console.warn(
          "[seed-int-admin] --disable-2fa given, but no tenant could be resolved for this user — nothing changed.",
        );
      } else {
        await prisma.tenantConfig.update({
          where: { tenantId },
          data: { twoFaEnabled: false },
        });
        // Revisionssicherheit: a tenant security setting must never change unlogged.
        await prisma.auditLog.create({
          data: {
            userId: null,
            action: "TENANT_CONFIG_UPDATED",
            entity: "TenantConfig",
            entityId: tenantId,
            oldValue: { twoFaEnabled: true },
            newValue: { twoFaEnabled: false },
          },
        });
        console.log(`[seed-int-admin] 2FA disabled for tenantId=${tenantId} (AuditLog written).`);
      }
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((e) => {
  console.error("[seed-int-admin] fatal error:", e);
  process.exitCode = 1;
});
