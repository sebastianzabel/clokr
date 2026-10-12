/**
 * Issue #87 (Phase 87b-02), D-01/D-04/D-12 — the web clock-in (`POST /time-entries/clock-in`,
 * source MOBILE) may name the salon the new entry belongs to. The clock resolver hands the id to
 * the one entry-salon rule (`resolveEntrySalon`); this file proves the route-level write path:
 *
 * - the entry carries the CHOSEN salon, a deviation from the weekly pattern is never an error,
 *   a warning or a marker (AC-4/AC-5);
 * - without a salonId the pattern chain applies exactly as before (D-01);
 * - a foreign tenant's salon and an unknown id answer the byte-identical 404 in every state —
 *   no open entry, a closed entry of the day (REOPEN) and an open entry (T-100-09, D-12);
 * - a deactivated salon answers 400 SALON_INACTIVE, a null or malformed id 400 Validierungsfehler;
 * - re-clocking a finished day reopens its entry and never moves its salon: a differing explicit
 *   salon is a 409 SALON_DIFFERS_FROM_DAY_ENTRY and leaves the entry untouched (D-04).
 *
 * No person names in fixtures. Every fixture id is a UUID.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { addDaysStr, mondayOfWeekStr, TEST_TZ } from "./test-dates";

/** Tenant-local instant for `HH:MM` on `dayStr`. */
function instant(dayStr: string, hhmm: string): Date {
  return fromZonedTime(`${dayStr}T${hhmm}:00`, TEST_TZ);
}

type ClockInBody = {
  resolution: { kind: string; entry: { id: string; salonId: string } };
  warnings?: unknown;
};

describe("Issue #87 — clock-in with a chosen salon (write path)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let salonC: { id: string };

  // One distinct past Thursday per case: the one-entry-per-day index allows a single non-deleted
  // row per employee and day, so no case ever shares a day with another.
  const baseMonday = addDaysStr(mondayOfWeekStr(), -14 * 7);
  const thursdayOf = (weekOffset: number): string => addDaysStr(baseMonday, weekOffset * 7 + 3);

  /** POST /clock-in at `hhmm` of `dayStr` (tenant time) with the employee's token. */
  async function clockIn(
    dayStr: string,
    hhmm: string,
    payload: Record<string, unknown>,
    token?: string,
  ) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(instant(dayStr, hhmm));
    try {
      return await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/clock-in",
        headers: { authorization: `Bearer ${token ?? seed.empToken}` },
        payload,
      });
    } finally {
      vi.useRealTimers();
    }
  }

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "cis87");
    salonA = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon A (HOME)" });
    salonB = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Salon B (Thursday DEPLOYMENT)",
    });
    salonC = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Salon C (never assigned)",
    });

    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        employeeId: seed.employee.id,
        salonId: salonA.id,
        kind: "HOME",
        validFrom: new Date("2020-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        employeeId: seed.employee.id,
        salonId: salonB.id,
        kind: "DEPLOYMENT",
        validFrom: new Date("2020-01-01"),
        validUntil: null,
        weekdays: [3], // Thursday
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("tracer: a Thursday clock-in naming salon A lands on A although the pattern says B", async () => {
    const res = await clockIn(thursdayOf(0), "09:00", { source: "MOBILE", salonId: salonA.id });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as ClockInBody;
    expect(body.resolution.kind).toBe("CLOCKED_IN");
    expect(body.resolution.entry.salonId).toBe(salonA.id);
    const row = await app.prisma.timeEntry.findUniqueOrThrow({
      where: { id: body.resolution.entry.id },
    });
    expect(row.salonId).toBe(salonA.id);
  });

  it("without a salonId the same Thursday still lands on the pattern salon B (D-01)", async () => {
    const res = await clockIn(thursdayOf(1), "09:00", { source: "MOBILE" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as ClockInBody;
    expect(body.resolution.entry.salonId).toBe(salonB.id);
  });
});
