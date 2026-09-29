/**
 * Phase 91b Plan 09 (Issue #91), D-17, revised by Issue #367 — the tracer end-to-end proof for
 * `resolveScopedHolderIds` applied to `leave.ts`'s `leaveRequestApproveHolderIds` site.
 *
 * Phase 91b's own conclusion (91b-09-SUMMARY.md, quoted in the pre-#367 version of this file):
 * `userIdsHoldingPermission` (Phase 75b, D-16) only ever returned holders via (a) a well-formed
 * TENANT-scope RoleAssignment, or (b) the legacy no-stored-assignment fallback — a SALONS/PERSONS
 * assignment was NEVER a candidate (D-09), so `resolveScopedHolderIds`'s narrowing was a
 * structural no-op: a SALONS/PERSONS manager who CAN approve a request (Plan 91b-01's access-gate
 * widening) was still never NOTIFIED about it. That gap is Issue #367.
 *
 * Issue #367 (owner decision 2026-09-29, revises D-09): `userIdsHoldingPermission()` now includes
 * a well-formed SALONS/PERSONS assignment as a candidate too; `resolveScopedHolderIds()` (D-17,
 * unchanged) narrows to the holder's actual scope exactly as it always did for a TENANT holder.
 * This file's two AC tests below (mirroring the issue's Akzeptanzkriterien) replace the old
 * "documented finding" test that proved the gap: a SALONS-scope holder covering the requester's
 * own Stammsalon IS now notified; one covering a different salon is NOT. A third test covers the
 * issue's PERSONS-scope AC directly against `leave.ts` too.
 *
 * No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { DEFAULT_SALON_OPENING_HOURS } from "../contexts/platform/facade/salons";
import {
  normalizeRolePermissions,
  roleNameKey,
  userIdsHoldingPermission,
} from "../contexts/platform";

const PASSWORD = "test1234";

describe("Issue #91 (Phase 91b Plan 09) / Issue #367 — leave-request:approve notification scope", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async function createEmployee(label: string) {
    const s = uniqueSuffix(label);
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await app.prisma.user.create({
      data: { email: `${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "NotifScopeTest",
        hireDate: new Date("2020-01-01"),
      },
    });
    return { user, employee };
  }

  function createHome(employeeId: string, salonId: string, validFrom: string) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: new Date(validFrom),
        validUntil: null,
        weekdays: [],
      },
    });
  }

  async function createScopedManager(
    label: string,
    permissions: string[],
    scope: {
      scopeType: "SALONS" | "PERSONS" | "TENANT";
      salonIds?: string[];
      employeeIds?: string[];
    },
  ) {
    const { user } = await createEmployee(label);
    const name = `NotifScope ${crypto.randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: data.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(permissions),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        accessRoleId: role.id,
        scopeType: scope.scopeType,
        salonIds: scope.salonIds ?? [],
        employeeIds: scope.employeeIds ?? [],
      },
    });
    return { user };
  }

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "lrans");
    salonA = await app.prisma.salon.create({
      data: {
        tenantId: data.tenant.id,
        name: "LRANS Salon A",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
        federalState: "NIEDERSACHSEN", // Phase 71b (issue #71) — required since the merge; irrelevant to this test's own assertions
      },
    });
    salonB = await app.prisma.salon.create({
      data: {
        tenantId: data.tenant.id,
        name: "LRANS Salon B",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
        federalState: "NIEDERSACHSEN", // Phase 71b (issue #71) — required since the merge; irrelevant to this test's own assertions
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("a TENANT-scope holder is still notified after the resolveScopedHolderIds wiring (no regression)", async () => {
    const requester = await createEmployee("requester-notif");
    await createHome(requester.employee.id, salonA.id, "2020-01-01");

    const tenantHolder = await createScopedManager(
      "tenant-holder",
      ["leave-request:approve:ZUGEWIESEN"],
      { scopeType: "TENANT" },
    );

    const requesterToken = await login(requester.user.email);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${requesterToken}` },
      payload: { type: "VACATION", startDate: "2026-07-01", endDate: "2026-07-02" },
    });
    expect(res.statusCode).toBe(201);
    const requestId = JSON.parse(res.body).id as string;

    const notifiedUserIds = (
      await app.prisma.notification.findMany({
        where: { type: "LEAVE_REQUEST", relatedId: requestId },
        select: { userId: true },
      })
    ).map((n) => n.userId);

    expect(notifiedUserIds).toContain(tenantHolder.user.id);
  });

  it("Issue #367 AK-1: a SALONS-scope holder covering the requester's own Stammsalon IS notified; one covering a different salon is NOT", async () => {
    const requester = await createEmployee("requester-notif-2");
    await createHome(requester.employee.id, salonA.id, "2020-01-01");

    const inScopeSalonHolder = await createScopedManager(
      "inscope-holder",
      ["leave-request:approve:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );
    const outOfScopeSalonHolder = await createScopedManager(
      "outscope-holder",
      ["leave-request:approve:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [salonB.id] },
    );

    // Sanity check for the fix itself: both SALONS-scope users are now genuine candidates of
    // userIdsHoldingPermission (Issue #367 widened the candidate set) — the salon-A/salon-B split
    // below is entirely resolveScopedHolderIds's narrowing, not a candidate-set difference.
    const holderIds = await userIdsHoldingPermission(
      app.prisma,
      data.tenant.id,
      "leave-request:approve:ZUGEWIESEN",
    );
    expect(holderIds).toContain(inScopeSalonHolder.user.id);
    expect(holderIds).toContain(outOfScopeSalonHolder.user.id);

    const requesterToken = await login(requester.user.email);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${requesterToken}` },
      payload: { type: "VACATION", startDate: "2026-07-03", endDate: "2026-07-04" },
    });
    expect(res.statusCode).toBe(201);
    const requestId = JSON.parse(res.body).id as string;

    const notifiedUserIds = (
      await app.prisma.notification.findMany({
        where: { type: "LEAVE_REQUEST", relatedId: requestId },
        select: { userId: true },
      })
    ).map((n) => n.userId);

    expect(notifiedUserIds).toContain(inScopeSalonHolder.user.id);
    expect(notifiedUserIds).not.toContain(outOfScopeSalonHolder.user.id);
  });

  it("Issue #367 AK-2: a PERSONS-scope holder is notified only about the listed employee(s)", async () => {
    // Short, mutually distinct-at-20-chars labels: createEmployee's employeeNumber truncates the
    // unique suffix to 20 chars total, so two long, near-identical labels in the same test can
    // collide on Employee_tenantId_employeeNumber_key — keep these two short and different early.
    const listedRequester = await createEmployee("pers-listed");
    await createHome(listedRequester.employee.id, salonA.id, "2020-01-01");
    const unlistedRequester = await createEmployee("pers-unlisted");
    await createHome(unlistedRequester.employee.id, salonA.id, "2020-01-01");

    const personsHolder = await createScopedManager(
      "persons-holder",
      ["leave-request:approve:ZUGEWIESEN"],
      { scopeType: "PERSONS", employeeIds: [listedRequester.employee.id] },
    );

    const listedToken = await login(listedRequester.user.email);
    const listedRes = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${listedToken}` },
      payload: { type: "VACATION", startDate: "2026-07-05", endDate: "2026-07-06" },
    });
    expect(listedRes.statusCode).toBe(201);
    const listedRequestId = JSON.parse(listedRes.body).id as string;

    const unlistedToken = await login(unlistedRequester.user.email);
    const unlistedRes = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${unlistedToken}` },
      payload: { type: "VACATION", startDate: "2026-07-07", endDate: "2026-07-08" },
    });
    expect(unlistedRes.statusCode).toBe(201);
    const unlistedRequestId = JSON.parse(unlistedRes.body).id as string;

    const notifiedForListed = (
      await app.prisma.notification.findMany({
        where: { type: "LEAVE_REQUEST", relatedId: listedRequestId },
        select: { userId: true },
      })
    ).map((n) => n.userId);
    const notifiedForUnlisted = (
      await app.prisma.notification.findMany({
        where: { type: "LEAVE_REQUEST", relatedId: unlistedRequestId },
        select: { userId: true },
      })
    ).map((n) => n.userId);

    expect(notifiedForListed).toContain(personsHolder.user.id);
    expect(notifiedForUnlisted).not.toContain(personsHolder.user.id);
  });
});
