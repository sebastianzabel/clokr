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
 * Mutation proofs (each reverted with `cp`, byte-compared; red tests measured):
 *   M1 attendance passes an empty `homeByPerson` to `salonViewMemberIds` -> "salon A lists ...",
 *      "marks valid time in another salon ...", "counts only the shown rows ..." and "salon B
 *      lists ..." red (5 failed, the fifth is the derived observed-statuses case).
 *   M2 attendance omits `workedElsewhere` -> "marks valid time in another salon ...", "salon B
 *      lists ...", "lists the entry-only person TB ..." and all four parity cases red.
 *   M3 the team week passes `days: []` to `salonViewMemberIds` -> dashboard-team-salon-filter-84
 *      ("salon A: rows by entry or Stammsalon ...", "salon B: the same person ...") and all four
 *      parity cases red.
 *   M4 attendance validates the salon after the population read -> report-salon-filter-source-542
 *      "get /today-attendance: validates before any read ..." red.
 *
 * "Saldenübersicht" (GET /dashboard/overtime-overview?salonId=, 542-03; own tenant, same clock).
 * Persons: OA homed A; OB homed B; OM B until 2026-06-16 then A; OZ A until 2026-06-17 (today) then
 * B; OX left 2026-05-31 (HOME A until the exit day, May not closed); OY left 2026-05-31 homed B;
 * C1 / C2 carry the two-reach roles (homed A). Mutation proofs (reverted with `cp`, byte-compared):
 *   M1 the salon is validated against the team-overview reach only -> "validates against both
 *      reaches ..." red (1 failed).
 *   M2 the active rows are narrowed at the month start instead of today -> "salon A lists ...",
 *      "salon B lists ...", "decides the Stammsalon by the tenant-local day ..." and "validates
 *      against both reaches ..." red (4 failed; OM would still be in B).
 *   M3 the exited rows are narrowed at today instead of the exit day -> "salon A lists ...",
 *      "partitions ..." and "decides the Stammsalon by the tenant-local day ..." red (3 failed; OX).
 *   M4 an account read placed before the validation -> report-salon-filter-source-542 "get
 *      /overtime-overview: validates before any read ..." red.
 *   M5 the narrowing Stichtag passed as the instant `new Date()` instead of the calendar day ->
 *      "salon A lists ...", "partitions ..." and "decides the Stammsalon by the tenant-local day
 *      ..." red (3 failed). Note: Prisma truncates a Date given to a @db.Date filter to its UTC
 *      date, so an instant is wrong only where the tenant-local day differs from the UTC day
 *      (the 00:30 local case) and for the exit-day rows; the calendar-day form is exact everywhere.
 *   M6 (plan 05) the callers' own reaches evaluated at `new Date()` instead of the tenant-local
 *      calendar day -> "judges a scoped caller's own reach on the tenant-local day ..." red (1
 *      failed; OZ stays in the reach of C1 at 23:30Z).
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
import { SYSTEM_ROLE_IDS, normalizeRolePermissions, roleNameKey } from "../../contexts/platform";

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
  // ── Saldenübersicht (Issue #542, AC-542-6, OD-1, CTX-3, D-542-2, P-04, P-05) ──────────────────
  describe("Saldenübersicht", () => {
    const OV_URL = "/api/v1/dashboard/overtime-overview";
    const TODAY = "2026-06-17";
    const EXIT_DAY = "2026-05-31";
    type OvRow = Record<string, unknown> & {
      id: string;
      exitedWithOpenFinalSaldo: boolean;
      balanceHours: number;
    };
    type Ov = { salonId?: string; employees: OvRow[]; exitedOpenFinalSaldoCount: number };

    let o: Awaited<ReturnType<typeof seedTestData>>;
    let oForeign: Awaited<ReturnType<typeof seedTestData>>;
    let oA = "";
    let oB = "";
    let oInactive = "";
    let c1Token = "";
    let c2Token = "";
    const op = {} as Record<"OA" | "OB" | "OM" | "OZ" | "OX" | "OY" | "C1" | "C2", string>;

    async function ov(query: string, token = o.adminToken): Promise<Ov> {
      const res = await getRaw(`${OV_URL}${query}`, token);
      expect(res.statusCode, res.body).toBe(200);
      return JSON.parse(res.body) as Ov;
    }
    const ovIds = (r: Ov) => sorted(r.employees.map((e) => e.id));
    const ovRow = (r: Ov, id: string): OvRow => {
      const row = r.employees.find((e) => e.id === id);
      if (!row) throw new Error(`overview row ${id} missing`);
      return row;
    };
    const want = (...keys: Array<keyof typeof op>) => sorted(keys.map((k) => op[k]));

    function ovPerson(tag: string, salonId: string, extra: { exitDate?: Date } = {}) {
      return createPopulationPerson(app, {
        tenantId: o.tenant.id,
        salonId,
        tag,
        hireDate: HIRE,
        ...extra,
      });
    }
    function closedEntry(employeeId: string, salonId: string, date: string) {
      return app.prisma.timeEntry.create({
        data: {
          employeeId,
          salonId,
          date: day(date),
          startTime: new Date(`${date}T06:00:00Z`),
          endTime: new Date(`${date}T14:00:00Z`),
          breakMinutes: 30,
          type: "WORK",
          source: "MANUAL",
        },
      });
    }
    function setHome(
      employeeId: string,
      salonId: string,
      from: string | null,
      until: string | null,
    ) {
      return app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId: o.tenant.id,
          employeeId,
          salonId,
          kind: "HOME",
          validFrom: day(from ?? "2025-01-01"),
          validUntil: until === null ? null : day(until),
          weekdays: [],
        },
      });
    }
    function endHome(employeeId: string, until: string) {
      return app.prisma.employeeSalonAssignment.updateMany({
        where: { employeeId, kind: "HOME" },
        data: { validUntil: day(until) },
      });
    }
    async function customCaller(
      tag: string,
      grants: Array<{
        permission: string;
        scopeType: "TENANT" | "SALONS";
        salonIds?: string[];
      }>,
    ): Promise<{ employeeId: string; token: string }> {
      const p = await ovPerson(tag, oA);
      // The person is only a carrier of the login; a login needs a real password hash.
      await app.prisma.user.update({
        where: { id: p.userId },
        data: { passwordHash: await bcrypt.hash(PASSWORD, 4) },
      });
      for (const g of grants) {
        const name = `Sf542 ${tag} ${randomUUID().slice(0, 8)}`;
        const role = await app.prisma.accessRole.create({
          data: {
            tenantId: o.tenant.id,
            name,
            nameKey: roleNameKey(name),
            permissions: normalizeRolePermissions([g.permission]),
          },
        });
        await app.prisma.roleAssignment.create({
          data: {
            tenantId: o.tenant.id,
            userId: p.userId,
            accessRoleId: role.id,
            scopeType: g.scopeType,
            salonIds: g.salonIds ?? [],
            employeeIds: [],
          },
        });
      }
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: p.email, password: PASSWORD },
      });
      expect(login.statusCode, login.body).toBe(200);
      return {
        employeeId: p.employeeId,
        token: (JSON.parse(login.body) as { accessToken: string }).accessToken,
      };
    }

    beforeAll(async () => {
      o = await seedTestData(app, "sf542o");
      oForeign = await seedTestData(app, "sf542of");
      oA = o.salonId;
      oB = (await createTestSalon(app.prisma, o.tenant.id, { name: "Sf542o B" })).id;
      oInactive = (
        await createTestSalon(app.prisma, o.tenant.id, { name: "Sf542o off", isActive: false })
      ).id;

      op.OA = (await ovPerson("oa", oA)).employeeId;
      op.OB = (await ovPerson("ob", oB)).employeeId;
      // OM: homed B until the day before, A from today.
      op.OM = (await ovPerson("om", oB)).employeeId;
      await endHome(op.OM, "2026-06-16");
      await setHome(op.OM, oA, TODAY, null);
      // OZ: homed A until today (validUntil = today), B from tomorrow — the calendar-day Stichtag (P-05).
      op.OZ = (await ovPerson("oz", oA)).employeeId;
      await endHome(op.OZ, TODAY);
      await setHome(op.OZ, oB, "2026-06-18", null);
      // OX / OY: left on 2026-05-31, May never closed, so the final saldo is still open.
      op.OX = (await ovPerson("ox", oA, { exitDate: day(EXIT_DAY) })).employeeId;
      await endHome(op.OX, EXIT_DAY);
      op.OY = (await ovPerson("oy", oB, { exitDate: day(EXIT_DAY) })).employeeId;
      for (const key of ["OA", "OB", "OM", "OZ"] as const) {
        await closedEntry(op[key], key === "OB" ? oB : oA, "2026-06-16");
      }
      await closedEntry(op.OX, oA, "2026-05-29");
      await closedEntry(op.OY, oB, "2026-05-29");

      // C1: whole-tenant team-overview reach, overtime reach narrowed to [A].
      const c1 = await customCaller("c1", [
        { permission: "team-overview:read:ZUGEWIESEN", scopeType: "TENANT" },
        { permission: "overtime:read:ZUGEWIESEN", scopeType: "SALONS", salonIds: [oA] },
      ]);
      op.C1 = c1.employeeId;
      c1Token = c1.token;
      // C2: team-overview reach [A, B], overtime reach [A].
      const c2 = await customCaller("c2", [
        { permission: "team-overview:read:ZUGEWIESEN", scopeType: "SALONS", salonIds: [oA, oB] },
        { permission: "overtime:read:ZUGEWIESEN", scopeType: "SALONS", salonIds: [oA] },
      ]);
      op.C2 = c2.employeeId;
      c2Token = c2.token;
    });

    afterAll(async () => {
      vi.useRealTimers();
      for (const tenantId of [o?.tenant.id, oForeign?.tenant.id]) {
        if (!tenantId) continue;
        try {
          await app.prisma.roleAssignment.deleteMany({ where: { tenantId } });
          await app.prisma.accessRole.deleteMany({ where: { tenantId } });
          await cleanupTestData(app, tenantId);
        } catch (err) {
          console.error("dashboard-salon-filter-542 overview cleanup failed:", err);
        }
      }
    });

    it("salon A lists the persons homed in A today (OZ on its last A day) and the exited person homed in A at its exit day", async () => {
      const unfiltered = await ov("");
      const a = await ov(`?salonId=${oA}`);
      expect(a.salonId).toBe(oA);
      expect(ovIds(a)).toEqual(want("OA", "OM", "OZ", "OX", "C1", "C2"));
      expect(ovRow(a, op.OX).exitedWithOpenFinalSaldo).toBe(true);
      for (const key of ["OA", "OM", "OZ", "C1", "C2"] as const) {
        expect(ovRow(a, op[key]).exitedWithOpenFinalSaldo, key).toBe(false);
      }
      expect(a.exitedOpenFinalSaldoCount).toBe(1);
      for (const row of a.employees) {
        expect(row, row.id).toEqual(ovRow(unfiltered, row.id));
      }
    });

    it("salon B lists OB and the exited OY; OM and OZ are not in B today", async () => {
      const unfiltered = await ov("");
      const b = await ov(`?salonId=${oB}`);
      expect(b.salonId).toBe(oB);
      expect(ovIds(b)).toEqual(want("OB", "OY"));
      expect(ovRow(b, op.OY).exitedWithOpenFinalSaldo).toBe(true);
      expect(b.exitedOpenFinalSaldoCount).toBe(1);
      for (const row of b.employees) {
        expect(row, row.id).toEqual(ovRow(unfiltered, row.id));
      }
    });

    it("partitions the persons with a Stammsalon: A and B are disjoint, the persons without one appear in neither", async () => {
      const unfiltered = await ov("");
      const a = new Set(ovIds(await ov(`?salonId=${oA}`)));
      const b = new Set(ovIds(await ov(`?salonId=${oB}`)));
      for (const id of a) expect(b.has(id), id).toBe(false);
      const seedIds = [o.adminEmployee.id, o.employee.id];
      // The seeded admin and employee have no HOME row at all.
      for (const id of seedIds) {
        expect(ovIds(unfiltered)).toContain(id);
        expect(a.has(id), id).toBe(false);
        expect(b.has(id), id).toBe(false);
      }
      const union = sorted([...a, ...b]);
      const homed = ovIds(unfiltered).filter((id) => !seedIds.includes(id));
      expect(union).toEqual(homed);
    });

    it("decides the Stammsalon by the tenant-local day: at 00:30 local on 18 June OZ has moved to B and OM stays in A", async () => {
      // 2026-06-17T22:30Z is 00:30 CEST on 18 June: the UTC date is still the 17th, the tenant-local
      // day is the 18th. An instant passed as the Stichtag would truncate to the 17th and keep OZ in A.
      const late = "2026-06-17T22:30:00Z";
      const asOv = async (query: string): Promise<Ov> => {
        const res = await getRaw(`${OV_URL}${query}`, o.adminToken, late);
        expect(res.statusCode, res.body).toBe(200);
        return JSON.parse(res.body) as Ov;
      };
      const a = await asOv(`?salonId=${oA}`);
      const b = await asOv(`?salonId=${oB}`);
      expect(ovIds(a)).toEqual(want("OA", "OM", "OX", "C1", "C2"));
      expect(ovIds(b)).toEqual(want("OB", "OZ", "OY"));
    });

    it("judges a scoped caller's own reach on the tenant-local day: at 01:30 local on 18 June the caller of salon A no longer reaches OZ", async () => {
      // 2026-06-17T23:30Z is 01:30 CEST on 18 June. OZ is homed A until the 17th and B from the 18th,
      // so on the tenant-local day OZ is outside the SALONS [A] reach of C1 and C2. The caller's reach
      // used to be evaluated at `new Date()`, which a @db.Date filter truncates to the UTC date (the
      // 17th) and which kept OZ in the reach for two hours every evening (orchestrator amendment 6a).
      const late = "2026-06-17T23:30:00Z";
      for (const token of [c1Token, c2Token]) {
        const res = await getRaw(OV_URL, token, late);
        expect(res.statusCode, res.body).toBe(200);
        const ids = ovIds(JSON.parse(res.body) as Ov);
        expect(ids).not.toContain(op.OZ);
        // A person homed in A on both days stays in the reach.
        expect(ids).toContain(op.OA);
        expect(ids).toContain(op.OM);
      }
      // Control at 10:00Z the same day: OZ is still homed A (its last day), inside the reach.
      const noon = await getRaw(OV_URL, c1Token, "2026-06-17T10:00:00Z");
      expect(noon.statusCode, noon.body).toBe(200);
      expect(ovIds(JSON.parse(noon.body) as Ov)).toContain(op.OZ);
    });

    it("without a filter no salonId key appears and the body keys are the pre-542 keys", async () => {
      const u = await ov("");
      expect(Object.keys(u).sort((x, y) => x.localeCompare(y))).toEqual([
        "employees",
        "exitedOpenFinalSaldoCount",
      ]);
      expect(u.exitedOpenFinalSaldoCount).toBe(2);
    });

    it("validates against both reaches: a salon outside the narrower overtime reach answers 404", async () => {
      // C1: team-overview TENANT, overtime [A] — B is inside the first reach, outside the second.
      const c1B = await getRaw(`${OV_URL}?salonId=${oB}`, c1Token);
      expect(c1B.statusCode, c1B.body).toBe(404);
      // C2: team-overview [A, B], overtime [A].
      const c2B = await getRaw(`${OV_URL}?salonId=${oB}`, c2Token);
      expect(c2B.statusCode, c2B.body).toBe(404);
      expect(c2B.body).toBe(c1B.body);

      for (const token of [c1Token, c2Token]) {
        const unfiltered = await ov("", token);
        const a = await ov(`?salonId=${oA}`, token);
        const unfilteredIds = new Set(ovIds(unfiltered));
        expect(a.employees.length).toBeGreaterThan(0);
        for (const row of a.employees) {
          expect(unfilteredIds.has(row.id), row.id).toBe(true);
          expect(row, row.id).toEqual(ovRow(unfiltered, row.id));
        }
        for (const key of ["OA", "OM", "OZ"] as const) {
          expect(ovIds(a), key).toContain(op[key]);
        }
        expect(ovIds(a)).not.toContain(op.OB);
      }
    });

    it("answers the one 404 for a foreign, unknown and inactive salon, byte-identical to the other places", async () => {
      const bodies: string[] = [];
      for (const salonId of [oForeign.salonId, randomUUID(), oInactive]) {
        const res = await getRaw(`${OV_URL}?salonId=${salonId}`, o.adminToken);
        expect(res.statusCode, salonId).toBe(404);
        bodies.push(res.body);
      }
      for (const body of bodies) expect(body).toBe('{"error":"Salon nicht gefunden"}');
      const bad = await getRaw(`${OV_URL}?salonId=not-a-uuid`, o.adminToken);
      expect(bad.statusCode).toBe(400);
    });
  });
});
