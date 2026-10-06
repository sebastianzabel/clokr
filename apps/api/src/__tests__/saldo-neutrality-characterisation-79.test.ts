/**
 * Phase 79 (Issue #79) D-10 — saldo-neutrality characterisation.
 *
 * Written and GREEN on the untouched call sites at HEAD 74fc476b, BEFORE plans 79-03 / 79-05
 * migrate the working-time arithmetic (Arbeitszeitkonto, composition layer, ArbZG) onto the
 * `entryDurations()` kernel. Every literal below is either hand-derived (marked "hand") or was
 * captured from that untouched tree (marked "captured"). This file is the integration half of the
 * saldo-neutrality proof; the arithmetic half is the equivalence matrices of
 * `contexts/time-tracking/__tests__/entry-durations-equivalence-79.test.ts` (shapes S1…S12).
 *
 * THIS FILE MUST NEVER BE EDITED TO MAKE A TEST PASS. A red cell after a migration is a
 * regression of the saldo/display figures, not a stale value. There is deliberately no snapshot
 * mechanism — every pinned value is an explicit literal.
 *
 * Fixture — the eight D-10 cases, identical rows for employee A (FIXED_SCHEDULE Mo-Fr 8h) and
 * employee B (MONTHLY_HOURS, `monthlyHours` null = untracked path, shape S3). Tenant timezone
 * Europe/Berlin, salon federalState NIEDERSACHSEN, CET = UTC+1 until 2026-03-29 02:00 local,
 * then CEST = UTC+2:
 *
 *   # date        case                                   presence -> working (minutes)
 *   1 2026-03-16  breakMinutes only, no Break rows       510     -> 480
 *   2 2026-03-17  break via Break[] rows (45 min)        540     -> 495
 *   3 2026-03-18  stored auto-break (breakStatus AUTO)   420     -> 390
 *   4 2026-03-19  millisecond precision, no break (> 6h) 513.4644 -> 513.4644
 *   5 2026-03-20  invalid                                510     -> 480 (excluded from the saldo)
 *   6 2026-03-21  open (no endTime)                      (excluded)
 *   7 2026-03-27  cross-midnight (UTC 21:00 -> 05:00)    480     -> 450
 *   8 2026-03-29  DST switch (00:30 CET -> 08:30 CEST)   420     -> 405
 *
 * Saldo entry set (closed, valid, WORK, not deleted) = rows 1,2,3,4,7,8:
 * working 2733.4644 (-> 2733), presence 2883.4644 (-> 2883), breaks 150.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import iconv from "iconv-lite";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  salonIdForEmployee,
  configureDatevKanzlei,
} from "./setup";
import * as pdfUtils from "../composition/pdf";
import { checkArbZG } from "../contexts/time-tracking/arbzg";

// The monthly-report PDF spy: `vi.fn(actual.fn)` wraps the REAL generator so the bytes stay a valid
// PDF and the test only inspects the DATA payload handed to it (same pattern as the #451 parity test).
vi.mock("../composition/pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../composition/pdf")>();
  return {
    ...actual,
    generateMonthlyReportPdf: vi.fn(actual.generateMonthlyReportPdf),
  };
});

async function loginAs(app: FastifyInstance, email: string, password = "test1234") {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
  });
  const { accessToken } = JSON.parse(res.body) as { accessToken: string };
  return accessToken;
}

interface CharEmployee {
  id: string;
  email: string;
}

/** Employee A — FIXED_SCHEDULE Mo-Fr 8h, weeklyHours 40, hire 2026-01-01, HOME assignment. */
async function createFixedEmployee(
  app: FastifyInstance,
  tenantId: string,
  salonId: string,
  label: string,
): Promise<CharEmployee> {
  const passwordHash = await bcrypt.hash("test1234", 10);
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const email = `${label}-${suffix}@test.de`;
  const user = await app.prisma.user.create({
    data: { email, passwordHash, role: "EMPLOYEE", isActive: true },
  });
  const employee = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber: `${label}-${suffix}`,
      firstName: label,
      lastName: "Snc79",
      hireDate: new Date("2026-01-01T00:00:00Z"),
    },
  });
  await app.prisma.workSchedule.create({
    data: {
      employeeId: employee.id,
      type: "FIXED_SCHEDULE",
      weeklyHours: 40,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
      workDays: [1, 2, 3, 4, 5],
      validFrom: new Date("2026-01-01T00:00:00Z"),
    },
  });
  await app.prisma.employeeSalonAssignment.create({
    data: {
      tenantId,
      employeeId: employee.id,
      salonId,
      kind: "HOME",
      validFrom: new Date("2026-01-01T00:00:00Z"),
      validUntil: null,
      weekdays: [],
    },
  });
  await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
  return { id: employee.id, email };
}

/** Employee B — MONTHLY_HOURS with `monthlyHours` null (the untracked path, shape S3). */
async function createUntrackedMonthlyHoursEmployee(
  app: FastifyInstance,
  tenantId: string,
  salonId: string,
  label: string,
): Promise<CharEmployee> {
  const passwordHash = await bcrypt.hash("test1234", 10);
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const email = `${label}-${suffix}@test.de`;
  const user = await app.prisma.user.create({
    data: { email, passwordHash, role: "EMPLOYEE", isActive: true },
  });
  const employee = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber: `${label}-${suffix}`,
      firstName: label,
      lastName: "Snc79MH",
      hireDate: new Date("2026-01-01T00:00:00Z"),
    },
  });
  await app.prisma.workSchedule.create({
    data: {
      employeeId: employee.id,
      type: "MONTHLY_HOURS",
      monthlyHours: null,
      workDays: [1, 2, 3, 4, 5],
      overtimeMode: "TRACK_ONLY",
      validFrom: new Date("2026-01-01T00:00:00Z"),
    },
  });
  await app.prisma.employeeSalonAssignment.create({
    data: {
      tenantId,
      employeeId: employee.id,
      salonId,
      kind: "HOME",
      validFrom: new Date("2026-01-01T00:00:00Z"),
      validUntil: null,
      weekdays: [],
    },
  });
  await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
  return { id: employee.id, email };
}

/** Rows 1-8 of the header table, exactly. */
async function seedCharacterisationEntries(app: FastifyInstance, employeeId: string) {
  const salonId = await salonIdForEmployee(app.prisma, employeeId);
  const base = { employeeId, type: "WORK" as const, salonId };

  // 1 — legacy breakMinutes only (no Break rows)
  await app.prisma.timeEntry.create({
    data: {
      ...base,
      date: new Date("2026-03-16T00:00:00Z"),
      startTime: new Date("2026-03-16T07:00:00.000Z"),
      endTime: new Date("2026-03-16T15:30:00.000Z"),
      breakMinutes: 30,
    },
  });

  // 2 — break via Break[] rows (11:00-11:30Z and 14:00-14:15Z = 45 min)
  const row2 = await app.prisma.timeEntry.create({
    data: {
      ...base,
      date: new Date("2026-03-17T00:00:00Z"),
      startTime: new Date("2026-03-17T07:00:00.000Z"),
      endTime: new Date("2026-03-17T16:00:00.000Z"),
      breakMinutes: 45,
    },
  });
  await app.prisma.break.create({
    data: {
      timeEntryId: row2.id,
      startTime: new Date("2026-03-17T11:00:00.000Z"),
      endTime: new Date("2026-03-17T11:30:00.000Z"),
    },
  });
  await app.prisma.break.create({
    data: {
      timeEntryId: row2.id,
      startTime: new Date("2026-03-17T14:00:00.000Z"),
      endTime: new Date("2026-03-17T14:15:00.000Z"),
    },
  });

  // 3 — stored auto-break
  await app.prisma.timeEntry.create({
    data: {
      ...base,
      date: new Date("2026-03-18T00:00:00Z"),
      startTime: new Date("2026-03-18T07:00:00.000Z"),
      endTime: new Date("2026-03-18T14:00:00.000Z"),
      breakMinutes: 30,
      breakStatus: "AUTO",
    },
  });

  // 4 — millisecond precision, no break recorded although > 6h
  await app.prisma.timeEntry.create({
    data: {
      ...base,
      date: new Date("2026-03-19T00:00:00Z"),
      startTime: new Date("2026-03-19T06:58:17.123Z"),
      endTime: new Date("2026-03-19T15:31:44.987Z"),
      breakMinutes: 0,
    },
  });

  // 5 — invalid
  await app.prisma.timeEntry.create({
    data: {
      ...base,
      date: new Date("2026-03-20T00:00:00Z"),
      startTime: new Date("2026-03-20T07:00:00.000Z"),
      endTime: new Date("2026-03-20T15:30:00.000Z"),
      breakMinutes: 30,
      isInvalid: true,
    },
  });

  // 6 — open
  await app.prisma.timeEntry.create({
    data: {
      ...base,
      date: new Date("2026-03-21T00:00:00Z"),
      startTime: new Date("2026-03-21T08:00:00.000Z"),
      endTime: null,
      breakMinutes: 0,
    },
  });

  // 7 — cross-midnight (the date column carries the day the entry started on)
  await app.prisma.timeEntry.create({
    data: {
      ...base,
      date: new Date("2026-03-27T00:00:00Z"),
      startTime: new Date("2026-03-27T21:00:00.000Z"),
      endTime: new Date("2026-03-28T05:00:00.000Z"),
      breakMinutes: 30,
    },
  });

  // 8 — DST switch: 00:30 CET -> 08:30 CEST on 2026-03-29
  await app.prisma.timeEntry.create({
    data: {
      ...base,
      date: new Date("2026-03-29T00:00:00Z"),
      startTime: new Date("2026-03-28T23:30:00.000Z"),
      endTime: new Date("2026-03-29T06:30:00.000Z"),
      breakMinutes: 15,
    },
  });
}

describe("Phase 79 D-10 — saldo-neutrality characterisation (frozen on the untouched tree)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let salonId: string;
  let adminEmail: string;
  let a: CharEmployee;
  let b: CharEmployee;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-15T10:00:00.000Z"));

    app = await getTestApp();
    const seed = await seedTestData(app, "snc79", { withDefaultSalon: false });
    tenantId = seed.tenant.id;
    adminEmail = seed.adminUser.email;

    const salon = await createTestSalon(app.prisma, tenantId, { federalState: "NIEDERSACHSEN" });
    salonId = salon.id;

    a = await createFixedEmployee(app, tenantId, salonId, "snc79-fixed");
    b = await createUntrackedMonthlyHoursEmployee(app, tenantId, salonId, "snc79-monthly");
    await seedCharacterisationEntries(app, a.id);
    await seedCharacterisationEntries(app, b.id);
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("saldo-neutrality-characterisation-79 cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("saldo core — clock 2026-04-15T10:00:00Z", () => {
    let adminToken: string;

    beforeAll(async () => {
      vi.setSystemTime(new Date("2026-04-15T10:00:00.000Z"));
      adminToken = await loginAs(app, adminEmail);
    });

    async function monthSaldo(employeeId: string) {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/month-saldo/${employeeId}?year=2026&month=3`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.body) as {
        workedMinutes: number;
        expectedMinutes: number;
        balanceMinutes: number;
      };
    }

    async function reportRow(employeeId: string) {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/reports/monthly?employeeId=${employeeId}&year=2026&month=3`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        rows: Array<{
          employeeId: string;
          workedHours: number;
          shouldHours: number;
          overtimeHours?: number;
        }>;
      };
      const row = body.rows.find((r) => r.employeeId === employeeId);
      if (!row) throw new Error(`no report row for ${employeeId}`);
      return row;
    }

    it("A: month saldo counts WORKING time 2733 (hand), never the presence sum 2883 (R4)", async () => {
      const saldo = await monthSaldo(a.id);
      expect(saldo.workedMinutes).toBe(2733);
      expect(saldo.workedMinutes).not.toBe(2883);
    });

    it("A: month saldo expected and balance minutes (captured)", async () => {
      const saldo = await monthSaldo(a.id);
      // captured at 74fc476b; consistent with hand: 22 March weekdays x 480 = 10560 (no NI
      // holiday in March) and 2733 - 10560 = -7827.
      expect(saldo.expectedMinutes).toBe(10560);
      expect(saldo.balanceMinutes).toBe(-7827);
    });

    it("A: /reports/monthly workedHours is 45.55 (hand) and equals the month-saldo value", async () => {
      const saldo = await monthSaldo(a.id);
      const row = await reportRow(a.id);
      expect(row.workedHours).toBe(45.55);
      expect(row.workedHours).toBe(Math.round((saldo.workedMinutes / 60) * 100) / 100);
    });

    it("B (untracked MONTHLY_HOURS, shape S3): /reports/monthly workedHours is 45.55 (hand)", async () => {
      const row = await reportRow(b.id);
      expect(row.workedHours).toBe(45.55);
    });
  });

  describe("live balance — clock 2026-03-31T10:00:00Z", () => {
    it("A: GET /overtime/:employeeId balanceHours and status (captured; the live saldo excludes today)", async () => {
      vi.setSystemTime(new Date("2026-03-31T10:00:00.000Z"));
      const adminToken = await loginAs(app, adminEmail);
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${a.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { balanceHours: number; status: string };
      // captured at 1396e30c (untouched call sites)
      expect({ balanceHours: body.balanceHours, status: body.status }).toEqual({
        balanceHours: -450.45,
        status: "NORMAL",
      });
    });
  });

  describe("dashboard — clock 2026-03-20T20:00:00Z", () => {
    let empToken: string;
    let adminToken: string;

    beforeAll(async () => {
      vi.setSystemTime(new Date("2026-03-20T20:00:00.000Z"));
      empToken = await loginAs(app, a.email);
      adminToken = await loginAs(app, adminEmail);
    });

    it("A: GET /dashboard today counts the invalid row 5 (8h, hand, D-15); week values captured (S4/S5)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard",
        headers: { authorization: `Bearer ${empToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        today: { workedHours: number; entries: number };
        week: { workedHours: number; targetHours: number };
      };
      expect(body.today.workedHours).toBe(8);
      // captured at 1396e30c: Mon-Fri 16.-20.03 closed rows incl. the invalid row 5
      expect(body.week).toEqual({
        workedHours: 39.31,
        targetHours: 40,
        workedToDateHours: 31.3,
        targetToDateHours: 32,
      });
    });

    it("A: GET /dashboard/my-week 16.-22.03 — per-day workedHours (hand; invalid row counted, open row 0 — D-15) and statuses (captured, S7)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/my-week?date=2026-03-18",
        headers: { authorization: `Bearer ${empToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        days: Array<{ date: string; workedHours: number; status: string }>;
      };
      expect(body.days.map((d) => d.date)).toEqual([
        "2026-03-16",
        "2026-03-17",
        "2026-03-18",
        "2026-03-19",
        "2026-03-20",
        "2026-03-21",
        "2026-03-22",
      ]);
      expect(body.days.map((d) => d.workedHours)).toEqual([8, 8.25, 6.5, 8.56, 8, 0, 0]);
      expect(body.days.map((d) => d.status)).toEqual([
        "complete",
        "complete",
        "partial",
        "complete",
        "complete",
        "clocked_in",
        "weekend",
      ]);
    });

    it("A: GET /dashboard/team-week 16.-22.03 — per-day workedHours (hand; invalid row excluded) and statuses (captured, S6)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/team-week?date=2026-03-18",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        team: Array<{ id: string; days: Array<{ workedHours: number; status: string }> }>;
      };
      const member = body.team.find((t) => t.id === a.id);
      expect(member).toBeDefined();
      expect(member!.days.map((d) => d.workedHours)).toEqual([8, 8.25, 6.5, 8.56, 0, 0, 0]);
      expect(member!.days.map((d) => d.status)).toEqual([
        "present",
        "present",
        "present",
        "present",
        "scheduled",
        "clocked_in",
        "none",
      ]);
    });
  });

  describe("dashboard team-week 23.-29.03 — clock 2026-03-31T10:00:00Z", () => {
    it("A: cross-midnight 27.03 and DST day 29.03 (hand) and statuses (captured, S6)", async () => {
      vi.setSystemTime(new Date("2026-03-31T10:00:00.000Z"));
      const adminToken = await loginAs(app, adminEmail);
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/team-week?date=2026-03-25",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        team: Array<{ id: string; days: Array<{ workedHours: number; status: string }> }>;
      };
      const member = body.team.find((t) => t.id === a.id);
      expect(member).toBeDefined();
      expect(member!.days.map((d) => d.workedHours)).toEqual([0, 0, 0, 0, 7.5, 0, 6.75]);
      expect(member!.days.map((d) => d.status)).toEqual([
        "missing",
        "missing",
        "missing",
        "missing",
        "present",
        "none",
        "present",
      ]);
    });
  });

  describe("reports — clock 2026-04-15T10:00:00Z", () => {
    let adminToken: string;

    beforeAll(async () => {
      vi.setSystemTime(new Date("2026-04-15T10:00:00.000Z"));
      adminToken = await loginAs(app, adminEmail);
      await configureDatevKanzlei(app, tenantId);
      await app.prisma.employee.update({
        where: { id: a.id },
        data: { employeeNumber: "SNC79-A" },
      });
      await app.prisma.employee.update({
        where: { id: b.id },
        data: { employeeNumber: "SNC79-B" },
      });
    });

    it("A: monthly-report PDF netHours per entry in date order (hand, S8; invalid and open rows are not in the report set)", async () => {
      const spy = vi.mocked(pdfUtils.generateMonthlyReportPdf);
      spy.mockClear();
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/reports/monthly/pdf?employeeId=${a.id}&year=2026&month=3`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      const payload = spy.mock.calls[0][0];
      expect(payload.entries.map((e) => e.netHours)).toEqual([8, 8.25, 6.5, 8.56, 7.5, 6.75]);
    });

    it("A and B: DATEV worked-hours line (Normalstunden) in [Bewegungsdaten] (hand 45,56 for 2733.4644 min, S9)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/datev?year=2026&month=3",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = iconv.decode(res.rawPayload, "win1252");
      const rows = body
        .split("[Bewegungsdaten]")[1]
        .split("\r\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => l.split(";"));
      // Field offsets: 1 = Personalnummer, 4 = Ausfallschluessel (empty on a worked-hours line), 6 = Stunden.
      const hoursOf = (pn: string) => rows.find((r) => r[1] === pn && r[4] === "")?.[6];
      expect(hoursOf("SNC79-A")).toBe("45,56");
      expect(hoursOf("SNC79-B")).toBe("45,56");
    });
  });

  describe("ArbZG — clock 2026-04-15T10:00:00Z", () => {
    // The fixture stays below the 48h weekly and 8h-average thresholds, so S11 (weekly) and S12
    // (24-week average) emit nothing here; their arithmetic is covered by the 79-01 matrices.
    async function warningsOn(day: string) {
      vi.setSystemTime(new Date("2026-04-15T10:00:00.000Z"));
      const warnings = await checkArbZG(app.prisma, a.id, new Date(`${day}T00:00:00Z`));
      return warnings.map((w) => ({ code: w.code, severity: w.severity, message: w.message }));
    }

    it("2026-03-17 (Break[] rows, S10)", async () => {
      expect(await warningsOn("2026-03-17")).toEqual([]);
    });

    it("2026-03-19 (millisecond precision without a recorded break, S10)", async () => {
      expect(await warningsOn("2026-03-19")).toEqual([
        {
          code: "BREAK_TOO_SHORT",
          severity: "warning",
          message:
            "§ 4 ArbZG: Bei über 6 Stunden Arbeitszeit sind mindestens 30 Minuten Pause vorgeschrieben. Erfasst: 0 Min.",
        },
      ]);
    });

    it("2026-03-27 (cross-midnight)", async () => {
      expect(await warningsOn("2026-03-27")).toEqual([]);
    });

    it("2026-03-29 (DST switch)", async () => {
      expect(await warningsOn("2026-03-29")).toEqual([
        {
          code: "BREAK_TOO_SHORT",
          severity: "warning",
          message:
            "§ 4 ArbZG: Bei über 6 Stunden Arbeitszeit sind mindestens 30 Minuten Pause vorgeschrieben. Erfasst: 15 Min.",
        },
      ]);
    });
  });
});
