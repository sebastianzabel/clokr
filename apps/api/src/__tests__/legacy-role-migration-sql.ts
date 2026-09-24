/**
 * Phase 75b (Issue #75) — the ONE way tests run the checked-in legacy-role migration.
 *
 * The data migration `<timestamp>_system_roles_and_legacy_role_assignments` inserts the three
 * system roles and gives every eligible existing user one TENANT assignment on the system role of
 * their legacy `User.role`. It is idempotent (D-07), so tests execute the REAL file — never a
 * restatement of it — against their fixtures: the migration's own tests, and the neutrality
 * recording of plans 75b-02/03, which runs it in both RECORD and VERIFY mode (D-25).
 *
 * `test:setup` already applied the file once to the (then user-less) template database, so the
 * three system roles exist in every worker database. Executing it again inside a test backfills the
 * users that exist at that moment — including leftover users of other suites in the same worker
 * database, which is harmless by design (idempotent; `cleanupTestData` deletes users first, and the
 * user cascade removes their assignments).
 *
 * The directory is located by its name SUFFIX (the timestamp prefix is not restated here), and
 * exactly one match is required: zero or several matches throw, naming what was found — an input
 * proof, so a renamed or duplicated migration can never make these tests run nothing.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@clokr/db";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root (same resolution as
// salon-migration.test.ts and t100-09-oracle-probe.test.ts).
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS_ROOT = join(REPO_ROOT, "packages", "db", "prisma", "migrations");
const MIGRATION_DIR_SUFFIX = "_system_roles_and_legacy_role_assignments";

function locateMigrationDir(): string {
  const entries = readdirSync(MIGRATIONS_ROOT);
  if (entries.length === 0) {
    throw new Error(`legacy-role migration: ${MIGRATIONS_ROOT} lists no entries at all`);
  }
  const matches = entries.filter((name) => name.endsWith(MIGRATION_DIR_SUFFIX));
  if (matches.length !== 1) {
    throw new Error(
      `legacy-role migration: expected exactly one directory ending in "${MIGRATION_DIR_SUFFIX}" ` +
        `under ${MIGRATIONS_ROOT}, found ${matches.length}: ${JSON.stringify(matches)}`,
    );
  }
  return matches[0];
}

/** The migration directory's name, e.g. `20260925003815_system_roles_and_legacy_role_assignments`. */
export const LEGACY_ROLE_MIGRATION_DIR = locateMigrationDir();

const MIGRATION_PATH = join(MIGRATIONS_ROOT, LEGACY_ROLE_MIGRATION_DIR, "migration.sql");

/**
 * The migration text, verbatim. Throws when it lacks either INSERT — a file that lost its role
 * rows or its backfill must fail loudly here, not be run as "nothing to do".
 */
export function readLegacyRoleMigrationSql(): string {
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  for (const required of ['INSERT INTO "AccessRole"', 'INSERT INTO "RoleAssignment"']) {
    if (!sql.includes(required)) {
      throw new Error(`legacy-role migration: ${MIGRATION_PATH} does not contain ${required}`);
    }
  }
  return sql;
}

/**
 * Runs the migration file verbatim through Prisma. Without parameters, `@prisma/adapter-pg` sends
 * the text through the pg simple-query protocol, which accepts several statements and a `DO $$`
 * block in one call (75b-RESEARCH Q7). The returned count is meaningless for multi-statement text
 * and is deliberately not exposed. Notices are not surfaced on this path — see
 * `executeLegacyRoleMigrationCapturingNotices`.
 */
export async function executeLegacyRoleMigration(
  prisma: Pick<PrismaClient, "$executeRawUnsafe">,
): Promise<void> {
  await prisma.$executeRawUnsafe(readLegacyRoleMigrationSql());
}
