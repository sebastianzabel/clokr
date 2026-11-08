/**
 * Issue #835 (D-835-20, owner decision 06.11.2026) — the data-only migration that gives the global
 * templates Admin, Inhaber and Salonmanager `leave-plan:manage:ZUGEWIESEN`, proven on REAL SQL
 * execution of the checked-in file (never a restatement of it), same discipline as
 * `leave-limits-template-migration-836.test.ts` — built on `template-grant-chain.ts` from the start
 * so the next grant moves one chain entry and no line here.
 *
 * - Static shape: three `UPDATE "AccessRole"` statements, one per granted slot id and no other
 *   system-role id, each with `"tenantId" IS NULL` and an `IS DISTINCT FROM` guard; no DDL, no
 *   RoleAssignment/AuditLog insert. Both ARRAY literals of every statement equal the slot's
 *   template as of this migration (`templateAsOf`), element by element, in catalog order.
 * - Replay: inside a transaction that is ALWAYS rolled back. The file alone is idempotent (its
 *   second execution affects no row), and replaying the #836 file and then this one leaves every
 *   global row equal to its live constant; nothing outside the transaction changes.
 * - Customer copy: a tenant-owned copy of the Salonmanager template (as of the #836 grant, 25
 *   keys) keeps its permissions and its `updatedAt` through the replay.
 * - Content drift: Admin, Inhaber and Salonmanager hold the key and equal their constants; the
 *   other four system roles (Manager legacy, Mitarbeiter, Personalabteilung, Ausbilder) do not hold
 *   it and equal theirs.
 *
 * Mutation proof (run locally, then undone with cp, Phase 835-03): removing
 * `leave-plan:manage:ZUGEWIESEN` from one ARRAY of the migration file turned three cases red: "both
 * ARRAY literals ... equal the slot's template", "the key is named ... (three ids, six arrays)" and
 * the chain-replay case (the replayed row no longer equals its live constant). The content-drift
 * cases read the live rows and stay green by design.
 */
import { readdirSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import {
  MIGRATIONS_ROOT,
  grantMigrationSql,
  locateGrantDir,
  replayChainFrom,
  templateAsOf,
  withRolledBackTransaction,
} from "./template-grant-chain";
import {
  SYSTEM_ROLE_IDS,
  SYSTEM_ROLE_PERMISSIONS,
  normalizeRolePermissions,
  roleNameKey,
} from "../contexts/platform";

const MIGRATION_DIR_SUFFIX = "_leave_plan_template_grant";
const PREVIOUS_DIR_SUFFIX = "_leave_limit_template_grant";
const KEY = "leave-plan:manage:ZUGEWIESEN";

/** The slots that receive the key (Admin and Inhaber are fixed by the template invariants). */
const GRANTED_SLOTS = ["ADMIN", "OWNER", "SALON_MANAGER"] as const;

const MIGRATION_DIR = locateGrantDir(MIGRATION_DIR_SUFFIX);

function readMigrationSql(): string {
  const sql = grantMigrationSql(MIGRATION_DIR_SUFFIX);
  if (!sql.includes('UPDATE "AccessRole"')) {
    throw new Error(`leave plan template migration: ${MIGRATION_DIR} has no AccessRole update`);
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
  return [...arrayText.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe("Issue #835 — leave plan template migration, static shape", () => {
  const sql = readMigrationSql();
  const body = nonCommentText(sql);
  const statements = statementsOf(body);

  it("sorts after the leave plan tables and after the #836 template migration (input proof)", () => {
    const dirs = readdirSync(MIGRATIONS_ROOT).filter((n) => n !== "migration_lock.toml");
    expect(dirs.length).toBeGreaterThan(1);
    const tables = dirs.filter((n) => n.endsWith("_leave_plan"));
    expect(tables, "exactly one leave_plan directory").toHaveLength(1);
    expect(MIGRATION_DIR > tables[0]!).toBe(true);
    expect(MIGRATION_DIR > locateGrantDir(PREVIOUS_DIR_SUFFIX)).toBe(true);
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
    expect(otherIds).toHaveLength(4);
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

  it("both ARRAY literals of each UPDATE equal the slot's template as of this migration, in catalog order", () => {
    for (const slot of GRANTED_SLOTS) {
      const statement = statements.find((s) =>
        s.includes(`WHERE "id" = '${SYSTEM_ROLE_IDS[slot]}'`),
      );
      const arrays = [...(statement ?? "").matchAll(/ARRAY\[([\s\S]*?)\]::text\[\]/g)].map((m) =>
        keysOf(m[1]!),
      );
      // SET list and the IS DISTINCT FROM comparison.
      expect(arrays, slot).toHaveLength(2);
      for (const keys of arrays) {
        expect(keys, slot).toEqual(templateAsOf(slot, MIGRATION_DIR_SUFFIX));
        expect(keys, slot).toContain(KEY);
      }
    }
  });

  it("the key is named in no other statement than the granted ones (three ids, six arrays)", () => {
    expect(body.match(new RegExp(KEY, "g"))).toHaveLength(GRANTED_SLOTS.length * 2);
  });
});

describe("Issue #835 — leave plan template migration, replay and content drift", () => {
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

  it("replaying the #836 and the #835 files in order leaves every global row equal to its live constant, and nothing outside the transaction changes", async () => {
    const before = await globalRows();
    expect(before).toHaveLength(7);
    const countsBefore = await countTables();

    const observed = await withRolledBackTransaction(app.prisma, async (tx) => {
      await replayChainFrom(tx, PREVIOUS_DIR_SUFFIX);
      return {
        counts: {
          roles: await tx.accessRole.count(),
          assignments: await tx.roleAssignment.count(),
          audits: await tx.auditLog.count(),
        },
        rows: await tx.accessRole.findMany({
          where: { id: { in: globalIds } },
          select: { id: true, permissions: true },
          orderBy: { id: "asc" },
        }),
      };
    });

    expect(observed.counts).toEqual(countsBefore);
    for (const row of observed.rows) {
      const slot = Object.entries(SYSTEM_ROLE_IDS).find(
        ([, id]) => id === row.id,
      )![0] as keyof typeof SYSTEM_ROLE_PERMISSIONS;
      expect(row.permissions, slot).toEqual([...SYSTEM_ROLE_PERMISSIONS[slot]]);
    }
    expect(await globalRows()).toEqual(before);
    expect(await countTables()).toEqual(countsBefore);
  });

  it("the file alone is idempotent: its second execution affects no row", async () => {
    const updates = statementsOf(nonCommentText(readMigrationSql()));
    const affected = await withRolledBackTransaction(app.prisma, async (tx) => {
      // test:setup's migrate deploy applied the file already, so even the first execution here is
      // a replay; the second is asserted too so the proof does not depend on that.
      for (const statement of updates) await tx.$executeRawUnsafe(statement);
      const second: number[] = [];
      for (const statement of updates) second.push(await tx.$executeRawUnsafe(statement));
      return second;
    });
    expect(affected).toEqual(updates.map(() => 0));
  });

  it("a tenant-owned copy of the Salonmanager template keeps its permissions and updatedAt through the replay", async () => {
    const data = await seedTestData(app, "lptm835");
    tenantId = data.tenant.id;
    const oldKeys = templateAsOf("SALON_MANAGER", PREVIOUS_DIR_SUFFIX);
    expect(oldKeys).toHaveLength(25);
    expect(oldKeys).not.toContain(KEY);
    const name = "Salonmanager Kopie 835";
    const copy = await app.prisma.accessRole.create({
      data: {
        tenantId: data.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(oldKeys),
      },
    });

    const afterReplay = await withRolledBackTransaction(app.prisma, async (tx) => {
      await replayChainFrom(tx, MIGRATION_DIR_SUFFIX);
      return tx.accessRole.findUniqueOrThrow({ where: { id: copy.id } });
    });

    expect(afterReplay.permissions).toEqual([...oldKeys]);
    expect(afterReplay.updatedAt).toEqual(copy.updatedAt);
  });

  it("writes no AuditLog row referencing a granted template id", async () => {
    for (const slot of GRANTED_SLOTS) {
      const count = await app.prisma.auditLog.count({ where: { entityId: SYSTEM_ROLE_IDS[slot] } });
      expect(count, slot).toBe(0);
    }
  });

  it("content drift: Admin, Inhaber and Salonmanager hold the key and equal their constants", async () => {
    for (const slot of GRANTED_SLOTS) {
      const row = await app.prisma.accessRole.findUniqueOrThrow({
        where: { id: SYSTEM_ROLE_IDS[slot] },
      });
      expect(row.tenantId, slot).toBeNull();
      expect(row.permissions, slot).toEqual([...SYSTEM_ROLE_PERMISSIONS[slot]]);
      expect(row.permissions, slot).toContain(KEY);
    }
  });

  it("the four other system roles do not hold the key, and each equals its constant", async () => {
    const rows = await globalRows();
    for (const [slot, id] of Object.entries(SYSTEM_ROLE_IDS)) {
      if ((GRANTED_SLOTS as readonly string[]).includes(slot)) continue;
      const row = rows.find((r) => r.id === id);
      expect(row, slot).toBeDefined();
      expect(row?.permissions, slot).toEqual([
        ...SYSTEM_ROLE_PERMISSIONS[slot as keyof typeof SYSTEM_ROLE_PERMISSIONS],
      ]);
      expect(row?.permissions.includes(KEY), slot).toBe(false);
    }
  });
});
