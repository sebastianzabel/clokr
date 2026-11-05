/**
 * Issue #660 — the rules of the travel offer on the real route and the migrated database:
 * every no-offer case (AC-660-3; D-02, D-04, D-06; P-660-02/03/04/05), the reach matrix with "no
 * hidden number" (#85 D-07), and stale offers refused by the unchanged write rule (AC-660-4, D-05).
 *
 * The world, as tags (tenant time; every case owns a day of its own):
 *   A, B, X, C  salons "Salon A" / "Salon B" / "Salon X" / default salon of the fixture tenant
 *   E           the fixture employee (own days inside the retro window only for the stale cases)
 *   ADMIN       whole-tenant admin; reads another person's day, so the retro window never applies
 *   M-*         scoped managers (one stored role assignment per role/scope pair)
 *
 * Every no-offer case first asserts its CONTROL from the same answer (the day is listed in full
 * detail, a cross-salon gap and an UNCLEAR warning are present) and only then the absence of the
 * key - never a vacuous absence. No person names in fixtures.
 *
 * Mutation proofs (cp backup / restore) are recorded in the 660-01 SUMMARY.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { dowOf, nextWeekdayStr, pastDateStr, TEST_TZ, utcMidnight } from "./test-dates";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";
import { getTenantTimezone, monthRangeUtc } from "../contexts/working-time-account";
import { invalidReasonFields } from "../contexts/time-tracking/invalid-reason";

const PASSWORD = "test1234";

/** Tenant-local instant for `HH:MM` on `dayStr`. */
function at(dayStr: string, hhmm: string): string {
  return fromZonedTime(`${dayStr}T${hhmm}:00`, TEST_TZ).toISOString();
}

/** Every number anywhere in a JSON value, with its path. */
function numericLeaves(value: unknown, path = "$"): Array<{ path: string; value: number }> {
  if (typeof value === "number") return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => numericLeaves(v, `${path}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => numericLeaves(v, `${path}.${k}`));
  }
  return [];
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

type RowSpec = [from: string, to: string, salonId: string, extra?: Record<string, unknown>];

describe("Issue #660 — the travel offer: where it exists, where it must not, and stale offers", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let salonX: { id: string };
  let dayCounter = 0;
  const retroRequestIds: string[] = [];

  /** The n-th distinct weekday, three calendar days apart, starting twenty days ago. */
  function nextAdminDay(): string {
    return nextWeekdayStr(pastDateStr(20 + 3 * dayCounter++));
  }

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  /** A fresh user + employee holding one stored role assignment per `assignments` entry. */
  async function person(
    label: string,
    assignments: Array<{ permissions: string[]; salonIds: string[] | "TENANT" }>,
  ): Promise<{ token: string; employeeId: string }> {
    const s = `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `${s}@test.de`,
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: seed.tenant.id,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: "Scoped",
        lastName: "OfferTest",
        hireDate: new Date("2020-01-01"),
      },
    });
    for (const [i, a] of assignments.entries()) {
      const name = `Offer660 ${i} ${crypto.randomBytes(3).toString("hex")}`;
      const role = await app.prisma.accessRole.create({
        data: {
          tenantId: seed.tenant.id,
          name,
          nameKey: roleNameKey(name),
          permissions: normalizeRolePermissions(a.permissions),
        },
      });
      await app.prisma.roleAssignment.create({
        data: {
          tenantId: seed.tenant.id,
          userId: user.id,
          accessRoleId: role.id,
          scopeType: a.salonIds === "TENANT" ? "TENANT" : "SALONS",
          salonIds: a.salonIds === "TENANT" ? [] : a.salonIds,
          employeeIds: [],
        },
      });
    }
    return { token: await login(user.email), employeeId: employee.id };
  }

  async function seedRows(employeeId: string, day: string, specs: RowSpec[]) {
    const ids: string[] = [];
    for (const [from, to, salonId, extra] of specs) {
      const row = await app.prisma.timeEntry.create({
        data: {
          employeeId,
          date: utcMidnight(day),
          startTime: new Date(at(day, from)),
          endTime: new Date(at(day, to)),
          source: "MANUAL",
          salonId,
          ...extra,
        },
      });
      ids.push(row.id);
    }
    return ids;
  }

  /** The day A 08:00-12:00 / B 12:30-14:30 (the #92 tracer day, UNCLEAR by the kernel). */
  const anchors = (): RowSpec[] => [
    ["08:00", "12:00", salonA.id],
    ["12:30", "14:30", salonB.id],
  ];

  async function checkRaw(token: string, employeeId: string, day: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/day-breaks/checks?employeeId=${employeeId}&from=${day}&to=${day}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.body;
  }

  async function checkDay(token: string, employeeId: string, day: string) {
    const body = await checkRaw(token, employeeId, day);
    return (JSON.parse(body) as { days: DayItem[] }).days.find((d) => d.date === day);
  }

  /** The CONTROL of a no-offer case: listed in full detail, a cross-salon gap, an UNCLEAR warning. */
  function expectUnclearControl(item: DayItem | undefined): asserts item is DayItem {
    expect(item, "the day is listed").toBeDefined();
    expect(item!.detail).toBe("full");
    expect(
      (item!.gaps ?? []).some((g) => g.crossSalon),
      JSON.stringify(item!.gaps),
    ).toBe(true);
    expect(
      item!.warnings.some((w) => w.certainty === "UNCLEAR"),
      JSON.stringify(item!.warnings),
    ).toBe(true);
  }

  const post = (token: string, payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

  const offerBody = (day: string, o: Offer, extra: Record<string, unknown> = {}) => ({
    date: day,
    startTime: o.startTime,
    endTime: o.endTime,
    salonId: o.departureSalonId,
    travelToSalonId: o.arrivalSalonId,
    ...extra,
  });

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "off660r");
    salonA = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon A" });
    salonB = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon B" });
    salonX = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon X" });
  });

  afterAll(async () => {
    try {
      await app.prisma.timeEntry.deleteMany({ where: { employee: { tenantId: seed.tenant.id } } });
      await app.prisma.retroEntryRequest.deleteMany({
        where: { employee: { tenantId: seed.tenant.id } },
      });
      await cleanupTestData(app, seed.tenant.id);
    } catch {
      // best-effort cleanup
    }
  });

  describe("which gap qualifies (D-02, P-660-02/05) - read by the whole-tenant admin", () => {
    it("a same-salon gap gets no offer; the cross-salon gap of the same day gets exactly one", async () => {
      const day = nextAdminDay();
      await seedRows(seed.employee.id, day, [
        ["07:00", "09:00", salonA.id],
        ["09:15", "12:00", salonA.id],
        ["12:30", "17:00", salonB.id],
      ]);
      const item = await checkDay(seed.adminToken, seed.employee.id, day);
      expectUnclearControl(item);
      expect(item.gaps!.filter((g) => !g.crossSalon)).toHaveLength(1);
      expect(item.travelOffers, JSON.stringify(item)).toHaveLength(1);
      expect(item.travelOffers![0]).toMatchObject({
        startTime: at(day, "12:00"),
        endTime: at(day, "12:30"),
        departureSalonId: salonA.id,
        arrivalSalonId: salonB.id,
      });
    });

    it("a gap overlapped by a recorded day break gets no offer; the other cross-salon gap does", async () => {
      const day = nextAdminDay();
      await seedRows(seed.employee.id, day, [
        ["07:00", "10:00", salonA.id],
        ["10:30", "13:00", salonB.id],
        ["13:30", "16:00", salonA.id],
      ]);
      await app.prisma.dayBreak.create({
        data: {
          employeeId: seed.employee.id,
          date: utcMidnight(day),
          startTime: new Date(at(day, "10:00")),
          endTime: new Date(at(day, "10:10")),
          createdBy: seed.adminUser.id,
        },
      });
      const item = await checkDay(seed.adminToken, seed.employee.id, day);
      expectUnclearControl(item);
      expect(item.gaps!.filter((g) => g.crossSalon)).toHaveLength(2);
      expect(item.travelOffers, JSON.stringify(item)).toHaveLength(1);
      expect(item.travelOffers![0]).toMatchObject({
        startTime: at(day, "13:00"),
        endTime: at(day, "13:30"),
        departureSalonId: salonB.id,
        arrivalSalonId: salonA.id,
      });
    });

    it("a gap that ends at a recorded trip gets no offer (answered by that trip)", async () => {
      const day = nextAdminDay();
      await seedRows(seed.employee.id, day, [
        ["08:00", "12:00", salonA.id],
        ["12:00", "12:15", salonA.id, { activityKind: "TRAVEL", travelToSalonId: salonB.id }],
        ["12:45", "15:00", salonB.id],
      ]);
      const item = await checkDay(seed.adminToken, seed.employee.id, day);
      expectUnclearControl(item);
      expect("travelOffers" in item).toBe(false);
    });

    it("a gap before a pending Zeitnachtrag row gets no offer (not yet a recorded statement)", async () => {
      const day = nextAdminDay();
      await seedRows(seed.employee.id, day, [["08:00", "12:00", salonA.id]]);
      const request = await app.prisma.retroEntryRequest.create({
        data: {
          employeeId: seed.employee.id,
          targetDate: utcMidnight(day),
          reason: "Nachtrag fixture for the offer rules",
          startTime: "12:30",
          endTime: "14:30",
          breakMinutes: 0,
          status: "PENDING",
        },
      });
      retroRequestIds.push(request.id);
      await seedRows(seed.employee.id, day, [
        [
          "12:30",
          "14:30",
          salonB.id,
          {
            isInvalid: true,
            ...invalidReasonFields("RETRO_APPROVAL_PENDING"),
            retroRequestId: request.id,
          },
        ],
      ]);
      const item = await checkDay(seed.adminToken, seed.employee.id, day);
      expectUnclearControl(item);
      expect("travelOffers" in item).toBe(false);
    });

    it("a deactivated salon gets no offer (the write would answer 400 SALON_INACTIVE)", async () => {
      const day = nextAdminDay();
      await seedRows(seed.employee.id, day, [
        ["08:00", "12:00", salonA.id],
        ["12:30", "14:30", salonX.id],
      ]);
      const before = await checkDay(seed.adminToken, seed.employee.id, day);
      expectUnclearControl(before);
      expect(before.travelOffers, "offered while Salon X is active").toHaveLength(1);

      await app.prisma.salon.update({ where: { id: salonX.id }, data: { isActive: false } });
      try {
        const after = await checkDay(seed.adminToken, seed.employee.id, day);
        expectUnclearControl(after);
        expect("travelOffers" in after).toBe(false);
      } finally {
        await app.prisma.salon.update({ where: { id: salonX.id }, data: { isActive: true } });
      }
    });
  });

  describe("locks (D-06)", () => {
    it("a day with a locked entry is locked and gets no offer", async () => {
      const day = nextAdminDay();
      await seedRows(seed.employee.id, day, [
        ["08:00", "12:00", salonA.id, { isLocked: true }],
        ["12:30", "14:30", salonB.id],
      ]);
      const item = await checkDay(seed.adminToken, seed.employee.id, day);
      expectUnclearControl(item);
      expect(item.locked).toBe(true);
      expect("travelOffers" in item).toBe(false);
    });

    it("a day in a closed month is locked and gets no offer", async () => {
      // 150 days back: no other case of this file lies in that month.
      const day = nextWeekdayStr(pastDateStr(150));
      await seedRows(seed.employee.id, day, anchors());
      const tz = await getTenantTimezone(app.prisma, seed.tenant.id);
      const [year, month] = day.split("-").map(Number) as [number, number];
      const { start, end } = monthRangeUtc(year, month, tz);
      await app.prisma.saldoSnapshot.create({
        data: {
          employeeId: seed.employee.id,
          periodType: "MONTHLY",
          periodStart: start,
          periodEnd: end,
          workedMinutes: 0,
          expectedMinutes: 0,
          balanceMinutes: 0,
          carryOver: 0,
          closedAt: new Date(),
          closedBy: "test-system",
          superseded: false,
        },
      });
      const item = await checkDay(seed.adminToken, seed.employee.id, day);
      expectUnclearControl(item);
      expect(item.locked).toBe(true);
      expect("travelOffers" in item).toBe(false);
    });
  });

  describe("the retro window of the person's own day (P-660-04)", () => {
    it("outside the window the employee gets no offer, the admin does, and the admin's POST of it is a 201", async () => {
      const day = nextWeekdayStr(pastDateStr(14));
      await seedRows(seed.employee.id, day, anchors());

      const own = await checkDay(seed.empToken, seed.employee.id, day);
      expectUnclearControl(own);
      expect("travelOffers" in own).toBe(false);

      const admin = await checkDay(seed.adminToken, seed.employee.id, day);
      expectUnclearControl(admin);
      expect(admin.travelOffers).toHaveLength(1);

      const res = await post(
        seed.adminToken,
        offerBody(day, admin.travelOffers![0]!, {
          employeeId: seed.employee.id,
          source: "CORRECTION",
        }),
      );
      expect(res.statusCode, res.body).toBe(201);
    });
  });

  describe("reach (D-04, AC-660-3): the offer exists exactly where the write rule would accept the trip", () => {
    const READ = "time-entry:read:ZUGEWIESEN";
    const CREATE = "time-entry:create:ZUGEWIESEN";

    it("M-both: read + create on A and B sees the full day, gets the offer, and its POST is a 201", async () => {
      const day = nextAdminDay();
      await seedRows(seed.employee.id, day, anchors());
      const m = await person("m-both", [
        { permissions: [READ, CREATE], salonIds: [salonA.id, salonB.id] },
      ]);
      const item = await checkDay(m.token, seed.employee.id, day);
      expectUnclearControl(item);
      expect(item.travelOffers).toHaveLength(1);
      const res = await post(
        m.token,
        offerBody(day, item.travelOffers![0]!, { employeeId: seed.employee.id }),
      );
      expect(res.statusCode, res.body).toBe(201);
    });

    it("M-split: read on A and B but create on A only sees the full day and gets no offer", async () => {
      const day = nextAdminDay();
      await seedRows(seed.employee.id, day, anchors());
      const m = await person("m-split", [
        { permissions: [READ], salonIds: [salonA.id, salonB.id] },
        { permissions: [CREATE], salonIds: [salonA.id] },
      ]);
      const item = await checkDay(m.token, seed.employee.id, day);
      expectUnclearControl(item);
      expect("travelOffers" in item).toBe(false);
    });

    it("M-read: read on A and B without any create right sees the full day and gets no offer", async () => {
      const day = nextAdminDay();
      await seedRows(seed.employee.id, day, anchors());
      const m = await person("m-read", [{ permissions: [READ], salonIds: [salonA.id, salonB.id] }]);
      const item = await checkDay(m.token, seed.employee.id, day);
      expectUnclearControl(item);
      expect("travelOffers" in item).toBe(false);
    });

    it("a person whose role has no time-entry:create reads the own day completely and gets no offer", async () => {
      const day = nextWeekdayStr(pastDateStr(3));
      const solo = await person("solo", [
        { permissions: ["time-entry:read:EIGENE"], salonIds: "TENANT" },
      ]);
      await seedRows(solo.employeeId, day, anchors());
      const item = await checkDay(solo.token, solo.employeeId, day);
      expectUnclearControl(item);
      expect("travelOffers" in item).toBe(false);
    });

    it("no hidden number: a partially covered day stays the neutral hint - no offer, no time, salon id, salon name or number", async () => {
      const day = nextAdminDay();
      const ids = await seedRows(seed.employee.id, day, anchors());
      const m = await person("m-hidden", [
        { permissions: [READ], salonIds: [salonA.id] },
        { permissions: [CREATE], salonIds: [salonA.id, salonB.id] },
      ]);
      const body = await checkRaw(m.token, seed.employee.id, day);
      const item = (JSON.parse(body) as { days: DayItem[] }).days.find((d) => d.date === day);
      expect(item, "the partially covered day is listed").toBeDefined();
      expect(item!.detail).toBe("redacted");
      expect("travelOffers" in item!).toBe(false);
      expect(numericLeaves(item)).toEqual([]);
      for (const secret of [
        at(day, "12:00"),
        at(day, "12:30"),
        at(day, "14:30"),
        ids[1]!,
        salonB.id,
        "Salon B",
      ]) {
        expect(body, `the answer must not contain ${secret}`).not.toContain(secret);
      }
    });
  });

  describe("stale offers are refused by the unchanged write rule with 409 and nothing is written (AC-660-4, D-05)", () => {
    /** Four distinct weekdays inside the employee's retro window. */
    const windowDays: string[] = [];

    async function counts() {
      return {
        entries: await app.prisma.timeEntry.count({
          where: { employeeId: seed.employee.id, deletedAt: null },
        }),
        audits: await app.prisma.auditLog.count({
          where: {
            entity: "TimeEntry",
            action: "CREATE",
            user: { employee: { id: seed.employee.id } },
          },
        }),
      };
    }

    /** Reads the offer as the employee, lets `change` alter the day, then sends the offer unchanged. */
    async function staleCase(
      day: string,
      change: (ids: string[]) => Promise<void>,
    ): Promise<{ status: number; body: { error: string; code?: string } }> {
      const ids = await seedRows(seed.employee.id, day, anchors());
      const item = await checkDay(seed.empToken, seed.employee.id, day);
      expectUnclearControl(item);
      expect(item.travelOffers).toHaveLength(1);
      const offer = item.travelOffers![0]!;
      await change(ids);
      const before = await counts();
      const res = await post(seed.empToken, offerBody(day, offer));
      expect(await counts(), "nothing was written").toEqual(before);
      return { status: res.statusCode, body: JSON.parse(res.body) };
    }

    beforeAll(() => {
      for (let back = 1; windowDays.length < 4 && back <= 10; back++) {
        const candidate = pastDateStr(back);
        if (dowOf(candidate) >= 1 && dowOf(candidate) <= 5) windowDays.push(candidate);
      }
      expect(windowDays, "four weekdays inside the retro window").toHaveLength(4);
    });

    it("the arrival entry deleted -> 409 TRAVEL_NOT_BETWEEN_SALON_ENTRIES", async () => {
      const r = await staleCase(windowDays[0]!, async (ids) => {
        await app.prisma.timeEntry.update({
          where: { id: ids[1]! },
          data: { deletedAt: new Date() },
        });
      });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("TRAVEL_NOT_BETWEEN_SALON_ENTRIES");
    });

    it("the arrival entry moved into the gap -> 409 overlap", async () => {
      const day = windowDays[1]!;
      const r = await staleCase(day, async (ids) => {
        await app.prisma.timeEntry.update({
          where: { id: ids[1]! },
          data: { startTime: new Date(at(day, "12:15")) },
        });
      });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/Überschneidung/);
    });

    it("a day break recorded inside the gap -> 409 TRAVEL_OVERLAPS_DAY_BREAK", async () => {
      const day = windowDays[2]!;
      const r = await staleCase(day, async () => {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/day-breaks",
          headers: { authorization: `Bearer ${seed.empToken}` },
          payload: {
            employeeId: seed.employee.id,
            date: day,
            startTime: at(day, "12:05"),
            endTime: at(day, "12:20"),
          },
        });
        expect(res.statusCode, res.body).toBe(201);
      });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("TRAVEL_OVERLAPS_DAY_BREAK");
    });

    it("the same offer sent twice -> the first is a 201, the second a 409 and writes nothing", async () => {
      const day = windowDays[3]!;
      await seedRows(seed.employee.id, day, anchors());
      const item = await checkDay(seed.empToken, seed.employee.id, day);
      expectUnclearControl(item);
      const offer = item.travelOffers![0]!;
      const first = await post(seed.empToken, offerBody(day, offer));
      expect(first.statusCode, first.body).toBe(201);
      const before = await counts();
      const second = await post(seed.empToken, offerBody(day, offer));
      expect(second.statusCode, second.body).toBe(409);
      expect(await counts()).toEqual(before);
    });
  });
});
