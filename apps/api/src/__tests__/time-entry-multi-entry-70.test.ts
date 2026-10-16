/**
 * Issue #70 (Phase 70b-02) — the tracer: one employee holds several entries on one day, created
 * through the real POST route on the migrated database, evaluated by the unchanged day kernel
 * (#80/#511) and read back through the day-break check and the period summary.
 *
 * The scenario (tenant time): 07:00-11:00 in salon A, 11:30-15:00 in salon B. The gap between two
 * DIFFERENT salons is never a break (travel is working time, #92), so the day carries a § 4
 * shortfall flagged `crossSalon` and an UNCLEAR cross-salon gap. Each entry is under 6 h, so the
 * automatic break (which stays per entry) does not apply to either.
 *
 * Nothing is mocked: the database guarantee of 70b-01 (exclusion constraint) is the backstop, the
 * route re-checks overlap inside its own transaction under the Employee row lock.
 *
 * No person names in fixtures.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon, soleAuditRow } from "./setup";
import { nextWeekdayStr, pastDateStr, TEST_TZ } from "./test-dates";

/** Tenant-local instant for `HH:MM` on `dayStr`. */
function at(dayStr: string, hhmm: string): string {
  return fromZonedTime(`${dayStr}T${hhmm}:00`, TEST_TZ).toISOString();
}

interface CreatedBody {
  entry: { id: string; salonId: string; breakMinutes: number; startTime: string; endTime: string };
  warnings: Array<{ code: string; crossSalon?: boolean }>;
}

describe("Issue #70 — several entries per day through POST (tracer)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  // A past weekday inside the retro window (the employee writes their own entries).
  let day: string;

  async function post(payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${seed.empToken}` },
      payload: { date: day, ...payload },
    });
  }

  let firstId: string;
  let secondId: string;
  let thirdId: string;

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "multi70");
    salonA = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon A" });
    salonB = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon B" });
    // A weekday at least 3 days back, so the day is closed and not "today" for any clock rule.
    day = nextWeekdayStr(pastDateStr(6));
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch {
      // best-effort cleanup
    }
  });

  it("the first entry (07:00-11:00, salon A) is created", async () => {
    const res = await post({
      startTime: at(day, "07:00"),
      endTime: at(day, "11:00"),
      salonId: salonA.id,
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = JSON.parse(res.body) as CreatedBody;
    expect(body.entry.salonId).toBe(salonA.id);
    expect(body.entry.breakMinutes, "an entry under 6 h gets no automatic break").toBe(0);
    firstId = body.entry.id;
  });

  it("a second entry on the same day in another salon (11:30-15:00, salon B) is created, with the cross-salon shortfall warning", async () => {
    const res = await post({
      startTime: at(day, "11:30"),
      endTime: at(day, "15:00"),
      salonId: salonB.id,
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = JSON.parse(res.body) as CreatedBody;
    expect(body.entry.salonId).toBe(salonB.id);
    expect(body.entry.breakMinutes).toBe(0);
    secondId = body.entry.id;

    const tooShort = body.warnings.find((w) => w.code === "BREAK_TOO_SHORT");
    expect(tooShort, JSON.stringify(body.warnings)).toBeDefined();
    expect(tooShort?.crossSalon).toBe(true);

    const breaks = await app.prisma.break.count({
      where: { timeEntryId: { in: [firstId, secondId] } },
    });
    expect(breaks, "neither entry gets a Break row").toBe(0);
  });

  it("GET /time-entries lists both entries of the day with their salons", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/time-entries?from=${day}&to=${day}`,
      headers: { authorization: `Bearer ${seed.empToken}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const list = JSON.parse(res.body) as Array<{ id: string; salonId: string }>;
    const rows = (
      Array.isArray(list) ? list : (list as unknown as { entries: typeof list }).entries
    )
      .filter((e) => e.id === firstId || e.id === secondId)
      .sort((a, b) => (a.id === firstId ? -1 : 1) - (b.id === firstId ? -1 : 1));
    expect(rows.map((r) => r.salonId)).toEqual([salonA.id, salonB.id]);
  });

  it("the day check lists the day with an UNCLEAR cross-salon gap", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/day-breaks/checks?employeeId=${seed.employee.id}&from=${day}&to=${day}`,
      headers: { authorization: `Bearer ${seed.empToken}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as {
      days: Array<{
        date: string;
        crossSalon: boolean;
        warnings: Array<{ code: string; certainty?: string }>;
        gaps: Array<{ crossSalon: boolean; countsAsBreak: boolean }> | null;
      }>;
    };
    const dayCheck = body.days.find((d) => d.date === day);
    expect(dayCheck, JSON.stringify(body.days)).toBeDefined();
    expect(dayCheck?.crossSalon).toBe(true);
    expect(dayCheck?.gaps?.some((g) => g.crossSalon && !g.countsAsBreak)).toBe(true);
    // The § 4 Satz 3 placement finding of a cross-salon gap is UNCLEAR ("Fahrzeit oder Pause?");
    // the Satz 1 shortfall of the same day is the BREAK_TOO_SHORT item.
    expect(
      dayCheck?.warnings.some((w) => w.code === "BREAK_TOO_SHORT"),
      JSON.stringify(dayCheck?.warnings),
    ).toBe(true);
    expect(
      dayCheck?.warnings.some((w) => w.certainty === "UNCLEAR"),
      JSON.stringify(dayCheck?.warnings),
    ).toBe(true);
  });

  it("the period summary counts both entries: 450 working minutes", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/time-entries/summary?employeeId=${seed.employee.id}&from=${day}&to=${day}`,
      headers: { authorization: `Bearer ${seed.empToken}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).workingMinutes).toBe(450);
  });

  it("an overlapping third entry is a 409 naming the conflicting entry, and writes nothing", async () => {
    const before = await app.prisma.timeEntry.count({
      where: { employeeId: seed.employee.id, deletedAt: null },
    });
    const res = await post({
      startTime: at(day, "10:00"),
      endTime: at(day, "12:00"),
      salonId: salonA.id,
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body).error).toMatch(/^Überschneidung mit bestehendem Eintrag vom /);
    const after = await app.prisma.timeEntry.count({
      where: { employeeId: seed.employee.id, deletedAt: null },
    });
    expect(after).toBe(before);
  });

  it("a back-to-back entry (15:00-16:00, salon B) is created", async () => {
    const res = await post({
      startTime: at(day, "15:00"),
      endTime: at(day, "16:00"),
      salonId: salonB.id,
    });
    expect(res.statusCode, res.body).toBe(201);
    thirdId = (JSON.parse(res.body) as CreatedBody).entry.id;
  });

  it("every created entry has exactly one CREATE audit row", async () => {
    for (const id of [firstId, secondId, thirdId]) {
      const row = await soleAuditRow(app.prisma, {
        where: { entity: "TimeEntry", entityId: id, action: "CREATE" },
      });
      expect(row.entityId).toBe(id);
    }
  });

  it("a soft-deleted entry frees its interval", async () => {
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/time-entries/${thirdId}`,
      headers: { authorization: `Bearer ${seed.empToken}` },
      payload: { reason: "Irrtümlich angelegt, wird neu erfasst" },
    });
    expect(del.statusCode, del.body).toBe(204);

    const again = await post({
      startTime: at(day, "15:00"),
      endTime: at(day, "16:00"),
      salonId: salonB.id,
    });
    expect(again.statusCode, again.body).toBe(201);
  });
});
