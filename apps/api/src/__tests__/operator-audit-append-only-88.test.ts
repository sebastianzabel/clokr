/**
 * Phase 88 (#88, D-01/D-06/D-07/D-07a) — the operator principal and its append-only audit trail.
 *
 * Operator and audit rows are never deleted by this file (Pitfall 11): the table is append-only by
 * design, and the test databases are rebuilt from the template by `test:setup`. Only the tenant
 * fixture is cleaned up.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  OPERATOR_AUDIT_ACTIONS,
  OPERATOR_AUDIT_RETENTION_CLASS,
  purgeExpiredOperatorAudit,
  recordOperatorAudit,
} from "../contexts/platform/operator-audit";

let app: FastifyInstance;
let tenantId: string;

async function createOperator() {
  return app.prisma.operatorAccount.create({
    data: {
      email: `op-${randomUUID()}@example.invalid`,
      displayName: "Operator Fixture",
      passwordHash: "x",
    },
  });
}

/** `months` calendar months before now, shifted by `extraDays` further days into the past. */
function monthsAgo(months: number, extraDays = 0): Date {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  d.setUTCDate(d.getUTCDate() - extraDays);
  return d;
}

async function insertBackdated(action: string, createdAt: Date): Promise<string> {
  const row = await app.prisma.operatorAuditLog.create({
    data: { action, entity: "OperatorAccount", createdAt },
    select: { id: true },
  });
  return row.id;
}

beforeAll(async () => {
  app = await getTestApp();
  const seed = await seedTestData(app, "op88a");
  tenantId = seed.tenant.id;
});

afterAll(async () => {
  await cleanupTestData(app, tenantId);
});

describe("Phase 88 tracer — operator audit writer", () => {
  it("writes one operator audit row and reads every field back", async () => {
    const operator = await createOperator();
    const entry = await recordOperatorAudit(app.prisma, {
      operatorId: operator.id,
      action: OPERATOR_AUDIT_ACTIONS.OPERATOR_CREATED,
      entity: "OperatorAccount",
      entityId: operator.id,
      newValue: { email: operator.email, nested: { ok: true } },
      request: { ip: "203.0.113.7", headers: { "user-agent": "vitest-88" } },
    });

    const row = await app.prisma.operatorAuditLog.findUniqueOrThrow({ where: { id: entry.id } });
    expect(row.operatorId).toBe(operator.id);
    expect(row.action).toBe("OPERATOR_CREATED");
    expect(row.entity).toBe("OperatorAccount");
    expect(row.entityId).toBe(operator.id);
    expect(row.newValue).toEqual({ email: operator.email, nested: { ok: true } });
    expect(row.oldValue).toBeNull();
    expect(row.ipAddress).toBe("203.0.113.7");
    expect(row.userAgent).toBe("vitest-88");
    expect(row.subjectTenantId).toBeNull();
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("a freshly seeded tenant is active: all three deactivation columns are null (D-06)", async () => {
    const tenant = await app.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(tenant.deactivatedAt).toBeNull();
    expect(tenant.deactivatedReason).toBeNull();
    expect(tenant.deactivatedByOperatorId).toBeNull();
  });

  it("an audit row about a tenant outlives that tenant (subjectTenantId has no foreign key)", async () => {
    const seed = await seedTestData(app, "op88b");
    const subject = seed.tenant.id;
    const entry = await recordOperatorAudit(app.prisma, {
      action: OPERATOR_AUDIT_ACTIONS.TENANT_CREATED,
      subjectTenantId: subject,
      entity: "Tenant",
      entityId: subject,
    });

    await cleanupTestData(app, subject);

    const row = await app.prisma.operatorAuditLog.findUnique({ where: { id: entry.id } });
    expect(row).not.toBeNull();
    expect(row?.subjectTenantId).toBe(subject);
    expect(row?.operatorId).toBeNull();
  });
});

describe("Phase 88 — append-only enforcement (D-07a)", () => {
  it("rejects a Prisma update of an audit row", async () => {
    const id = await insertBackdated("OPERATOR_LOGIN", new Date());
    await expect(
      app.prisma.operatorAuditLog.update({ where: { id }, data: { entity: "Tampered" } }),
    ).rejects.toThrow(/append-only/);
    const row = await app.prisma.operatorAuditLog.findUniqueOrThrow({ where: { id } });
    expect(row.entity).toBe("OperatorAccount");
  });

  it("rejects a raw UPDATE of an audit row", async () => {
    const id = await insertBackdated("OPERATOR_LOGIN", new Date());
    await expect(
      app.prisma.$executeRawUnsafe(
        `UPDATE "OperatorAuditLog" SET "entity" = 'Tampered' WHERE "id" = $1`,
        id,
      ),
    ).rejects.toThrow(/append-only/);
  });

  it("rejects a Prisma delete without the retention flag", async () => {
    const id = await insertBackdated("OPERATOR_LOGIN", monthsAgo(13));
    await expect(app.prisma.operatorAuditLog.delete({ where: { id } })).rejects.toThrow(
      /append-only/,
    );
    expect(await app.prisma.operatorAuditLog.findUnique({ where: { id } })).not.toBeNull();
  });

  it("rejects a raw DELETE without the retention flag", async () => {
    const id = await insertBackdated("OPERATOR_LOGIN", monthsAgo(13));
    await expect(
      app.prisma.$executeRawUnsafe(`DELETE FROM "OperatorAuditLog" WHERE "id" = $1`, id),
    ).rejects.toThrow(/append-only/);
  });

  it("rejects a flagged DELETE of a row younger than 12 months (database floor)", async () => {
    const id = await insertBackdated("OPERATOR_LOGIN", monthsAgo(1));
    await expect(
      app.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL clokr.operator_audit_retention = 'on'`);
        await tx.operatorAuditLog.delete({ where: { id } });
      }),
    ).rejects.toThrow(/append-only/);
    expect(await app.prisma.operatorAuditLog.findUnique({ where: { id } })).not.toBeNull();
  });

  it("rejects TRUNCATE with the trigger error, not with the test's own rollback", async () => {
    const sentinel = new Error("sentinel-rollback");
    const outcome = await app.prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`TRUNCATE "OperatorAuditLog"`);
        throw sentinel;
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(outcome).not.toBeNull();
    expect(outcome).not.toBe(sentinel);
    expect(String(outcome)).toMatch(/append-only/);
  });
});

describe("Phase 88 — retention purge (D-07a)", () => {
  it("deletes only expired rows per retention class and reports the count", async () => {
    const expiredAuth = await insertBackdated(OPERATOR_AUDIT_ACTIONS.OPERATOR_LOGIN, monthsAgo(13));
    const oldLifecycle = await insertBackdated(
      OPERATOR_AUDIT_ACTIONS.TENANT_CREATED,
      monthsAgo(13),
    );
    const youngAuth = await insertBackdated(OPERATOR_AUDIT_ACTIONS.OPERATOR_LOGIN, monthsAgo(1));

    const result = await purgeExpiredOperatorAudit(app.prisma, new Date());

    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(await app.prisma.operatorAuditLog.findUnique({ where: { id: expiredAuth } })).toBeNull();
    expect(
      await app.prisma.operatorAuditLog.findUnique({ where: { id: oldLifecycle } }),
    ).not.toBeNull();
    expect(
      await app.prisma.operatorAuditLog.findUnique({ where: { id: youngAuth } }),
    ).not.toBeNull();
  });

  it("counts exactly the removed rows", async () => {
    const before = await app.prisma.operatorAuditLog.count();
    await insertBackdated(OPERATOR_AUDIT_ACTIONS.OPERATOR_LOCKED, monthsAgo(14));
    await insertBackdated(OPERATOR_AUDIT_ACTIONS.OPERATOR_MFA_FAILED, monthsAgo(24));
    const result = await purgeExpiredOperatorAudit(app.prisma, new Date());
    const after = await app.prisma.operatorAuditLog.count();
    expect(result.deleted).toBe(before + 2 - after);
    expect(result.deleted).toBeGreaterThanOrEqual(2);
  });

  it("purges a lifecycle row only after 120 months", async () => {
    const id = await insertBackdated(OPERATOR_AUDIT_ACTIONS.TENANT_DEACTIVATED, monthsAgo(121));
    await purgeExpiredOperatorAudit(app.prisma, new Date());
    expect(await app.prisma.operatorAuditLog.findUnique({ where: { id } })).toBeNull();
  });
});

describe("Phase 89 — salon and coupling lifecycle actions (D-09)", () => {
  it("gives each of the six salon actions the 10-year LIFECYCLE class", () => {
    const salonActions = [
      OPERATOR_AUDIT_ACTIONS.SALON_CREATED,
      OPERATOR_AUDIT_ACTIONS.SALON_UPDATED,
      OPERATOR_AUDIT_ACTIONS.SALON_DEACTIVATED,
      OPERATOR_AUDIT_ACTIONS.SALON_ACTIVATED,
      OPERATOR_AUDIT_ACTIONS.SALON_COUPLING_SET,
      OPERATOR_AUDIT_ACTIONS.SALON_COUPLING_REMOVED,
    ];
    expect(salonActions).toHaveLength(6);
    for (const action of salonActions) {
      expect(OPERATOR_AUDIT_RETENTION_CLASS[action]).toBe("LIFECYCLE");
    }
  });
});

describe("Phase 88 — source scan: the audit delegate has one writer file", () => {
  const SRC_ROOT = resolve(__dirname, "..");
  const WRITER = "contexts/platform/operator-audit.ts";

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
    text: readFileSync(f, "utf8"),
  }));

  it("scans a non-empty tree that contains the writer file", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.rel === WRITER)).toBe(true);
  });

  it("names the operatorAuditLog delegate only in the writer file", () => {
    const offenders = files
      .filter((f) => f.rel !== WRITER && /operatorAuditLog/.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("never updates, upserts or deletes through the delegate; deleteMany only in the purge", () => {
    const writer = files.find((f) => f.rel === WRITER);
    expect(writer).toBeDefined();
    const text = writer?.text ?? "";
    expect(text).not.toMatch(/operatorAuditLog\s*\.\s*(update|updateMany|upsert|delete)\s*\(/);
    const purgeStart = text.indexOf("export async function purgeExpiredOperatorAudit");
    expect(purgeStart).toBeGreaterThan(-1);
    const deleteManyAt = text.indexOf("operatorAuditLog.deleteMany");
    expect(deleteManyAt).toBeGreaterThan(purgeStart);
    expect(text.indexOf("operatorAuditLog.deleteMany", deleteManyAt + 1)).toBe(-1);
  });
});
