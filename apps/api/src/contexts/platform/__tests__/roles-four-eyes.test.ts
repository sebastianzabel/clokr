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
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { PERMISSIONS, permissionKey } from "../permission-catalog";
import { roleNameKey, normalizeRolePermissions } from "../access-role";
import { ROLE_LOCKOUT_MESSAGE } from "../role-assignment";
import {
  FOUR_EYES_COMBINATION,
  holdsFourEyesCombination,
  FOUR_EYES_CONFIRMATION_REQUIRED,
  SYSTEM_ROLE_IDS,
  SYSTEM_ROLE_NAMES,
} from "..";
import { FOUR_EYES_CONFIRMATION_MESSAGE } from "../four-eyes";
import type { FastifyInstance } from "fastify";

const ROLE_NAME_CONFLICT_MESSAGE = "Eine Rolle mit diesem Namen existiert bereits.";
const ROLE_SYSTEM_UPDATE_MESSAGE =
  "Systemrollen können nicht geändert werden. Kopieren Sie die Rolle, um sie anzupassen.";
const ROLE_MANAGE = "role:manage:ZUGEWIESEN";
const ASSIGNMENT_MANAGE = "role-assignment:manage:ZUGEWIESEN";

// The two-key combination shape used across every describe block below (D-01): half A "eigene
// Zeiten ändern" (here via create:EIGENE) + half B "Zeiten genehmigen".
const combinationPermissions = ["time-entry:create:EIGENE", "retro-request:approve:ZUGEWIESEN"];

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

  describe("PATCH /api/v1/roles/:id (Task 2)", () => {
    let app: FastifyInstance;
    let data: Awaited<ReturnType<typeof seedTestData>>;
    const createdRoleIds: string[] = [];
    const actorUserIds: string[] = [];

    beforeAll(async () => {
      app = await getTestApp();
      data = await seedTestData(app, "78b-01-four-eyes-patch");
    });

    afterAll(async () => {
      // Deleting the user cascades its RoleAssignment rows (customer-role-escalation.test.ts
      // convention), freeing every accessRole below from the `onDelete: Restrict` FK.
      if (actorUserIds.length > 0) {
        try {
          await app.prisma.user.deleteMany({ where: { id: { in: actorUserIds } } });
        } catch (err) {
          console.error("Four-eyes actor cleanup failed:", err);
        }
      }
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

    async function createCustomerRole(permissions: string[], name?: string): Promise<string> {
      const roleName =
        name ?? `4E-Patch-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const role = await app.prisma.accessRole.create({
        data: {
          tenantId: data.tenant.id,
          name: roleName,
          nameKey: roleNameKey(roleName),
          permissions: normalizeRolePermissions(permissions),
        },
      });
      createdRoleIds.push(role.id);
      return role.id;
    }

    function patchRole(id: string, payload: unknown) {
      return app.inject({
        method: "PATCH",
        url: `/api/v1/roles/${id}`,
        headers: {
          authorization: `Bearer ${data.adminToken}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify(payload),
      });
    }

    async function updateAuditCountSince(entityId: string, sinceTs: Date): Promise<number> {
      return app.prisma.auditLog.count({
        where: { entity: "AccessRole", entityId, action: "UPDATE", createdAt: { gte: sinceTs } },
      });
    }

    /**
     * Phase 78b review WR-01 regression helper — modelled on
     * `role-assignment-review-fixes.test.ts`'s helper of the same name (74b review WR-01, an
     * identically-shaped finding on the sibling role-assignments facade). Runs `concurrentWrite`
     * once, right before the NEXT `app.prisma.$transaction()` call made by the code under test —
     * i.e. after the route has done its pre-transaction reads (the `existing` snapshot) but before
     * `withRoleLockoutGuard` takes the tenant lock. That is exactly the staleness window WR-01
     * describes, made deterministic instead of left to timing.
     */
    function beforeNextTransaction(concurrentWrite: () => Promise<unknown>) {
      const realTransaction = app.prisma.$transaction.bind(app.prisma) as unknown as (
        ...args: unknown[]
      ) => Promise<unknown>;
      vi.spyOn(app.prisma, "$transaction").mockImplementationOnce((async (...args: unknown[]) => {
        await concurrentWrite();
        return realTransaction(...args);
      }) as never);
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("(h) adding half B to a half-A role without confirm answers 409, stored permissions unchanged, no UPDATE audit", async () => {
      const id = await createCustomerRole(["time-entry:create:EIGENE"]);
      const beforeTs = new Date();
      const res = await patchRole(id, { permissions: combinationPermissions });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe(FOUR_EYES_CONFIRMATION_REQUIRED);

      const row = await app.prisma.accessRole.findUniqueOrThrow({ where: { id } });
      expect(row.permissions).toEqual(["time-entry:create:EIGENE"]);
      expect(await updateAuditCountSince(id, beforeTs)).toBe(0);
    });

    it("(i) the same PATCH with confirm: true saves and audits the confirmation; oldValue matches the previous set", async () => {
      const id = await createCustomerRole(["time-entry:create:EIGENE"]);
      const res = await patchRole(id, { permissions: combinationPermissions, confirm: true });
      expect(res.statusCode).toBe(200);

      const audit = await app.prisma.auditLog.findFirst({
        where: { entity: "AccessRole", entityId: id, action: "UPDATE" },
        orderBy: { createdAt: "desc" },
      });
      expect(audit).not.toBeNull();
      const newValue = audit!.newValue as Record<string, unknown>;
      expect(newValue.fourEyesWarningConfirmed).toBe(true);
      const oldValue = audit!.oldValue as Record<string, unknown>;
      expect(oldValue.permissions).toEqual(["time-entry:create:EIGENE"]);
    });

    it("(j) a role that already holds the combination: rename only, no confirm — 200, no key", async () => {
      const id = await createCustomerRole(combinationPermissions);
      const newName = `4E-Renamed-${Date.now().toString(36)}`;
      const res = await patchRole(id, { name: newName });
      expect(res.statusCode).toBe(200);

      const audit = await app.prisma.auditLog.findFirst({
        where: { entity: "AccessRole", entityId: id, action: "UPDATE" },
        orderBy: { createdAt: "desc" },
      });
      const newValue = audit!.newValue as Record<string, unknown>;
      expect("fourEyesWarningConfirmed" in newValue).toBe(false);
    });

    it("(k) adding an unrelated key to a combination role without confirm — 200", async () => {
      const id = await createCustomerRole(combinationPermissions);
      const res = await patchRole(id, {
        permissions: [...combinationPermissions, "employee:read:EIGENE"],
      });
      expect(res.statusCode).toBe(200);
    });

    it("(l) removing half B from a combination role — 200, no key", async () => {
      const id = await createCustomerRole(combinationPermissions);
      const res = await patchRole(id, { permissions: ["time-entry:create:EIGENE"] });
      expect(res.statusCode).toBe(200);

      const audit = await app.prisma.auditLog.findFirst({
        where: { entity: "AccessRole", entityId: id, action: "UPDATE" },
        orderBy: { createdAt: "desc" },
      });
      const newValue = audit!.newValue as Record<string, unknown>;
      expect("fourEyesWarningConfirmed" in newValue).toBe(false);
    });

    it("(m) confirm: true that does not create the combination — 200, no key", async () => {
      const id = await createCustomerRole(["time-entry:create:EIGENE"]);
      const res = await patchRole(id, {
        permissions: ["time-entry:create:EIGENE", "employee:read:EIGENE"],
        confirm: true,
      });
      expect(res.statusCode).toBe(200);

      const audit = await app.prisma.auditLog.findFirst({
        where: { entity: "AccessRole", entityId: id, action: "UPDATE" },
        orderBy: { createdAt: "desc" },
      });
      const newValue = audit!.newValue as Record<string, unknown>;
      expect("fourEyesWarningConfirmed" in newValue).toBe(false);
    });

    it("(n) PATCH of a system role that would create the combination answers 409 with the system-role message, no code", async () => {
      const res = await patchRole(SYSTEM_ROLE_IDS.EMPLOYEE, {
        permissions: combinationPermissions,
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.code).toBeUndefined();
      expect(body.error).toBe(ROLE_SYSTEM_UPDATE_MESSAGE);
    });

    it("(o) a rename onto a taken name that ALSO creates the combination, no confirm — 409 name-conflict, no code", async () => {
      const takenName = `4E-Taken-${Date.now().toString(36)}`;
      await createCustomerRole(["time-entry:create:EIGENE"], takenName);
      const targetId = await createCustomerRole(["time-entry:create:EIGENE"]);

      const res = await patchRole(targetId, {
        name: takenName,
        permissions: combinationPermissions,
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.code).toBeUndefined();
      expect(body.error).toBe(ROLE_NAME_CONFLICT_MESSAGE);
    });

    it("(p) lockout precedence (P-01): removing the last role:manage/role-assignment:manage holder while creating the combination answers the lockout 409, never four-eyes", async () => {
      const roleId = await createCustomerRole([ROLE_MANAGE, ASSIGNMENT_MANAGE]);
      const s = `4e-lockout-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const passwordHash = await bcrypt.hash("test1234", 10);
      const user = await app.prisma.user.create({
        data: { email: `${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
      });
      actorUserIds.push(user.id);
      // countGuardedPermissionHolders (facade/role-assignments.ts) only counts a holder whose
      // Employee belongs to the tenant — a bare user is never a holder. Deleting the user in
      // afterAll cascades this Employee row too (Employee.userId onDelete: Cascade).
      await app.prisma.employee.create({
        data: {
          tenantId: data.tenant.id,
          userId: user.id,
          employeeNumber: `4E-${s}`.slice(0, 20),
          firstName: "Four-Eyes",
          lastName: "Lockout",
          hireDate: new Date("2024-01-01"),
        },
      });
      await app.prisma.roleAssignment.create({
        data: {
          tenantId: data.tenant.id,
          userId: user.id,
          accessRoleId: roleId,
          scopeType: "TENANT",
          salonIds: [],
          employeeIds: [],
        },
      });

      // This replaces both guarded permissions with the four-eyes pair: a >=1 -> 0 transition on
      // role:manage/role-assignment:manage (the ONLY stored holder in this fresh tenant) AND a
      // combination-creating save. The lockout guard must win (P-01).
      const res = await patchRole(roleId, { permissions: combinationPermissions });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.code).toBeUndefined();
      expect(body.error).toBe(ROLE_LOCKOUT_MESSAGE);

      const row = await app.prisma.accessRole.findUniqueOrThrow({ where: { id: roleId } });
      expect(row.permissions).toEqual(normalizeRolePermissions([ROLE_MANAGE, ASSIGNMENT_MANAGE]));
    });

    // ── Phase 78b review WR-01: locked-read regression (fix commit) ─────────────────────────────
    //
    // Both tests below start a role that ALREADY holds the combination, then use
    // `beforeNextTransaction` to commit a concurrent write — removing half B — in the exact window
    // between this request's pre-transaction `existing` read and the moment its own transaction
    // takes the tenant lock. At that point the TRUE prior state no longer holds the combination,
    // even though the pre-transaction snapshot still does. Both PATCH bodies also change `name` so
    // the no-op early return (which runs before any transaction, and so before the concurrent
    // write's hook ever fires) does not short-circuit the request.

    it("(v) WR-01: restoring the combination without confirm, after a concurrent write removed half B, answers 409 — not the false-negative 200 a pre-lock read would give", async () => {
      const id = await createCustomerRole(combinationPermissions);
      beforeNextTransaction(() =>
        app.prisma.accessRole.update({
          where: { id },
          data: { permissions: normalizeRolePermissions(["time-entry:create:EIGENE"]) },
        }),
      );

      const newName = `4E-WR01-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const beforeTs = new Date();
      const res = await patchRole(id, { name: newName, permissions: combinationPermissions });

      // Relative to the TRUE prior state (half A only, set by the concurrent write, read inside
      // the lock), this save newly creates the combination — 409 is correct. A pre-lock read would
      // still see the stale `existing` snapshot (already holding the combination) and compute
      // createsCombination === false, silently skipping the confirmation gate (the false-negative
      // WR-01 describes).
      expect(res.statusCode, res.body).toBe(409);
      expect(JSON.parse(res.body).code).toBe(FOUR_EYES_CONFIRMATION_REQUIRED);

      // The whole transaction (including the write the concurrent-write-unaware pre-lock
      // computation would have let commit) rolled back; only the concurrent write's own,
      // separately-committed state survives.
      const row = await app.prisma.accessRole.findUniqueOrThrow({ where: { id } });
      expect(row.name).not.toBe(newName);
      expect(row.permissions).toEqual(normalizeRolePermissions(["time-entry:create:EIGENE"]));
      expect(await updateAuditCountSince(id, beforeTs)).toBe(0);
    });

    it("(w) WR-01: the UPDATE audit's oldValue reflects the state read inside the lock, not the stale pre-transaction snapshot", async () => {
      const id = await createCustomerRole(combinationPermissions);
      beforeNextTransaction(() =>
        app.prisma.accessRole.update({
          where: { id },
          data: { permissions: normalizeRolePermissions(["time-entry:create:EIGENE"]) },
        }),
      );

      const newName = `4E-WR01-Confirmed-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const res = await patchRole(id, {
        name: newName,
        permissions: combinationPermissions,
        confirm: true,
      });
      expect(res.statusCode, res.body).toBe(200);

      const audit = await app.prisma.auditLog.findFirst({
        where: { entity: "AccessRole", entityId: id, action: "UPDATE" },
        orderBy: { createdAt: "desc" },
      });
      expect(audit).not.toBeNull();
      const newValue = audit!.newValue as Record<string, unknown>;
      expect(newValue.fourEyesWarningConfirmed).toBe(true);
      const oldValue = audit!.oldValue as Record<string, unknown>;
      // The truly-committed prior value (the concurrent write's result), never the stale
      // pre-transaction `existing` snapshot (which still showed the full combination).
      expect(oldValue.permissions).toEqual(normalizeRolePermissions(["time-entry:create:EIGENE"]));
    });
  });

  describe("POST /api/v1/roles/:id/copy (Task 2)", () => {
    let app: FastifyInstance;
    let data: Awaited<ReturnType<typeof seedTestData>>;
    const createdRoleIds: string[] = [];

    beforeAll(async () => {
      app = await getTestApp();
      data = await seedTestData(app, "78b-01-four-eyes-copy");
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

    function copyRole(id: string, payload: unknown = {}) {
      return app.inject({
        method: "POST",
        url: `/api/v1/roles/${id}/copy`,
        headers: {
          authorization: `Bearer ${data.adminToken}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify(payload),
      });
    }

    async function createCustomerRole(permissions: string[], name?: string): Promise<string> {
      const roleName =
        name ?? `4E-Copy-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const role = await app.prisma.accessRole.create({
        data: {
          tenantId: data.tenant.id,
          name: roleName,
          nameKey: roleNameKey(roleName),
          permissions: normalizeRolePermissions(permissions),
        },
      });
      createdRoleIds.push(role.id);
      return role.id;
    }

    /** D-08's own convention: a combination-creating source is built through the API + confirm. */
    async function createCombinationRoleViaApi(): Promise<string> {
      const roleName = `4E-Copy-Source-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/roles",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { name: roleName, permissions: combinationPermissions, confirm: true },
      });
      const body = JSON.parse(res.body);
      createdRoleIds.push(body.id);
      return body.id;
    }

    it("(q) copying a system role that holds the combination without confirm answers 409, creates nothing, no COPY audit", async () => {
      const beforeTs = new Date();
      const res = await copyRole(SYSTEM_ROLE_IDS.MANAGER);
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe(FOUR_EYES_CONFIRMATION_REQUIRED);

      const newRows = await app.prisma.accessRole.findMany({
        where: { tenantId: data.tenant.id, name: { startsWith: SYSTEM_ROLE_NAMES.MANAGER } },
      });
      expect(newRows).toHaveLength(0);
      const audits = await app.prisma.auditLog.count({
        where: { entity: "AccessRole", action: "COPY", createdAt: { gte: beforeTs } },
      });
      expect(audits).toBe(0);
    });

    it("(r) the same copy with confirm: true creates it and audits the confirmation with copiedFromId", async () => {
      const res = await copyRole(SYSTEM_ROLE_IDS.MANAGER, { confirm: true });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      createdRoleIds.push(body.id);

      const audit = await app.prisma.auditLog.findFirst({
        where: { entity: "AccessRole", entityId: body.id, action: "COPY" },
      });
      expect(audit).not.toBeNull();
      const newValue = audit!.newValue as Record<string, unknown>;
      expect(newValue.fourEyesWarningConfirmed).toBe(true);
      expect(newValue.copiedFromId).toBe(SYSTEM_ROLE_IDS.MANAGER);
    });

    it("(s) copying a customer role that already holds the combination also needs its own confirm (a copy is a new creation, D-04)", async () => {
      const sourceId = await createCombinationRoleViaApi();
      const res = await copyRole(sourceId);
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe(FOUR_EYES_CONFIRMATION_REQUIRED);
    });

    it("(t) copying a role without the combination with confirm: true succeeds; COPY audit has no key", async () => {
      const sourceId = await createCustomerRole(["time-entry:create:EIGENE"]);
      const res = await copyRole(sourceId, { confirm: true });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      createdRoleIds.push(body.id);

      const audit = await app.prisma.auditLog.findFirst({
        where: { entity: "AccessRole", entityId: body.id, action: "COPY" },
      });
      const newValue = audit!.newValue as Record<string, unknown>;
      expect("fourEyesWarningConfirmed" in newValue).toBe(false);
    });

    it("(u) copy with an explicit colliding name of a combination source, no confirm, answers 409 name conflict, no code", async () => {
      const takenName = `4E-Copy-Taken-${Date.now().toString(36)}`;
      await createCustomerRole(["time-entry:create:EIGENE"], takenName);
      const res = await copyRole(SYSTEM_ROLE_IDS.MANAGER, { name: takenName });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.code).toBeUndefined();
      expect(body.error).toBe(ROLE_NAME_CONFLICT_MESSAGE);
    });
  });
});
