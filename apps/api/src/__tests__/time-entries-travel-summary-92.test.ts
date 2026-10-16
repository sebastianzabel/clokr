/**
 * Issue #92 (Phase 92b-04, AC-92-5, D-07) — travel is evaluable separately: `GET
 * /api/v1/time-entries/summary` returns `activityMinutes.TRAVEL` next to PRODUCTIVE,
 * SETUP_CLEANING and UNSPECIFIED.
 *
 * Day (tenant time, real POST/PUT routes, nothing written to a saldo table):
 *   A 08:00-12:00 salon A (UNSPECIFIED), T 12:00-12:30 travel A -> B, B 12:30-14:30 salon B
 *   classified PRODUCTIVE through PUT `activityKind`.
 *
 * Pinned here: the four values add up to `workingMinutes` before rounding; a salon filter
 * attributes the trip to its DEPARTURE salon (its own `salonId`); `entryCount` counts the trip;
 * without the Auswertungen module only `activityMinutes` is withheld (recording and counting are
 * never gated, #566 D-05) and `workingMinutes` still contains the travel minutes; the body
 * carries minutes only. No person names in fixtures.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { fromZonedTime } from "date-fns-tz";
import {
  getTestApp,
  seedTestData,
  seedGrundversionTenant,
  cleanupTestData,
  createTestSalon,
} from "./setup";
import { dowOf, pastDateStr, TEST_TZ } from "./test-dates";

function at(dayStr: string, hhmm: string): string {
  return fromZonedTime(`${dayStr}T${hhmm}:00`, TEST_TZ).toISOString();
}

const KINDS = ["PRODUCTIVE", "SETUP_CLEANING", "TRAVEL", "UNSPECIFIED"];
const BODY_KEYS = [
  "activityMinutes",
  "breakMinutes",
  "employeeId",
  "entryCount",
  "from",
  "presenceMinutes",
  "to",
  "workingMinutes",
];

type Summary = {
  presenceMinutes: number;
  workingMinutes: number;
  breakMinutes: number;
  entryCount: number;
  activityMinutes: Record<string, number> | null;
  activityMinutesUnavailableReason?: string;
};

type Fixture = {
  seed: Awaited<ReturnType<typeof seedTestData>>;
  salonA: { id: string };
  salonB: { id: string };
  day: string;
};

describe("Issue #92 — GET /time-entries/summary evaluates travel separately", () => {
  let app: FastifyInstance;
  let booked: Fixture;
  let grundversion: Fixture;

  async function weekday(): Promise<string> {
    for (let back = 1; back <= 6; back++) {
      const candidate = pastDateStr(back);
      if (dowOf(candidate) >= 1 && dowOf(candidate) <= 5) return candidate;
    }
    throw new Error("no weekday among the last six days");
  }

  async function book(f: Fixture, tag: string): Promise<void> {
    const post = (payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${f.seed.empToken}` },
        payload: { date: f.day, ...payload },
      });
    const a = await post({
      startTime: at(f.day, "08:00"),
      endTime: at(f.day, "12:00"),
      salonId: f.salonA.id,
    });
    expect(a.statusCode, `${tag} A: ${a.body}`).toBe(201);
    const b = await post({
      startTime: at(f.day, "12:30"),
      endTime: at(f.day, "14:30"),
      salonId: f.salonB.id,
    });
    expect(b.statusCode, `${tag} B: ${b.body}`).toBe(201);
    const t = await post({
      startTime: at(f.day, "12:00"),
      endTime: at(f.day, "12:30"),
      salonId: f.salonA.id,
      travelToSalonId: f.salonB.id,
    });
    expect(t.statusCode, `${tag} T: ${t.body}`).toBe(201);
    const put = await app.inject({
      method: "PUT",
      url: `/api/v1/time-entries/${JSON.parse(b.body).entry.id}`,
      headers: { authorization: `Bearer ${f.seed.adminToken}` },
      payload: { activityKind: "PRODUCTIVE" },
    });
    expect(put.statusCode, `${tag} PUT: ${put.body}`).toBe(200);
  }

  async function summary(f: Fixture, salonId?: string): Promise<Summary & Record<string, unknown>> {
    const qs = new URLSearchParams({
      employeeId: f.seed.employee.id,
      from: f.day,
      to: f.day,
      ...(salonId ? { salonId } : {}),
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/time-entries/summary?${qs.toString()}`,
      headers: { authorization: `Bearer ${f.seed.adminToken}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body);
  }

  beforeAll(async () => {
    app = await getTestApp();
    const day = await weekday();
    const seedA = await seedTestData(app, "trsum92");
    booked = {
      seed: seedA,
      salonA: await createTestSalon(app.prisma, seedA.tenant.id, { name: "Salon A" }),
      salonB: await createTestSalon(app.prisma, seedA.tenant.id, { name: "Salon B" }),
      day,
    };
    const seedG = await seedGrundversionTenant(app, "trsum92g");
    // Salons are created through the test helper (not the quota-bound route): the package rules
    // under test here concern the evaluation module only, not the salon quota.
    const gA = await createTestSalon(app.prisma, seedG.tenant.id, { name: "Salon A" });
    const gB = await createTestSalon(app.prisma, seedG.tenant.id, { name: "Salon B" });
    grundversion = { seed: seedG, salonA: gA, salonB: gB, day };
    await book(booked, "booked");
    await book(grundversion, "grundversion");
  });

  afterAll(async () => {
    for (const f of [booked, grundversion]) {
      try {
        await cleanupTestData(app, f.seed.tenant.id);
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("unfiltered: TRAVEL 30 next to PRODUCTIVE 120 and UNSPECIFIED 240, the four values sum to workingMinutes", async () => {
    const body = await summary(booked);
    expect(body.workingMinutes).toBe(390);
    expect(body.entryCount).toBe(3);
    expect(body.activityMinutes).toEqual({
      PRODUCTIVE: 120,
      SETUP_CLEANING: 0,
      TRAVEL: 30,
      UNSPECIFIED: 240,
    });
    const sum = Object.values(body.activityMinutes ?? {}).reduce((s, v) => s + v, 0);
    expect(sum).toBe(body.workingMinutes);
  });

  it("salonId = departure salon A: the trip counts to A", async () => {
    const body = await summary(booked, booked.salonA.id);
    expect(body.workingMinutes).toBe(270);
    expect(body.entryCount).toBe(2);
    expect(body.activityMinutes).toEqual({
      PRODUCTIVE: 0,
      SETUP_CLEANING: 0,
      TRAVEL: 30,
      UNSPECIFIED: 240,
    });
    const sum = Object.values(body.activityMinutes ?? {}).reduce((s, v) => s + v, 0);
    expect(sum).toBe(body.workingMinutes);
  });

  it("salonId = arrival salon B: the trip does not count to B", async () => {
    const body = await summary(booked, booked.salonB.id);
    expect(body.workingMinutes).toBe(120);
    expect(body.entryCount).toBe(1);
    expect(body.activityMinutes).toEqual({
      PRODUCTIVE: 120,
      SETUP_CLEANING: 0,
      TRAVEL: 0,
      UNSPECIFIED: 0,
    });
  });

  it("without the Auswertungen module only activityMinutes is withheld; workingMinutes still holds the trip", async () => {
    const body = await summary(grundversion);
    expect(body.workingMinutes).toBe(390);
    expect(body.entryCount).toBe(3);
    expect(body.activityMinutes).toBeNull();
    expect(body.activityMinutesUnavailableReason).toBe("MODULE_NOT_BOOKED");
  });

  it("the key set is the #81 one and the kinds are exactly the four values; minutes only", async () => {
    const body = await summary(booked);
    expect(Object.keys(body).sort()).toEqual(BODY_KEYS);
    expect(Object.keys(body.activityMinutes ?? {}).sort()).toEqual(KINDS);
    for (const v of Object.values(body.activityMinutes ?? {}))
      expect(Number.isInteger(v)).toBe(true);
    const forbidden = /(rate|ratio|percent|quot|amount|betrag|euro|kennzahl|score|cost)/i;
    const keys: string[] = [];
    const walk = (o: unknown) => {
      if (o && typeof o === "object") {
        for (const [k, v] of Object.entries(o)) {
          keys.push(k);
          walk(v);
        }
      }
    };
    walk(body);
    expect(keys.filter((k) => forbidden.test(k))).toEqual([]);
  });
});
