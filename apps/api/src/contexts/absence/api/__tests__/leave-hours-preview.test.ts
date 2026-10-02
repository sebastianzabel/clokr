/**
 * leave-hours-preview.test.ts
 *
 * Phase 430 Plan 04 (D-15) — `GET /leave/hours-preview` gains a `rosterImported` boolean: true
 * only when at least one active `Shift` row exists for the employee in the requested week (Monday
 * of `startDate`'s week .. that Sunday), meaningful only for `SHIFT_BASED` employees. For every
 * other schedule type the field is `true` unconditionally, so the leave-dialog hint this signal
 * feeds (D-16) can never fire for them.
 *
 * `provisional` (Issue #417, hard-wired `false`) is a DIFFERENT field and must not be repurposed
 * for this signal (CONTEXT.md D-15) — the SHIFT_BASED-with-no-roster case below asserts BOTH
 * fields in the same response to pin that they vary independently: `provisional` stays `false`
 * while `rosterImported` is `false`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getTestApp,
  closeTestApp,
  cleanupTestData,
  createTestSalon,
  salonIdForEmployee,
} from "../../../../__tests__/setup";
import { holidayFreeMondayStr, addDaysStr, utcMidnight } from "../../../../__tests__/test-dates";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

// Two full years before "now" — always in the past, never a bare calendar-year literal.
const PAST_ANCHOR = new Date(Date.UTC(new Date().getUTCFullYear() - 2, 0, 1));

describe("GET /leave/hours-preview — rosterImported (Phase 430, D-15)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let sbEmployeeId: string;
  let sbToken: string;
  let fxEmployeeId: string;
  let fxToken: string;

  // Widely-spaced, holiday-free Mondays so the three cases' weeks can never overlap each other
  // and a stray public holiday can never change the calc this file is NOT testing.
  const NO_SHIFT_MONDAY = holidayFreeMondayStr(20);
  const WITH_SHIFT_MONDAY = holidayFreeMondayStr(24);
  const FX_MONDAY = holidayFreeMondayStr(28);

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;

    const suffix = "lhp-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const tenant = await prisma.tenant.create({
      data: { name: `LHP ${suffix}`, slug: `lhp-${suffix}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await createTestSalon(prisma, tenantId);
    await prisma.tenantConfig.create({ data: { tenantId } });

    const passwordHash = await bcrypt.hash("test1234", 10);

    async function makeEmployee(
      label: string,
      type: "SHIFT_BASED" | "FIXED_SCHEDULE",
    ): Promise<{ employeeId: string; token: string }> {
      const email = `lhp-${label}-${suffix}@test.de`;
      const user = await prisma.user.create({
        data: { email, passwordHash, role: "EMPLOYEE", isActive: true },
      });
      const employee = await prisma.employee.create({
        data: {
          tenantId,
          userId: user.id,
          employeeNumber: `LHP-${label.toUpperCase()}-${suffix}`,
          firstName: "LHP",
          lastName: label,
          hireDate: PAST_ANCHOR,
        },
      });
      await prisma.workSchedule.create({
        data: {
          employeeId: employee.id,
          type,
          weeklyHours: type === "SHIFT_BASED" ? 32 : 40,
          ...(type === "SHIFT_BASED" ? { contractWorkDaysPerWeek: 4 } : {}),
          validFrom: PAST_ANCHOR,
        },
      });
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email, password: "test1234" },
      });
      const token = JSON.parse(login.body).accessToken as string;
      return { employeeId: employee.id, token };
    }

    const sb = await makeEmployee("sb", "SHIFT_BASED");
    sbEmployeeId = sb.employeeId;
    sbToken = sb.token;

    const fx = await makeEmployee("fx", "FIXED_SCHEDULE");
    fxEmployeeId = fx.employeeId;
    fxToken = fx.token;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("leave-hours-preview cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function hoursPreview(token: string, startDate: string, endDate: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1/leave/hours-preview?startDate=${startDate}&endDate=${endDate}&halfDay=false`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function seedShift(employeeId: string, dateIso: string) {
    await app.prisma.shift.create({
      data: {
        employeeId,
        salonId: await salonIdForEmployee(app.prisma, employeeId),
        date: utcMidnight(dateIso),
        startTime: "09:00",
        endTime: "15:00",
      },
    });
  }

  it("SHIFT_BASED employee, no Shift rows in the requested week -> rosterImported: false (and provisional stays false, unrelated)", async () => {
    const start = NO_SHIFT_MONDAY;
    const end = addDaysStr(NO_SHIFT_MONDAY, 1); // Mon+Tue fragment

    const res = await hoursPreview(sbToken, start, end);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.rosterImported).toBe(false);
    expect(body.provisional).toBe(false); // Issue #417 — unaffected by this new field
  });

  it("SHIFT_BASED employee, at least one Shift row in the requested week -> rosterImported: true", async () => {
    const start = WITH_SHIFT_MONDAY;
    const end = addDaysStr(WITH_SHIFT_MONDAY, 1); // Mon+Tue fragment

    // The shift lands on the Wednesday of the SAME ISO week, outside the requested Mon+Tue
    // fragment itself — rosterImported asks "is this WEEK rostered", not "is this exact day".
    await seedShift(sbEmployeeId, addDaysStr(WITH_SHIFT_MONDAY, 2));

    const res = await hoursPreview(sbToken, start, end);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.rosterImported).toBe(true);
  });

  it("non-SHIFT_BASED (FIXED_SCHEDULE) employee -> rosterImported is true regardless of Shift rows, so the hint can never fire", async () => {
    const start = FX_MONDAY;
    const end = addDaysStr(FX_MONDAY, 1);

    const before = await hoursPreview(fxToken, start, end);
    expect(before.statusCode).toBe(200);
    expect(JSON.parse(before.body).rosterImported).toBe(true);

    // Seeding a Shift changes nothing — the field is unconditional for this schedule type.
    await seedShift(fxEmployeeId, FX_MONDAY);
    const after = await hoursPreview(fxToken, start, end);
    expect(after.statusCode).toBe(200);
    expect(JSON.parse(after.body).rosterImported).toBe(true);
  });

  it("existing hours-preview fields (hours/days/minutesNeeded) are unchanged in shape", async () => {
    const res = await hoursPreview(sbToken, NO_SHIFT_MONDAY, NO_SHIFT_MONDAY);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.hours).toBe("number");
    expect(typeof body.days).toBe("number");
    expect(typeof body.minutesNeeded).toBe("number");
  });
});

/**
 * Issue #436 (D-04/D-09, Task 3 of 436-04) — `type`/`excludeRequestId` on `GET
 * /hours-preview`: with `type` the preview prices EXACTLY like the server would (week-union
 * against the employee's other counted VACATION requests, excluding the request being edited).
 */
describe("GET /leave/hours-preview — type/excludeRequestId (Issue #436, D-04/D-09)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let empId: string;
  let empToken: string;
  const MONDAY = holidayFreeMondayStr(40);

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const suffix = "lhp2-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const tenant = await prisma.tenant.create({
      data: { name: `LHP2 ${suffix}`, slug: `lhp2-${suffix}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await createTestSalon(prisma, tenantId);
    await prisma.tenantConfig.create({ data: { tenantId } });

    const passwordHash = await bcrypt.hash("test1234", 10);
    const email = `lhp2-emp-${suffix}@test.de`;
    const user = await prisma.user.create({
      data: { email, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `LHP2-EMP-${suffix}`,
        firstName: "LHP2",
        lastName: "emp",
        hireDate: PAST_ANCHOR,
      },
    });
    empId = employee.id;
    await prisma.workSchedule.create({
      data: {
        employeeId: empId,
        type: "SHIFT_BASED",
        weeklyHours: 38,
        contractWorkDaysPerWeek: 4,
        validFrom: PAST_ANCHOR,
      },
    });
    const vacType = await prisma.leaveType.create({
      data: { tenantId, code: "VACATION", name: "Urlaub", isPaid: true, requiresApproval: true },
    });
    const thisYear = new Date().getUTCFullYear();
    for (const year of [thisYear, thisYear + 1]) {
      await prisma.leaveEntitlement.create({
        data: { employeeId: empId, leaveTypeId: vacType.id, year, totalDays: 200, usedDays: 0 },
      });
    }
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: "test1234" },
    });
    empToken = JSON.parse(login.body).accessToken as string;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("leave-hours-preview type/excludeRequestId cleanup failed:", err);
    }
  });

  async function previewWithType(
    startDate: string,
    endDate: string,
    extra: Record<string, string> = {},
  ) {
    const params = new URLSearchParams({ startDate, endDate, halfDay: "false", ...extra });
    return app.inject({
      method: "GET",
      url: `/api/v1/leave/hours-preview?${params.toString()}`,
      headers: { authorization: `Bearer ${empToken}` },
    });
  }

  async function postVacation(startDate: string, endDate: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${empToken}` },
      payload: { type: "VACATION", startDate, endDate },
    });
  }

  async function approve(id: string) {
    const admin = await app.prisma.user.create({
      data: {
        email: `lhp2-admin-${id}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "ADMIN",
        isActive: true,
      },
    });
    await app.prisma.employee.create({
      data: {
        tenantId,
        userId: admin.id,
        employeeNumber: `LHP2-ADMIN-${id}`,
        firstName: "LHP2",
        lastName: "admin",
        hireDate: PAST_ANCHOR,
      },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `lhp2-admin-${id}@test.de`, password: "test1234" },
    });
    const adminToken = JSON.parse(login.body).accessToken as string;
    return app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/review`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: "APPROVED" },
    });
  }

  it("with approved A=Mo-Mi, preview Do-Sa with type=VACATION -> 1; without type -> 3 (unchanged isolated answer)", async () => {
    const resA = await postVacation(MONDAY, addDaysStr(MONDAY, 2)); // Mo-Mi
    const idA = JSON.parse(resA.body).id as string;
    await approve(idA);

    const withType = await previewWithType(addDaysStr(MONDAY, 3), addDaysStr(MONDAY, 5), {
      type: "VACATION",
    });
    expect(withType.statusCode).toBe(200);
    expect(JSON.parse(withType.body).days).toBe(1);

    const withoutType = await previewWithType(addDaysStr(MONDAY, 3), addDaysStr(MONDAY, 5));
    expect(withoutType.statusCode).toBe(200);
    expect(JSON.parse(withoutType.body).days).toBe(3);
  });

  it("editing B (pending Do-Sa, stored 1): preview Do-Sa with type=VACATION&excludeRequestId=B -> 1; without excludeRequestId -> 0", async () => {
    const monday2 = addDaysStr(MONDAY, 70); // a fresh, non-overlapping week far from case 1
    const resA = await postVacation(monday2, addDaysStr(monday2, 2)); // Mo-Mi
    const idA = JSON.parse(resA.body).id as string;
    await approve(idA);

    const resB = await postVacation(addDaysStr(monday2, 3), addDaysStr(monday2, 5)); // Do-Sa
    const idB = JSON.parse(resB.body).id as string;
    expect(Number(JSON.parse(resB.body).days)).toBe(1);

    const withExclude = await previewWithType(addDaysStr(monday2, 3), addDaysStr(monday2, 5), {
      type: "VACATION",
      excludeRequestId: idB,
    });
    expect(withExclude.statusCode).toBe(200);
    expect(JSON.parse(withExclude.body).days).toBe(1);

    const withoutExclude = await previewWithType(addDaysStr(monday2, 3), addDaysStr(monday2, 5), {
      type: "VACATION",
    });
    expect(withoutExclude.statusCode).toBe(200);
    expect(JSON.parse(withoutExclude.body).days).toBe(0); // B's own stored dates already counted
  });

  it("excludeRequestId of another tenant's request vs. a random unknown uuid -> byte-identical status and body (T-100-09 style); a non-uuid value -> 400 German message", async () => {
    const otherTenant = await app.prisma.tenant.create({
      data: { name: "LHP2 other", slug: `lhp2-other-${Date.now()}`, federalState: "NIEDERSACHSEN" },
    });
    const otherUser = await app.prisma.user.create({
      data: {
        email: `lhp2-other-${Date.now()}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const otherEmployee = await app.prisma.employee.create({
      data: {
        tenantId: otherTenant.id,
        userId: otherUser.id,
        employeeNumber: `LHP2-OTHER-${Date.now()}`,
        firstName: "LHP2",
        lastName: "other",
        hireDate: PAST_ANCHOR,
      },
    });
    const otherVacType = await app.prisma.leaveType.create({
      data: {
        tenantId: otherTenant.id,
        code: "VACATION",
        name: "Urlaub",
        isPaid: true,
        requiresApproval: true,
      },
    });
    const foreignMonday = addDaysStr(MONDAY, 140);
    const foreignRequest = await app.prisma.leaveRequest.create({
      data: {
        employeeId: otherEmployee.id,
        leaveTypeId: otherVacType.id,
        startDate: new Date(foreignMonday),
        endDate: new Date(addDaysStr(foreignMonday, 2)),
        halfDay: false,
        status: "APPROVED",
        days: 3,
      },
    });

    const previewMonday = addDaysStr(MONDAY, 210);
    const withForeignId = await previewWithType(previewMonday, previewMonday, {
      type: "VACATION",
      excludeRequestId: foreignRequest.id,
    });
    const randomUuid = "00000000-0000-4000-8000-000000000000";
    const withRandomUuid = await previewWithType(previewMonday, previewMonday, {
      type: "VACATION",
      excludeRequestId: randomUuid,
    });
    expect(withForeignId.statusCode).toBe(withRandomUuid.statusCode);
    expect(withForeignId.body).toBe(withRandomUuid.body);

    const withNonUuid = await previewWithType(previewMonday, previewMonday, {
      type: "VACATION",
      excludeRequestId: "not-a-uuid",
    });
    expect(withNonUuid.statusCode).toBe(400);
    expect(JSON.parse(withNonUuid.body).error).toBe("Ungültige Antrags-ID");

    await app.prisma.leaveRequest.delete({ where: { id: foreignRequest.id } });
    await app.prisma.employee.delete({ where: { id: otherEmployee.id } });
    await app.prisma.leaveType.delete({ where: { id: otherVacType.id } });
    await app.prisma.user.delete({ where: { id: otherUser.id } });
    await app.prisma.tenant.delete({ where: { id: otherTenant.id } });
  });
});
