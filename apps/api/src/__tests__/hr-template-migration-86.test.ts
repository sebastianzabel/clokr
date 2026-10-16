/**
 * Phase 86b (Issue #86, owner decision 16.10.2026) — the data-only migration that widens the global
 * Personalabteilung template by `salon:read` and `report:read`, proven on REAL SQL execution of the
 * checked-in file (never a restatement of it), same discipline as
 * `system-role-templates-migration.test.ts` for the 76b file.
 *
 * - Static shape: the file contains one `UPDATE "AccessRole"` that targets only the HR id with
 *   `"tenantId" IS NULL`, is guarded by `IS DISTINCT FROM` (a replay changes no timestamp), and whose
 *   non-comment text has no DDL and no RoleAssignment/AuditLog insert. The 15 keys of its array equal
 *   `SYSTEM_ROLE_PERMISSIONS.HR`, in order.
 * - Replay: `test:setup`'s own `prisma migrate deploy` already applied the file once, so both
 *   executions here are replays. Neither changes a row count nor the `updatedAt` of the HR row or of
 *   any other global row.
 * - Content drift: the migrated HR row equals `SYSTEM_ROLE_PERMISSIONS.HR`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp } from "./setup";
import { SYSTEM_ROLE_IDS, SYSTEM_ROLE_PERMISSIONS } from "../contexts/platform";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS_ROOT = join(REPO_ROOT, "packages", "db", "prisma", "migrations");
// Must NOT equal the 76b suffix `_system_role_templates` (that locator needs exactly one match).
const MIGRATION_DIR_SUFFIX = "_hr_template_report_salon_read";

/** Locates the migration directory by name suffix; zero or several matches throw (input proof). */
function locateMigrationDir(): string {
  const entries = readdirSync(MIGRATIONS_ROOT);
  if (entries.length === 0) {
    throw new Error(`hr template migration: ${MIGRATIONS_ROOT} lists no entries at all`);
  }
  const matches = entries.filter((name) => name.endsWith(MIGRATION_DIR_SUFFIX));
  if (matches.length !== 1) {
    throw new Error(
      `hr template migration: expected exactly one directory ending in "${MIGRATION_DIR_SUFFIX}" ` +
        `under ${MIGRATIONS_ROOT}, found ${matches.length}: ${JSON.stringify(matches)}`,
    );
  }
  return matches[0];
}

const MIGRATION_DIR = locateMigrationDir();
const MIGRATION_PATH = join(MIGRATIONS_ROOT, MIGRATION_DIR, "migration.sql");

function readMigrationSql(): string {
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  if (!sql.includes('UPDATE "AccessRole"')) {
    throw new Error(
      `hr template migration: ${MIGRATION_PATH} does not contain an AccessRole update`,
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

describe("Phase 86b — HR template migration, static shape (#86)", () => {
  const sql = readMigrationSql();
  const body = nonCommentText(sql);

  it("sorts after every other migration directory (input proof)", () => {
    const dirs = readdirSync(MIGRATIONS_ROOT).filter((n) => n !== "migration_lock.toml");
    expect(dirs.length).toBeGreaterThan(1);
    const last = [...dirs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).pop();
    expect(last).toBe(MIGRATION_DIR);
  });

  it("has exactly one UPDATE of AccessRole, aimed at the global HR row only", () => {
    expect(body.match(/UPDATE "AccessRole"/g)).toHaveLength(1);
    expect(body).toContain(`'${SYSTEM_ROLE_IDS.HR}'`);
    expect(body).toContain('"tenantId" IS NULL');
    // No other row id of a system role may be named.
    const otherIds = Object.entries(SYSTEM_ROLE_IDS)
      .filter(([slot]) => slot !== "HR")
      .map(([, id]) => id);
    for (const id of otherIds) expect(body).not.toContain(id);
  });

  it("is guarded by IS DISTINCT FROM so a replay changes no row and no timestamp", () => {
    expect(body).toContain("IS DISTINCT FROM");
  });

  it("is data-only: the non-comment text contains no DDL", () => {
    // Case-SENSITIVE on purpose: Prisma DDL is uppercase, lowercase "create" appears in keys such
    // as "employee:create:ZUGEWIESEN".
    expect(body).not.toMatch(/\b(CREATE|ALTER|DROP)\b/);
  });

  it("assigns nothing to anyone: no RoleAssignment or AuditLog insert", () => {
    expect(body).not.toContain('INSERT INTO "RoleAssignment"');
    expect(body).not.toContain('INSERT INTO "AuditLog"');
  });

  it("its array holds exactly the keys of SYSTEM_ROLE_PERMISSIONS.HR, in catalog order", () => {
    const arrayText = body.match(/ARRAY\[([\s\S]*?)\]::text\[\]/);
    expect(arrayText, "the UPDATE carries a text[] array literal").not.toBeNull();
    const keys = [...(arrayText?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(keys).toEqual([...SYSTEM_ROLE_PERMISSIONS.HR]);
    expect(keys).toHaveLength(15);
  });
});

describe("Phase 86b — HR template migration, replay and content drift (#86)", () => {
  let app: FastifyInstance;
  const globalIds = Object.values(SYSTEM_ROLE_IDS);

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

  function globalRows() {
    return app.prisma.accessRole.findMany({
      where: { id: { in: globalIds } },
      select: { id: true, permissions: true, createdAt: true, updatedAt: true },
      orderBy: { id: "asc" },
    });
  }

  it("replaying the file twice changes no row count and no timestamp of any global role", async () => {
    const before = await globalRows();
    expect(before).toHaveLength(7);
    const countsBefore = await countTables();
    const sql = readMigrationSql();

    // test:setup already applied the file once — both executions are replays, never a first run.
    await app.prisma.$executeRawUnsafe(sql);
    const countsAfterFirst = await countTables();
    await app.prisma.$executeRawUnsafe(sql);
    const countsAfterSecond = await countTables();

    expect(countsAfterFirst).toEqual(countsBefore);
    expect(countsAfterSecond).toEqual(countsBefore);
    expect(await globalRows()).toEqual(before);
  });

  it("writes no AuditLog row referencing the HR template id", async () => {
    const count = await app.prisma.auditLog.count({ where: { entityId: SYSTEM_ROLE_IDS.HR } });
    expect(count).toBe(0);
  });

  it("content drift: the migrated HR row equals SYSTEM_ROLE_PERMISSIONS.HR, in order", async () => {
    const row = await app.prisma.accessRole.findUniqueOrThrow({
      where: { id: SYSTEM_ROLE_IDS.HR },
    });
    expect(row.tenantId).toBeNull();
    expect(row.permissions).toEqual([...SYSTEM_ROLE_PERMISSIONS.HR]);
    expect(row.permissions).toHaveLength(15);
  });

  it("the migration moved no other global role: each equals its constant", async () => {
    const rows = await globalRows();
    for (const [slot, id] of Object.entries(SYSTEM_ROLE_IDS)) {
      const row = rows.find((r) => r.id === id);
      expect(row, slot).toBeDefined();
      expect(row?.permissions, slot).toEqual([
        ...SYSTEM_ROLE_PERMISSIONS[slot as keyof typeof SYSTEM_ROLE_PERMISSIONS],
      ]);
    }
  });
});
