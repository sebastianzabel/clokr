// Issue #80 (D-09, D-11, D-13, D-20, D-22) — GET /api/v1/day-breaks/checks.
//
// A multi-entry day cannot exist in the database while the partial unique index
// `TimeEntry_employeeId_date_unique_not_deleted` holds, so the range read of closed WORK entries
// (`getWorkedEntriesInRange`, the facade the day check reads through) is wrapped for the
// constructed days only and delegates to the real implementation for everything else. Everything
// downstream is real: employees, salons, role assignments, the month lock, DayBreak and
// DayBreakAck rows and the kernel `evaluateDayBreaks`.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import bcrypt from "bcryptjs";
import crypto, { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
} from "../../../../__tests__/setup";
import { normalizeRolePermissions, roleNameKey } from "../../../platform";
import { getTenantTimezone, monthRangeUtc } from "../../../working-time-account";
import { evaluateDayBreaks } from "../../day-break-rule";

vi.mock("../../facade/time-entries", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../facade/time-entries")>();
  return { ...original, getWorkedEntriesInRange: vi.fn(original.getWorkedEntriesInRange) };
});

// A spy on the bulk day-break/acknowledgement read, to prove (80-AC6) it is not issued for a range
// without a multi-entry day.
vi.mock("../../day-break-store", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../day-break-store")>();
  return { ...original, loadDayBreakDataForDays: vi.fn(original.loadDayBreakDataForDays) };
});

import { getWorkedEntriesInRange } from "../../facade/time-entries";
import { loadDayBreakDataForDays } from "../../day-break-store";

const PASSWORD = "test1234";
const DAY = "2026-03-10"; // constructed two-salon day
const SAME_SALON_DAY = "2026-03-12";
const ELEVEN_HOUR_DAY = "2026-03-13";
const LOCKED_DAY = "2026-03-11";
const CLOSED_DAY = "2026-02-10";
const mockedRange = vi.mocked(getWorkedEntriesInRange);
const mockedBulk = vi.mocked(loadDayBreakDataForDays);

const REASON = "Kundentermin ohne Unterbrechung";

interface ConstructedRow {
  id: string;
  employeeId: string;
  date: Date;
  startTime: Date;
  endTime: Date;
  breakMinutes: number;
  breakStatus: string;
  isLocked: boolean;
  salonId: string;
}

interface DayCheckBody {
  date: string;
  detail: "full" | "redacted";
  crossSalon: boolean;
  netWorkedMinutes: number;
  totalBreakMinutes: number;
  requiredBreakMinutes: number;
  breakShortfall: boolean;
  maxDailyExceeded: boolean;
  acknowledged: boolean;
  locked: boolean;
  mayAcknowledge: boolean;
  mayRecordDayBreak: boolean;
  acknowledgement: { id: string; createdAt: string; reason: string } | null;
  entries: Array<{ id: string; startTime: string; endTime: string; salonId: string }> | null;
  gaps: Array<{
    startTime: string;
    endTime: string;
    crossSalon: boolean;
    countsAsBreak: boolean;
  }> | null;
  dayBreaks: Array<{ id: string; startTime: string; endTime: string }> | null;
}

interface ChecksBody {
  employeeId: string;
  from: string;
  to: string;
  days: DayCheckBody[];
}

function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}
function at(hhmm: string, day = DAY): string {
  return `${day}T${hhmm}:00.000Z`;
}
function errorOf(res: { body: string }): string {
  return (JSON.parse(res.body) as { error: string }).error;
}

describe("Issue #80 — GET /api/v1/day-breaks/checks", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let dataB: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: string;
  let salonB: string;
  const constructedDays = new Map<string, ConstructedRow[]>();

  function row(
    employeeId: string,
    day: string,
    salonId: string,
    start: string,
    end: string,
    opts: { isLocked?: boolean } = {},
  ): ConstructedRow {
    return {
      id: randomUUID(),
      employeeId,
      date: dateOf(day),
      startTime: new Date(at(start, day)),
      endTime: new Date(at(end, day)),
      breakMinutes: 0,
      breakStatus: "CONFIRMED",
      isLocked: opts.isLocked ?? false,
      salonId,
    };
  }

  /** 8 h net across two salons with a 30 min travel gap: a § 4 shortfall (30 min required). */
  function twoSalonDay(employeeId: string, day = DAY, opts: { isLocked?: boolean } = {}) {
    const rows = [
      row(employeeId, day, salonA, "08:00", "12:00", opts),
      row(employeeId, day, salonB, "12:30", "16:30", opts),
    ];
    constructedDays.set(`${employeeId}:${day}`, rows);
    return rows;
  }

  /** 8 h net in ONE salon with a 30 min same-salon gap: the gap counts as the break (D-01). */
  function sameSalonDay(employeeId: string, day = SAME_SALON_DAY) {
    const rows = [
      row(employeeId, day, salonA, "08:00", "12:00"),
      row(employeeId, day, salonA, "12:30", "16:30"),
    ];
    constructedDays.set(`${employeeId}:${day}`, rows);
    return rows;
  }

  /** 11 h net across two salons: § 4 shortfall AND over the § 3 cap of 10 h. */
  function elevenHourDay(employeeId: string, day = ELEVEN_HOUR_DAY) {
    const rows = [
      row(employeeId, day, salonA, "08:00", "13:00"),
      row(employeeId, day, salonB, "13:30", "19:30"),
    ];
    constructedDays.set(`${employeeId}:${day}`, rows);
    return rows;
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

  async function createScopedManager(label: string, permissions: string[], salonIds: string[]) {
    const s = `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await app.prisma.user.create({
      data: { email: `${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "DayBreakChecksTest",
        hireDate: new Date("2020-01-01"),
      },
    });
    const name = `DayBreakChecks ${crypto.randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: data.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(permissions),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        accessRoleId: role.id,
        scopeType: "SALONS",
        salonIds,
        employeeIds: [],
      },
    });
    return { token: await login(user.email) };
  }

  function getChecks(token: string, employeeId: string, from = "2026-03-01", to = "2026-03-31") {
    return app.inject({
      method: "GET",
      url: `/api/v1/day-breaks/checks?employeeId=${employeeId}&from=${from}&to=${to}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function checksOf(token: string, employeeId: string, from?: string, to?: string) {
    const res = await getChecks(token, employeeId, from, to);
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as ChecksBody;
  }

  async function seedDayBreak(employeeId: string, day: string, start: string, end: string) {
    return app.prisma.dayBreak.create({
      data: {
        employeeId,
        date: dateOf(day),
        startTime: new Date(at(start, day)),
        endTime: new Date(at(end, day)),
        createdBy: data.adminUser.id,
      },
    });
  }

  /**
   * A current acknowledgement of the constructed day, stored the way POST /acks stores it: the
   * kernel's own snapshot of the day. The route itself reads the day through another lookup than
   * the one wrapped here, so the row is created directly.
   */
  async function seedCurrentAck(employeeId: string, rows: ConstructedRow[], day = DAY) {
    const { snapshot } = evaluateDayBreaks({ rows, dayBreaks: [], acks: [] });
    return app.prisma.dayBreakAck.create({
      data: {
        employeeId,
        date: dateOf(day),
        reason: REASON,
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
        acknowledgedBy: data.adminUser.id,
      },
    });
  }

  async function closeMonth(employeeId: string, year: number, month: number) {
    const tz = await getTenantTimezone(app.prisma, data.tenant.id);
    const { start, end } = monthRangeUtc(year, month, tz);
    return app.prisma.saldoSnapshot.create({
      data: {
        employeeId,
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
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "daybreakchecks-80");
    dataB = await seedTestData(app, "daybreakchecks-80-b");
    salonA = data.salonId;
    salonB = (await createTestSalon(app.prisma, data.tenant.id, { name: "Zweiter Salon" })).id;

    const actual = await vi.importActual<typeof import("../../facade/time-entries")>(
      "../../facade/time-entries",
    );
    mockedRange.mockImplementation(async (db, scope, from, to) => {
      const real = await actual.getWorkedEntriesInRange(db, scope, from, to);
      if (scope.kind !== "employee") return real;
      const extra: ConstructedRow[] = [];
      for (const [key, rows] of constructedDays) {
        if (!key.startsWith(`${scope.employeeId}:`)) continue;
        const date = rows[0].date;
        if (date >= from && date <= to) extra.push(...rows);
      }
      return [...real, ...extra] as typeof real;
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, dataB.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(async () => {
    constructedDays.clear();
    mockedBulk.mockClear();
    const ids = [data.employee.id, data.adminEmployee.id, dataB.employee.id];
    await app.prisma.dayBreakAck.deleteMany({ where: { employeeId: { in: ids } } });
    await app.prisma.dayBreak.deleteMany({ where: { employeeId: { in: ids } } });
  });

  // ── Task 1: the employee's own days, the kernel gaps, the empty list ──────

  describe("own days (D-09, D-20, D-22, 80-AC5, 80-AC6)", () => {
    it("80-AC6: real single-entry data over a month yields an empty list and no day-break or acknowledgement read", async () => {
      const dates = ["2026-03-02", "2026-03-03", "2026-03-04"];
      for (const d of dates) {
        await app.prisma.timeEntry.create({
          data: {
            employeeId: data.employee.id,
            date: dateOf(d),
            startTime: new Date(at("08:00", d)),
            endTime: new Date(at("16:00", d)),
            breakMinutes: 30,
            type: "WORK",
            source: "MANUAL",
            salonId: salonA,
          },
        });
      }
      try {
        const body = await checksOf(data.empToken, data.employee.id);
        expect(body).toEqual({
          employeeId: data.employee.id,
          from: "2026-03-01",
          to: "2026-03-31",
          days: [],
        });
        expect(mockedBulk).not.toHaveBeenCalled();
      } finally {
        await app.prisma.timeEntry.deleteMany({
          where: { employeeId: data.employee.id, date: { in: dates.map(dateOf) } },
        });
      }
    });

    it("the employee sees the own A+B day in full: two entries, one kernel gap, the shortfall; no acknowledgement offer (D-14), a day break may be recorded", async () => {
      const rows = twoSalonDay(data.employee.id);
      const body = await checksOf(data.empToken, data.employee.id);
      expect(body.days).toHaveLength(1);
      const day = body.days[0];
      expect(day).toEqual({
        date: DAY,
        detail: "full",
        crossSalon: true,
        netWorkedMinutes: 480,
        totalBreakMinutes: 0,
        requiredBreakMinutes: 30,
        breakShortfall: true,
        maxDailyExceeded: false,
        acknowledged: false,
        locked: false,
        mayAcknowledge: false,
        mayRecordDayBreak: true,
        acknowledgement: null,
        entries: rows.map((r) => ({
          id: r.id,
          startTime: r.startTime.toISOString(),
          endTime: r.endTime.toISOString(),
          salonId: r.salonId,
        })),
        gaps: [
          {
            startTime: at("12:00"),
            endTime: at("12:30"),
            crossSalon: true,
            countsAsBreak: false,
          },
        ],
        dayBreaks: [],
      });
    });

    it("D-22: the response gaps are the kernel's own gap list, mapped one to one", async () => {
      const rows = twoSalonDay(data.employee.id);
      await seedDayBreak(data.employee.id, DAY, "12:00", "12:10");
      const body = await checksOf(data.empToken, data.employee.id);
      const kernel = evaluateDayBreaks({ rows, dayBreaks: [], acks: [] });
      expect(kernel.gaps.length).toBeGreaterThan(0);
      expect(body.days[0].gaps).toEqual(
        kernel.gaps.map((g) => ({
          startTime: g.startTime.toISOString(),
          endTime: g.endTime.toISOString(),
          crossSalon: g.crossSalon,
          countsAsBreak: g.countsAsBreak,
        })),
      );
    });

    it("a recorded day break inside the gap is listed and clears the shortfall", async () => {
      twoSalonDay(data.employee.id);
      const dayBreak = await seedDayBreak(data.employee.id, DAY, "12:00", "12:30");
      const day = (await checksOf(data.empToken, data.employee.id)).days[0];
      expect(day.dayBreaks).toEqual([
        { id: dayBreak.id, startTime: at("12:00"), endTime: at("12:30") },
      ]);
      expect(day.totalBreakMinutes).toBe(30);
      expect(day.breakShortfall).toBe(false);
    });

    it("80-AC5: reading writes no TimeEntry, DayBreak, DayBreakAck or audit row", async () => {
      twoSalonDay(data.employee.id);
      const count = async () => ({
        entries: await app.prisma.timeEntry.count({ where: { employeeId: data.employee.id } }),
        breaks: await app.prisma.dayBreak.count({ where: { employeeId: data.employee.id } }),
        acks: await app.prisma.dayBreakAck.count({ where: { employeeId: data.employee.id } }),
        audits: await app.prisma.auditLog.count({
          where: { entity: { in: ["DayBreak", "DayBreakAck", "TimeEntry"] } },
        }),
      });
      const before = await count();
      await checksOf(data.empToken, data.employee.id);
      await checksOf(data.adminToken, data.employee.id);
      expect(await count()).toEqual(before);
    });
  });

  // ── Task 2: reach-based redaction, flags, error matrix ────────────────────

  describe("reach-based detail (D-11, D-13, T-80-26)", () => {
    it("a tenant-wide manager gets full detail and may acknowledge; a current acknowledgement flips acknowledged and stays revocable", async () => {
      const rows = twoSalonDay(data.employee.id);
      const before = (await checksOf(data.adminToken, data.employee.id)).days[0];
      expect(before).toMatchObject({
        detail: "full",
        breakShortfall: true,
        acknowledged: false,
        acknowledgement: null,
        mayAcknowledge: true,
        mayRecordDayBreak: true,
      });

      const ack = await seedCurrentAck(data.employee.id, rows);
      const after = (await checksOf(data.adminToken, data.employee.id)).days[0];
      expect(after.acknowledged).toBe(true);
      expect(after.acknowledgement).toEqual({
        id: ack.id,
        createdAt: ack.createdAt.toISOString(),
        reason: REASON,
      });
      expect(after.mayAcknowledge).toBe(true); // revoke stays allowed
    });

    it("a manager scoped on salon A only gets the day redacted: totals and the finding, no entry, gap, day break, acknowledgement or foreign id", async () => {
      const rows = twoSalonDay(data.employee.id);
      await seedDayBreak(data.employee.id, DAY, "12:00", "12:10");
      const partial = await createScopedManager(
        "chk-mgr-a",
        ["time-entry:read:ZUGEWIESEN"],
        [salonA],
      );

      const res = await getChecks(partial.token, data.employee.id);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as ChecksBody;
      expect(body.days).toEqual([
        {
          date: DAY,
          detail: "redacted",
          crossSalon: true,
          netWorkedMinutes: 480,
          totalBreakMinutes: 10,
          requiredBreakMinutes: 30,
          breakShortfall: true,
          maxDailyExceeded: false,
          acknowledged: false,
          locked: false,
          mayAcknowledge: false,
          mayRecordDayBreak: false,
          acknowledgement: null,
          entries: null,
          gaps: null,
          dayBreaks: null,
        },
      ]);

      // Byte-level: not a field check — the raw response body must not contain anything of the
      // foreign salon (its id, the id of its entry, any timestamp of it) nor of the day break.
      const [entryA, entryB] = rows;
      const dayBreak = await app.prisma.dayBreak.findFirstOrThrow({
        where: { employeeId: data.employee.id },
      });
      const forbidden = [
        salonB,
        entryB.id,
        entryB.startTime.toISOString(),
        entryB.endTime.toISOString(),
        "12:30:00",
        "16:30:00",
        dayBreak.id,
        entryA.id,
        entryA.startTime.toISOString(),
        entryA.endTime.toISOString(),
        "Zweiter Salon",
      ];
      for (const needle of forbidden) {
        expect(res.body.includes(needle), `body leaks ${needle}`).toBe(false);
      }
      // The only identifiers in the body are the requested employee id (the caller sent it).
      const uuids = res.body.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g);
      expect(uuids).toEqual([data.employee.id]);
    });

    it("a redacted day with a current acknowledgement shows acknowledged but never its reason or id", async () => {
      const rows = twoSalonDay(data.employee.id);
      await seedCurrentAck(data.employee.id, rows);
      const partial = await createScopedManager(
        "chk-mgr-a2",
        ["time-entry:read:ZUGEWIESEN"],
        [salonA],
      );
      const res = await getChecks(partial.token, data.employee.id);
      const day = (JSON.parse(res.body) as ChecksBody).days[0];
      expect(day.detail).toBe("redacted");
      expect(day.acknowledged).toBe(true);
      expect(day.acknowledgement).toBeNull();
      expect(res.body.includes(REASON)).toBe(false);
    });

    it("a manager scoped on salons A and B gets full detail; mayAcknowledge needs the update reach as well", async () => {
      twoSalonDay(data.employee.id);
      const readOnly = await createScopedManager(
        "chk-mgr-ab-r",
        ["time-entry:read:ZUGEWIESEN"],
        [salonA, salonB],
      );
      const readDay = (await checksOf(readOnly.token, data.employee.id)).days[0];
      expect(readDay.detail).toBe("full");
      expect(readDay.entries).toHaveLength(2);
      expect(readDay.mayAcknowledge).toBe(false);
      expect(readDay.mayRecordDayBreak).toBe(false);

      const writer = await createScopedManager(
        "chk-mgr-ab-w",
        ["time-entry:read:ZUGEWIESEN", "time-entry:update:ZUGEWIESEN"],
        [salonA, salonB],
      );
      const writeDay = (await checksOf(writer.token, data.employee.id)).days[0];
      expect(writeDay.detail).toBe("full");
      expect(writeDay.mayAcknowledge).toBe(true);
      expect(writeDay.mayRecordDayBreak).toBe(true);
    });

    it("a manager who reads A and B but updates only A may not acknowledge or record (the write routes need every entry)", async () => {
      twoSalonDay(data.employee.id);
      const s = `chk-split-${Date.now().toString(36)}`;
      const passwordHash = await bcrypt.hash(PASSWORD, 10);
      const user = await app.prisma.user.create({
        data: { email: `${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
      });
      await app.prisma.employee.create({
        data: {
          tenantId: data.tenant.id,
          userId: user.id,
          employeeNumber: s.toUpperCase().slice(0, 20),
          firstName: "Split",
          lastName: "DayBreakChecksTest",
          hireDate: new Date("2020-01-01"),
        },
      });
      const mkRole = async (perm: string, salons: string[]) => {
        const name = `DayBreakChecks ${crypto.randomBytes(3).toString("hex")}`;
        const role = await app.prisma.accessRole.create({
          data: {
            tenantId: data.tenant.id,
            name,
            nameKey: roleNameKey(name),
            permissions: normalizeRolePermissions([perm]),
          },
        });
        await app.prisma.roleAssignment.create({
          data: {
            tenantId: data.tenant.id,
            userId: user.id,
            accessRoleId: role.id,
            scopeType: "SALONS",
            salonIds: salons,
            employeeIds: [],
          },
        });
      };
      await mkRole("time-entry:read:ZUGEWIESEN", [salonA, salonB]);
      await mkRole("time-entry:update:ZUGEWIESEN", [salonA]);
      const day = (await checksOf(await login(`${s}@test.de`), data.employee.id)).days[0];
      expect(day.detail).toBe("full");
      expect(day.mayAcknowledge).toBe(false);
      expect(day.mayRecordDayBreak).toBe(false);
    });

    it("a manager covering neither salon does not see the day at all", async () => {
      twoSalonDay(data.employee.id);
      const other = await createTestSalon(app.prisma, data.tenant.id, { name: "Dritter Salon" });
      const none = await createScopedManager(
        "chk-mgr-none",
        ["time-entry:read:ZUGEWIESEN"],
        [other.id],
      );
      const res = await getChecks(none.token, data.employee.id);
      expect(res.statusCode).toBe(200);
      expect((JSON.parse(res.body) as ChecksBody).days).toEqual([]);
    });
  });

  describe("flags and derived values", () => {
    it("a same-salon day with a counting gap has no shortfall and nothing to acknowledge", async () => {
      sameSalonDay(data.employee.id);
      const day = (await checksOf(data.adminToken, data.employee.id)).days[0];
      expect(day).toMatchObject({
        crossSalon: false,
        totalBreakMinutes: 30,
        breakShortfall: false,
        mayAcknowledge: false,
      });
      expect(day.gaps).toEqual([
        {
          startTime: at("12:00", SAME_SALON_DAY),
          endTime: at("12:30", SAME_SALON_DAY),
          crossSalon: false,
          countsAsBreak: true,
        },
      ]);
    });

    it("an 11 h day reports maxDailyExceeded, taken from the kernel's own § 3 rule", async () => {
      elevenHourDay(data.employee.id);
      const day = (await checksOf(data.adminToken, data.employee.id)).days[0];
      expect(day.netWorkedMinutes).toBe(660);
      expect(day.maxDailyExceeded).toBe(true);
      const ordinary = twoSalonDay(data.employee.id);
      expect(ordinary).toHaveLength(2);
      const days = (await checksOf(data.adminToken, data.employee.id)).days;
      expect(days.find((d) => d.date === DAY)?.maxDailyExceeded).toBe(false);
    });

    it("a locked entry of the day makes it locked: no acknowledgement offer, no day break offer", async () => {
      twoSalonDay(data.employee.id, LOCKED_DAY, { isLocked: true });
      const day = (await checksOf(data.adminToken, data.employee.id)).days[0];
      expect(day).toMatchObject({ locked: true, mayAcknowledge: false, mayRecordDayBreak: false });
    });

    it("a day in a closed month is locked", async () => {
      twoSalonDay(data.employee.id, CLOSED_DAY);
      const snapshot = await closeMonth(data.employee.id, 2026, 2);
      try {
        const day = (await checksOf(data.adminToken, data.employee.id, "2026-02-01", "2026-02-28"))
          .days[0];
        expect(day).toMatchObject({
          date: CLOSED_DAY,
          locked: true,
          mayAcknowledge: false,
          mayRecordDayBreak: false,
        });
      } finally {
        await app.prisma.saldoSnapshot.delete({ where: { id: snapshot.id } });
      }
    });

    it("days come back in date order", async () => {
      twoSalonDay(data.employee.id, DAY);
      twoSalonDay(data.employee.id, "2026-03-05");
      elevenHourDay(data.employee.id);
      const days = (await checksOf(data.adminToken, data.employee.id)).days;
      expect(days.map((d) => d.date)).toEqual(["2026-03-05", DAY, ELEVEN_HOUR_DAY]);
    });
  });

  describe("error matrix (D-20)", () => {
    it("an EIGENE caller naming another employee is 403 Forbidden", async () => {
      twoSalonDay(data.adminEmployee.id);
      const res = await getChecks(data.empToken, data.adminEmployee.id);
      expect(res.statusCode).toBe(403);
      expect(errorOf(res)).toBe("Forbidden");
    });

    it("a caller without any time-entry:read reach is 403 Forbidden", async () => {
      const none = await createScopedManager("chk-noread", ["employee:read:ZUGEWIESEN"], [salonA]);
      const res = await getChecks(none.token, data.employee.id);
      expect(res.statusCode).toBe(403);
      expect(errorOf(res)).toBe("Forbidden");
    });

    it("an unauthenticated request is 401", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/day-breaks/checks?employeeId=${data.employee.id}&from=2026-03-01&to=2026-03-31`,
      });
      expect(res.statusCode).toBe(401);
    });

    it("from after to is 400", async () => {
      const res = await getChecks(data.adminToken, data.employee.id, "2026-03-31", "2026-03-01");
      expect(res.statusCode).toBe(400);
      expect(errorOf(res)).toBe("Startdatum darf nicht nach dem Enddatum liegen");
    });

    it("more than 62 days is 400, exactly 62 days is accepted", async () => {
      const tooLong = await getChecks(
        data.adminToken,
        data.employee.id,
        "2026-01-01",
        "2026-03-04",
      );
      expect(tooLong.statusCode).toBe(400);
      expect(errorOf(tooLong)).toBe("Der Zeitraum darf höchstens 62 Tage umfassen");
      const exact = await getChecks(data.adminToken, data.employee.id, "2026-01-01", "2026-03-03");
      expect(exact.statusCode).toBe(200);
    });

    it("a malformed or impossible date is 400", async () => {
      const res = await getChecks(data.adminToken, data.employee.id, "2026-02-30", "2026-03-01");
      expect(res.statusCode).toBe(400);
    });

    it("a foreign tenant's employee and a random uuid answer byte-identically (404)", async () => {
      const foreign = await getChecks(data.adminToken, dataB.employee.id);
      const unknown = await getChecks(data.adminToken, randomUUID());
      expect(foreign.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(foreign.statusCode);
      expect(unknown.body).toBe(foreign.body);
      expect(errorOf(foreign)).toBe("Mitarbeiter nicht gefunden");
    });
  });
});
