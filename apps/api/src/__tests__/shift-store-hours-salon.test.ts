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
