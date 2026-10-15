/**
 * Phase 89 (#89, D-09/D-09a/D-09b) — the one writer of operator-actor rows in a tenant's AuditLog.
 *
 * Two halves:
 *   - writer behaviour against the test database (actor stamp, required tenant, transaction
 *     rollback);
 *   - a source guard: exactly one non-test file of `apps/api/src` spells the operator actor shape,
 *     so a route file cannot forge or forget the stamp.
 *
 * AuditLog rows are append-only and are never deleted by this file; the test databases are rebuilt
 * from the template by `test:setup`. Only the tenant fixture is cleaned up.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { operatorTenantAudit } from "../contexts/platform/operator-tenant-audit";

let app: FastifyInstance;
let tenantId: string;
let operatorId: string;

beforeAll(async () => {
  app = await getTestApp();
  const seed = await seedTestData(app, "ota89");
  tenantId = seed.tenant.id;
  operatorId = randomUUID();
});

afterAll(async () => {
  await cleanupTestData(app, tenantId);
});

describe("Phase 89 — operatorTenantAudit writer (D-09b)", () => {
  it("writes one AuditLog row without a user and stamps actor with operator and tenant", async () => {
    const entityId = randomUUID();
    const write = operatorTenantAudit(app, { operatorId, tenantId });
    await write({
      action: "CREATE",
      entity: "Salon",
      entityId,
      oldValue: { before: 1 },
      newValue: { name: "Fixture salon" },
    });

    const rows = await app.prisma.auditLog.findMany({
      where: { entityId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.userId).toBeNull();
    expect(row.action).toBe("CREATE");
    expect(row.entity).toBe("Salon");
    expect(row.oldValue).toEqual({ before: 1 });
    expect(row.newValue).toEqual({
      name: "Fixture salon",
      actor: { type: "OPERATOR", operatorId, tenantId },
    });
  });

  it("stamps the actor even when the entry carries no newValue", async () => {
    const entityId = randomUUID();
    await operatorTenantAudit(app, { operatorId, tenantId })({
      action: "DELETE",
      entity: "Salon",
      entityId,
    });
    const row = await app.prisma.auditLog.findFirstOrThrow({
      where: { entityId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(row.newValue).toEqual({ actor: { type: "OPERATOR", operatorId, tenantId } });
  });

  it("lets the stamp win over an actor key smuggled into the entry's newValue", async () => {
    const entityId = randomUUID();
    await operatorTenantAudit(app, { operatorId, tenantId })({
      action: "UPDATE",
      entity: "Salon",
      entityId,
      newValue: { actor: { type: "OPERATOR", operatorId, tenantId: randomUUID() } },
    });
    const row = await app.prisma.auditLog.findFirstOrThrow({
      where: { entityId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect((row.newValue as { actor: { tenantId: string } }).actor.tenantId).toBe(tenantId);
  });

  it("honours the caller's transaction: the row rolls back with the change", async () => {
    const entityId = randomUUID();
    const write = operatorTenantAudit(app, { operatorId, tenantId });
    await expect(
      app.prisma.$transaction(async (tx) => {
        await write({ action: "CREATE", entity: "Salon", entityId }, tx);
        expect(await tx.auditLog.count({ where: { entityId } })).toBe(1);
        throw new Error("rollback after audit");
      }),
    ).rejects.toThrow("rollback after audit");
    expect(await app.prisma.auditLog.count({ where: { entityId } })).toBe(0);
  });

  it("commits the row together with the transaction", async () => {
    const entityId = randomUUID();
    const write = operatorTenantAudit(app, { operatorId, tenantId });
    await app.prisma.$transaction(async (tx) => {
      await write({ action: "CREATE", entity: "Salon", entityId }, tx);
    });
    expect(await app.prisma.auditLog.count({ where: { entityId } })).toBe(1);
  });
});

/**
 * Removes line and block comments, leaving string and template literals untouched. A state machine
 * rather than two regexes, because `"http://x"` and `"/* not a comment"` are code, not comments.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") {
          out += source[i];
          i++;
        }
        out += source[i] ?? "";
        i++;
      }
      out += quote;
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

describe("Phase 89 — source guard: one file spells the operator actor (D-09b, T-89-24)", () => {
  const SRC_ROOT = resolve(__dirname, "..");
  const WRITER = "contexts/platform/operator-tenant-audit.ts";
  const POSITIVE_CONTROL = "contexts/platform/operator-audit.ts";
  const ACTOR_LITERAL = /type:\s*["']OPERATOR["']/;

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === "__tests__" || name === "node_modules") continue;
        out.push(...walk(full));
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
        out.push(full);
      }
    }
    return out;
  }

  const files = walk(SRC_ROOT).map((f) => ({
    rel: relative(SRC_ROOT, f).split("\\").join("/"),
    code: stripComments(readFileSync(f, "utf8")),
  }));

  it("scans a deep, non-empty tree that contains the writer and a positive control", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.rel === WRITER)).toBe(true);
    expect(files.some((f) => f.rel === POSITIVE_CONTROL)).toBe(true);
  });

  it("strips comments but keeps code (the comment stripper itself is not vacuous)", () => {
    const stripped = stripComments(
      'a(); // type: "OPERATOR"\n/* type: "OPERATOR" */ const url = "http://x"; b();',
    );
    expect(stripped).not.toMatch(ACTOR_LITERAL);
    expect(stripped).toContain('"http://x"');
    expect(stripComments('const t = { type: "OPERATOR" };')).toMatch(ACTOR_LITERAL);
  });

  it("names the operator actor shape in exactly one file, the writer", () => {
    const writers = files.filter((f) => ACTOR_LITERAL.test(f.code)).map((f) => f.rel);
    expect(writers).toEqual([WRITER]);
  });
});
