/**
 * Issue #92 (Phase 92b-01) — the tracer: the first REAL travel day, created through the real POST
 * route on the migrated database, evaluated by the UNCHANGED day kernel (#80/#511), the day check,
 * the period summary and the live saldo.
 *
 * The scenario (tenant time): 08:00-12:00 in salon A and 12:30-14:30 in salon B. The half hour in
 * between is an unrecorded cross-salon gap — never a break (#80), so it is "unclear" (Fahrzeit oder
 * Pause?). Recording it as a travel entry A -> B 12:00-12:30 turns it into working time: the kernel
 * then sees 390 working minutes and a 30 minute break duty (§ 4 ArbZG), the day check no longer
 * lists a cross-salon gap, and the saldo rises by exactly the travel minutes (AC-92-2/3).
 *
 * Nothing is mocked: the CHECK constraint of 92b-01 Task 1 and the overlap exclusion constraint of
 * #70 are the backstops behind the route. No person names in fixtures.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon, soleAuditRow } from "./setup";
import { dowOf, pastDateStr, TEST_TZ, utcMidnight } from "./test-dates";
import { closedWorkRowsOfDay } from "../contexts/time-tracking/day-break-store";
import { evaluateDayBreaks } from "../contexts/time-tracking/day-break-rule";

/** Tenant-local instant for `HH:MM` on `dayStr`. */
function at(dayStr: string, hhmm: string): string {
  return fromZonedTime(`${dayStr}T${hhmm}:00`, TEST_TZ).toISOString();
}

interface CreatedBody {
  entry: {
    id: string;
    salonId: string;
    travelToSalonId: string | null;
    activityKind: string;
    breakMinutes: number;
    type: string;
  };
  warnings: Array<{ code: string; crossSalon?: boolean }>;
}

interface DayCheckBody {
  days: Array<{
    date: string;
    crossSalon: boolean;
    warnings: Array<{ code: string; certainty?: string }>;
    gaps: Array<{ crossSalon: boolean; countsAsBreak: boolean }> | null;
  }>;
}

describe("Issue #92 — a travel day through POST, the unchanged kernel, the day check and the saldo", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  // Three DIFFERENT recent weekdays inside the retro window (the employee writes their own entries).
  let day: string;
  let day2: string;
  let day3: string;

  async function post(dayStr: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${seed.empToken}` },
      payload: { date: dayStr, ...payload },
    });
  }

  async function liveBalanceMinutes(): Promise<number> {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/${seed.employee.id}`,
      headers: { authorization: `Bearer ${seed.empToken}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return Math.round(Number(JSON.parse(res.body).balanceHours) * 60);
  }

  async function dayCheck(dayStr: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/day-breaks/checks?employeeId=${seed.employee.id}&from=${dayStr}&to=${dayStr}`,
      headers: { authorization: `Bearer ${seed.empToken}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return (JSON.parse(res.body) as DayCheckBody).days.find((d) => d.date === dayStr);
  }

  async function kernel(dayStr: string) {
    const rows = await closedWorkRowsOfDay(app.prisma, {
      tenantId: seed.tenant.id,
      employeeId: seed.employee.id,
      date: utcMidnight(dayStr),
    });
    return evaluateDayBreaks({ rows, dayBreaks: [], acks: [] });
  }

  async function entryCount() {
    return app.prisma.timeEntry.count({ where: { employeeId: seed.employee.id } });
  }
  async function auditCount() {
    return app.prisma.auditLog.count({
      where: {
        entity: "TimeEntry",
        action: "CREATE",
        user: { employee: { id: seed.employee.id } },
      },
    });
  }

  let travelId: string;

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "travel92");
    salonA = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon A" });
    salonB = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon B" });
    const weekdays: string[] = [];
    for (let back = 1; weekdays.length < 3 && back <= 5; back++) {
      const candidate = pastDateStr(back);
      if (dowOf(candidate) >= 1 && dowOf(candidate) <= 5) weekdays.push(candidate);
    }
    expect(weekdays, "three weekdays among the last five days").toHaveLength(3);
    [day, day2, day3] = weekdays as [string, string, string];
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch {
      // best-effort cleanup
    }
  });

  it("the two salon entries (08:00-12:00 A, 12:30-14:30 B) are created", async () => {
    const first = await post(day, {
      startTime: at(day, "08:00"),
      endTime: at(day, "12:00"),
      salonId: salonA.id,
    });
    expect(first.statusCode, first.body).toBe(201);
    const second = await post(day, {
      startTime: at(day, "12:30"),
      endTime: at(day, "14:30"),
      salonId: salonB.id,
    });
    expect(second.statusCode, second.body).toBe(201);
  });

  it("CONTROL (before the travel entry): 360 working minutes, no break duty, one cross-salon gap that is UNCLEAR", async () => {
    const evaluation = await kernel(day);
    expect(evaluation.netWorkedMin).toBe(360);
    expect(evaluation.requiredBreakMin).toBe(0);
    expect(evaluation.gaps).toHaveLength(1);
    expect(evaluation.gaps[0]?.crossSalon).toBe(true);

    const check = await dayCheck(day);
    expect(check, "the day is listed").toBeDefined();
    expect(check?.gaps?.some((g) => g.crossSalon && !g.countsAsBreak)).toBe(true);
    expect(
      check?.warnings.some((w) => w.certainty === "UNCLEAR"),
      JSON.stringify(check?.warnings),
    ).toBe(true);
  });

  let balanceBefore: number;
  let auditsBefore: number;

  it("the travel entry 12:00-12:30 (salon A -> salon B) is created with the derived kind TRAVEL (AC-92-1, AC-92-7)", async () => {
    balanceBefore = await liveBalanceMinutes();
    auditsBefore = await auditCount();
    const res = await post(day, {
      startTime: at(day, "12:00"),
      endTime: at(day, "12:30"),
      salonId: salonA.id,
      travelToSalonId: salonB.id,
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = JSON.parse(res.body) as CreatedBody;
    expect(body.entry.activityKind).toBe("TRAVEL");
    expect(body.entry.salonId).toBe(salonA.id);
    expect(body.entry.travelToSalonId).toBe(salonB.id);
    expect(body.entry.breakMinutes).toBe(0);
    expect(body.entry.type).toBe("WORK");
    travelId = body.entry.id;

    // AC-92-3: the day now needs a 30 minute break and has none.
    const tooShort = body.warnings.find((w) => w.code === "BREAK_TOO_SHORT");
    expect(tooShort, JSON.stringify(body.warnings)).toBeDefined();

    expect(await app.prisma.break.count({ where: { timeEntryId: travelId } })).toBe(0);
    expect(await auditCount()).toBe(auditsBefore + 1);
    const audit = await soleAuditRow(app.prisma, {
      where: { entity: "TimeEntry", entityId: travelId, action: "CREATE" },
    });
    expect(audit.newValue).toMatchObject({
      activityKind: "TRAVEL",
      salonId: salonA.id,
      travelToSalonId: salonB.id,
    });
  });

  it("AC-92-3: the unchanged kernel now computes 390 working minutes and a 30 minute break duty", async () => {
    const evaluation = await kernel(day);
    expect(evaluation.netWorkedMin).toBe(390);
    expect(evaluation.requiredBreakMin).toBe(30);
    expect(evaluation.breakShortfall).toBe(true);
  });

  it("D-09: the day check lists no cross-salon gap and no UNCLEAR finding any more", async () => {
    const check = await dayCheck(day);
    expect(check, "the day is still listed (a § 4 finding remains)").toBeDefined();
    expect(check?.gaps ?? []).toHaveLength(0);
    expect(
      check?.warnings.some((w) => w.certainty === "UNCLEAR"),
      JSON.stringify(check?.warnings),
    ).toBe(false);
  });

  it("the period summary counts the travel entry: 390 working minutes", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/time-entries/summary?employeeId=${seed.employee.id}&from=${day}&to=${day}`,
      headers: { authorization: `Bearer ${seed.empToken}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).workingMinutes).toBe(390);
  });

  it("AC-92-2: the live saldo rose by exactly the travel minutes (+30)", async () => {
    expect((await liveBalanceMinutes()) - balanceBefore).toBe(30);
  });

  it("AC-92-4: 5 h + 30 min travel + 5 h exceeds the 10 h day, the same day without the travel does not", async () => {
    const a = await post(day2, {
      startTime: at(day2, "06:00"),
      endTime: at(day2, "11:00"),
      salonId: salonA.id,
    });
    expect(a.statusCode, a.body).toBe(201);
    const b = await post(day2, {
      startTime: at(day2, "11:30"),
      endTime: at(day2, "16:30"),
      salonId: salonB.id,
    });
    expect(b.statusCode, b.body).toBe(201);
    const withoutTravel = JSON.parse(b.body) as CreatedBody;
    expect(
      withoutTravel.warnings.some((w) => w.code === "MAX_DAILY_EXCEEDED"),
      "600 minutes is not above 600",
    ).toBe(false);

    const travel = await post(day2, {
      startTime: at(day2, "11:00"),
      endTime: at(day2, "11:30"),
      salonId: salonA.id,
      travelToSalonId: salonB.id,
    });
    expect(travel.statusCode, travel.body).toBe(201);
    const withTravel = JSON.parse(travel.body) as CreatedBody;
    expect(
      withTravel.warnings.some((w) => w.code === "MAX_DAILY_EXCEEDED"),
      JSON.stringify(withTravel.warnings),
    ).toBe(true);
  });

  describe("AC-92-6: the way from or to home is not travel", () => {
    beforeAll(async () => {
      const a = await post(day3, {
        startTime: at(day3, "09:00"),
        endTime: at(day3, "12:00"),
        salonId: salonA.id,
      });
      expect(a.statusCode, a.body).toBe(201);
      const b = await post(day3, {
        startTime: at(day3, "12:30"),
        endTime: at(day3, "15:00"),
        salonId: salonB.id,
      });
      expect(b.statusCode, b.body).toBe(201);
    });

    const cases: Array<{ name: string; from: string; to: string; dep: "A" | "B" }> = [
      { name: "the trip from home (no entry before it)", from: "08:30", to: "09:00", dep: "B" },
      { name: "the trip home (no entry after it)", from: "15:00", to: "15:30", dep: "B" },
      {
        name: "the entry before it lies in the other salon",
        from: "12:00",
        to: "12:30",
        dep: "B",
      },
    ];
    for (const c of cases) {
      it(`${c.name} is 409 TRAVEL_NOT_BETWEEN_SALON_ENTRIES and writes nothing`, async () => {
        const entriesBefore = await entryCount();
        const auditsBeforeCase = await auditCount();
        const res = await post(day3, {
          startTime: at(day3, c.from),
          endTime: at(day3, c.to),
          salonId: c.dep === "B" ? salonB.id : salonA.id,
          travelToSalonId: c.dep === "B" ? salonA.id : salonB.id,
        });
        expect(res.statusCode, res.body).toBe(409);
        const body = JSON.parse(res.body) as { error: string; code: string };
        expect(body.code).toBe("TRAVEL_NOT_BETWEEN_SALON_ENTRIES");
        expect(body.error).toMatch(/^Fahrzeit kann nur zwischen einem Eintrag im Abfahrtssalon/);
        expect(await entryCount()).toBe(entriesBefore);
        expect(await auditCount()).toBe(auditsBeforeCase);
      });
    }
  });

  describe("D-06: the kind is derived, never sent; the travel shape is fixed", () => {
    async function refused(
      payload: Record<string, unknown>,
      status: number,
      expectedCode?: string,
    ): Promise<{ error: string; code?: string }> {
      const entriesBefore = await entryCount();
      const res = await post(day3, {
        startTime: at(day3, "16:00"),
        endTime: at(day3, "16:30"),
        ...payload,
      });
      expect(res.statusCode, res.body).toBe(status);
      const body = JSON.parse(res.body) as { error: string; code?: string };
      if (expectedCode) expect(body.code).toBe(expectedCode);
      expect(await entryCount(), "nothing was written").toBe(entriesBefore);
      return body;
    }

    it("a plain entry with activityKind TRAVEL is a 400 TRAVEL_KIND_DERIVED (never the database CHECK)", async () => {
      await refused({ salonId: salonB.id, activityKind: "TRAVEL" }, 400, "TRAVEL_KIND_DERIVED");
    });

    it("a plain entry with a TRAVEL activity share is a 400 with the share text", async () => {
      const body = await refused(
        { salonId: salonB.id, activityShares: [{ kind: "TRAVEL", minutes: 10 }] },
        400,
      );
      expect(body.error).toMatch(/^Fahrzeit ist kein Tätigkeitsanteil/);
    });

    it("equal departure and arrival salon is a 400 TRAVEL_SAME_SALON", async () => {
      await refused({ salonId: salonA.id, travelToSalonId: salonA.id }, 400, "TRAVEL_SAME_SALON");
    });

    it("a travel entry without an end, with break minutes or with break slots is a 400 TRAVEL_SHAPE", async () => {
      const base = { salonId: salonA.id, travelToSalonId: salonB.id };
      await refused({ ...base, endTime: null }, 400, "TRAVEL_SHAPE");
      await refused({ ...base, breakMinutes: 15 }, 400, "TRAVEL_SHAPE");
      await refused(
        {
          ...base,
          breaks: [{ startTime: at(day3, "16:05"), endTime: at(day3, "16:10") }],
        },
        400,
        "TRAVEL_SHAPE",
      );
    });

    it("a travel entry without a departure salon is a 400 TRAVEL_SALONS_REQUIRED", async () => {
      await refused({ travelToSalonId: salonB.id }, 400, "TRAVEL_SALONS_REQUIRED");
    });

    it("an unknown arrival salon is the 404 of any unknown salon and writes nothing", async () => {
      const body = await refused({ salonId: salonA.id, travelToSalonId: randomUUID() }, 404);
      expect(body.error).toBe("Salon nicht gefunden");
    });
  });
});
