/**
 * Phase 76b (Issue #76), D-03 / AK-76b-1 — the four system-role templates behave as immutable,
 * copyable system roles through the SAME role API the 73b system-role fixture already proves
 * (`roles.test.ts` (o)/(q)/(t)). No new guard code exists for this: `roles.ts`'s
 * `existing.tenantId === null` check is already generic (RESEARCH.md Pattern 2) — this file is a
 * REGRESSION test over the four real template ids, with a mutation proof against the product code
 * itself (temporarily disabling the guard), not against a fixture.
 *
 * Fixture/login style follows `roles.test.ts` (seedTestData, `dataA.adminToken` — the seeded ADMIN
 * legacy user resolves `role:manage`/`role-assignment:manage` through the 75b fallback path with no
 * stored assignment needed). No person names (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { SYSTEM_ROLE_IDS, SYSTEM_ROLE_NAMES, SYSTEM_ROLE_PERMISSIONS } from "..";
import type { FastifyInstance } from "fastify";

const ROLE_SYSTEM_UPDATE_MESSAGE =
  "Systemrollen können nicht geändert werden. Kopieren Sie die Rolle, um sie anzupassen.";
const ROLE_SYSTEM_DELETE_MESSAGE = "Systemrollen können nicht gelöscht werden.";
const ROLE_NAME_CONFLICT_MESSAGE = "Eine Rolle mit diesem Namen existiert bereits.";

const NEW_TEMPLATE_SLOTS = ["OWNER", "SALON_MANAGER", "HR", "TRAINER"] as const;

describe("System-role templates through the role API (Phase 76b, Issue #76)", () => {
  let app: FastifyInstance;
  let dataA: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    dataA = await seedTestData(app, "76b-roles-a");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, dataA.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it.each(NEW_TEMPLATE_SLOTS)(
    "(AK-76b-1) PATCH (name, then permissions) and DELETE on %s answer 409, unchanged, no audit",
    async (slot) => {
      const id = SYSTEM_ROLE_IDS[slot];
      const before = await app.prisma.accessRole.findUniqueOrThrow({ where: { id } });

      const nameRes = await app.inject({
        method: "PATCH",
        url: `/api/v1/roles/${id}`,
        headers: { authorization: `Bearer ${dataA.adminToken}` },
        payload: { name: `${before.name} geändert` },
      });
      expect(nameRes.statusCode, slot).toBe(409);
      expect(JSON.parse(nameRes.body).error, slot).toBe(ROLE_SYSTEM_UPDATE_MESSAGE);

      const permsRes = await app.inject({
        method: "PATCH",
        url: `/api/v1/roles/${id}`,
        headers: { authorization: `Bearer ${dataA.adminToken}` },
        payload: { permissions: [] },
      });
      expect(permsRes.statusCode, slot).toBe(409);
      expect(JSON.parse(permsRes.body).error, slot).toBe(ROLE_SYSTEM_UPDATE_MESSAGE);

      const deleteRes = await app.inject({
        method: "DELETE",
        url: `/api/v1/roles/${id}`,
        headers: { authorization: `Bearer ${dataA.adminToken}` },
      });
      expect(deleteRes.statusCode, slot).toBe(409);
      expect(JSON.parse(deleteRes.body).error, slot).toBe(ROLE_SYSTEM_DELETE_MESSAGE);

      const after = await app.prisma.accessRole.findUniqueOrThrow({ where: { id } });
      expect(after, slot).toEqual(before);

      const audits = await app.prisma.auditLog.count({
        where: { entity: "AccessRole", entityId: id },
      });
      expect(audits, slot).toBe(0);
    },
  );

  it("(AK-73-3) GET /api/v1/roles lists all seven system-role ids as isSystem, with their labels", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${dataA.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const list = JSON.parse(res.body) as { id: string; name: string; isSystem: boolean }[];
    const byId = new Map(list.map((r) => [r.id, r]));

    for (const slot of Object.keys(SYSTEM_ROLE_IDS) as (keyof typeof SYSTEM_ROLE_IDS)[]) {
      const id = SYSTEM_ROLE_IDS[slot];
      const entry = byId.get(id);
      expect(entry, slot).toBeDefined();
      expect(entry?.isSystem, slot).toBe(true);
      expect(entry?.name, slot).toBe(SYSTEM_ROLE_NAMES[slot]);
    }
  });

  it("(AK-76b-1) copying the Inhaber template creates an editable customer role with identical permissions", async () => {
    // Phase 78b (issue #78, D-04): the Inhaber template holds the four-eyes combination
    // (changing one's own time entries plus approving time corrections) — copying it is a new
    // creation and needs its own explicit confirmation, same as any other combination-creating
    // save on the role API.
    const copyRes = await app.inject({
      method: "POST",
      url: `/api/v1/roles/${SYSTEM_ROLE_IDS.OWNER}/copy`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: { confirm: true },
    });
    expect(copyRes.statusCode).toBe(201);
    const copy = JSON.parse(copyRes.body);
    expect(copy.isSystem).toBe(false);
    expect(copy.permissions).toEqual([...SYSTEM_ROLE_PERMISSIONS.OWNER]);

    const row = await app.prisma.accessRole.findUniqueOrThrow({ where: { id: copy.id } });
    expect(row.tenantId).toBe(dataA.tenant.id);
    expect(row.permissions).toEqual([...SYSTEM_ROLE_PERMISSIONS.OWNER]);

    // The whole point of #76's "wer anpassen will, kopiert" path: the copy is freely editable.
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/roles/${copy.id}`,
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: { name: `${copy.name} angepasst` },
    });
    expect(patchRes.statusCode).toBe(200);
  });

  it("(D-06) creating a role named like a template (any casing) is rejected as a name conflict", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/roles",
      headers: { authorization: `Bearer ${dataA.adminToken}` },
      payload: { name: "iNHABER", permissions: [] },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe(ROLE_NAME_CONFLICT_MESSAGE);
  });
});
