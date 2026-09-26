/**
 * Phase 78b (Issue #78, AK-78b-2) — the four-eyes combination on the role API.
 *
 * A role that can both change its own holder's own time entries ("eigene Zeiten ändern",
 * `time-entry:create:EIGENE` OR `time-entry:update:EIGENE`) and approve time corrections
 * ("Zeiten genehmigen", `retro-request:approve:ZUGEWIESEN`) must never come into being silently.
 * `POST /roles`, `PATCH /roles/:id` and `POST /roles/:id/copy` answer 409
 * `FOUR_EYES_CONFIRMATION_REQUIRED` when a save CREATES the combination, unless the body carries
 * `confirm: true` — recorded in the role's audit entry as `fourEyesWarningConfirmed: true`.
 *
 * Unit block: the pure predicate, DB-free, imported from the Unterbau's public surface (`..`) to
 * prove the export (D-01). Integration blocks: the three role-mutation routes, added task by task
 * (POST here in Task 1, PATCH/COPY in Task 2).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { PERMISSIONS, permissionKey } from "../permission-catalog";
import {
  FOUR_EYES_COMBINATION,
  holdsFourEyesCombination,
  FOUR_EYES_CONFIRMATION_REQUIRED,
} from "..";
import { FOUR_EYES_CONFIRMATION_MESSAGE } from "../four-eyes";
import type { FastifyInstance } from "fastify";

const ROLE_NAME_CONFLICT_MESSAGE = "Eine Rolle mit diesem Namen existiert bereits.";

describe("Four-eyes combination (Phase 78b, Issue #78)", () => {
  describe("holdsFourEyesCombination (unit, DB-free)", () => {
    it("is false for an empty permission set", () => {
      expect(holdsFourEyesCombination([])).toBe(false);
    });

    it('is false when only half A ("eigene Zeiten ändern") is present', () => {
      expect(holdsFourEyesCombination(["time-entry:create:EIGENE"])).toBe(false);
    });

    it('is false when only half B ("Zeiten genehmigen") is present', () => {
      expect(holdsFourEyesCombination(["retro-request:approve:ZUGEWIESEN"])).toBe(false);
    });

    it("is true for time-entry:create:EIGENE + retro-request:approve:ZUGEWIESEN", () => {
      expect(
        holdsFourEyesCombination(["time-entry:create:EIGENE", "retro-request:approve:ZUGEWIESEN"]),
      ).toBe(true);
    });

    it("is true for time-entry:update:EIGENE + retro-request:approve:ZUGEWIESEN (both half-A alternatives count)", () => {
      expect(
        holdsFourEyesCombination(["time-entry:update:EIGENE", "retro-request:approve:ZUGEWIESEN"]),
      ).toBe(true);
    });

    it("is false for the Salonmanager shape (only ZUGEWIESEN time-entry keys, no EIGENE)", () => {
      expect(
        holdsFourEyesCombination([
          "time-entry:create:ZUGEWIESEN",
          "time-entry:update:ZUGEWIESEN",
          "retro-request:approve:ZUGEWIESEN",
        ]),
      ).toBe(false);
    });

    it("FOUR_EYES_COMBINATION holds exactly the two halves, every key a valid catalog key", () => {
      expect(FOUR_EYES_COMBINATION.changeOwnTimes).toEqual([
        "time-entry:create:EIGENE",
        "time-entry:update:EIGENE",
      ]);
      expect(FOUR_EYES_COMBINATION.approveTimes).toEqual(["retro-request:approve:ZUGEWIESEN"]);

      const catalogKeys = new Set(PERMISSIONS.map(permissionKey));
      for (const key of [
        ...FOUR_EYES_COMBINATION.changeOwnTimes,
        ...FOUR_EYES_COMBINATION.approveTimes,
      ]) {
        expect(catalogKeys.has(key), key).toBe(true);
      }
    });

    it("FOUR_EYES_CONFIRMATION_REQUIRED is the exact control-value string", () => {
      expect(FOUR_EYES_CONFIRMATION_REQUIRED).toBe("FOUR_EYES_CONFIRMATION_REQUIRED");
    });
  });

  describe("POST /api/v1/roles (Task 1)", () => {
    let app: FastifyInstance;
    let data: Awaited<ReturnType<typeof seedTestData>>;
    const createdRoleIds: string[] = [];

    const combinationPermissions = ["time-entry:create:EIGENE", "retro-request:approve:ZUGEWIESEN"];

    beforeAll(async () => {
      app = await getTestApp();
      data = await seedTestData(app, "78b-01-four-eyes-post");
    });

    afterAll(async () => {
      for (const id of createdRoleIds) {
        try {
          await app.prisma.accessRole.delete({ where: { id } });
        } catch (err) {
          console.error("Four-eyes role fixture cleanup failed:", err);
        }
      }
      try {
        await cleanupTestData(app, data.tenant.id);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
      await closeTestApp();
    });

    async function createAuditCountSince(sinceTs: Date): Promise<number> {
      return app.prisma.auditLog.count({
        where: { entity: "AccessRole", userId: data.adminUser.id, createdAt: { gte: sinceTs } },
      });
    }

    it("(a) rejects a combination-creating save without confirm with 409, writes nothing", async () => {
      const beforeTs = new Date();
      const roleName = `Four-Eyes-Test-A-${Date.now().toString(36)}`;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/roles",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { name: roleName, permissions: combinationPermissions },
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.code).toBe(FOUR_EYES_CONFIRMATION_REQUIRED);
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(0);
      expect(body.error).toBe(FOUR_EYES_CONFIRMATION_MESSAGE);

      const row = await app.prisma.accessRole.findFirst({
        where: { tenantId: data.tenant.id, nameKey: roleName.trim().toLowerCase() },
      });
      expect(row).toBeNull();
      expect(await createAuditCountSince(beforeTs)).toBe(0);
    });

    it("(b) confirm: null also answers 409 (never 400)", async () => {
      const roleName = `Four-Eyes-Test-B-${Date.now().toString(36)}`;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/roles",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { name: roleName, permissions: combinationPermissions, confirm: null },
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe(FOUR_EYES_CONFIRMATION_REQUIRED);
    });

    it("(c) confirm: false also answers 409", async () => {
      const roleName = `Four-Eyes-Test-C-${Date.now().toString(36)}`;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/roles",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { name: roleName, permissions: combinationPermissions, confirm: false },
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe(FOUR_EYES_CONFIRMATION_REQUIRED);
    });

    it("(d) confirm: true saves and audits the confirmation", async () => {
      const roleName = `Four-Eyes-Test-D-${Date.now().toString(36)}`;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/roles",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { name: roleName, permissions: combinationPermissions, confirm: true },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      createdRoleIds.push(body.id);

      const audit = await app.prisma.auditLog.findFirst({
        where: { entity: "AccessRole", entityId: body.id, action: "CREATE" },
      });
      expect(audit).not.toBeNull();
      const newValue = audit!.newValue as Record<string, unknown>;
      expect(newValue.fourEyesWarningConfirmed).toBe(true);
    });

    it("(e) confirm: true on a save that does NOT create the combination is not recorded", async () => {
      const roleName = `Four-Eyes-Test-E-${Date.now().toString(36)}`;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/roles",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { name: roleName, permissions: ["time-entry:create:EIGENE"], confirm: true },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      createdRoleIds.push(body.id);

      const audit = await app.prisma.auditLog.findFirst({
        where: { entity: "AccessRole", entityId: body.id, action: "CREATE" },
      });
      expect(audit).not.toBeNull();
      const newValue = audit!.newValue as Record<string, unknown>;
      expect("fourEyesWarningConfirmed" in newValue).toBe(false);
    });

    it("(f) a combination-creating save colliding on name answers 409 name-conflict, never four-eyes", async () => {
      const roleName = `Four-Eyes-Test-F-${Date.now().toString(36)}`;
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/roles",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { name: roleName, permissions: ["time-entry:create:EIGENE"] },
      });
      expect(first.statusCode).toBe(201);
      createdRoleIds.push(JSON.parse(first.body).id);

      const second = await app.inject({
        method: "POST",
        url: "/api/v1/roles",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { name: roleName, permissions: combinationPermissions },
      });
      expect(second.statusCode).toBe(409);
      const body = JSON.parse(second.body);
      expect(body.code).toBeUndefined();
      expect(body.error).toBe(ROLE_NAME_CONFLICT_MESSAGE);
    });

    it("(g) a combination-creating save with an unknown permission key answers 400", async () => {
      const roleName = `Four-Eyes-Test-G-${Date.now().toString(36)}`;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/roles",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          name: roleName,
          permissions: [...combinationPermissions, "role:fly:ZUGEWIESEN"],
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
