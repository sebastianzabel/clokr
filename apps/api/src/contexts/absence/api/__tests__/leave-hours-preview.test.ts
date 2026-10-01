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
