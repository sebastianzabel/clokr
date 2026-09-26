/**
 * Phase 91b Plan 09 (Issue #91), D-17 — the tracer end-to-end proof for `resolveScopedHolderIds`
 * applied to `leave.ts`'s `leaveRequestApproveHolderIds` site.
 *
 * IMPORTANT, empirically confirmed finding (documented in 91b-09-SUMMARY.md, all narrowing sites
 * this plan touches): `userIdsHoldingPermission` (Phase 75b, D-16, explicitly UNCHANGED by this
 * plan) only ever returns holders via (a) a well-formed TENANT-scope RoleAssignment whose role
 * grants the permission, or (b) the legacy no-stored-assignment fallback — D-09's OWN comment
 * states this in the source: "a SALONS or PERSONS assignment never grants a ZUGEWIESEN permission
 * here ... that boundary is #91's, not this facade's." A SALONS/PERSONS-only holder is therefore
 * NEVER a member of `userIdsHoldingPermission`'s output, in EITHER direction — resolveScopedHolderIds
 * narrows that SAME list, so at every site built this way (all 17 in this plan) every surviving
 * candidate ALWAYS resolves `wholeTenant` for the very permission being asked about (the two
 * functions apply structurally identical TENANT/fallback criteria to the same RoleAssignment rows)
 * and is therefore ALWAYS kept. This makes resolveScopedHolderIds's narrowing a structural no-op
 * for TODAY's real-world notification traffic at every one of these sites — it does not (and,
 * built this way, cannot) close the actual gap CONTEXT.md's D-17 describes (a SALONS/PERSONS
 * manager who CAN now approve a request per Plan 91b-01's access-gate widening still never being
 * NOTIFIED about it, since notification-recipient enumeration is a completely separate candidate
 * source from the access decision). Closing that gap would require widening the CANDIDATE set
 * itself (not just narrowing it), which is a semantic change to a Phase 75b facade this plan's own
 * context explicitly keeps unchanged — reported as a finding, not fixed here (see the phase's final
 * decision-log comment on Issue #91).
 *
 * This test therefore proves what the wiring actually does today: a TENANT-scope holder is still
 * notified (no regression from adding the narrowing step), the route does not crash, and — as
 * direct evidence of the finding above — a SALONS-scope holder (in or out of the affected
 * employee's Stammsalon) is NOT notified, for the PRE-EXISTING `userIdsHoldingPermission` reason,
 * not because `resolveScopedHolderIds` excluded them.
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

describe("Issue #91 (Phase 91b Plan 09) — leave-request:approve notification scope", () => {
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

  it("evidence for the documented finding: a SALONS-scope holder is never a userIdsHoldingPermission candidate, so is never notified here, regardless of matching the affected employee's own Stammsalon", async () => {
    const requester = await createEmployee("requester-notif-2");
    await createHome(requester.employee.id, salonA.id, "2020-01-01");

    const inScopeSalonHolder = await createScopedManager(
      "inscope-holder",
      ["leave-request:approve:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );

    // Sanity check backing the finding: this user genuinely holds the permission at their own
    // (SALONS) scope — `resolveAccessReach` for THIS user would resolve `scoped` covering salonA —
    // yet userIdsHoldingPermission (the notification-candidate source) never lists them.
    const holderIds = await userIdsHoldingPermission(
      app.prisma,
      data.tenant.id,
      "leave-request:approve:ZUGEWIESEN",
    );
    expect(holderIds).not.toContain(inScopeSalonHolder.user.id);

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

    expect(notifiedUserIds).not.toContain(inScopeSalonHolder.user.id);
  });
});
