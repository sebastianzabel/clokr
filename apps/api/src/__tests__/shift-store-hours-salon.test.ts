/**
 * Phase 325 Plan 02 (issue #325), D-10/D-11/D-13 — the shift store-hours check's parity table,
 * recorded against the PRE-#325 `TenantConfig.storeHours` reader, and the AC-4 two-salon
 * characterization for the check AFTER it switches to reading the shift's own `Salon.openingHours`.
 *
 * The "D-11 parity" describe block below was recorded against the OLD reader and MUST stay
 * BYTE-IDENTICAL after the switch (`git diff <parity-sha> <switch-sha> --
 * shift-store-hours-salon.test.ts` touches no line of it — only additions below it). See
 * 325-02-SUMMARY.md for both runs ("recorded on old reader", "after switch").
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { addDaysStr, holidayFreeMondayStr } from "./test-dates";
import { DEFAULT_SALON_OPENING_HOURS } from "../contexts/platform/facade/salons";
import type { FastifyInstance } from "fastify";

type StoreHoursMode = "STRICT" | "DAY_ONLY" | "OFF";

/** Only SHIFT_BASED employees pass the route's eligibility gate. */
async function makeShiftEligible(app: FastifyInstance, employeeId: string): Promise<void> {
  await app.prisma.workSchedule.create({
    data: {
      employeeId,
      type: "SHIFT_BASED",
      weeklyHours: 40,
      // Later than seedTestData's default 2024-01-01 FIXED_SCHEDULE row.
      validFrom: new Date("2024-06-01"),
    },
  });
}

// A custom 7-day week (0=Monday..6=Sunday, matching the check's own weekday encoding), covering
// a closed day on each end of the week plus two different open windows.
const CUSTOM_WEEK = [
  { day: 0, open: "09:00", close: "17:00" }, // Monday
  { day: 1, open: "10:00", close: "18:00" }, // Tuesday
  { day: 2, open: "09:00", close: "17:00", closed: true }, // Wednesday — closed
  { day: 3, open: "09:00", close: "17:00" }, // Thursday
  { day: 4, open: "09:00", close: "17:00" }, // Friday
  { day: 5, open: "09:00", close: "17:00" }, // Saturday
  { day: 6, open: "09:00", close: "17:00", closed: true }, // Sunday — closed
];

async function setMode(app: FastifyInstance, tenantId: string, mode: StoreHoursMode) {
  await app.prisma.tenantConfig.update({
    where: { tenantId },
    data: { shiftStoreHoursMode: mode },
  });
}

type ParityCase = {
  name: string;
  weeksAhead: number;
  dayOffset: number; // 0=Mon..6=Sun, matching CUSTOM_WEEK's `day`
  startTime: string;
  endTime: string;
  mode: StoreHoursMode;
  expectedStatus: number;
  expectedCode?: string;
  messageFragment?: string;
};

// Table-driven: weekday, start/end, mode, expected status/code/message-fragment. Each row uses a
// DIFFERENT future week (`weeksAhead`) so no two rows collide on the same calendar date.
const PARITY_CASES: ParityCase[] = [
  {
    name: "closed day (Wed) DAY_ONLY -> 409 geschlossen",
    weeksAhead: 2,
    dayOffset: 2,
    startTime: "10:00",
    endTime: "12:00",
    mode: "DAY_ONLY",
    expectedStatus: 409,
    expectedCode: "SHIFT_OUTSIDE_STORE_HOURS",
    messageFragment: "geschlossen",
  },
  {
    name: "closed day (Sun) STRICT -> 409 geschlossen",
    weeksAhead: 3,
    dayOffset: 6,
    startTime: "10:00",
    endTime: "12:00",
    mode: "STRICT",
    expectedStatus: 409,
    expectedCode: "SHIFT_OUTSIDE_STORE_HOURS",
    messageFragment: "geschlossen",
  },
  {
    name: "closed day (Wed) OFF -> 201",
    weeksAhead: 4,
    dayOffset: 2,
    startTime: "10:00",
    endTime: "12:00",
    mode: "OFF",
    expectedStatus: 201,
  },
  {
    name: "before open (Mon 07:00, opens 09:00) DAY_ONLY -> 201",
    weeksAhead: 5,
    dayOffset: 0,
    startTime: "07:00",
    endTime: "08:30",
    mode: "DAY_ONLY",
    expectedStatus: 201,
  },
  {
    name: "before open (Mon 07:00, opens 09:00) STRICT -> 409 names 09:00-17:00",
    weeksAhead: 6,
    dayOffset: 0,
    startTime: "07:00",
    endTime: "08:30",
    mode: "STRICT",
    expectedStatus: 409,
    expectedCode: "SHIFT_OUTSIDE_STORE_HOURS",
    messageFragment: "09:00–17:00",
  },
  {
    name: "after close (Tue 18:30, closes 18:00) STRICT -> 409",
    weeksAhead: 7,
    dayOffset: 1,
    startTime: "18:30",
    endTime: "19:30",
    mode: "STRICT",
    expectedStatus: 409,
    expectedCode: "SHIFT_OUTSIDE_STORE_HOURS",
  },
  {
    name: "inside (Tue 11:00-13:00, 10:00-18:00) STRICT -> 201",
    weeksAhead: 8,
    dayOffset: 1,
    startTime: "11:00",
    endTime: "13:00",
    mode: "STRICT",
    expectedStatus: 201,
  },
];

describe("shift store-hours check — D-11 parity (Phase 325 Plan 02, issue #325)", () => {
  let app: FastifyInstance;
  const cleanupTenantIds: string[] = [];

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    for (const tenantId of cleanupTenantIds) {
      try {
        await cleanupTestData(app, tenantId);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    }
  });

  it("D-13 mirror precondition + D-11 parity table (weekday x mode)", async () => {
    const seed = await seedTestData(app, "shift-store-hours-parity");
    cleanupTenantIds.push(seed.tenant.id);
    await makeShiftEligible(app, seed.employee.id);

    const putRes = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: { storeHours: CUSTOM_WEEK },
    });
    expect(putRes.statusCode, putRes.body.slice(0, 400)).toBe(200);

    // D-13 mirror precondition: seedTestData's tenant has exactly one active salon, so the PUT
    // above must have mirrored the custom week into it verbatim.
    const salon = await app.prisma.salon.findUniqueOrThrow({ where: { id: seed.salonId } });
    expect(salon.openingHours).toEqual(CUSTOM_WEEK);

    for (const c of PARITY_CASES) {
      await setMode(app, seed.tenant.id, c.mode);
      const monday = holidayFreeMondayStr(c.weeksAhead);
      const date = addDaysStr(monday, c.dayOffset);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts",
        headers: { authorization: `Bearer ${seed.adminToken}` },
        payload: {
          employeeId: seed.employee.id,
          date,
          startTime: c.startTime,
          endTime: c.endTime,
        },
      });
      expect(res.statusCode, `${c.name}: ${res.body.slice(0, 300)}`).toBe(c.expectedStatus);
      if (c.expectedCode) {
        const body = JSON.parse(res.body);
        expect(body.code, c.name).toBe(c.expectedCode);
        if (c.messageFragment) expect(body.message, c.name).toContain(c.messageFragment);
      }
    }
  });

  it("D-11: no TenantConfig row -> the OLD reader's no-check status, recorded", async () => {
    const seed = await seedTestData(app, "shift-store-hours-no-cfg");
    cleanupTenantIds.push(seed.tenant.id);
    await makeShiftEligible(app, seed.employee.id);

    // The salon's DEFAULT hours already close Sunday (DEFAULT_SALON_OPENING_HOURS, day 6). With
    // NO TenantConfig row at all, the OLD reader's combined `!cfg?.storeHours` check returns null
    // (no check) — recorded here as the ground truth this describe's sibling test must reproduce
    // unchanged after the switch to the salon reader.
    await app.prisma.tenantConfig.delete({ where: { tenantId: seed.tenant.id } });

    const monday = holidayFreeMondayStr(9);
    const sunday = addDaysStr(monday, 6);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        employeeId: seed.employee.id,
        date: sunday,
        startTime: "10:00",
        endTime: "12:00",
      },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("shift store-hours check — AC-4/D-07 two-salon behavior (Phase 325 Plan 02, issue #325)", () => {
  let app: FastifyInstance;
  const cleanupTenantIds: string[] = [];

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    for (const tenantId of cleanupTenantIds) {
      try {
        await cleanupTestData(app, tenantId);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    }
  });

  it("AC-4 direction 1 (DAY_ONLY): a shift outside ITS OWN salon's hours is flagged, inside is not", async () => {
    const seed = await seedTestData(app, "shift-store-hours-ac4-dayonly");
    cleanupTenantIds.push(seed.tenant.id);
    await makeShiftEligible(app, seed.employee.id);
    await setMode(app, seed.tenant.id, "DAY_ONLY");

    // Salon A (seedTestData's default) keeps DEFAULT_SALON_OPENING_HOURS — Monday OPEN.
    // Salon B closes Monday, created with a LATER createdAt so A stays the tenant default.
    const closedMonday = DEFAULT_SALON_OPENING_HOURS.map((d) =>
      d.day === 0 ? { ...d, closed: true } : d,
    );
    const salonB = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Salon B (Montags geschlossen)",
      openingHours: closedMonday,
      createdAt: new Date(Date.now() + 60_000),
    });

    const monday = holidayFreeMondayStr(10);

    const resB = await app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        employeeId: seed.employee.id,
        date: monday,
        startTime: "10:00",
        endTime: "12:00",
        salonId: salonB.id,
      },
    });
    expect(resB.statusCode, resB.body.slice(0, 300)).toBe(409);
    expect(JSON.parse(resB.body).code).toBe("SHIFT_OUTSIDE_STORE_HOURS");

    const resA = await app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        employeeId: seed.employee.id,
        date: monday,
        startTime: "10:00",
        endTime: "12:00",
        salonId: seed.salonId,
      },
    });
    expect(resA.statusCode, resA.body.slice(0, 300)).toBe(201);
  });

  it("AC-4 direction 2 (STRICT): a shift inside B's hours but outside A's is not flagged for B, and vice versa", async () => {
    const seed = await seedTestData(app, "shift-store-hours-ac4-strict");
    cleanupTenantIds.push(seed.tenant.id);
    await makeShiftEligible(app, seed.employee.id);
    await setMode(app, seed.tenant.id, "STRICT");

    // Salon A: Tuesday 10:00-18:00 (narrower). Salon B: Tuesday 08:00-20:00 (wider).
    const aHours = DEFAULT_SALON_OPENING_HOURS.map((d) =>
      d.day === 1 ? { ...d, open: "10:00", close: "18:00" } : d,
    );
    await app.prisma.salon.update({ where: { id: seed.salonId }, data: { openingHours: aHours } });
    const bHours = DEFAULT_SALON_OPENING_HOURS.map((d) =>
      d.day === 1 ? { ...d, open: "08:00", close: "20:00" } : d,
    );
    const salonB = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Salon B (weiter geöffnet Di)",
      openingHours: bHours,
      createdAt: new Date(Date.now() + 60_000),
    });

    const monday = holidayFreeMondayStr(11);
    const tuesdayWeek1 = addDaysStr(monday, 1);
    const tuesdayWeek2 = addDaysStr(monday, 8); // a different Tuesday — avoids the same-day conflict

    const resB = await app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        employeeId: seed.employee.id,
        date: tuesdayWeek1,
        startTime: "08:00",
        endTime: "12:00",
        salonId: salonB.id,
      },
    });
    expect(resB.statusCode, resB.body.slice(0, 300)).toBe(201);

    const resA = await app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        employeeId: seed.employee.id,
        date: tuesdayWeek2,
        startTime: "08:00",
        endTime: "12:00",
        salonId: seed.salonId,
      },
    });
    expect(resA.statusCode, resA.body.slice(0, 300)).toBe(409);
    expect(JSON.parse(resA.body).code).toBe("SHIFT_OUTSIDE_STORE_HOURS");
  });

  it("PUT changing to a salon whose hours reject it -> 409 (the NEW salon's hours); force=true -> 200 with SHIFT_FORCED_OUTSIDE_HOURS audit", async () => {
    const seed = await seedTestData(app, "shift-store-hours-put-change");
    cleanupTenantIds.push(seed.tenant.id);
    await makeShiftEligible(app, seed.employee.id);
    await setMode(app, seed.tenant.id, "DAY_ONLY");

    const closedMonday = DEFAULT_SALON_OPENING_HOURS.map((d) =>
      d.day === 0 ? { ...d, closed: true } : d,
    );
    const salonB = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Salon B (Montags geschlossen, PUT)",
      openingHours: closedMonday,
      createdAt: new Date(Date.now() + 60_000),
    });

    const monday = holidayFreeMondayStr(12);
    const shift = await app.prisma.shift.create({
      data: {
        employeeId: seed.employee.id,
        salonId: seed.salonId,
        date: new Date(monday),
        startTime: "10:00",
        endTime: "12:00",
      },
    });

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/shifts/${shift.id}`,
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: { salonId: salonB.id },
    });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(409);
    expect(JSON.parse(res.body).code).toBe("SHIFT_OUTSIDE_STORE_HOURS");

    const rowAfterReject = await app.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(rowAfterReject.salonId).toBe(seed.salonId);

    const forceRes = await app.inject({
      method: "PUT",
      url: `/api/v1/shifts/${shift.id}?force=true`,
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: { salonId: salonB.id },
    });
    expect(forceRes.statusCode, forceRes.body.slice(0, 300)).toBe(200);
    expect(JSON.parse(forceRes.body).salonId).toBe(salonB.id);

    const audit = await app.prisma.auditLog.findFirst({
      where: { entity: "Shift", entityId: shift.id, action: "SHIFT_FORCED_OUTSIDE_HOURS" },
    });
    expect(audit).not.toBeNull();
  });

  it("D-07: PUT {note} without salonId reads the shift's OWN (non-default) salon's hours, even after that salon is deactivated", async () => {
    const seed = await seedTestData(app, "shift-store-hours-put-note-only");
    cleanupTenantIds.push(seed.tenant.id);
    await makeShiftEligible(app, seed.employee.id);
    await setMode(app, seed.tenant.id, "DAY_ONLY");

    const closedMonday = DEFAULT_SALON_OPENING_HOURS.map((d) =>
      d.day === 0 ? { ...d, closed: true } : d,
    );
    const salonB = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Salon B (Montags geschlossen, PUT note)",
      openingHours: closedMonday,
      createdAt: new Date(Date.now() + 60_000),
    });

    const monday = holidayFreeMondayStr(13);
    // Created directly on salon B's closed Monday — this fixture only needs the ROW to already
    // sit on B, not to prove the create-time force flow (already pinned by the case above).
    const shift = await app.prisma.shift.create({
      data: {
        employeeId: seed.employee.id,
        salonId: salonB.id,
        date: new Date(monday),
        startTime: "10:00",
        endTime: "12:00",
      },
    });

    const res1 = await app.inject({
      method: "PUT",
      url: `/api/v1/shifts/${shift.id}`,
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: { note: "nur eine Notiz" },
    });
    expect(res1.statusCode, res1.body.slice(0, 300)).toBe(409);
    expect(JSON.parse(res1.body).code).toBe("SHIFT_OUTSIDE_STORE_HOURS");

    // Deactivate B — its hours still apply to a shift that already sits on it (D-07).
    await app.prisma.salon.update({
      where: { id: salonB.id },
      data: { isActive: false, deactivatedAt: new Date() },
    });

    const res2 = await app.inject({
      method: "PUT",
      url: `/api/v1/shifts/${shift.id}`,
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: { note: "noch eine Notiz" },
    });
    expect(res2.statusCode, res2.body.slice(0, 300)).toBe(409);
    expect(JSON.parse(res2.body).code).toBe("SHIFT_OUTSIDE_STORE_HOURS");
  });
});
