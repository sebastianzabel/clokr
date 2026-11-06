/**
 * Issue #836 (T-836-15) - deleting a role that a leave-limit rule names answers 409 with a German
 * message instead of an unhandled foreign-key 500; an unreferenced role is deleted as before.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { roleNameKey } from "../contexts/platform/access-role";

describe("DELETE /api/v1/roles/:id with a leave-limit rule (Issue #836)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let usedRoleId: string;
  let freeRoleId: string;
  let ruleId: string;

  async function role(name: string): Promise<string> {
    const row = await app.prisma.accessRole.create({
      data: { tenantId: data.tenant.id, name, nameKey: roleNameKey(name), permissions: [] },
    });
    return row.id;
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "rdl836");
    const suffix = Date.now().toString(36);
    usedRoleId = await role(`Used836 ${suffix}`);
    freeRoleId = await role(`Free836 ${suffix}`);
    // A soft-deleted rule keeps its row, so it must hold the role too.
    const rule = await app.prisma.leaveLimitRule.create({
      data: {
        tenantId: data.tenant.id,
        salonId: data.salonId,
        groupKind: "ACCESS_ROLE",
        accessRoleId: usedRoleId,
        maxPersons: 1,
        deletedAt: new Date(),
      },
    });
    ruleId = rule.id;
  });

  afterAll(async () => {
    await app.prisma.leaveLimitRule.deleteMany({ where: { id: ruleId } });
    await app.prisma.accessRole.deleteMany({ where: { id: { in: [usedRoleId, freeRoleId] } } });
    await cleanupTestData(app, data.tenant.id);
  });

  it("answers 409 for a role referenced by a rule (also a soft-deleted one) and keeps the role", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/roles/${usedRoleId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      error: "Die Rolle wird in Urlaubsgrenzen verwendet und kann nicht gelöscht werden.",
    });
    expect(await app.prisma.accessRole.findUnique({ where: { id: usedRoleId } })).not.toBeNull();
  });

  it("deletes an unreferenced role as before", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/roles/${freeRoleId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(204);
    expect(await app.prisma.accessRole.findUnique({ where: { id: freeRoleId } })).toBeNull();
  });
});
