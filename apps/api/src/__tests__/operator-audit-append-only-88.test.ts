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
import { OPERATOR_AUDIT_ACTIONS, recordOperatorAudit } from "../contexts/platform/operator-audit";

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
