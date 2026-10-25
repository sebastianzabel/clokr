/**
 * Issue #670 (AC-670-1..5) - "Meine Woche" and the open-items gap finder read the SAME day status
 * (`resolveDayStatus`, Issue #587) as the team week and the attendance list.
 *
 * One tenant (Europe/Berlin), `Date` faked at non-midnight instants in the past of the real run.
 * For every fixture person the own `/my-week`, the admin's `/team-week` and (for today) the
 * attendance list are compared cell by cell, and `/open-items` `missingDays` is compared with the
 * team week's "missing" days. The vocabulary mapping my-week <-> shared status is
 * `composition/my-week-status.ts`; the one justified difference of the gap finder (a day whose
 * only entries are invalid) is pinned below.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  reissueTokenNow,
  tokenWithoutSignIn,
} from "../../__tests__/setup";
import { createPopulationPerson } from "../../__tests__/population-fixtures-613";

const WED = "2026-06-17";
const HIRE = new Date("2025-01-01T00:00:00Z");
const day = (s: string) => new Date(`${s}T00:00:00Z`);
// Wed 2026-06-17 12:00 local (CEST), and Mon 2026-06-22 12:00 local (the week of WED is past).
const AT_WED_1200 = "2026-06-17T10:00:00Z";
const AT_MON_AFTER = "2026-06-22T10:00:00Z";
// Mon 2026-07-06 12:00 local: the week 29 Jun - 5 Jul (contract change on 1 Jul) is past.
const AT_JULY = "2026-07-06T10:00:00Z";

type TeamCell = { date: string; status: string; isWorkday: boolean; expectedHours: number };
type Week = { team: Array<{ id: string; days: TeamCell[] }> };
type MyDay = {
  date: string;
  status: string;
  isWorkday: boolean;
  workedHours: number;
  expectedHours: number;
};
type Att = { employees: Array<{ id: string; status: string }> };

// shared status -> the my-week values it may carry (composition/my-week-status.ts)
const MAPPING: Record<string, string[]> = {
  clocked_in: ["clocked_in"],
  present: ["complete", "partial"],
  requested: ["requested"],
  absent: ["leave", "sick", "absent"],
  holiday: ["holiday"],
  missing: ["missing"],
  scheduled: ["scheduled"],
  none: ["weekend", "none"],
};

describe("Issue #670 - one day status for my-week, open-items, team-week and attendance", () => {
  let app: FastifyInstance;
  let d: Awaited<ReturnType<typeof seedTestData>>;
  let salonA = "";
  let salonB = "";
  const ids: Record<string, string> = {};
  const emails: Record<string, string> = {};
  const observed = new Set<string>();

  async function person(
    tag: string,
    opts: { salonId?: string; hireDate?: Date; exitDate?: Date } = {},
  ) {
    const p = await createPopulationPerson(app, {
      tenantId: d.tenant.id,
      salonId: opts.salonId ?? salonA,
      tag,
      hireDate: opts.hireDate ?? HIRE,
      exitDate: opts.exitDate,
    });
    ids[tag] = p.employeeId;
    emails[tag] = p.email;
    return p.employeeId;
  }

  const setSchedule = (employeeId: string, data: Record<string, unknown>) =>
    app.prisma.workSchedule.updateMany({ where: { employeeId }, data });

  const shift = (employeeId: string, start: string, end: string, date = WED, salonId = salonA) =>
    app.prisma.shift.create({
      data: { employeeId, salonId, date: day(date), startTime: start, endTime: end, label: "t670" },
    });

  const entry = (employeeId: string, start: string, end: string | null, isInvalid = false) =>
    app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId: salonA,
        date: day(WED),
        startTime: new Date(`${WED}T${start}:00Z`),
        endTime: end ? new Date(`${WED}T${end}:00Z`) : null,
        breakMinutes: 0,
        type: "WORK",
        source: "MANUAL",
        isInvalid,
      },
    });

  /** Runs `fn` under a faked clock; every token is re-issued inside the window. */
  async function at<T>(clock: string, fn: (tok: (t: string) => string) => Promise<T>): Promise<T> {
    vi.useFakeTimers({ now: new Date(clock), toFake: ["Date"] });
    try {
      return await fn((t) => reissueTokenNow(app, t));
    } finally {
      vi.useRealTimers();
    }
  }

  async function getJson<T>(url: string, token: string): Promise<T> {
    const res = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
    return JSON.parse(res.body) as T;
  }

  /** team week (admin), the person's own my-week and open-items, all inside one clock window. */
  async function views(clock: string, weekDate: string, tag: string) {
    const token = await tokenWithoutSignIn(app, emails[tag]);
    return at(clock, async (tok) => {
      const week = await getJson<Week>(
        `/api/v1/dashboard/team-week?date=${weekDate}`,
        tok(d.adminToken),
      );
      const mine = await getJson<{ days: MyDay[] }>(
        `/api/v1/dashboard/my-week?date=${weekDate}`,
        tok(token),
      );
      const open = await getJson<{ missingDays: string[]; invalidEntries: number }>(
        "/api/v1/dashboard/open-items",
        tok(token),
      );
      const att = await getJson<Att>("/api/v1/dashboard/today-attendance", tok(d.adminToken));
      return {
        team: week.team.find((r) => r.id === ids[tag])?.days ?? [],
        mine: mine.days,
        open,
        att,
      };
    });
  }

  /** Every day of the week: the my-week status is a mapping of the team-week status. */
  function expectWeekParity(tag: string, team: TeamCell[], mine: MyDay[]) {
    expect(team.length, `${tag} team week`).toBe(7);
    expect(mine.length, `${tag} my-week`).toBe(7);
    team.forEach((cell, i) => {
      const my = mine[i];
      expect(my.date).toBe(cell.date);
      expect(MAPPING[cell.status], `${tag} ${cell.date}: ${cell.status} -> ${my.status}`).toContain(
        my.status,
      );
      expect(my.isWorkday, `${tag} ${cell.date} isWorkday`).toBe(cell.isWorkday);
      observed.add(cell.status);
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    d = await seedTestData(app, "t670");
    const tenantId = d.tenant.id;
    salonA = d.salonId;
    salonB = (await createTestSalon(app.prisma, tenantId, { name: "T670 B" })).id;
    await app.prisma.tenantConfig.updateMany({
      where: { tenantId },
      data: { missingEntriesDays: 7 },
    });
    const vacation = await app.prisma.leaveType.findFirstOrThrow({
      where: { tenantId, code: "VACATION" },
    });
    const leave = (employeeId: string, status: "APPROVED" | "PENDING", halfDay = false) =>
      app.prisma.leaveRequest.create({
        data: {
          employeeId,
          leaveTypeId: vacation.id,
          startDate: day(WED),
          endDate: day(WED),
          days: halfDay ? 0.5 : 1,
          halfDay,
          status,
          ...(status === "APPROVED" ? { reviewedBy: d.adminUser.id, reviewedAt: new Date() } : {}),
        },
      });
    const shiftBased = (id: string) =>
      setSchedule(id, {
        type: "SHIFT_BASED",
        contractWorkDaysPerWeek: 5,
        usualWorkDays: [1, 2, 3, 4, 5],
      });

    await person("FX");
    await person("FXS");
    await shift(ids.FXS, "08:00", "16:00");
    await person("SB1");
    await shiftBased(ids.SB1);
    await shift(ids.SB1, "09:00", "17:00");
    await person("SB0");
    await shiftBased(ids.SB0);
    await person("FL");
    await setSchedule(ids.FL, { type: "FLEXTIME" });
    await person("PD");
    await leave(ids.PD, "PENDING");
    await person("AP");
    await leave(ids.AP, "APPROVED");
    await person("HF");
    await leave(ids.HF, "APPROVED", true);
    await person("BS");
    await leave(ids.BS, "APPROVED");
    await app.prisma.absence.create({
      data: {
        employeeId: ids.BS,
        type: "VOCATIONAL_SCHOOL",
        source: "MANUAL",
        startDate: day(WED),
        endDate: day(WED),
        days: 1,
        createdBy: "system",
      },
    });
    await person("HO", { salonId: salonB });
    await app.prisma.publicHoliday.create({
      data: {
        tenantId,
        salonId: salonB,
        date: day(WED),
        name: "Hausfeiertag t670",
        federalState: "NIEDERSACHSEN",
        year: 2026,
      },
    });
    await person("PR");
    await entry(ids.PR, "06:00", "09:00");
    await person("CI");
    await entry(ids.CI, "06:00", null);
    // INV: the ONLY entry of the day is invalid ("Urlaubsstornierung ausstehend" case).
    await person("INV");
    await entry(ids.INV, "06:00", "09:00", true);
    // PRE: hired on the Wednesday; EX: exited on the Tuesday.
    await person("PRE", { hireDate: day(WED) });
    await person("EX", { exitDate: day("2026-06-16") });
    // WE: a Mon-Sat contract (Saturday is a workday per workDays).
    await person("WE");
    await setSchedule(ids.WE, {
      workDays: [1, 2, 3, 4, 5, 6],
      saturdayHours: 4,
      weeklyHours: 44,
    });
    // CC: Mon-Fri until 30 Jun, Wed-Fri 6 h days from 1 Jul (month-first change in the week).
    await person("CC");
    await setSchedule(ids.CC, { workDays: [1, 2, 3, 4, 5] });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: ids.CC,
        type: "FIXED_SCHEDULE",
        weeklyHours: 18,
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 6,
        thursdayHours: 6,
        fridayHours: 6,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [3, 4, 5],
        validFrom: new Date("2026-06-30T22:00:00Z"),
      },
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, d.tenant.id);
    } catch (err) {
      console.error("my-week-open-items-parity-670 cleanup failed:", err);
    }
    await closeTestApp();
  });

  const PAST_WEEK_TAGS = [
    "FX",
    "FXS",
    "SB1",
    "SB0",
    "FL",
    "PD",
    "AP",
    "HF",
    "BS",
    "HO",
    "PR",
    "CI",
    "INV",
    "PRE",
    "EX",
    "WE",
  ];

  describe("a past week: my-week == team-week, open-items == the team week's missing days", () => {
    for (const tag of PAST_WEEK_TAGS) {
      it(`${tag}`, async () => {
        const v = await views(AT_MON_AFTER, WED, tag);
        expectWeekParity(tag, v.team, v.mine);
        const teamMissing = v.team.filter((c) => c.status === "missing").map((c) => c.date);
        // The one justified difference: a day with ONLY invalid entries is counted under
        // `invalidEntries`, not named a second time as a missing day.
        const expected = tag === "INV" ? teamMissing.filter((x) => x !== WED) : teamMissing;
        expect(v.open.missingDays, `${tag} missingDays`).toEqual(expected);
      });
    }
  });

  describe("named cells", () => {
    it("a requested vacation reads requested in my-week and is not a gap (B1)", async () => {
      const v = await views(AT_MON_AFTER, WED, "PD");
      expect(v.mine[2].status).toBe("requested");
      expect(v.team[2].status).toBe("requested");
      expect(v.open.missingDays).not.toContain(WED);
    });

    it("a day with only an invalid entry: Fehlt in the team week and my-week, no worked hours, excluded from the gap list (A2/B2)", async () => {
      const v = await views(AT_MON_AFTER, WED, "INV");
      expect(v.team[2].status).toBe("missing");
      expect(v.mine[2].status).toBe("missing");
      expect(v.mine[2].workedHours).toBe(0);
      expect(v.open.missingDays).not.toContain(WED);
      expect(v.open.invalidEntries).toBeGreaterThan(0);
    });

    // Issue #743 (owner decision 25.10.2026) replaced the #670 pin "half-day leave reads as leave,
    // no gap": a PAST half day without an entry is owed for the other half and now reads
    // "missing" in every reader. Today and a day with an entry are unchanged (half-day-missing-743).
    it("a past half-day leave without an entry is missing in every reader (B6, #743)", async () => {
      const v = await views(AT_MON_AFTER, WED, "HF");
      expect(v.mine[2].status).toBe("missing");
      expect(v.team[2].status).toBe("missing");
      expect(v.open.missingDays).toContain(WED);
    });

    it("the Berufsschule day displaces the vacation: absent, not leave", async () => {
      const v = await views(AT_MON_AFTER, WED, "BS");
      expect(v.mine[2].status).toBe("absent");
    });

    it("before the hire day and after the exit day nothing is missing (A4/AC-4)", async () => {
      const pre = await views(AT_MON_AFTER, WED, "PRE");
      expect(pre.mine.slice(0, 2).map((x) => x.status)).toEqual(["none", "none"]);
      expect(pre.open.missingDays).toEqual(["2026-06-17", "2026-06-18", "2026-06-19"]);
      const ex = await views(AT_MON_AFTER, WED, "EX");
      expect(ex.mine.slice(3, 5).map((x) => x.status)).toEqual(["none", "none"]);
      expect(ex.open.missingDays).toEqual(["2026-06-15", "2026-06-16"]);
    });

    it("a weekend day the contract owes is missing, not weekend (A5)", async () => {
      const v = await views(AT_MON_AFTER, WED, "WE");
      expect(v.mine[5]).toMatchObject({ date: "2026-06-20", status: "missing", isWorkday: true });
      expect(v.team[5].status).toBe("missing");
      expect(v.open.missingDays).toContain("2026-06-20");
      const fx = await views(AT_MON_AFTER, WED, "FX");
      expect(fx.mine[5].status).toBe("weekend");
      expect(fx.mine[6].status).toBe("weekend");
    });

    it("a holiday keeps the day a contract workday in isWorkday while the displayed Soll is 0 (A7)", async () => {
      const v = await views(AT_MON_AFTER, WED, "HO");
      expect(v.mine[2]).toMatchObject({ status: "holiday", isWorkday: true, expectedHours: 0 });
      expect(v.team[2].isWorkday).toBe(true);
    });

    it("a month-first contract change inside the week: every day by its own contract (A3/B3)", async () => {
      const v = await views(AT_JULY, "2026-07-01", "CC");
      expectWeekParity("CC", v.team, v.mine);
      // Mon/Tue by the Mon-Fri contract, Wed-Fri by the Wed-Fri contract: all five missing.
      expect(v.mine.slice(0, 5).map((x) => x.status)).toEqual(Array(5).fill("missing"));
      expect(v.mine[0].expectedHours).toBe(8);
      expect(v.mine[2].expectedHours).toBe(6);
      expect(v.open.missingDays).toEqual([
        "2026-06-29",
        "2026-06-30",
        "2026-07-01",
        "2026-07-02",
        "2026-07-03",
      ]);
    });
  });

  describe("today (Wed 12:00): my-week == attendance == team-week", () => {
    for (const tag of PAST_WEEK_TAGS) {
      it(`${tag}`, async () => {
        const v = await views(AT_WED_1200, WED, tag);
        expectWeekParity(tag, v.team, v.mine);
        const att = v.att.employees.find((r) => r.id === ids[tag]);
        if (att) {
          expect(att.status, `${tag} attendance`).toBe(v.team[2].status);
          expect(MAPPING[att.status]).toContain(v.mine[2].status);
        }
      });
    }

    it("a not-yet-due FIXED day is scheduled, a shift past its start is missing", async () => {
      const fx = await views(AT_WED_1200, WED, "FX");
      expect(fx.mine[2].status).toBe("scheduled");
      const fxs = await views(AT_WED_1200, WED, "FXS");
      expect(fxs.mine[2].status).toBe("missing");
      expect(fxs.open.missingDays).not.toContain(WED); // the window ends yesterday
    });
  });

  it("the matrix reached every shared status but 'none'-only gaps", () => {
    for (const s of [
      "clocked_in",
      "present",
      "requested",
      "absent",
      "holiday",
      "missing",
      "scheduled",
      "none",
    ]) {
      expect(observed.has(s), `status ${s} observed`).toBe(true);
    }
  });
});
