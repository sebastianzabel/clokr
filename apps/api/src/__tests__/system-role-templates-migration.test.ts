/**
 * Phase 76b (Issue #76) — the system-role-templates data migration, proven on REAL SQL execution
 * of the checked-in file (never a restatement of it), same discipline as
 * `legacy-role-migration-sql.ts` / `system-roles-migration.test.ts` for the 75b file.
 *
 * - Static shape (AK-76b-8, D-02): the file contains an `AccessRole` insert and
 *   `ON CONFLICT ("id") DO NOTHING`; its non-comment lines contain no `RoleAssignment` or
 *   `AuditLog` insert and no DDL (CREATE/ALTER/DROP) — it is data-only and never assigns the
 *   templates to anyone.
 * - Replay (D-02): `test:setup`'s own `prisma migrate deploy` already applied this file once to
 *   the template database, so BOTH executions here are replays of an idempotent insert. Neither
 *   changes the row counts of `AccessRole`, `RoleAssignment` or `AuditLog`, and neither touches the
 *   four template rows' `createdAt`/`updatedAt`. Deleting global rows first to simulate a "first
 *   run" is deliberately NOT done: other test files in the same worker database depend on them
 *   existing, and a crash mid-test would strand the worker (RESEARCH.md, D-02).
 * - Content drift (WR-02, code review): the "replaying the file twice" describe block below also
 *   asserts that the four migrated rows' `permissions` equal `SYSTEM_ROLE_PERMISSIONS`, in
 *   declaration order — co-located here so a reader of THIS file does not have to discover that
 *   the general proof lives in `system-roles-migration.test.ts`'s "(a) D-04 drift" test (Phase
 *   75b), which covers all seven global rows (three 75b system roles + these four 76b templates)
 *   only because `test:setup`'s `migrate deploy` applies both migrations to the same worker
 *   database before either test file runs — that file was written before this migration existed
 *   and was never specifically extended for it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp } from "./setup";
import {
  SYSTEM_ROLE_IDS,
  SYSTEM_ROLE_NAMES,
  SYSTEM_ROLE_PERMISSIONS,
  roleNameKey,
  type SystemRoleSlot,
} from "../contexts/platform";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root (same resolution as
// legacy-role-migration-sql.ts).
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS_ROOT = join(REPO_ROOT, "packages", "db", "prisma", "migrations");
const MIGRATION_DIR_SUFFIX = "_system_role_templates";

/**
 * Locates the migration directory by name SUFFIX (the timestamp prefix is not restated here) and
 * requires exactly one match: zero or several matches throw, naming what was found — an input
 * proof, so a renamed or duplicated migration can never make these tests run nothing
 * (mirrors `legacy-role-migration-sql.ts:31-44`).
 */
function locateMigrationDir(): string {
  const entries = readdirSync(MIGRATIONS_ROOT);
  if (entries.length === 0) {
    throw new Error(`system-role-templates migration: ${MIGRATIONS_ROOT} lists no entries at all`);
  }
  const matches = entries.filter((name) => name.endsWith(MIGRATION_DIR_SUFFIX));
  if (matches.length !== 1) {
    throw new Error(
      `system-role-templates migration: expected exactly one directory ending in ` +
        `"${MIGRATION_DIR_SUFFIX}" under ${MIGRATIONS_ROOT}, found ${matches.length}: ` +
        `${JSON.stringify(matches)}`,
    );
  }
  return matches[0];
}

/** The migration directory's name, e.g. `20260926074542_system_role_templates`. */
export const SYSTEM_ROLE_TEMPLATES_MIGRATION_DIR = locateMigrationDir();

const MIGRATION_PATH = join(MIGRATIONS_ROOT, SYSTEM_ROLE_TEMPLATES_MIGRATION_DIR, "migration.sql");

/**
 * The migration text, verbatim. Throws when it lacks the AccessRole insert — a file that lost its
 * role rows must fail loudly here, not be run as "nothing to do".
 */
function readMigrationSql(): string {
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  if (!sql.includes('INSERT INTO "AccessRole"')) {
    throw new Error(
      `system-role-templates migration: ${MIGRATION_PATH} does not contain an AccessRole insert`,
    );
  }
  return sql;
}

/** Non-comment lines only — a `--` comment may legitimately mention any of the checked keywords. */
function nonCommentText(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

describe("Phase 76b — system-role-templates migration, static shape (AK-76b-8, D-02)", () => {
  const sql = readMigrationSql();
  const body = nonCommentText(sql);

  it('contains an AccessRole insert with ON CONFLICT ("id") DO NOTHING', () => {
    expect(sql).toContain('INSERT INTO "AccessRole"');
    expect(sql).toContain('ON CONFLICT ("id") DO NOTHING');
  });

  it("is data-only: the non-comment text contains no DDL", () => {
    // Case-SENSITIVE on purpose (matches the acceptance-criteria grep): Prisma-generated DDL is
    // always uppercase, while lowercase "create" legitimately appears inside permission keys like
    // "employee:create:ZUGEWIESEN" — a case-insensitive check would misfire on those.
    expect(body).not.toMatch(/\b(CREATE|ALTER|DROP)\b/);
  });

  it("assigns nothing to anyone: no RoleAssignment or AuditLog insert (AK-76b-8)", () => {
    expect(body).not.toContain('INSERT INTO "RoleAssignment"');
    expect(body).not.toContain('INSERT INTO "AuditLog"');
  });
});

describe("Phase 76b — system-role-templates migration, replay (AK-76b-8, D-02)", () => {
  let app: FastifyInstance;
  const templateIds = [
    SYSTEM_ROLE_IDS.OWNER,
    SYSTEM_ROLE_IDS.SALON_MANAGER,
    SYSTEM_ROLE_IDS.HR,
    SYSTEM_ROLE_IDS.TRAINER,
  ];

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  async function countTables() {
    return {
      roles: await app.prisma.accessRole.count(),
      assignments: await app.prisma.roleAssignment.count(),
      audits: await app.prisma.auditLog.count(),
    };
  }

  it("replaying the file twice changes no AccessRole/RoleAssignment/AuditLog row or timestamp", async () => {
    const before = await app.prisma.accessRole.findMany({
      where: { id: { in: templateIds } },
      select: { id: true, createdAt: true, updatedAt: true },
      orderBy: { id: "asc" },
    });
    expect(before).toHaveLength(4);

    const countsBefore = await countTables();
    const sql = readMigrationSql();

    // test:setup already applied this file once to the template database — both executions
    // below are replays of the idempotent ON CONFLICT DO NOTHING insert, never a "first run".
    await app.prisma.$executeRawUnsafe(sql);
    const countsAfterFirst = await countTables();
    await app.prisma.$executeRawUnsafe(sql);
    const countsAfterSecond = await countTables();

    expect(countsAfterFirst).toEqual(countsBefore);
    expect(countsAfterSecond).toEqual(countsBefore);

    const after = await app.prisma.accessRole.findMany({
      where: { id: { in: templateIds } },
      select: { id: true, createdAt: true, updatedAt: true },
      orderBy: { id: "asc" },
    });
    expect(after).toEqual(before);
  });

  it("writes no AuditLog row referencing any of the four template ids", async () => {
    const count = await app.prisma.auditLog.count({ where: { entityId: { in: templateIds } } });
    expect(count).toBe(0);
  });

  it(
    "content drift (WR-02, code review): the four template rows' permissions equal " +
      "SYSTEM_ROLE_PERMISSIONS, in declaration order — the co-located counterpart to " +
      'system-roles-migration.test.ts\'s "(a) D-04 drift" test',
    async () => {
      const slots: SystemRoleSlot[] = ["OWNER", "SALON_MANAGER", "HR", "TRAINER"];
      const rows = await app.prisma.accessRole.findMany({
        where: { id: { in: templateIds } },
        orderBy: { id: "asc" },
      });
      expect(rows).toHaveLength(4);
      // a004..a007 sort lexically in slot-declaration order (same fact
      // system-roles-migration.test.ts relies on for all seven global rows, RESEARCH Pitfall 5) —
      // `templateIds` above is declared in that same order, so index-zipping is safe here too.
      const bySlot = slots.map((slot, i) => [slot, rows[i]] as const);
      for (const [slot, row] of bySlot) {
        expect(row.id).toBe(SYSTEM_ROLE_IDS[slot]);
        expect(row.tenantId).toBeNull();
        expect(row.name).toBe(SYSTEM_ROLE_NAMES[slot]);
        expect(row.nameKey).toBe(roleNameKey(SYSTEM_ROLE_NAMES[slot]));
        expect(row.permissions).toEqual([...SYSTEM_ROLE_PERMISSIONS[slot]]);
      }
    },
  );
});
