// Issue #840 (D-840-07/10/12) — the pure model behind the absence timeline: the period of a zoom,
// its day columns, and the adapter that turns the (masked) calendar answer into timeline rows.
//
// The adapter reads only `masked: true` / `isHoliday: true` of the answer, never a role (T-840-49):
// a masked bar has no type and the neutral word, whoever the reader is.

import { describe, it, expect } from "vitest";
import {
  calendarDayLoad,
  calendarRangeQuery,
  calendarToTimeline,
  dayColumns,
  dayMarkings,
  hasMixedWeek,
  isoWeekColumns,
  periodLabel,
  periodOf,
  plannerToTimeline,
  shiftPeriod,
  weekCells,
  weekLoad,
  workdaySet,
  type CalendarDetailedEntry,
  type CalendarHolidayEntry,
  type CalendarMaskedEntry,
  type TimelineBar,
  type TimelinePerson,
} from "../timeline-model";
import type { PlannerReadDto } from "$lib/leave-plan/types";
import { LEAVE_TYPES, NEUTRAL_CHIP_LABEL } from "../team-calendar-visibility";
import { ABSENT, leaveTypeColor } from "../leave-colors";

describe("periodOf", () => {
  it("the year contains the anchor day: 1 January to 31 December", () => {
    expect(periodOf("jahr", "2026-06-15")).toEqual({
      zoom: "jahr",
      year: 2026,
      startDay: "2026-01-01",
      endDay: "2026-12-31",
    });
  });

  it("the quarter: Q4 runs 1 October to 31 December, Q1 to 31 March, Q2 to 30 June", () => {
    expect(periodOf("quartal", "2026-11-08")).toMatchObject({
      zoom: "quartal",
      startDay: "2026-10-01",
      endDay: "2026-12-31",
    });
    expect(periodOf("quartal", "2026-01-31")).toMatchObject({
      startDay: "2026-01-01",
      endDay: "2026-03-31",
    });
    expect(periodOf("quartal", "2026-05-01")).toMatchObject({
      startDay: "2026-04-01",
      endDay: "2026-06-30",
    });
  });

  it("the month: February of a leap year has 29 days, of another year 28", () => {
    expect(periodOf("monat", "2028-02-10")).toMatchObject({
      zoom: "monat",
      year: 2028,
      startDay: "2028-02-01",
      endDay: "2028-02-29",
    });
    expect(periodOf("monat", "2026-02-10").endDay).toBe("2026-02-28");
    expect(periodOf("monat", "2026-12-31").endDay).toBe("2026-12-31");
  });
});

describe("dayColumns", () => {
  it("one column per day of the period with the German weekday letter and the day number", () => {
    // 2026-11-01 is a Sunday.
    const columns = dayColumns(periodOf("monat", "2026-11-15"));
    expect(columns).toHaveLength(30);
    expect(columns[0]).toEqual({
      day: "2026-11-01",
      weekdayLetter: "S",
      dayNumber: 1,
      isWeekend: true,
    });
    expect(columns.slice(0, 7).map((c) => c.weekdayLetter)).toEqual([
      "S",
      "M",
      "D",
      "M",
      "D",
      "F",
      "S",
    ]);
    expect(columns[29].dayNumber).toBe(30);
  });

  it("flags Saturday and Sunday as weekend, nothing else", () => {
    const columns = dayColumns(periodOf("monat", "2026-11-15"));
    const weekend = columns.filter((c) => c.isWeekend).map((c) => c.day);
    expect(weekend).toEqual([
      "2026-11-01",
      "2026-11-07",
      "2026-11-08",
      "2026-11-14",
      "2026-11-15",
      "2026-11-21",
      "2026-11-22",
      "2026-11-28",
      "2026-11-29",
    ]);
  });

  it("a year has 365 columns, a leap year 366", () => {
    expect(dayColumns(periodOf("jahr", "2026-03-01"))).toHaveLength(365);
    expect(dayColumns(periodOf("jahr", "2028-03-01"))).toHaveLength(366);
  });
});

const detailed = (over: Partial<CalendarDetailedEntry>): CalendarDetailedEntry => ({
  id: "req-1",
  isOwn: false,
  employeeId: "emp-a",
  firstName: "Anna",
  lastName: "Muster",
  typeCode: "VACATION",
  typeName: "Urlaub",
  startDate: "2026-11-02",
  endDate: "2026-11-04",
  halfDay: false,
  status: "APPROVED",
  isHoliday: false,
  ...over,
});

const masked = (over: Partial<CalendarMaskedEntry>): CalendarMaskedEntry => ({
  employeeId: "emp-b",
  firstName: "Bernd",
  lastName: "Beispiel",
  startDate: "2026-11-09",
  endDate: "2026-11-10",
  isOwn: false,
  masked: true,
  ...over,
});

const holiday: CalendarHolidayEntry = {
  id: "holiday-2026-11-01",
  isOwn: false,
  firstName: "Allerheiligen",
  lastName: "",
  typeCode: "HOLIDAY",
  typeName: "Allerheiligen",
  startDate: "2026-11-01",
  endDate: "2026-11-01",
  halfDay: false,
  status: "APPROVED",
  isHoliday: true,
};

describe("calendarToTimeline", () => {
  it("groups the entries by person: one row per absent person, one bar per absence", () => {
    const { rows } = calendarToTimeline([
      detailed({ id: "r1" }),
      detailed({ id: "r2", startDate: "2026-11-16", endDate: "2026-11-17" }),
      masked({}),
    ]);
    // Ordered by last name: "Beispiel" before "Muster".
    expect(rows.map((r) => r.employeeId)).toEqual(["emp-b", "emp-a"]);
    expect(rows[1].name).toBe("Anna Muster");
    expect(rows[1].bars.map((b) => b.key)).toEqual(["r1", "r2"]);
    expect(rows[0].bars).toHaveLength(1);
  });

  it("an APPROVED detailed request is a solid bar (gesetzt) with its type", () => {
    const { rows } = calendarToTimeline([detailed({ status: "APPROVED" })]);
    expect(rows[0].bars[0]).toMatchObject({
      key: "req-1",
      requestId: "req-1",
      start: "2026-11-02",
      end: "2026-11-04",
      style: "gesetzt",
      typeCode: "VACATION",
      label: "Urlaub",
    });
  });

  it("a PENDING detailed request is a dashed bar (beantragt)", () => {
    const { rows } = calendarToTimeline([detailed({ status: "PENDING", isOwn: true })]);
    expect(rows[0].bars[0].style).toBe("beantragt");
    expect(rows[0].isOwn).toBe(true);
  });

  it("a masked row is an abwesend bar: no type, the neutral label, the client key, no request id", () => {
    const { rows } = calendarToTimeline([masked({})]);
    const bar = rows[0].bars[0];
    expect(bar).toMatchObject({
      key: "masked:emp-b:2026-11-09",
      start: "2026-11-09",
      end: "2026-11-10",
      style: "abwesend",
      typeCode: null,
      label: NEUTRAL_CHIP_LABEL,
      editable: false,
    });
    expect(NEUTRAL_CHIP_LABEL).toBe("abwesend");
    expect(bar.requestId).toBeUndefined();
  });

  it("a masked bar leaks nothing of the type even if a stray field were present", () => {
    const stray = { ...masked({}), typeCode: "SICK", typeName: "Krankmeldung" } as never;
    const { rows } = calendarToTimeline([stray]);
    expect(rows[0].bars[0].typeCode).toBeNull();
    expect(rows[0].bars[0].label).toBe(NEUTRAL_CHIP_LABEL);
  });

  it("splits the holiday items into `holidays`; they make no row", () => {
    const { rows, holidays } = calendarToTimeline([holiday, detailed({})]);
    expect(holidays).toEqual([{ day: "2026-11-01", name: "Allerheiligen" }]);
    expect(rows.map((r) => r.employeeId)).toEqual(["emp-a"]);
  });

  it("an empty answer gives no rows and no holidays", () => {
    expect(calendarToTimeline([])).toEqual({ rows: [], holidays: [] });
  });

  it("a half day keeps its flag on the bar", () => {
    const { rows } = calendarToTimeline([detailed({ halfDay: true })]);
    expect(rows[0].bars[0].halfDay).toBe(true);
  });
});

describe("calendarRangeQuery", () => {
  it("is from/to of the period, in this order", () => {
    expect(calendarRangeQuery(periodOf("monat", "2026-11-08"))).toBe(
      "from=2026-11-01&to=2026-11-30",
    );
  });
});

describe("leaveTypeColor", () => {
  // The fill and the text token are asserted as separate strings: `leave-chip-contrast` Test 3
  // scans test files too and reads `fill: ... --leave-type-*-text` in one literal as a text
  // token used as a background.
  it("returns the fill token and its -text partner", () => {
    const color = leaveTypeColor("VACATION");
    expect(color.fill).toBe("--leave-type-vacation");
    expect(color.text).toBe("--leave-type-vacation-text");
  });

  it("null (no type) is the absent pair, an unknown code the default pair", () => {
    expect(leaveTypeColor(null)).toBe(ABSENT);
    expect(ABSENT.fill).toBe("--leave-type-absent");
    expect(ABSENT.text).toBe("--leave-type-absent-text");
    const unknown = leaveTypeColor("NOT_A_CODE");
    expect(unknown.fill).toBe("--leave-type-default");
    expect(unknown.text).toBe("--leave-type-default-text");
  });

  it("agrees with the calendar's own table for every code (one colour per type)", () => {
    for (const type of LEAVE_TYPES) {
      expect(leaveTypeColor(type.code).fill, type.code).toBe(type.colorVar);
      expect(leaveTypeColor(type.code).text, type.code).toBe(`${type.colorVar}-text`);
    }
  });
});

// ── Plan 840-05: ISO week grid, Werktage share, markings, load, planner adapter, labels ────

describe("isoWeekColumns", () => {
  it("has 53 columns for every year 2024-2045 except 2040, which has 54", () => {
    for (let year = 2024; year <= 2045; year++) {
      expect(isoWeekColumns(year), String(year)).toHaveLength(year === 2040 ? 54 : 53);
    }
  });

  it("starts on the Monday on/before 1 January and ends on the Sunday on/after 31 December", () => {
    // 1 January: Monday 2024, Thursday 2026, Saturday 2022, Sunday 2023.
    expect(isoWeekColumns(2024)[0].monday).toBe("2024-01-01");
    expect(isoWeekColumns(2026)[0].monday).toBe("2025-12-29");
    expect(isoWeekColumns(2022)[0].monday).toBe("2021-12-27");
    expect(isoWeekColumns(2023)[0].monday).toBe("2022-12-26");
    expect(isoWeekColumns(2024).at(-1)?.sunday).toBe("2025-01-05");
    expect(isoWeekColumns(2026).at(-1)?.sunday).toBe("2027-01-03");
  });

  it("numbers the weeks by ISO 8601; the first column of 2027 carries week 53", () => {
    expect(isoWeekColumns(2027)[0]).toMatchObject({ monday: "2026-12-28", isoWeek: 53 });
    expect(isoWeekColumns(2026)[0].isoWeek).toBe(1);
    expect(isoWeekColumns(2022)[0].isoWeek).toBe(52);
    expect(isoWeekColumns(2026)[1].isoWeek).toBe(2);
  });

  it("lists only the days inside the year per column; all columns together are the year", () => {
    const columns = isoWeekColumns(2026);
    expect(columns[0].daysInYear).toEqual(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"]);
    expect(isoWeekColumns(2023)[0].daysInYear).toEqual(["2023-01-01"]);
    expect(columns.flatMap((c) => c.daysInYear)).toHaveLength(365);
    expect(isoWeekColumns(2028).flatMap((c) => c.daysInYear)).toHaveLength(366);
  });

  it("every column runs Monday to Sunday and the columns are consecutive", () => {
    const columns = isoWeekColumns(2040);
    columns.forEach((column, i) => {
      expect(dayColumns(periodOf("monat", column.monday)).length).toBeGreaterThan(0);
      const next = columns[i + 1];
      if (!next) return;
      const sunday = new Date(`${column.sunday}T00:00:00Z`).getTime();
      const monday = new Date(`${next.monday}T00:00:00Z`).getTime();
      expect(monday - sunday).toBe(86_400_000);
      expect(new Date(`${column.monday}T00:00:00Z`).getUTCDay()).toBe(1);
    });
  });
});

describe("workdaySet", () => {
  it("is Monday to Saturday without a single salon (§ 3 Abs. 2 BUrlG)", () => {
    expect([...workdaySet(null)].sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("is the seven weekdays minus the closed ones", () => {
    expect([...workdaySet(new Set([6]))].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect([...workdaySet(new Set([0, 6]))].sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

const bar = (over: Partial<TimelineBar>): TimelineBar => ({
  key: "b",
  start: "2026-11-02",
  end: "2026-11-06",
  style: "gesetzt",
  typeCode: "VACATION",
  label: "Urlaub",
  editable: false,
  ...over,
});

const personWith = (bars: TimelineBar[], id = "e1"): TimelinePerson => ({
  employeeId: id,
  name: id,
  isOwn: false,
  bars,
});

const MON_SAT = workdaySet(null);

function cellOf(person: TimelinePerson, year: number, monday: string) {
  const cell = weekCells(person, year, MON_SAT, []).find((c) => c.monday === monday);
  if (!cell) throw new Error(`no week ${monday}`);
  return cell;
}

describe("weekCells", () => {
  it("a full vacation week Monday to Friday over Werktage Monday to Saturday is 5/6", () => {
    const cell = cellOf(personWith([bar({})]), 2026, "2026-11-02");
    expect(cell.share).toBeCloseTo(5 / 6, 10);
    expect(cell.outOfYearDays).toBe(0);
  });

  it("a holiday on Wednesday is no Werktag: 4/5", () => {
    const holidays = [{ day: "2026-11-04", name: "Feiertag" }];
    const cell = weekCells(personWith([bar({})]), 2026, MON_SAT, holidays).find(
      (c) => c.monday === "2026-11-02",
    );
    expect(cell?.share).toBeCloseTo(4 / 5, 10);
  });

  it("a partial edge week: 3 in-year Werktage, 2 absent -> 2/3, 4 days outside the year", () => {
    // 31 December 2025 is a Wednesday: the last week of 2025 has Mon-Wed inside the year.
    const person = personWith([bar({ start: "2025-12-29", end: "2025-12-30" })]);
    const cell = cellOf(person, 2025, "2025-12-29");
    expect(cell.share).toBeCloseTo(2 / 3, 10);
    expect(cell.outOfYearDays).toBe(4);
  });

  it("days outside the year are excluded from the share", () => {
    // The bar covers all of the week 29 Dec - 4 Jan; for 2025 only Mon-Wed count.
    const person = personWith([bar({ start: "2025-12-29", end: "2026-01-04" })]);
    expect(cellOf(person, 2025, "2025-12-29").share).toBe(1);
  });

  it("a week without any absence has share 0 and no fill", () => {
    const cell = cellOf(personWith([bar({})]), 2026, "2026-11-09");
    expect(cell).toMatchObject({ share: 0, fill: null, typeCode: null });
  });

  it("only one visible type in the week: fill type with that code", () => {
    const cell = cellOf(personWith([bar({})]), 2026, "2026-11-02");
    expect(cell).toMatchObject({ fill: "type", typeCode: "VACATION" });
  });

  it("two types in the week (sick and vacation): the mixed fill, no single type", () => {
    // #840 G-4: a week with several visible types has its own look; masked stays absent
    const person = personWith([
      bar({ key: "a", start: "2026-11-02", end: "2026-11-03" }),
      bar({ key: "b", start: "2026-11-04", end: "2026-11-04", typeCode: "SICK" }),
    ]);
    expect(cellOf(person, 2026, "2026-11-02")).toMatchObject({ fill: "mixed", typeCode: null });
  });

  it("a masked bar and a visible bar in the same week stay absent, never mixed (T-840-17)", () => {
    // #840 G-4: nothing about a hidden type may be inferred from the look of the week
    const person = personWith([
      bar({ key: "a", start: "2026-11-02", end: "2026-11-03" }),
      bar({
        key: "m",
        start: "2026-11-04",
        end: "2026-11-04",
        style: "abwesend",
        typeCode: null,
      }),
    ]);
    expect(cellOf(person, 2026, "2026-11-02")).toMatchObject({ fill: "absent", typeCode: null });
  });

  it("a wish never changes the fill of a week", () => {
    const person = personWith([
      bar({ key: "a", start: "2026-11-02", end: "2026-11-03" }),
      bar({ key: "w", style: "wunsch", typeCode: null, start: "2026-11-04", end: "2026-11-05" }),
    ]);
    expect(cellOf(person, 2026, "2026-11-02")).toMatchObject({
      fill: "type",
      typeCode: "VACATION",
    });
  });

  it("a masked bar gives the neutral absent fill and no type", () => {
    const person = personWith([bar({ style: "abwesend", typeCode: null })]);
    expect(cellOf(person, 2026, "2026-11-02")).toMatchObject({ fill: "absent", typeCode: null });
  });

  it("a half day counts as half a Werktag", () => {
    const person = personWith([bar({ start: "2026-11-02", end: "2026-11-02", halfDay: true })]);
    expect(cellOf(person, 2026, "2026-11-02").share).toBeCloseTo(0.5 / 6, 10);
  });

  it("flags a requested bar and a wish in the week; a wish is not absence", () => {
    const person = personWith([
      bar({ key: "r", style: "beantragt", start: "2026-11-02", end: "2026-11-02" }),
      bar({ key: "w", style: "wunsch", typeCode: null, start: "2026-11-10", end: "2026-11-12" }),
    ]);
    expect(cellOf(person, 2026, "2026-11-02")).toMatchObject({
      hasBeantragt: true,
      hasWish: false,
    });
    const wishWeek = cellOf(person, 2026, "2026-11-09");
    expect(wishWeek).toMatchObject({ hasBeantragt: false, hasWish: true, share: 0, fill: null });
  });
});

describe("hasMixedWeek", () => {
  const mixed = personWith([
    bar({ key: "a", start: "2026-11-02", end: "2026-11-03" }),
    bar({ key: "b", start: "2026-11-04", end: "2026-11-04", typeCode: "SICK" }),
  ]);
  const masked = personWith(
    [
      bar({ style: "abwesend", typeCode: null }),
      bar({ key: "x", start: "2026-11-09", end: "2026-11-09" }),
    ],
    "e2",
  );
  const single = personWith([bar({})], "e3");

  it("is true when a person has a week with two visible types", () => {
    expect(hasMixedWeek([single, mixed], 2026, MON_SAT, [])).toBe(true);
  });

  it("is false for single-type and masked weeks only", () => {
    expect(hasMixedWeek([single, masked], 2026, MON_SAT, [])).toBe(false);
  });

  it("is false for an empty set", () => {
    expect(hasMixedWeek([], 2026, MON_SAT, [])).toBe(false);
  });
});

describe("dayMarkings", () => {
  it("marks weekend, holiday with its name, closed weekday and today", () => {
    const marks = dayMarkings(periodOf("monat", "2026-11-15"), {
      holidays: [{ day: "2026-11-04", name: "Feiertag" }],
      closedWeekdays: new Set([0]),
      today: "2026-11-10",
    });
    expect(marks.get("2026-11-07")).toMatchObject({ weekend: true, closed: false });
    expect(marks.get("2026-11-08")?.weekend).toBe(true);
    expect(marks.get("2026-11-04")).toMatchObject({ holidayName: "Feiertag", weekend: false });
    // Monday is weekday index 0 = closed.
    expect(marks.get("2026-11-02")?.closed).toBe(true);
    expect(marks.get("2026-11-03")?.closed).toBe(false);
    expect(marks.get("2026-11-10")?.today).toBe(true);
    expect(marks.get("2026-11-11")?.today).toBe(false);
    expect(marks.get("2026-11-11")?.holidayName).toBeNull();
    expect(marks.size).toBe(30);
  });

  it("no single salon (null) closes nothing", () => {
    const marks = dayMarkings(periodOf("monat", "2026-11-15"), {
      holidays: [],
      closedWeekdays: null,
      today: "2026-01-01",
    });
    expect([...marks.values()].some((m) => m.closed)).toBe(false);
  });
});

describe("calendarDayLoad and weekLoad", () => {
  const days = dayColumns(periodOf("monat", "2026-11-15")).map((c) => c.day);

  it("counts a person with two overlapping bars once; wishes are not counted", () => {
    const rows = [
      personWith([
        bar({ key: "a", start: "2026-11-02", end: "2026-11-03" }),
        bar({ key: "b", start: "2026-11-03", end: "2026-11-04", typeCode: "SICK" }),
        bar({ key: "w", style: "wunsch", start: "2026-11-10", end: "2026-11-10" }),
      ]),
      personWith([bar({ key: "c", start: "2026-11-03", end: "2026-11-03" })], "e2"),
    ];
    const load = calendarDayLoad(rows, days);
    expect(load.get("2026-11-02")).toBe(1);
    expect(load.get("2026-11-03")).toBe(2);
    expect(load.get("2026-11-04")).toBe(1);
    expect(load.get("2026-11-10")).toBeUndefined();
  });

  it("weekLoad counts a person absent on at least one Werktag once, keyed by the Monday", () => {
    const rows = [
      personWith([bar({ start: "2026-11-02", end: "2026-11-06" })]),
      personWith([bar({ start: "2026-11-06", end: "2026-11-06" })], "e2"),
      // Sunday only: no Werktag, no load.
      personWith([bar({ start: "2026-11-08", end: "2026-11-08" })], "e3"),
    ];
    const load = weekLoad(rows, 2026, MON_SAT, []);
    expect(load.get("2026-11-02")).toBe(2);
    expect(load.get("2026-11-09")).toBeUndefined();
  });
});

describe("plannerToTimeline", () => {
  const dto = (persons: PlannerReadDto["persons"]): PlannerReadDto => ({
    plan: {
      id: "p1",
      salonId: "s1",
      year: 2027,
      deadline: null,
      status: "OPEN",
      openedAt: "2027-01-01T00:00:00.000Z",
      takenOverAt: null,
      deadlinePassed: false,
      deadlineLocksWishes: false,
      partiallyTakenOver: false,
      openWishCount: null,
    },
    salon: { id: "s1", name: "Salon", openingHours: [] },
    viewer: { employeeId: "e1", canManage: false, canWishOwn: true, ownEditLocked: false },
    persons,
    holidays: [{ date: "2027-01-01", name: "Neujahr" }],
    dayLoad: [],
  });

  const plannerPerson = (over: Partial<PlannerReadDto["persons"][number]> = {}) => ({
    employeeId: "e1",
    firstName: "Alex",
    lastName: "Muster",
    homeRanges: [{ from: "2027-01-01", to: "2027-12-31" }],
    rows: [],
    wishes: [],
    forecast: null,
    ...over,
  });

  const row = (over: Partial<PlannerReadDto["persons"][number]["rows"][number]>) => ({
    kind: "LEAVE" as const,
    state: "GESETZT" as const,
    startDate: "2027-02-01",
    endDate: "2027-02-05",
    halfDay: false,
    typeCode: "VACATION" as string | null,
    ...over,
  });

  const wish = (over: Partial<PlannerReadDto["persons"][number]["wishes"][number]> = {}) => ({
    id: "w1",
    planId: "p1",
    startDate: "2027-03-08",
    endDate: "2027-03-12",
    halfDay: false,
    foreignPlan: false,
    conflict: false,
    leaveRequestId: null,
    leaveRequestStatus: null,
    refusalCode: null,
    refusalMessage: null,
    editable: true,
    createdAt: "2027-01-01T00:00:00.000Z",
    ...over,
  });

  it("maps every kind and state of a row", () => {
    const { rows, holidays } = plannerToTimeline(
      dto([
        plannerPerson({
          rows: [
            row({}),
            row({ state: "BEANTRAGT", startDate: "2027-04-05", endDate: "2027-04-06" }),
            row({ kind: "ABSENCE", typeCode: "VOCATIONAL_SCHOOL", startDate: "2027-05-03" }),
            row({ kind: "COMPANY_SHUTDOWN", typeCode: null, startDate: "2027-12-27" }),
            row({ kind: "MASKED", state: "ABWESEND", typeCode: null, startDate: "2027-06-07" }),
          ],
        }),
      ]),
    );
    expect(holidays).toEqual([{ day: "2027-01-01", name: "Neujahr" }]);
    const bars = rows[0].bars;
    expect(bars.map((b) => b.style)).toEqual([
      "gesetzt",
      "beantragt",
      "gesetzt",
      "gesetzt",
      "abwesend",
    ]);
    expect(bars[0]).toMatchObject({ typeCode: "VACATION", label: "Urlaub", editable: false });
    expect(bars[3].label).toBe("Betriebsurlaub");
    expect(new Set(bars.map((b) => b.key)).size).toBe(5);
  });

  it("a MASKED row has no type and the neutral label, even with a stray typeCode", () => {
    const { rows } = plannerToTimeline(
      dto([
        plannerPerson({
          rows: [row({ kind: "MASKED", state: "ABWESEND", typeCode: "SICK" })],
        }),
      ]),
    );
    expect(rows[0].bars[0]).toMatchObject({
      style: "abwesend",
      typeCode: null,
      label: NEUTRAL_CHIP_LABEL,
      editable: false,
    });
  });

  it("a wish is a wunsch bar keyed by its id; editable, conflict and hints come from the server", () => {
    const { rows } = plannerToTimeline(
      dto([
        plannerPerson({
          wishes: [
            wish({ conflict: true }),
            wish({ id: "w2", foreignPlan: true, editable: false }),
            wish({ id: "w3", leaveRequestId: "lr", editable: true }),
          ],
        }),
      ]),
    );
    const [w1, w2, w3] = rows[0].bars;
    expect(w1).toMatchObject({
      key: "w1",
      style: "wunsch",
      editable: true,
      conflict: true,
      start: "2027-03-08",
    });
    expect(w1.hint).toContain("Überschneidet sich");
    expect(w2).toMatchObject({ editable: false, foreignPlan: true });
    expect(w2.hint).toContain("anderen Planung");
    // A taken-over wish is not editable whatever the server said.
    expect(w3.editable).toBe(false);
    expect(w3.hint).toContain("Übernommen");
  });

  it("takes forecast, own flag and the outside ranges from the person", () => {
    const { rows } = plannerToTimeline(
      dto([
        plannerPerson({
          homeRanges: [{ from: "2027-03-01", to: "2027-09-30" }],
          forecast: {
            entitlementBasis: "STORED",
            remainingDays: 10,
            pendingDays: 0,
            wishDays: 5,
            forecastDays: -2,
            forecastNegative: true,
          },
        }),
        plannerPerson({ employeeId: "e2" }),
      ]),
    );
    expect(rows[0].isOwn).toBe(true);
    expect(rows[1].isOwn).toBe(false);
    expect(rows[0].name).toBe("Alex Muster");
    expect(rows[0].forecast).toEqual({ forecastDays: -2, forecastNegative: true });
    expect(rows[1].forecast).toBeNull();
    expect(rows[0].outsideRanges).toEqual([
      { start: "2027-01-01", end: "2027-02-28" },
      { start: "2027-10-01", end: "2027-12-31" },
    ]);
    expect(rows[1].outsideRanges).toEqual([]);
  });

  it("a person without any Stammsalon day is outside for the whole year", () => {
    const { rows } = plannerToTimeline(dto([plannerPerson({ homeRanges: [] })]));
    expect(rows[0].outsideRanges).toEqual([{ start: "2027-01-01", end: "2027-12-31" }]);
  });
});

describe("periodLabel and shiftPeriod", () => {
  it("labels year, quarter and month", () => {
    expect(periodLabel(periodOf("jahr", "2026-06-01"))).toBe("2026");
    expect(periodLabel(periodOf("quartal", "2026-11-10"))).toBe("Q4 2026 · Okt–Dez");
    expect(periodLabel(periodOf("quartal", "2026-02-10"))).toBe("Q1 2026 · Jan–Mär");
    expect(periodLabel(periodOf("monat", "2026-11-10"))).toBe("November 2026");
  });

  it("steps by one period; the new anchor lies in the neighbouring period", () => {
    const q = periodOf("quartal", shiftPeriod("quartal", "2026-11-10", 1));
    expect(q).toMatchObject({ startDay: "2027-01-01", endDay: "2027-03-31" });
    const m = periodOf("monat", shiftPeriod("monat", "2026-01-31", -1));
    expect(m).toMatchObject({ startDay: "2025-12-01", endDay: "2025-12-31" });
    expect(periodOf("jahr", shiftPeriod("jahr", "2026-06-15", 1)).year).toBe(2027);
    expect(periodOf("jahr", shiftPeriod("jahr", "2026-06-15", -1)).year).toBe(2025);
    expect(periodOf("monat", shiftPeriod("monat", "2026-12-31", 1))).toMatchObject({
      startDay: "2027-01-01",
    });
  });
});
