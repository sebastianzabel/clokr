/**
 * Issue #660 — the tracer: an unclear cross-salon gap becomes a server-built offer in
 * `GET /api/v1/day-breaks/checks`, and the offer, sent UNCHANGED through the existing
 * `POST /api/v1/time-entries`, records exactly one audited trip after which the day is no longer
 * unclear (AC-660-1, AC-660-2, AC-660-5; D-01, D-02, D-05).
 *
 * The scenario (tenant time): 08:00-12:00 in salon A and 12:30-14:30 in salon B, the same day the
 * #92 tracer uses. The half hour between is an unrecorded cross-salon gap, so it is UNCLEAR
 * ("Fahrzeit oder Pause?"). Nothing is mocked; no person names in fixtures.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon, soleAuditRow } from "./setup";
import { dowOf, pastDateStr, TEST_TZ, utcMidnight } from "./test-dates";

/** Tenant-local instant for `HH:MM` on `dayStr`. */
function at(dayStr: string, hhmm: string): string {
  return fromZonedTime(`${dayStr}T${hhmm}:00`, TEST_TZ).toISOString();
}

interface Offer {
  startTime: string;
  endTime: string;
  departureSalonId: string;
  arrivalSalonId: string;
  departureSalonName: string;
  arrivalSalonName: string;
}

interface DayItem {
  date: string;
  detail: string;
  locked: boolean;
  warnings: Array<{ code: string; certainty?: string }>;
  gaps: Array<{ startTime: string; endTime: string; crossSalon: boolean }> | null;
  travelOffers?: Offer[];
  [key: string]: unknown;
}

describe("Issue #660 — the day check offers an unclear A -> B gap as a trip (tracer)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let day: string;
  let adminDay: string;

  async function check(token: string, dayStr: string): Promise<DayItem | undefined> {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/day-breaks/checks?employeeId=${seed.employee.id}&from=${dayStr}&to=${dayStr}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return (JSON.parse(res.body) as { days: DayItem[] }).days.find((d) => d.date === dayStr);
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

  async function createAuditCount() {
    return app.prisma.auditLog.count({
      where: {
        entity: "TimeEntry",
        action: "CREATE",
        user: { employee: { id: seed.employee.id } },
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "off660");
    salonA = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon A" });
    salonB = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon B" });
    const weekdays: string[] = [];
    for (let back = 1; weekdays.length < 2 && back <= 6; back++) {
      const candidate = pastDateStr(back);
      if (dowOf(candidate) >= 1 && dowOf(candidate) <= 5) weekdays.push(candidate);
    }
    expect(weekdays, "two weekdays among the last six days").toHaveLength(2);
    [day, adminDay] = weekdays as [string, string];

    for (const [d, via] of [
      [day, "post"],
      [adminDay, "fixture"],
    ] as const) {
      if (via === "post") {
        for (const [from, to, salon] of [
          ["08:00", "12:00", salonA.id],
          ["12:30", "14:30", salonB.id],
        ] as const) {
          const res = await app.inject({
            method: "POST",
            url: "/api/v1/time-entries",
            headers: { authorization: `Bearer ${seed.empToken}` },
            payload: { date: d, startTime: at(d, from), endTime: at(d, to), salonId: salon },
          });
          expect(res.statusCode, res.body).toBe(201);
        }
      } else {
        await app.prisma.timeEntry.createMany({
          data: [
            ["08:00", "12:00", salonA.id],
            ["12:30", "14:30", salonB.id],
          ].map(([from, to, salonId]) => ({
            employeeId: seed.employee.id,
            date: utcMidnight(d),
            startTime: new Date(at(d, from!)),
            endTime: new Date(at(d, to!)),
            source: "MANUAL" as const,
            salonId: salonId!,
          })),
        });
      }
    }
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch {
      // best-effort cleanup
    }
  });

  let offer: Offer;
  let keysBefore: string[];
  let balanceBefore: number;
  let auditsBefore: number;
  let tripsBefore: number;

  it("CONTROL: the own day check lists the day in full detail, a cross-salon gap 12:00-12:30 and an UNCLEAR warning", async () => {
    const item = await check(seed.empToken, day);
    expect(item, "the day is listed").toBeDefined();
    expect(item!.detail).toBe("full");
    expect(item!.gaps).toHaveLength(1);
    expect(item!.gaps![0]!.crossSalon).toBe(true);
    expect(item!.gaps![0]!.startTime).toBe(at(day, "12:00"));
    expect(item!.gaps![0]!.endTime).toBe(at(day, "12:30"));
    expect(
      item!.warnings.some((w) => w.certainty === "UNCLEAR"),
      JSON.stringify(item!.warnings),
    ).toBe(true);
  });

  it("AC-660-1: the day carries exactly one offer - the gap interval, A as departure, B as arrival, with names", async () => {
    const item = await check(seed.empToken, day);
    expect(item!.travelOffers, JSON.stringify(item)).toHaveLength(1);
    offer = item!.travelOffers![0]!;
    // Same instant convention as `gaps`: the offer is string-equal to the gap it comes from.
    expect(offer.startTime).toBe(item!.gaps![0]!.startTime);
    expect(offer.endTime).toBe(item!.gaps![0]!.endTime);
    expect(offer.startTime).toBe(at(day, "12:00"));
    expect(offer.endTime).toBe(at(day, "12:30"));
    expect(offer.departureSalonId).toBe(salonA.id);
    expect(offer.arrivalSalonId).toBe(salonB.id);
    expect(offer.departureSalonName).toBe("Salon A");
    expect(offer.arrivalSalonName).toBe("Salon B");
    expect(Object.keys(offer).sort()).toEqual(
      [
        "arrivalSalonId",
        "arrivalSalonName",
        "departureSalonId",
        "departureSalonName",
        "endTime",
        "startTime",
      ].sort(),
    );
    keysBefore = Object.keys(item!)
      .filter((k) => k !== "travelOffers")
      .sort();
  });

  it("a whole-tenant admin reading the same kind of day gets the same offer (ids and names)", async () => {
    const item = await check(seed.adminToken, adminDay);
    expect(item, "the day is listed").toBeDefined();
    expect(item!.detail).toBe("full");
    expect(
      item!.warnings.some((w) => w.certainty === "UNCLEAR"),
      JSON.stringify(item!.warnings),
    ).toBe(true);
    expect(item!.travelOffers).toHaveLength(1);
    const adminOffer = item!.travelOffers![0]!;
    expect(adminOffer.startTime).toBe(at(adminDay, "12:00"));
    expect(adminOffer.endTime).toBe(at(adminDay, "12:30"));
    expect(adminOffer.departureSalonId).toBe(salonA.id);
    expect(adminOffer.arrivalSalonId).toBe(salonB.id);
    expect(adminOffer.departureSalonName).toBe("Salon A");
    expect(adminOffer.arrivalSalonName).toBe("Salon B");
  });

  it("AC-660-2: the offer sent unchanged through POST /time-entries records exactly one trip and one CREATE audit", async () => {
    balanceBefore = await liveBalanceMinutes();
    auditsBefore = await createAuditCount();
    tripsBefore = await app.prisma.timeEntry.count({
      where: { employeeId: seed.employee.id, activityKind: "TRAVEL" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${seed.empToken}` },
      payload: {
        date: day,
        startTime: offer.startTime,
        endTime: offer.endTime,
        salonId: offer.departureSalonId,
        travelToSalonId: offer.arrivalSalonId,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const created = (JSON.parse(res.body) as { entry: { id: string } }).entry;

    const trips = await app.prisma.timeEntry.findMany({
      where: { employeeId: seed.employee.id, activityKind: "TRAVEL" },
    });
    expect(trips).toHaveLength(tripsBefore + 1);
    const trip = trips.find((t) => t.id === created.id)!;
    expect(trip.salonId).toBe(salonA.id);
    expect(trip.travelToSalonId).toBe(salonB.id);
    expect(trip.startTime.toISOString()).toBe(offer.startTime);
    expect(trip.endTime!.toISOString()).toBe(offer.endTime);

    expect(await createAuditCount()).toBe(auditsBefore + 1);
    const audit = await soleAuditRow(app.prisma, {
      where: { entity: "TimeEntry", entityId: trip.id, action: "CREATE" },
    });
    expect(audit.newValue).toMatchObject({
      activityKind: "TRAVEL",
      salonId: salonA.id,
      travelToSalonId: salonB.id,
    });
  });

  it("afterwards the day check has no UNCLEAR finding, no cross-salon gap and no travelOffers key", async () => {
    const item = await check(seed.empToken, day);
    expect(item, "the day is still listed (a § 4 finding remains)").toBeDefined();
    expect(item!.warnings.some((w) => w.certainty === "UNCLEAR")).toBe(false);
    expect((item!.gaps ?? []).some((g) => g.crossSalon)).toBe(false);
    expect("travelOffers" in item!).toBe(false);
    // The answer shape is the existing one: only the optional key differs.
    expect(Object.keys(item!).sort()).toEqual(keysBefore);
  });

  it("AC-660-5: the live saldo rose by exactly the gap minutes (+30), like any other trip", async () => {
    expect((await liveBalanceMinutes()) - balanceBefore).toBe(30);
  });
});
