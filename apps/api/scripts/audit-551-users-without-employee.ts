/**
 * Audit tool — Issue #551.
 *
 * Since Issue #551 a User WITHOUT an Employee has no tenant and can no longer sign in: `requireAuth`
 * refuses a tenant token whose tenant id is blank (403 TENANT_REQUIRED), and login, verify-otp,
 * resend-otp, refresh and change-password refuse such a user before any token is issued. Before the
 * fix such a user (the legacy admin) could sign in and reached the API through the legacy-role
 * fallback with an empty tenant id (measured in 88-13). This script lists every such user so the
 * operator knows who loses the ability to sign in with the release.
 *
 * What it lists: per User without an Employee one line — user id, legacy role, isActive flag, the
 * number of OPEN refresh tokens (not revoked, not expired) and the number of role assignments (all
 * tenants). A totals line follows: users, active users, open refresh tokens, role assignments.
 *
 * READ-ONLY. ZERO mutations: only Prisma reads run, there is no write flag, and none may ever be
 * added. The output carries ids, the role, flags and counts only — no mail address and no name
 * (DSGVO); the script never selects those columns. Full, untruncated UUIDs, so each user can be
 * located directly.
 *
 * Operator step: run it ONCE on int and on prod BEFORE the #551 release is deployed. Every listed
 * ACTIVE user loses the ability to sign in with that release; give such a user an Employee first
 * (or accept the loss). `scripts/seed-int-admin.ts` picks only admins that have an Employee for the
 * same reason.
 *
 * Usage:
 *   DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \
 *     scripts/audit-551-users-without-employee.ts [--help]
 *
 * Exit codes:
 *   0 — no user without an Employee exists
 *   1 — DATABASE_URL missing, bad CLI, or a DB connection/query failure
 *   2 — one or more users without an Employee were listed (review before deploying)
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

// ── Exit codes ──────────────────────────────────────────────────────────────
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_FINDINGS = 2;

// ── CLI parsing ───────────────────────────────────────────────────────────────
export type CliArgs = { help: boolean };

export function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", default: false },
    },
    strict: true, // rejects any unknown flag, in particular --confirm / --apply
  });
  return { help: Boolean(values.help) };
}

export const USAGE = `
Usage:
  DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \\
    scripts/audit-551-users-without-employee.ts [--help]

READ-ONLY — lists every user without an Employee (Issue #551): user id, role, isActive, open
refresh tokens and role assignments, then a totals line. Ids and counts only, no personal data.
Run it on int and prod before deploying the release: every listed ACTIVE user can no longer sign in.
`;

/**
 * Exported for unit-testability — pass a PrismaClient to inject a test connection (run against the
 * worker test DB only); without one the CLI entrypoint below bootstraps its own connection from
 * DATABASE_URL.
 */
export async function main(argv: string[], injectedPrisma?: PrismaClient): Promise<number> {
  const args = parseCli(argv);

  if (args.help) {
    console.info(USAGE);
    return EXIT_OK;
  }

  if (!injectedPrisma && !process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    return EXIT_ERROR;
  }

  let pool: pg.Pool | undefined;
  let prisma: PrismaClient;
  if (injectedPrisma) {
    prisma = injectedPrisma;
  } else {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new PrismaPg(pool as any);
    prisma = new PrismaClient({ adapter });
  }

  try {
    const now = new Date();
    // Only the id, role and isActive columns are selected, plus two relation counts.
    const users = await prisma.user.findMany({
      where: { employee: { is: null } },
      select: {
        id: true,
        role: true,
        isActive: true,
        _count: {
          select: {
            refreshTokens: { where: { revokedAt: null, expiresAt: { gt: now } } },
            roleAssignments: true,
          },
        },
      },
      orderBy: { id: "asc" },
    });

    let activeUsers = 0;
    let openRefreshTokens = 0;
    let roleAssignments = 0;
    for (const user of users) {
      const open = user._count.refreshTokens;
      const assignments = user._count.roleAssignments;
      if (user.isActive) activeUsers += 1;
      openRefreshTokens += open;
      roleAssignments += assignments;
      console.info(
        `userId=${user.id} role=${user.role} isActive=${user.isActive} ` +
          `openRefreshTokens=${open} roleAssignments=${assignments}`,
      );
    }

    console.info(
      `Totals: users=${users.length} activeUsers=${activeUsers} ` +
        `openRefreshTokens=${openRefreshTokens} roleAssignments=${roleAssignments}`,
    );
    if (users.length === 0) {
      console.info("No user without an Employee found.");
    } else {
      console.info(
        "Every listed ACTIVE user can no longer sign in once the #551 release is deployed. " +
          "This script writes nothing.",
      );
    }

    return users.length > 0 ? EXIT_FINDINGS : EXIT_OK;
  } finally {
    if (!injectedPrisma) {
      await prisma.$disconnect();
      await pool?.end();
    }
  }
}

// Run-guard: only bootstrap the DB + execute when invoked as a script, so importing the module
// for unit tests is side-effect-free (no connection, no process.exit).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = EXIT_ERROR;
    });
}
