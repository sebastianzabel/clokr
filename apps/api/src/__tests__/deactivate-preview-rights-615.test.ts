/**
 * Issue #615 (D-08/D-10/D-11/D-21, T-100-09) — who sees what in
 * `POST /api/v1/employees/:id/deactivate/preview`.
 *
 * - Each figure follows its own right: the saldo needs `overtime:read` over the person, the
 *   Resturlaub `leave-entitlement:read` over the person at the last working day, the absences'
 *   type, status and dates `leave-request:read` over the person (review WR-03: sick leave is health
 *   data). A figure the caller may not see is `null` with a reason code and is never computed; the
 *   absences then reduce to counts per action.
 * - A nonexistent id, an employee of another tenant and an in-tenant employee outside the caller's
 *   Stammsalon scope all get the byte-identical 404 body of `PATCH /:id/deactivate`.
 *
 * Fixtures carry no person names and no real e-mail addresses.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  seedEntitlementYears,
  grantSystemRole,
  numericEmployeeNumber,
} from "./setup";
import { getTenantTimezone, todayInTz } from "../contexts/working-time-account";
import { normalizeRolePermissions, roleNameKey, SYSTEM_ROLE_IDS } from "../contexts/platform";

const PASSWORD = "test1234";
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

interface PreviewBody {
  exitDate: string;
  absences: Array<Record<string, unknown>> | null;
  absenceCounts: Record<"CANCEL" | "SHORTEN" | "DELETE" | "SKIP", number> | null;
  absencesUnavailableReason: string | null;
  saldo: { balanceMinutes: number; asOf: string } | null;
  saldoUnavailableReason: string | null;
  vacation: Record<string, unknown> | null;
  vacationUnavailableReason: string | null;
}

describe("Issue #615 — deactivation preview: rights and the shared 404", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let other: Awaited<ReturnType<typeof seedTestData>>;
  let salonS: { id: string };
  let salonT: { id: string };
  let today: Date;

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  /** A person with a contract, an overtime account and entitlement rows; Stammsalon optional. */
  async function createPerson(
    label: string,
    opts: { homeSalonId?: string; exempt?: boolean; active?: boolean } = {},
  ) {
    const suffix = crypto.randomUUID().slice(0, 8);
    const user = await app.prisma.user.create({
      data: {
        email: `${label}-${suffix}@example.invalid`,
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        isActive: opts.active ?? true,
      },
    });
    const hireDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        firstName: "Rights615",
        lastName: "Fixture",
        employeeNumber: numericEmployeeNumber(),
        hireDate,
        isTimeTrackingExempt: opts.exempt ?? false,
      },
    });
    await grantSystemRole(app.prisma, {
      tenantId: data.tenant.id,
      userId: user.id,
      role: "EMPLOYEE",
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: hireDate,
      },
    });
    await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
    await seedEntitlementYears(app, {
      employeeId: employee.id,
      leaveTypeId: data.vacationType.id,
      years: [today.getUTCFullYear() - 1, today.getUTCFullYear()],
    });
    if (opts.homeSalonId) {
      await app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId: data.tenant.id,
          employeeId: employee.id,
          salonId: opts.homeSalonId,
          kind: "HOME",
          validFrom: new Date("2020-01-01"),
          validUntil: null,
          weekdays: [],
        },
      });
    }
    return { user, employee };
  }

  /** A signed-in actor holding one custom role with the given permissions and scope. */
  async function createActor(
    label: string,
    permissions: string[],
    scope: { scopeType: "TENANT" } | { scopeType: "SALONS"; salonIds: string[] },
  ) {
    const { user } = await createPerson(`actor-${label}`);
    const name = `Rights615 ${label} ${crypto.randomBytes(3).toString("hex")}`;
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
        salonIds: scope.scopeType === "SALONS" ? scope.salonIds : [],
        employeeIds: [],
      },
    });
    return { user, token: await login(user.email) };
  }

  const preview = (employeeId: string, token: string, payload: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: `/api/v1/employees/${employeeId}/deactivate/preview`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

  const patchDeactivate = (employeeId: string, token: string) =>
    app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${employeeId}/deactivate`,
      headers: { authorization: `Bearer ${token}` },
      payload: { exitDate: isoDay(today) },
    });

  const MANAGE = "employee:manage-access:ZUGEWIESEN";
  const OVERTIME = "overtime:read:ZUGEWIESEN";
  const ENTITLEMENT = "leave-entitlement:read:ZUGEWIESEN";
  const LEAVE_REQUEST = "leave-request:read:ZUGEWIESEN";

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "deactivate-preview-rights-615");
    other = await seedTestData(app, "deactivate-preview-rights-615-b");
    salonS = { id: data.salonId };
    salonT = await createTestSalon(app.prisma, data.tenant.id, { name: "Rights615 Salon T" });
    const tz = await getTenantTimezone(app.prisma, data.tenant.id);
    today = todayInTz(tz);
  });

  afterAll(async () => {
    for (const tenantId of [data?.tenant.id, other?.tenant.id]) {
      if (!tenantId) continue;
      try {
        await cleanupTestData(app, tenantId);
      } catch (err) {
        console.error("deactivate-preview-rights-615 test cleanup failed:", err);
      }
    }
  });

  describe("each figure follows its own right", () => {
    it("manage-access alone: saldo, Resturlaub and the absence rows NO_PERMISSION; each added right adds exactly its figure; the admin sees all", async () => {
      const person = await createPerson("figures", { homeSalonId: salonS.id });
      const r0 = await createActor("r0", [MANAGE], { scopeType: "TENANT" });
      const r1 = await createActor("r1", [MANAGE, OVERTIME], { scopeType: "TENANT" });
      const r2 = await createActor("r2", [MANAGE, ENTITLEMENT], { scopeType: "TENANT" });

      const read = async (token: string) => {
        const res = await preview(person.employee.id, token);
        expect(res.statusCode, res.body).toBe(200);
        return JSON.parse(res.body) as PreviewBody;
      };

      const b0 = await read(r0.token);
      expect(b0.absences).toBeNull();
      expect(b0.absencesUnavailableReason).toBe("NO_PERMISSION");
      expect(b0.absenceCounts).toEqual({ CANCEL: 0, SHORTEN: 0, DELETE: 0, SKIP: 0 });
      expect(b0.saldo).toBeNull();
      expect(b0.saldoUnavailableReason).toBe("NO_PERMISSION");
      expect(b0.vacation).toBeNull();
      expect(b0.vacationUnavailableReason).toBe("NO_PERMISSION");

      const b1 = await read(r1.token);
      expect(b1.saldo).not.toBeNull();
      expect(b1.saldoUnavailableReason).toBeNull();
      expect(b1.vacation).toBeNull();
      expect(b1.vacationUnavailableReason).toBe("NO_PERMISSION");

      const b2 = await read(r2.token);
      expect(b2.saldo).toBeNull();
      expect(b2.saldoUnavailableReason).toBe("NO_PERMISSION");
      expect(b2.vacation).not.toBeNull();
      expect(b2.vacationUnavailableReason).toBeNull();

      const admin = await read(data.adminToken);
      expect(admin.saldo).not.toBeNull();
      expect(admin.vacation).not.toBeNull();
      expect(admin.saldo).toEqual(b1.saldo);
      expect(admin.vacation).toEqual(b2.vacation);
    });

    it("the absence rows (type, status, dates) need leave-request:read over the person; without it only counts per action (review WR-03)", async () => {
      const person = await createPerson("absence-rows", { homeSalonId: salonS.id });
      const start = new Date(today.getTime() + 8 * 86_400_000);
      const sick = await app.prisma.leaveType.create({
        data: { tenantId: data.tenant.id, code: "SICK", name: "Krankenstand", isPaid: true },
      });
      const request = await app.prisma.leaveRequest.create({
        data: {
          employeeId: person.employee.id,
          leaveTypeId: sick.id,
          startDate: start,
          endDate: start,
          days: 1,
          status: "APPROVED",
        },
      });
      const noLeave = await createActor("al0", [MANAGE], { scopeType: "TENANT" });
      const withLeave = await createActor("al1", [MANAGE, LEAVE_REQUEST], { scopeType: "TENANT" });

      const withheld = await preview(person.employee.id, noLeave.token);
      expect(withheld.statusCode, withheld.body).toBe(200);
      const w = JSON.parse(withheld.body) as PreviewBody;
      expect(w.absences).toBeNull();
      expect(w.absencesUnavailableReason).toBe("NO_PERMISSION");
      expect(w.absenceCounts).toEqual({ CANCEL: 1, SHORTEN: 0, DELETE: 0, SKIP: 0 });
      // Nothing that identifies the sick leave leaves the server.
      for (const secret of ["SICK", isoDay(start), request.id]) {
        expect(withheld.body).not.toContain(secret);
      }

      const shown = await preview(person.employee.id, withLeave.token);
      const s = JSON.parse(shown.body) as PreviewBody;
      expect(s.absencesUnavailableReason).toBeNull();
      expect(s.absences).toHaveLength(1);
      expect(s.absences![0]).toMatchObject({ id: request.id, typeCode: "SICK", action: "CANCEL" });
      expect(s.absenceCounts).toEqual(w.absenceCounts);

      const admin = await preview(person.employee.id, data.adminToken);
      expect((JSON.parse(admin.body) as PreviewBody).absences).toEqual(s.absences);
    });

    it("a figure the caller may not see is never computed", async () => {
      const person = await createPerson("not-computed", { homeSalonId: salonS.id });
      const r0 = await createActor("nc", [MANAGE], { scopeType: "TENANT" });
      const res = await preview(person.employee.id, r0.token);
      expect(res.statusCode, res.body).toBe(200);
      const raw = JSON.parse(res.body) as Record<string, unknown>;
      // Both reason keys are always present; the figures are null, not absent.
      expect(Object.keys(raw)).toEqual(expect.arrayContaining(["saldo", "vacation"]));
      expect(raw.saldo).toBeNull();
      expect(raw.vacation).toBeNull();
    });

    it("a § 18 ArbZG exempt person has no saldo: NOT_TRACKED", async () => {
      const person = await createPerson("exempt", { homeSalonId: salonS.id, exempt: true });
      const res = await preview(person.employee.id, data.adminToken);
      expect(res.statusCode, res.body).toBe(200);
      const body = JSON.parse(res.body) as PreviewBody;
      expect(body.saldo).toBeNull();
      expect(body.saldoUnavailableReason).toBe("NOT_TRACKED");
      expect(body.vacation).not.toBeNull();
    });

    it("the Personalabteilung template holds overtime:read and leave-entitlement:read but not employee:manage-access: 403 on the preview, like on the deactivation", async () => {
      const person = await createPerson("hr-target", { homeSalonId: salonS.id });
      const { user } = await createPerson("hr-actor");
      await app.prisma.roleAssignment.create({
        data: {
          tenantId: data.tenant.id,
          userId: user.id,
          accessRoleId: SYSTEM_ROLE_IDS.HR,
          scopeType: "TENANT",
          salonIds: [],
          employeeIds: [],
        },
      });
      const token = await login(user.email);
      expect((await preview(person.employee.id, token)).statusCode).toBe(403);
      expect((await patchDeactivate(person.employee.id, token)).statusCode).toBe(403);
    });
  });

  describe("Stammsalon scope and the identical 404 (T-100-09)", () => {
    it("a salon-scoped actor previews a person of its own salon with both figures", async () => {
      const p = await createPerson("in-scope", { homeSalonId: salonS.id });
      const r3 = await createActor("r3-in", [MANAGE, OVERTIME, ENTITLEMENT], {
        scopeType: "SALONS",
        salonIds: [salonS.id],
      });
      const res = await preview(p.employee.id, r3.token);
      expect(res.statusCode, res.body).toBe(200);
      const body = JSON.parse(res.body) as PreviewBody;
      expect(body.saldo).not.toBeNull();
      expect(body.vacation).not.toBeNull();
    });

    it("an out-of-scope person, a nonexistent id and a foreign-tenant employee get the same status and byte-identical body, equal to the deactivation's", async () => {
      const r3 = await createActor("r3-404", [MANAGE, OVERTIME, ENTITLEMENT], {
        scopeType: "SALONS",
        salonIds: [salonS.id],
      });
      const outOfScope = await createPerson("out-of-scope", { homeSalonId: salonT.id });
      const targets = {
        outOfScope: outOfScope.employee.id,
        nonexistent: crypto.randomUUID(),
        foreignTenant: other.employee.id,
      };

      const previews: Record<string, { status: number; body: string }> = {};
      const patches: Record<string, { status: number; body: string }> = {};
      for (const [key, id] of Object.entries(targets)) {
        const p = await preview(id, r3.token);
        previews[key] = { status: p.statusCode, body: p.body };
        const d = await patchDeactivate(id, r3.token);
        patches[key] = { status: d.statusCode, body: d.body };
      }

      expect(previews.outOfScope.status).toBe(404);
      expect(previews.outOfScope.body).toBe(
        JSON.stringify({ error: "Mitarbeiter nicht gefunden" }),
      );
      expect(previews.nonexistent).toEqual(previews.outOfScope);
      expect(previews.foreignTenant).toEqual(previews.outOfScope);
      for (const key of Object.keys(targets)) expect(patches[key]).toEqual(previews[key]);

      // The admin cannot tell a foreign tenant's employee from an id that exists nowhere either.
      const adminNone = await preview(targets.nonexistent, data.adminToken);
      const adminForeign = await preview(targets.foreignTenant, data.adminToken);
      expect(adminNone.statusCode).toBe(404);
      expect({ status: adminForeign.statusCode, body: adminForeign.body }).toEqual({
        status: adminNone.statusCode,
        body: adminNone.body,
      });
      expect(adminNone.body).toBe(previews.outOfScope.body);

      // Nothing about the out-of-scope person was written.
      const still = await app.prisma.user.findUniqueOrThrow({ where: { id: outOfScope.user.id } });
      expect(still.isActive).toBe(true);
    });
  });

  describe("an inactive person", () => {
    it("is the 409 of the deactivation for an in-scope caller, but still the 404 for a caller who may not reach the person", async () => {
      const inScope = await createPerson("inactive-in", { homeSalonId: salonS.id, active: false });
      const outOfScope = await createPerson("inactive-out", {
        homeSalonId: salonT.id,
        active: false,
      });
      const res = await preview(inScope.employee.id, data.adminToken);
      expect(res.statusCode, res.body).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ error: "Mitarbeiter ist bereits deaktiviert" });

      const r3 = await createActor("r3-inactive", [MANAGE, OVERTIME, ENTITLEMENT], {
        scopeType: "SALONS",
        salonIds: [salonS.id],
      });
      const hidden = await preview(outOfScope.employee.id, r3.token);
      expect(hidden.statusCode, hidden.body).toBe(404);
      expect(JSON.parse(hidden.body)).toEqual({ error: "Mitarbeiter nicht gefunden" });
    });
  });
});
