/**
 * Phase 113b CHARACTERIZATION test, written before the #99 context split.
 *
 * Selected by docs/characterization-baseline.md § 6 "The D-06 shortlist" — `shifts.ts` row:
 * below-average line coverage in its own area (schichtplanung, 91.8% vs. 92.5%) AND named by
 * #100's cross-context-access list (`shifts.ts` reads `leaveRequest`/`absence` 5x each).
 *
 * These tests pin TODAY's behavior of `findShiftConflict()`'s ABSENCE branch (shifts.ts:181-190)
 * as exercised through POST /shifts and PUT /shifts/:id — the LEAVE-request branch of the same
 * function is already well covered (see the "POST /shifts conflictType" describe block in
 * shifts.test.ts), the ABSENCE branch was not, per `docs/characterization-baseline.md`'s own
 * coverage measurement.
 *
 * A failure here after the #99/#100 rebuild means the rebuild changed observable behavior, which
 * the rebuild promised not to do (#99's own acceptance criteria call the move a "reine
 * Verschiebung: keine Verhaltensänderung").
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import type { FastifyInstance } from "fastify";

/** A future business day (Mon–Fri), `offset` days out — mirrors shifts.test.ts's own
 *  `businessDayFromToday` helper (SHIFT_PAST_IMMUTABLE forbids past/today-adjacent dates from
 *  colliding with other describe blocks' fixtures in the same file). */
function businessDayFromToday(offset: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("shifts.ts characterization — Absence-conflict branch of findShiftConflict() (Phase 113b)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "shift-char");

    // POST /shifts requires an active SHIFT_BASED WorkSchedule (assertEmployeeShiftEligible).
    await app.prisma.workSchedule.create({
      data: {
        employeeId: data.employee.id,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        validFrom: new Date("2024-02-01"),
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

  it("POST /shifts on a day with a non-deleted VOCATIONAL_SCHOOL Absence, no force: 409 SHIFT_CONFLICT_ABSENCE with conflictType 'vocational_school'", async () => {
    const dateIso = businessDayFromToday(40);
    const absence = await app.prisma.absence.create({
      data: {
        employeeId: data.employee.id,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: new Date(dateIso),
        endDate: new Date(dateIso),
        days: 1,
        createdBy: data.adminUser.id,
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: data.employee.id,
        date: dateIso,
        startTime: "08:00",
        endTime: "16:00",
      },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code, "pins today's ABSENCE-branch conflict code").toBe("SHIFT_CONFLICT_ABSENCE");
    expect(
      body.conflictType,
      "pins classifyLeaveTypeCode(absence.type) for VOCATIONAL_SCHOOL",
    ).toBe("vocational_school");
    expect(body.canForce).toBe(true);

    // No shift was actually created — pins the "block, don't write" branch.
    const shifts = await app.prisma.shift.findMany({
      where: { employeeId: data.employee.id, date: new Date(dateIso) },
    });
    expect(shifts.length).toBe(0);

    await app.prisma.absence.delete({ where: { id: absence.id } });
  });

  it("POST /shifts?force=true over an Absence conflict: 201 created, and the force-override audit row names it SHIFT_FORCED_OVER_LEAVE (today's shared naming for BOTH leave- and absence-kind conflicts) carrying absenceId, not leaveRequestId", async () => {
    const dateIso = businessDayFromToday(46);
    const absence = await app.prisma.absence.create({
      data: {
        employeeId: data.employee.id,
        type: "SICK",
        source: "MANUAL",
        startDate: new Date(dateIso),
        endDate: new Date(dateIso),
        days: 1,
        createdBy: data.adminUser.id,
      },
    });
    await app.prisma.auditLog.deleteMany({
      where: { entity: "Shift", action: "SHIFT_FORCED_OVER_LEAVE" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts?force=true",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: data.employee.id,
        date: dateIso,
        startTime: "08:00",
        endTime: "16:00",
      },
    });

    expect(res.statusCode).toBe(201);
    const shift = JSON.parse(res.body);

    const audit = await app.prisma.auditLog.findFirst({
      where: { entity: "Shift", entityId: shift.id, action: "SHIFT_FORCED_OVER_LEAVE" },
    });
    expect(
      audit,
      "pins that force-overriding an ABSENCE conflict is audited under the SAME action name as forcing over a LEAVE conflict — the code branches on kind for the response body's `code` but not for this audit action string",
    ).not.toBeNull();
    const newValue = audit!.newValue as { absenceId?: string; leaveRequestId?: string };
    expect(newValue.absenceId).toBe(absence.id);
    expect(newValue.leaveRequestId).toBeUndefined();

    await app.prisma.shift.deleteMany({ where: { id: shift.id } });
    await app.prisma.absence.delete({ where: { id: absence.id } });
  });

  it("PUT /shifts/:id moved onto an Absence-conflict day, no force: 409 SHIFT_CONFLICT_ABSENCE — same gate as POST (call-site parity)", async () => {
    const safeDateIso = businessDayFromToday(52);
    const conflictDateIso = businessDayFromToday(58);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: data.employee.id,
        date: safeDateIso,
        startTime: "08:00",
        endTime: "16:00",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const shift = JSON.parse(createRes.body);

    const absence = await app.prisma.absence.create({
      data: {
        employeeId: data.employee.id,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: new Date(conflictDateIso),
        endDate: new Date(conflictDateIso),
        days: 1,
        createdBy: data.adminUser.id,
      },
    });

    const putRes = await app.inject({
      method: "PUT",
      url: `/api/v1/shifts/${shift.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { date: conflictDateIso },
    });

    expect(putRes.statusCode).toBe(409);
    const body = JSON.parse(putRes.body);
    expect(body.code).toBe("SHIFT_CONFLICT_ABSENCE");
    expect(body.conflictType).toBe("vocational_school");

    // The shift's date was NOT changed — pins "block before write" parity with POST.
    const reloaded = await app.prisma.shift.findUnique({ where: { id: shift.id } });
    expect(reloaded?.date.toISOString().slice(0, 10)).toBe(safeDateIso);

    await app.prisma.shift.deleteMany({ where: { id: shift.id } });
    await app.prisma.absence.delete({ where: { id: absence.id } });
  });
});
