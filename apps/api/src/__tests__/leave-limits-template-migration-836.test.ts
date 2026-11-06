/**
 * Phase 836 (Issue #836) — the data-only migration that gives the global templates Admin, Inhaber
 * and Salonmanager `leave-limit:manage:ZUGEWIESEN`, proven on REAL SQL execution of the checked-in
 * file (never a restatement of it), same discipline as `hr-template-migration-86.test.ts`.
 *
 * The role set is a proposal (owner confirmation pending before the merge). If it changes, this
 * file's `GRANTED_SLOTS` and the migration change together — nothing else of the phase moves.
 *
 * - Static shape: three `UPDATE "AccessRole"` statements, one per granted slot id and no other
 *   system-role id, each with `"tenantId" IS NULL` and an `IS DISTINCT FROM` guard; no DDL, no
 *   RoleAssignment/AuditLog insert. Both ARRAY literals of every statement equal
 *   `SYSTEM_ROLE_PERMISSIONS.<slot>` element by element, in catalog order.
 * - Replay: `test:setup`'s `prisma migrate deploy` already applied the file once, so both
 *   executions here are replays; neither changes a row count nor any `updatedAt` of a global row.
 * - Customer copy: a tenant-owned copy of the Salonmanager template (old 24 keys) is not touched
 *   by the replay.
 * - Content drift: each migrated row equals its constant.
 *
 * Mutation proof (run locally, then undone): removing `leave-limit:manage:ZUGEWIESEN` from one
 * ARRAY of the migration file turns the "array equals the constant" case red for that slot.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import {
  SYSTEM_ROLE_IDS,
  SYSTEM_ROLE_PERMISSIONS,
  normalizeRolePermissions,
  roleNameKey,
} from "../contexts/platform";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS_ROOT = join(REPO_ROOT, "packages", "db", "prisma", "migrations");
const MIGRATION_DIR_SUFFIX = "_leave_limit_template_grant";
const KEY = "leave-limit:manage:ZUGEWIESEN";

/** The slots that receive the key (Admin and Inhaber are fixed by the template invariants). */
const GRANTED_SLOTS = ["ADMIN", "OWNER", "SALON_MANAGER"] as const;

/** Locates the migration directory by name suffix; zero or several matches throw (input proof). */
function locateMigrationDir(): string {
  const entries = readdirSync(MIGRATIONS_ROOT);
  if (entries.length === 0) {
    throw new Error(`leave limit template migration: ${MIGRATIONS_ROOT} lists no entries at all`);
  }
  const matches = entries.filter((name) => name.endsWith(MIGRATION_DIR_SUFFIX));
  if (matches.length !== 1) {
    throw new Error(
      `leave limit template migration: expected exactly one directory ending in ` +
        `"${MIGRATION_DIR_SUFFIX}" under ${MIGRATIONS_ROOT}, found ${matches.length}: ` +
        JSON.stringify(matches),
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
      `leave limit template migration: ${MIGRATION_PATH} does not contain an AccessRole update`,
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

/** The statements of the file, one per `UPDATE "AccessRole"`, comments removed. */
function statementsOf(body: string): string[] {
  return body
    .split('UPDATE "AccessRole"')
    .slice(1)
    .map((s) => 'UPDATE "AccessRole"' + s);
}

function keysOf(arrayText: string): string[] {
  return [...arrayText.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe("Phase 836 — leave limit template migration, static shape (#836)", () => {
  const sql = readMigrationSql();
  const body = nonCommentText(sql);
  const statements = statementsOf(body);

  it("sorts after the leave limit rule migrations and after the 76b template migration (input proof)", () => {
    const dirs = readdirSync(MIGRATIONS_ROOT).filter((n) => n !== "migration_lock.toml");
    expect(dirs.length).toBeGreaterThan(1);
    const rule = dirs.filter((n) => n.endsWith("_leave_limit_rule_checks"));
    expect(rule, "exactly one leave_limit_rule_checks directory").toHaveLength(1);
    expect(MIGRATION_DIR > rule[0]).toBe(true);
    const templates = dirs.filter((n) => n.endsWith("_system_role_templates"));
    expect(templates, "exactly one 76b migration directory").toHaveLength(1);
    expect(MIGRATION_DIR > templates[0]).toBe(true);
  });

  it("has exactly three UPDATEs of AccessRole, one per granted slot id, no other system role", () => {
    expect(statements).toHaveLength(GRANTED_SLOTS.length);
    expect(body.match(/UPDATE "AccessRole"/g)).toHaveLength(GRANTED_SLOTS.length);
    for (const slot of GRANTED_SLOTS) {
      const own = statements.filter((s) => s.includes(`WHERE "id" = '${SYSTEM_ROLE_IDS[slot]}'`));
      expect(own, slot).toHaveLength(1);
    }
    const otherIds = Object.entries(SYSTEM_ROLE_IDS)
      .filter(([slot]) => !(GRANTED_SLOTS as readonly string[]).includes(slot))
      .map(([, id]) => id);
    for (const id of otherIds) expect(body).not.toContain(id);
  });

  it("every UPDATE is aimed at global rows only and guarded by IS DISTINCT FROM", () => {
    for (const s of statements) {
      expect(s).toContain('"tenantId" IS NULL');
      expect(s).toContain("IS DISTINCT FROM");
    }
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

  it("both ARRAY literals of each UPDATE equal SYSTEM_ROLE_PERMISSIONS.<slot>, in catalog order", () => {
    for (const slot of GRANTED_SLOTS) {
      const statement = statements.find((s) =>
        s.includes(`WHERE "id" = '${SYSTEM_ROLE_IDS[slot]}'`),
      );
      const arrays = [...(statement ?? "").matchAll(/ARRAY\[([\s\S]*?)\]::text\[\]/g)].map((m) =>
        keysOf(m[1]),
      );
      // SET list and the IS DISTINCT FROM comparison.
      expect(arrays, slot).toHaveLength(2);
      for (const keys of arrays) {
        expect(keys, slot).toEqual([...SYSTEM_ROLE_PERMISSIONS[slot]]);
        expect(keys, slot).toContain(KEY);
      }
    }
  });

  it("the key is named in no other statement than the granted ones (three ids, six arrays)", () => {
    expect(body.match(new RegExp(KEY, "g"))).toHaveLength(GRANTED_SLOTS.length * 2);
  });
});

describe("Phase 836 — leave limit template migration, replay and content drift (#836)", () => {
  let app: FastifyInstance;
  let tenantId: string | null = null;
  const globalIds = Object.values(SYSTEM_ROLE_IDS);

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    if (tenantId) await cleanupTestData(app, tenantId);
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

  it("a tenant-owned copy of the Salonmanager template is not changed by the replay", async () => {
    const data = await seedTestData(app, "lltm836");
    tenantId = data.tenant.id;
    const oldKeys = SYSTEM_ROLE_PERMISSIONS.SALON_MANAGER.filter((k) => k !== KEY);
    expect(oldKeys).toHaveLength(24);
    const name = "Salonmanager Kopie 836";
    const copy = await app.prisma.accessRole.create({
      data: {
        tenantId: data.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(oldKeys),
      },
    });

    await app.prisma.$executeRawUnsafe(readMigrationSql());

    const after = await app.prisma.accessRole.findUniqueOrThrow({ where: { id: copy.id } });
    expect(after.permissions).toEqual([...oldKeys]);
    expect(after.permissions).not.toContain(KEY);
    expect(after.updatedAt).toEqual(copy.updatedAt);
  });

  it("writes no AuditLog row referencing a granted template id", async () => {
    for (const slot of GRANTED_SLOTS) {
      const count = await app.prisma.auditLog.count({ where: { entityId: SYSTEM_ROLE_IDS[slot] } });
      expect(count, slot).toBe(0);
    }
  });

  it("content drift: each migrated row holds the key and equals its constant, in order", async () => {
    for (const slot of GRANTED_SLOTS) {
      const row = await app.prisma.accessRole.findUniqueOrThrow({
        where: { id: SYSTEM_ROLE_IDS[slot] },
      });
      expect(row.tenantId, slot).toBeNull();
      expect(row.permissions, slot).toEqual([...SYSTEM_ROLE_PERMISSIONS[slot]]);
      expect(row.permissions, slot).toContain(KEY);
    }
  });

  it("the roles that do not get the key do not hold it, and each equals its constant", async () => {
    const rows = await globalRows();
    for (const [slot, id] of Object.entries(SYSTEM_ROLE_IDS)) {
      const row = rows.find((r) => r.id === id);
      expect(row, slot).toBeDefined();
      expect(row?.permissions, slot).toEqual([
        ...SYSTEM_ROLE_PERMISSIONS[slot as keyof typeof SYSTEM_ROLE_PERMISSIONS],
      ]);
      const granted = (GRANTED_SLOTS as readonly string[]).includes(slot);
      expect(row?.permissions.includes(KEY), slot).toBe(granted);
    }
  });
});
