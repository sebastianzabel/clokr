// Issue #840 (D-840-07/10/12) — the pure model behind the absence timeline: the period of a zoom,
// its day columns, and the adapter that turns the (masked) calendar answer into timeline rows.
//
// The adapter reads only `masked: true` / `isHoliday: true` of the answer, never a role (T-840-49):
// a masked bar has no type and the neutral word, whoever the reader is.

import { describe, it, expect } from "vitest";
import {
  calendarRangeQuery,
  calendarToTimeline,
  dayColumns,
  periodOf,
  type CalendarDetailedEntry,
  type CalendarHolidayEntry,
  type CalendarMaskedEntry,
} from "../timeline-model";
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
  it("returns the fill token and its -text partner", () => {
    expect(leaveTypeColor("VACATION")).toEqual({
      fill: "--leave-type-vacation",
      text: "--leave-type-vacation-text",
    });
  });

  it("null (no type) and an unknown code give the absent pair / the default pair", () => {
    expect(leaveTypeColor(null)).toEqual(ABSENT);
    expect(ABSENT).toEqual({ fill: "--leave-type-absent", text: "--leave-type-absent-text" });
    expect(leaveTypeColor("NOT_A_CODE")).toEqual({
      fill: "--leave-type-default",
      text: "--leave-type-default-text",
    });
  });

  it("agrees with the calendar's own table for every code (one colour per type)", () => {
    for (const type of LEAVE_TYPES) {
      expect(leaveTypeColor(type.code).fill, type.code).toBe(type.colorVar);
      expect(leaveTypeColor(type.code).text, type.code).toBe(`${type.colorVar}-text`);
    }
  });
});
