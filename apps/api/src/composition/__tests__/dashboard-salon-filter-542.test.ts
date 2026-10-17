/**
 * Issue #542 (AC-542-6, AC-542-3/4/5; CTX-1, CTX-4; P-04, P-06) — `GET /dashboard/today-attendance?salonId=`.
 *
 * A chosen salon narrows the attendance list with the team-week rule: a person is listed when they
 * recorded an entry today in the salon (one of the rows the list already reads) or are homed there
 * today (`salonViewMemberIds`). The STATUS of every listed row comes from ALL of the person's
 * entries (#84 D-15) and is therefore the status the unfiltered list gives the same person; a neutral
 * `workedElsewhere` boolean marks valid time today in another salon. The summary counts only the
 * shown rows. Without a filter no additive key appears (`whole-tenant-frozen-85` pins the bytes).
 *
 * Fixture (tenant Europe/Berlin, `Date` faked to Wed 2026-06-17T10:00Z = 12:00 CEST, past), salon A
 * is the seeded salon, B a second one; hire 2025-01-01, FIXED Mo-Fr; no names, synthetic mails:
 *   TA homed A, no entry                    TB homed B, closed entry today in A
 *   TC homed A, closed entry today in B     TD homed B, no entry
 *   TE homed B until 2026-06-16, A from 2026-06-17
 *   TF homed A, OPEN entry today in A       MA homed A, Salonmanager of A (SALONS [A])
 * The "attendance equals the team week" describe adds SB1 (SHIFT_BASED homed A, shift 09:00-17:00)
 * and TP (homed A, PENDING vacation today).
 *
 * Mutation proofs (each reverted with `cp`, `git diff --quiet` exit 0; red tests measured and
 * recorded in the 542-02 SUMMARY):
 *   M1 attendance passes an empty `homeByPerson` to `salonViewMemberIds` -> "attendance" membership
 *      cases for TA/TE red.
 *   M2 attendance omits `workedElsewhere` -> the TC case and the parity cases red.
 *   M3 the team week passes `days: []` to `salonViewMemberIds` -> parity (and the 84 filter cases) red.
 *   M4 attendance validates the salon after the population read -> report-salon-filter-source-542 red.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  reissueTokenNow,
} from "../../__tests__/setup";
import { createPopulationPerson } from "../../__tests__/population-fixtures-613";
import { SYSTEM_ROLE_IDS } from "../../contexts/platform";

const WED = "2026-06-17";
const PASSWORD = "test1234";
const HIRE = new Date("2025-01-01T00:00:00Z");
// 07:00 and 12:00 local (Europe/Berlin, CEST = UTC+2).
const AT_0700 = "2026-06-17T05:00:00Z";
const AT_1200 = "2026-06-17T10:00:00Z";
const ATT_URL = "/api/v1/dashboard/today-attendance";
const day = (s: string) => new Date(`${s}T00:00:00Z`);
const sorted = (xs: readonly string[]) => [...xs].sort((a, b) => a.localeCompare(b));

type AttRow = {
  id: string;
  name: string;
  employeeNumber: string | null;
  status: string;
  reason: string | null;
  expectedStart: string | null;
  lateMinutes: number | null;
  workedElsewhere?: boolean;
};
type Att = {
  date: string;
  salonId?: string;
  employees: AttRow[];
  summary: Record<string, number>;
};
type Cell = { date: string; status: string; reason: string | null; workedElsewhere?: boolean };
type Week = { salonId?: string; team: Array<{ id: string; days: Cell[] }> };

describe("Issue #542 — today's attendance follows a chosen salon", () => {
  let app: FastifyInstance;
  let d: Awaited<ReturnType<typeof seedTestData>>;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  let salonA = "";
  let salonB = "";
  let inactiveSalon = "";
  let maToken = "";
  const ids = {} as Record<"TA" | "TB" | "TC" | "TD" | "TE" | "TF" | "MA", string>;

  async function at<T>(clock: string, fn: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ now: new Date(clock), toFake: ["Date"] });
    try {
      return await fn();
    } finally {
      vi.useRealTimers();
    }
  }

  function getRaw(url: string, token: string, clock = AT_1200) {
    return at(clock, () =>
      app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${reissueTokenNow(app, token)}` },
      }),
    );
  }

  async function att(query: string, token = d.adminToken, clock = AT_1200): Promise<Att> {
    const res = await getRaw(`${ATT_URL}${query}`, token, clock);
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as Att;
  }

  const rowOf = (a: Att, id: string): AttRow => {
    const row = a.employees.find((r) => r.id === id);
    if (!row) throw new Error(`attendance row ${id} missing`);
    return row;
  };
  const idsOf = (a: Att) => sorted(a.employees.map((r) => r.id));
  const expected = (...keys: Array<keyof typeof ids>) => sorted(keys.map((k) => ids[k]));

  async function person(tag: string, salonId: string, opts: { passwordHash?: string } = {}) {
    return createPopulationPerson(app, {
      tenantId: d.tenant.id,
      salonId,
      tag,
      hireDate: HIRE,
      ...opts,
    });
  }

  function entry(employeeId: string, salonId: string, start: string, end: string | null) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId,
        date: day(WED),
        startTime: new Date(`${WED}T${start}:00Z`),
        endTime: end ? new Date(`${WED}T${end}:00Z`) : null,
        breakMinutes: 0,
        type: "WORK",
        source: "MANUAL",
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    d = await seedTestData(app, "sf542");
    foreign = await seedTestData(app, "sf542f");
    salonA = d.salonId;
    salonB = (await createTestSalon(app.prisma, d.tenant.id, { name: "Sf542 B" })).id;
    inactiveSalon = (
      await createTestSalon(app.prisma, d.tenant.id, { name: "Sf542 off", isActive: false })
    ).id;

    ids.TA = (await person("ta", salonA)).employeeId;
    ids.TB = (await person("tb", salonB)).employeeId;
    await entry(ids.TB, salonA, "06:00", "09:00");
    ids.TC = (await person("tc", salonA)).employeeId;
    await entry(ids.TC, salonB, "06:00", "09:00");
    ids.TD = (await person("td", salonB)).employeeId;

    // TE: homed B until the day before, A from today.
    ids.TE = (await person("te", salonB)).employeeId;
    await app.prisma.employeeSalonAssignment.updateMany({
      where: { employeeId: ids.TE, kind: "HOME" },
      data: { validUntil: day("2026-06-16") },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: d.tenant.id,
        employeeId: ids.TE,
        salonId: salonA,
        kind: "HOME",
        validFrom: day(WED),
        validUntil: null,
        weekdays: [],
      },
    });

    ids.TF = (await person("tf", salonA)).employeeId;
    await entry(ids.TF, salonA, "06:00", null);

    const ma = await person("ma", salonA, { passwordHash: await bcrypt.hash(PASSWORD, 4) });
    ids.MA = ma.employeeId;
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: d.tenant.id,
        userId: ma.userId,
        accessRoleId: SYSTEM_ROLE_IDS.SALON_MANAGER,
        scopeType: "SALONS",
        salonIds: [salonA],
        employeeIds: [],
      },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: ma.email, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    maToken = (JSON.parse(login.body) as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    vi.useRealTimers();
    for (const tenantId of [d?.tenant.id, foreign?.tenant.id]) {
      if (!tenantId) continue;
      try {
        await app.prisma.roleAssignment.deleteMany({ where: { tenantId } });
        await cleanupTestData(app, tenantId);
      } catch (err) {
        console.error("dashboard-salon-filter-542 cleanup failed:", err);
      }
    }
    await closeTestApp();
  });

  describe("attendance", () => {
    it("salon A lists the persons with an entry in A today or homed in A today, with their unfiltered status", async () => {
      const unfiltered = await att("");
      const a = await att(`?salonId=${salonA}`);
      expect(a.salonId).toBe(salonA);
      expect(idsOf(a)).toEqual(expected("TA", "TB", "TC", "TE", "TF", "MA"));
      for (const row of a.employees) {
        const base = rowOf(unfiltered, row.id);
        expect(row.status, row.id).toBe(base.status);
        expect(row.reason, row.id).toBe(base.reason);
        expect(row.employeeNumber, row.id).toBe(base.employeeNumber);
      }
      expect(rowOf(a, ids.TA).status).toBe("scheduled");
      expect(rowOf(a, ids.TB).status).toBe("present");
      expect(rowOf(a, ids.TC).status).toBe("present");
      expect(rowOf(a, ids.TF).status).toBe("clocked_in");
    });

    it("marks valid time in another salon as workedElsewhere, never anything else", async () => {
      const a = await att(`?salonId=${salonA}`);
      expect(rowOf(a, ids.TC).workedElsewhere).toBe(true);
      for (const key of ["TA", "TB", "TE", "TF", "MA"] as const) {
        expect(rowOf(a, ids[key]).workedElsewhere, key).toBe(false);
      }
    });

    it("counts only the shown rows in the summary", async () => {
      const a = await att(`?salonId=${salonA}`);
      const byStatus = (s: string) => a.employees.filter((r) => r.status === s).length;
      expect(a.summary).toEqual({
        present: byStatus("present"),
        absent: byStatus("absent"),
        clockedIn: byStatus("clocked_in"),
        missing: byStatus("missing"),
        holiday: byStatus("holiday"),
      });
      expect(a.summary.present).toBe(2);
      expect(a.summary.clockedIn).toBe(1);
      const unfiltered = await att("");
      expect(unfiltered.employees.length).toBeGreaterThan(a.employees.length);
    });

    it("salon B lists the persons with an entry in B or homed in B; TE left B yesterday", async () => {
      const b = await att(`?salonId=${salonB}`);
      expect(b.salonId).toBe(salonB);
      expect(idsOf(b)).toEqual(expected("TB", "TC", "TD"));
      expect(rowOf(b, ids.TB).workedElsewhere).toBe(true);
      expect(rowOf(b, ids.TC).workedElsewhere).toBe(false);
      expect(rowOf(b, ids.TD).workedElsewhere).toBe(false);
      expect(b.employees.some((r) => r.id === ids.TE)).toBe(false);
    });

    it("without a filter no additive key appears and the row keys are the pre-542 keys", async () => {
      const a = await att("");
      expect(Object.keys(a).sort((x, y) => x.localeCompare(y))).toEqual([
        "date",
        "employees",
        "summary",
      ]);
      expect(a.employees.length).toBeGreaterThan(0);
      for (const row of a.employees) {
        expect(Object.keys(row).sort((x, y) => x.localeCompare(y))).toEqual(
          ["employeeNumber", "expectedStart", "id", "lateMinutes", "name", "reason", "status"].sort(
            (x, y) => x.localeCompare(y),
          ),
        );
      }
    });

    it("answers the one 404 for a foreign, unknown and inactive salon, byte-identical to the monthly report's", async () => {
      const bodies: string[] = [];
      for (const salonId of [foreign.salonId, randomUUID(), inactiveSalon]) {
        const res = await getRaw(`${ATT_URL}?salonId=${salonId}`, d.adminToken);
        expect(res.statusCode, salonId).toBe(404);
        bodies.push(res.body);
      }
      const monthly = await getRaw(
        `/api/v1/reports/monthly?year=2026&month=6&salonId=${foreign.salonId}`,
        d.adminToken,
      );
      expect(monthly.statusCode).toBe(404);
      for (const body of bodies) expect(body).toBe(monthly.body);
      expect(monthly.body).toBe('{"error":"Salon nicht gefunden"}');
    });

    it("answers 400 for a malformed salon id", async () => {
      const res = await getRaw(`${ATT_URL}?salonId=not-a-uuid`, d.adminToken);
      expect(res.statusCode).toBe(400);
    });
  });

  describe("Salonmanager", () => {
    it("never lists through the filter a person the unfiltered list does not show", async () => {
      const unfiltered = await att("", maToken);
      const a = await att(`?salonId=${salonA}`, maToken);
      const base = new Set(unfiltered.employees.map((r) => r.id));
      for (const row of a.employees) {
        expect(base.has(row.id), `${row.id} is in the unfiltered list`).toBe(true);
        expect(row.status, row.id).toBe(rowOf(unfiltered, row.id).status);
      }
      expect(a.employees.some((r) => r.id === ids.TD)).toBe(false);
      expect(base.has(ids.TD)).toBe(false);
    });

    it("lists the entry-only person TB without an employee number", async () => {
      const unfiltered = await att("", maToken);
      const a = await att(`?salonId=${salonA}`, maToken);
      expect(rowOf(unfiltered, ids.TB).employeeNumber).toBeNull();
      expect(rowOf(a, ids.TB).employeeNumber).toBeNull();
      expect(rowOf(a, ids.TB).workedElsewhere).toBe(false);
    });

    it("a salon outside the reach answers the one 404", async () => {
      const outside = await getRaw(`${ATT_URL}?salonId=${salonB}`, maToken);
      const foreignRes = await getRaw(`${ATT_URL}?salonId=${foreign.salonId}`, maToken);
      expect(outside.statusCode).toBe(404);
      expect(outside.body).toBe(foreignRes.body);
      expect(outside.body).toBe('{"error":"Salon nicht gefunden"}');
    });
  });

  describe("attendance equals the team week", () => {
    const WEEK_URL = `/api/v1/dashboard/team-week?date=${WED}`;
    const ids2 = {} as Record<"SB1" | "TP", string>;
    const observed = new Set<string>();

    beforeAll(async () => {
      ids2.SB1 = (await person("sb1", salonA)).employeeId;
      await app.prisma.workSchedule.updateMany({
        where: { employeeId: ids2.SB1 },
        data: { type: "SHIFT_BASED", contractWorkDaysPerWeek: 5, usualWorkDays: [1, 2, 3, 4, 5] },
      });
      await app.prisma.shift.create({
        data: {
          employeeId: ids2.SB1,
          salonId: salonA,
          date: day(WED),
          startTime: "09:00",
          endTime: "17:00",
          label: "sf542",
        },
      });
      ids2.TP = (await person("tp", salonA)).employeeId;
      const vacation = await app.prisma.leaveType.findFirstOrThrow({
        where: { tenantId: d.tenant.id, code: "VACATION" },
      });
      await app.prisma.leaveRequest.create({
        data: {
          employeeId: ids2.TP,
          leaveTypeId: vacation.id,
          startDate: day(WED),
          endDate: day(WED),
          days: 1,
          status: "PENDING",
        },
      });
    });

    async function bothAt(token: string, clock: string, query: string) {
      return at(clock, async () => {
        const headers = { authorization: `Bearer ${reissueTokenNow(app, token)}` };
        const a = await app.inject({ method: "GET", url: `${ATT_URL}${query}`, headers });
        expect(a.statusCode, a.body).toBe(200);
        const w = await app.inject({
          method: "GET",
          url: `${WEEK_URL}&${query.slice(1)}`,
          headers,
        });
        expect(w.statusCode, w.body).toBe(200);
        return { att: JSON.parse(a.body) as Att, week: JSON.parse(w.body) as Week };
      });
    }

    for (const [caller, tokenOf] of [
      ["admin", () => d.adminToken],
      ["Salonmanager", () => maToken],
    ] as const) {
      for (const clock of [AT_0700, AT_1200]) {
        it(`${caller} at ${clock}: every attendance person is in the filtered team week with the same status, reason and workedElsewhere`, async () => {
          const { att: a, week } = await bothAt(tokenOf(), clock, `?salonId=${salonA}`);
          expect(a.salonId).toBe(salonA);
          expect(week.salonId).toBe(salonA);
          expect(a.employees.length).toBeGreaterThan(0);
          for (const row of a.employees) {
            const weekRow = week.team.find((t) => t.id === row.id);
            expect(weekRow, `team-week row ${row.id}`).toBeDefined();
            const cell = weekRow?.days.find((c) => c.date === WED);
            expect(cell, `team-week cell ${row.id}`).toBeDefined();
            expect(row.status, `${row.id} status`).toBe(cell?.status);
            expect(row.reason, `${row.id} reason`).toBe(cell?.reason);
            expect(row.workedElsewhere, `${row.id} workedElsewhere`).toBe(cell?.workedElsewhere);
            observed.add(row.status);
          }
        });
      }
    }

    it("the observed statuses reach scheduled, present, clocked_in, missing and requested", async () => {
      // The admin cases above ran before this one; the set is filled by them.
      for (const status of ["scheduled", "present", "clocked_in", "missing", "requested"]) {
        expect(observed.has(status), `status ${status} observed`).toBe(true);
      }
    });
  });
});
