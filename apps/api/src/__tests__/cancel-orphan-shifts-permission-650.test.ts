/**
 * Issue #650 — `cancelOrphanShifts: true` on PUT /api/v1/settings/work/:employeeId deletes
 * shifts, which is a planning decision (least privilege, Art. 25/32 DSGVO). It therefore needs
 * `shift:plan` with a reach covering EVERY affected shift, refused with 403 before any write.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { SYSTEM_ROLE_IDS, normalizeRolePermissions, roleNameKey } from "../contexts/platform";

const PASSWORD = "Test1234!";
const REFUSAL = "Zum Verwerfen von Schichten ist das Recht zur Schichtplanung erforderlich.";

function isoDateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function monthFirstIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

describe("cancelOrphanShifts requires shift:plan over every affected shift (#650)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: string;
  let salonB: string;
  let target: { id: string };
  let hrToken: string;
  let managerAToken: string;
  let noPlanAToken: string;

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  async function createUser(label: string) {
    const suffix = `${label}-${crypto.randomBytes(3).toString("hex")}`;
    const user = await app.prisma.user.create({
      data: {
        email: `${suffix}@test.de`,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: suffix.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "Cos650",
        hireDate: new Date("2024-01-01T00:00:00Z"),
      },
    });
    return { user, employee };
  }

  async function homeAssignment(employeeId: string, salonId: string) {
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: new Date("2024-01-01T00:00:00Z"),
        validUntil: null,
        weekdays: [],
      },
    });
  }

  async function scopedCaller(label: string, permissions: string[], salonIds: string[]) {
    const { user, employee } = await createUser(label);
    await homeAssignment(employee.id, salonIds[0]);
    const name = `Cos650 ${crypto.randomBytes(3).toString("hex")}`;
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
        scopeType: "SALONS",
        salonIds,
        employeeIds: [],
      },
    });
    return login(user.email);
  }

  async function resetTarget(shiftSalons: string[]) {
    await app.prisma.shift.deleteMany({ where: { employeeId: target.id } });
    await app.prisma.workSchedule.deleteMany({ where: { employeeId: target.id } });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: target.id,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        validFrom: new Date("2024-01-01T00:00:00Z"),
      },
    });
    let i = 1;
    for (const salonId of shiftSalons) {
      await app.prisma.shift.create({
        data: {
          employeeId: target.id,
          salonId,
          date: new Date(`${isoDateOffset(i++)}T00:00:00Z`),
          startTime: "08:00",
          endTime: "16:00",
          createdBy: data.adminEmployee.id,
        },
      });
    }
  }

  function put(token: string, extra: Record<string, unknown> = { cancelOrphanShifts: true }) {
    return app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${target.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { type: "FLEXTIME", weeklyHours: 40, validFrom: monthFirstIso(), ...extra },
    });
  }

  async function expectUntouched(expectedShifts: number) {
    expect(await app.prisma.shift.count({ where: { employeeId: target.id } })).toBe(expectedShifts);
    const schedules = await app.prisma.workSchedule.findMany({ where: { employeeId: target.id } });
    expect(schedules).toHaveLength(1);
    expect(schedules[0].type).toBe("SHIFT_BASED");
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "cos650");
    salonA = data.salonId;
    salonB = (await createTestSalon(app.prisma, data.tenant.id, { name: "Cos650 B" })).id;

    const t = await createUser("Target");
    target = t.employee;
    await homeAssignment(target.id, salonA);

    const hr = await createUser("Hr");
    await homeAssignment(hr.employee.id, salonA);
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: hr.user.id,
        accessRoleId: SYSTEM_ROLE_IDS.HR,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    hrToken = await login(hr.user.email);

    managerAToken = await scopedCaller(
      "MgrA",
      ["contract:update:ZUGEWIESEN", "shift:plan:ZUGEWIESEN", "shift:read:ZUGEWIESEN"],
      [salonA],
    );
    noPlanAToken = await scopedCaller("NoPlan", ["contract:update:ZUGEWIESEN"], [salonA]);
  });

  beforeEach(async () => {
    await app.prisma.shift.deleteMany({ where: { employeeId: target.id } });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("cancel-orphan-shifts-permission-650 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("HR template (contract:update, no shift:plan) -> 403, shifts and contract unchanged", async () => {
    await resetTarget([salonA, salonA]);
    const res = await put(hrToken);
    expect(res.statusCode, res.body).toBe(403);
    expect(JSON.parse(res.body).error).toBe(REFUSAL);
    await expectUntouched(2);
  });

  it("caller with contract:update but no shift:plan at all -> 403, nothing written", async () => {
    await resetTarget([salonA]);
    const res = await put(noPlanAToken);
    expect(res.statusCode, res.body).toBe(403);
    await expectUntouched(1);
  });

  it("manager planning only salon A, shifts include one in salon B -> 403, nothing written", async () => {
    await resetTarget([salonA, salonB]);
    const res = await put(managerAToken);
    expect(res.statusCode, res.body).toBe(403);
    expect(JSON.parse(res.body).error).toBe(REFUSAL);
    await expectUntouched(2);
  });

  it("manager planning salon A, every shift in salon A -> 200, shifts discarded", async () => {
    await resetTarget([salonA, salonA]);
    const res = await put(managerAToken);
    expect(res.statusCode, res.body).toBe(200);
    expect(await app.prisma.shift.count({ where: { employeeId: target.id } })).toBe(0);
  });

  it("whole-tenant admin -> 200 as before", async () => {
    await resetTarget([salonA, salonB]);
    const res = await put(data.adminToken);
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).type).toBe("FLEXTIME");
    expect(await app.prisma.shift.count({ where: { employeeId: target.id } })).toBe(0);
  });

  it("without cancelOrphanShifts nothing changes for HR: 409 preview, then keepOrphanShifts -> 200", async () => {
    await resetTarget([salonA]);
    const pending = await put(hrToken, {});
    expect(pending.statusCode, pending.body).toBe(409);
    expect(JSON.parse(pending.body).code).toBe("ORPHAN_SHIFTS_PENDING");
    const kept = await put(hrToken, { keepOrphanShifts: true });
    expect(kept.statusCode, kept.body).toBe(200);
    expect(await app.prisma.shift.count({ where: { employeeId: target.id } })).toBe(1);
  });
});
