/**
 * Issue #542 (CTX-1, CTX-2; P-01..P-04, D-542-1) — `GET /api/v1/reports/monthly?salonId=`.
 *
 * A chosen salon narrows the monthly report to the persons who recorded time in it or are homed
 * in it on at least one day of the month; Ist follows the ENTRY's salon through tenant-local
 * yesterday, sick days follow the Stammsalon per day, and everything that is a contract figure of
 * the person (Soll, Saldo, Überstunden, the priced leave counts) is withheld with a reason. The
 * unfiltered answer carries none of the additive keys.
 *
 * Fixture (tenant Europe/Berlin, `Date` faked to 2026-07-15T10:00Z, report month June 2026 — fully
 * past): salon A is the seeded salon, B a second one. No person names; synthetic mails.
 *   PA homed A: closed entries in A on 1.-3.6. (3 x 8 h) and in B on 4.6. (4 h), one approved
 *               vacation day on 12.6.
 *   PB homed B: B entries on 9.6. and 10.6. (8 h each), one A entry on 8.6. (4 h)
 *   PX homed B until 15.6., A from 16.6.: approved sick leave 10.-20.6. without attest (11 days:
 *               6 in B, 5 in A), B entries on 1.6./2.6. (8 h each), A entries on 22.6./23.6. (8 h each)
 *   PN homed B: entries only in B (8 h on 5.6.)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { createPopulationPerson } from "./population-fixtures-613";
import { leaveTypeFields } from "../contexts/absence/leave-type";

type Row = Record<string, unknown> & {
  employeeId: string;
  workedHours: number;
  sickDays: number;
};
type Report = Record<string, unknown> & { rows: Row[] };

const FAKE_NOW = "2026-07-15T10:00:00.000Z";
const WITHHELD_KEYS = [
  "shouldHours",
  "overtimeHours",
  "overtimeConfirmed",
  "balanceAdjustmentHours",
  "vacationDays",
  "overtimeCompDays",
  "specialLeaveDays",
  "educationDays",
  "unpaidDays",
  "maternityDays",
  "parentalDays",
  "totalAbsenceDays",
] as const;
const ADDITIVE_KEYS = [
  "salonId",
  "workedBasis",
  "sollUnavailableReason",
  "leaveDaysUnavailableReason",
] as const;

describe("Issue #542 — monthly report salon filter", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: string;
  let salonB: string;
  let inactiveSalon: string;
  const ids = {} as Record<"PA" | "PB" | "PX" | "PN", string>;

  function entry(employeeId: string, salonId: string, date: string, start: string, end: string) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId,
        date: new Date(`${date}T00:00:00Z`),
        startTime: new Date(`${date}T${start}:00Z`),
        endTime: new Date(`${date}T${end}:00Z`),
        breakMinutes: 0,
        type: "WORK",
        source: "MANUAL",
      },
    });
  }

  function get(url: string, token = data.adminToken) {
    return app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function report(query: string, token = data.adminToken): Promise<Report> {
    const res = await get(`/api/v1/reports/monthly?${query}`, token);
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as Report;
  }

  const rowOf = (r: Report, id: string): Row => {
    const row = r.rows.find((x) => x.employeeId === id);
    if (!row) throw new Error(`row ${id} missing`);
    return row;
  };
  const idSet = (r: Report) => r.rows.map((x) => x.employeeId).sort((a, b) => a.localeCompare(b));
  const sorted = (xs: string[]) => [...xs].sort((a, b) => a.localeCompare(b));

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(FAKE_NOW));
    app = await getTestApp();
    data = await seedTestData(app, "rsf542");
    foreign = await seedTestData(app, "rsf542f");
    salonA = data.salonId;
    salonB = (await createTestSalon(app.prisma, data.tenant.id, { name: "Filter542 B" })).id;
    inactiveSalon = (
      await createTestSalon(app.prisma, data.tenant.id, { name: "Filter542 off", isActive: false })
    ).id;

    const hire = new Date("2025-01-01T00:00:00Z");
    const mk = async (tag: "PA" | "PB" | "PX" | "PN", salonId: string) => {
      const p = await createPopulationPerson(app, {
        tenantId: data.tenant.id,
        salonId,
        tag,
        hireDate: hire,
      });
      ids[tag] = p.employeeId;
      return p;
    };
    await mk("PA", salonA);
    await mk("PB", salonB);
    await mk("PX", salonB);
    await mk("PN", salonB);

    // PX changes Stammsalon at mid-month: the first HOME row ends on 15.6., the second starts 16.6.
    await app.prisma.employeeSalonAssignment.updateMany({
      where: { employeeId: ids.PX, kind: "HOME" },
      data: { validUntil: new Date("2026-06-15T00:00:00Z") },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId: ids.PX,
        salonId: salonA,
        kind: "HOME",
        validFrom: new Date("2026-06-16T00:00:00Z"),
        validUntil: null,
        weekdays: [],
      },
    });

    for (const d of ["2026-06-01", "2026-06-02", "2026-06-03"]) {
      await entry(ids.PA, salonA, d, "08:00", "16:00");
    }
    await entry(ids.PA, salonB, "2026-06-04", "08:00", "12:00");
    await entry(ids.PB, salonA, "2026-06-08", "08:00", "12:00");
    await entry(ids.PB, salonB, "2026-06-09", "08:00", "16:00");
    await entry(ids.PB, salonB, "2026-06-10", "08:00", "16:00");
    await entry(ids.PX, salonB, "2026-06-01", "08:00", "16:00");
    await entry(ids.PX, salonB, "2026-06-02", "08:00", "16:00");
    await entry(ids.PX, salonA, "2026-06-22", "08:00", "16:00");
    await entry(ids.PX, salonA, "2026-06-23", "08:00", "16:00");
    await entry(ids.PN, salonB, "2026-06-05", "08:00", "16:00");

    const sick = await app.prisma.leaveType.create({
      data: { tenantId: data.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: ids.PX,
        leaveTypeId: sick.id,
        startDate: new Date("2026-06-10T00:00:00Z"),
        endDate: new Date("2026-06-20T00:00:00Z"),
        days: 7,
        status: "APPROVED",
        attestPresent: false,
      },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: ids.PA,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2026-06-12T00:00:00Z"),
        endDate: new Date("2026-06-12T00:00:00Z"),
        days: 1,
        status: "APPROVED",
      },
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, foreign.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("tracer", () => {
    it("salon A lists the persons with an A entry or an A home day, with entry-salon Ist and Stammsalon sick days", async () => {
      const r = await report(`year=2026&month=6&salonId=${salonA}`);
      expect(idSet(r)).toEqual(sorted([ids.PA, ids.PB, ids.PX]));
      expect(rowOf(r, ids.PA).workedHours).toBe(24);
      expect(rowOf(r, ids.PB).workedHours).toBe(4);
      expect(rowOf(r, ids.PX).workedHours).toBe(16);
      expect(rowOf(r, ids.PX).sickDays).toBe(5);
      expect(rowOf(r, ids.PA).sickDays).toBe(0);
      expect(rowOf(r, ids.PB).sickDays).toBe(0);
    });

    it("withholds the contract figures with their reasons and adds exactly four keys", async () => {
      const filtered = await report(`year=2026&month=6&salonId=${salonA}`);
      const plain = await report(`year=2026&month=6`);
      for (const row of filtered.rows) {
        for (const k of WITHHELD_KEYS) expect(row[k], `${k}`).toBeNull();
        expect(Object.keys(row).sort((a, b) => a.localeCompare(b))).toEqual(
          Object.keys(plain.rows[0]).sort((a, b) => a.localeCompare(b)),
        );
      }
      expect(filtered.salonId).toBe(salonA);
      expect(filtered.workedBasis).toBe("SALON_ENTRIES");
      expect(filtered.sollUnavailableReason).toBe("SALON_FILTER");
      expect(filtered.leaveDaysUnavailableReason).toBe("SALON_FILTER");
    });

    it("salon B lists its persons and counts the other half of the sick leave", async () => {
      const r = await report(`year=2026&month=6&salonId=${salonB}`);
      expect(idSet(r)).toEqual(sorted([ids.PA, ids.PB, ids.PX, ids.PN]));
      expect(rowOf(r, ids.PX).sickDays).toBe(6);
      expect(rowOf(r, ids.PX).workedHours).toBe(16);
      expect(rowOf(r, ids.PA).workedHours).toBe(4);
      expect(rowOf(r, ids.PB).workedHours).toBe(16);
      expect(rowOf(r, ids.PN).workedHours).toBe(8);
    });

    it("the unfiltered answer carries none of the additive keys and keeps the contract figures", async () => {
      const r = await report(`year=2026&month=6`);
      for (const k of ADDITIVE_KEYS) expect(k in r, k).toBe(false);
      expect(rowOf(r, ids.PX).sickDays).toBe(11);
      expect(rowOf(r, ids.PA).vacationDays).toBe(1);
      expect(typeof rowOf(r, ids.PA).shouldHours).toBe("number");
    });

    it("answers the one 404 for a foreign, unknown and inactive salon, equal to the dashboard's", async () => {
      const urls = [
        `/api/v1/reports/monthly?year=2026&month=6&salonId=${foreign.salonId}`,
        `/api/v1/reports/monthly?year=2026&month=6&salonId=${randomUUID()}`,
        `/api/v1/reports/monthly?year=2026&month=6&salonId=${inactiveSalon}`,
      ];
      const bodies: string[] = [];
      for (const url of urls) {
        const res = await get(url);
        expect(res.statusCode, url).toBe(404);
        bodies.push(res.body);
      }
      expect(new Set(bodies).size).toBe(1);
      const dash = await get(`/api/v1/dashboard/team-week?salonId=${foreign.salonId}`);
      expect(dash.statusCode).toBe(404);
      expect(bodies[0]).toBe(dash.body);
      expect(bodies[0]).toBe('{"error":"Salon nicht gefunden"}');
    });

    it("answers 400 for a malformed salon id", async () => {
      const res = await get(`/api/v1/reports/monthly?year=2026&month=6&salonId=not-a-uuid`);
      expect(res.statusCode, res.body).toBe(400);
    });
  });
});
