/**
 * Issue #840 (D-840-19) — the masking kernel of `GET /leave/calendar` and the per-person day walk
 * of the visibility rule. Pure, no database.
 */
import { describe, expect, it } from "vitest";
import {
  clipDayRange,
  maskCalendarRows,
  mergeDayRanges,
  type MaskableCalendarRow,
} from "../leave-calendar-masking";
import { isPersonVisibleOnSomeDay, readerVisibilityFrom } from "../leave-limits/redact";

const EFFECTIVE = new Set(["APPROVED", "CANCELLATION_REQUESTED"]);

function row(
  employeeId: string,
  startDate: string,
  endDate: string,
  status = "APPROVED",
  extra: Partial<MaskableCalendarRow> & { halfDay?: boolean } = {},
) {
  return {
    id: `${employeeId}-${startDate}`,
    employeeId,
    firstName: "Vor",
    lastName: employeeId,
    startDate,
    endDate,
    status,
    isOwn: false,
    typeCode: "SICK",
    halfDay: false,
    ...extra,
  };
}

const MASKED_KEYS = [
  "employeeId",
  "endDate",
  "firstName",
  "isOwn",
  "lastName",
  "masked",
  "startDate",
];

describe("maskCalendarRows", () => {
  it("passes a detailed row through unchanged", () => {
    const r = row("p1", "2026-06-01", "2026-06-03");
    const { detailed, masked } = maskCalendarRows([r], () => true, EFFECTIVE);
    expect(detailed).toEqual([r]);
    expect(detailed[0]).toBe(r);
    expect(masked).toEqual([]);
  });

  it("turns a foreign APPROVED row into the exact seven-key masked shape", () => {
    const { detailed, masked } = maskCalendarRows(
      [row("p1", "2026-06-01", "2026-06-03")],
      () => false,
      EFFECTIVE,
    );
    expect(detailed).toEqual([]);
    expect(masked).toHaveLength(1);
    expect(Object.keys(masked[0]).sort()).toEqual(MASKED_KEYS);
    expect(masked[0]).toEqual({
      employeeId: "p1",
      firstName: "Vor",
      lastName: "p1",
      startDate: "2026-06-01",
      endDate: "2026-06-03",
      isOwn: false,
      masked: true,
    });
  });

  it("drops a foreign PENDING row (not yet an absence)", () => {
    const { detailed, masked } = maskCalendarRows(
      [row("p1", "2026-06-01", "2026-06-03", "PENDING")],
      () => false,
      EFFECTIVE,
    );
    expect(detailed).toEqual([]);
    expect(masked).toEqual([]);
  });

  it("keeps a PENDING row that is detailed", () => {
    const pending = row("p1", "2026-06-01", "2026-06-03", "PENDING");
    const { detailed } = maskCalendarRows([pending], () => true, EFFECTIVE);
    expect(detailed).toEqual([pending]);
  });

  it("merges overlapping masked ranges of one person", () => {
    const { masked } = maskCalendarRows(
      [row("p1", "2026-06-05", "2026-06-10"), row("p1", "2026-06-08", "2026-06-12")],
      () => false,
      EFFECTIVE,
    );
    expect(masked.map((m) => [m.startDate, m.endDate])).toEqual([["2026-06-05", "2026-06-12"]]);
  });

  it("merges touching masked ranges (end + 1 day = next start), also across a month change", () => {
    const { masked } = maskCalendarRows(
      [row("p1", "2026-06-25", "2026-06-30"), row("p1", "2026-07-01", "2026-07-03")],
      () => false,
      EFFECTIVE,
    );
    expect(masked.map((m) => [m.startDate, m.endDate])).toEqual([["2026-06-25", "2026-07-03"]]);
  });

  it("merges a half-day row next to a full-day row (the half day leaves no seam)", () => {
    const { masked } = maskCalendarRows(
      [
        row("p1", "2026-06-01", "2026-06-02"),
        row("p1", "2026-06-03", "2026-06-03", "APPROVED", { halfDay: true }),
      ],
      () => false,
      EFFECTIVE,
    );
    expect(masked.map((m) => [m.startDate, m.endDate])).toEqual([["2026-06-01", "2026-06-03"]]);
  });

  it("keeps two ranges when one day lies between them", () => {
    const { masked } = maskCalendarRows(
      [row("p1", "2026-06-01", "2026-06-02"), row("p1", "2026-06-04", "2026-06-05")],
      () => false,
      EFFECTIVE,
    );
    expect(masked.map((m) => [m.startDate, m.endDate])).toEqual([
      ["2026-06-01", "2026-06-02"],
      ["2026-06-04", "2026-06-05"],
    ]);
  });

  it("never merges two persons, and orders by employee then start", () => {
    const { masked } = maskCalendarRows(
      [
        row("p2", "2026-06-01", "2026-06-05"),
        row("p1", "2026-06-04", "2026-06-06"),
        row("p1", "2026-06-01", "2026-06-02"),
      ],
      () => false,
      EFFECTIVE,
    );
    expect(masked.map((m) => [m.employeeId, m.startDate, m.endDate])).toEqual([
      ["p1", "2026-06-01", "2026-06-02"],
      ["p1", "2026-06-04", "2026-06-06"],
      ["p2", "2026-06-01", "2026-06-05"],
    ]);
  });

  it("does not mutate its input and does not let a merge swallow a longer first range", () => {
    const first = row("p1", "2026-06-01", "2026-06-20");
    const second = row("p1", "2026-06-05", "2026-06-06");
    const { masked } = maskCalendarRows([first, second], () => false, EFFECTIVE);
    expect(masked.map((m) => [m.startDate, m.endDate])).toEqual([["2026-06-01", "2026-06-20"]]);
    expect(first.endDate).toBe("2026-06-20");
  });
});

describe("isPersonVisibleOnSomeDay", () => {
  const S1 = "salon-1";
  const S2 = "salon-2";
  const days = new Map<string, string | null>([
    ["2026-06-01", S2],
    ["2026-06-02", S2],
    ["2026-06-03", S1],
    ["2026-06-04", null],
  ]);

  it("answers true for a whole-tenant reach without looking at days", () => {
    const v = readerVisibilityFrom({ kind: "wholeTenant" }, null);
    expect(isPersonVisibleOnSomeDay(v, "p", undefined, "2026-06-01", "2026-06-02")).toBe(true);
  });

  it("answers true for a PERSONS grant and for the reader's own record without days", () => {
    const v = readerVisibilityFrom({ kind: "scoped", salonIds: [], employeeIds: ["p"] }, "me");
    expect(isPersonVisibleOnSomeDay(v, "p", undefined, "2026-06-01", "2026-06-02")).toBe(true);
    expect(isPersonVisibleOnSomeDay(v, "me", undefined, "2026-06-01", "2026-06-02")).toBe(true);
    expect(isPersonVisibleOnSomeDay(v, "other", undefined, "2026-06-01", "2026-06-02")).toBe(false);
  });

  it("for a SALONS grant is true only when some day of the range maps to a salon of the grant", () => {
    const v = readerVisibilityFrom({ kind: "scoped", salonIds: [S1], employeeIds: [] }, "me");
    expect(isPersonVisibleOnSomeDay(v, "p", days, "2026-06-01", "2026-06-02")).toBe(false);
    expect(isPersonVisibleOnSomeDay(v, "p", days, "2026-06-01", "2026-06-03")).toBe(true);
    expect(isPersonVisibleOnSomeDay(v, "p", days, "2026-06-03", "2026-06-03")).toBe(true);
  });

  it("never matches a null or missing day (fail-closed)", () => {
    const v = readerVisibilityFrom({ kind: "scoped", salonIds: [S1], employeeIds: [] }, "me");
    expect(isPersonVisibleOnSomeDay(v, "p", days, "2026-06-04", "2026-06-04")).toBe(false);
    expect(isPersonVisibleOnSomeDay(v, "p", days, "2026-06-10", "2026-06-12")).toBe(false);
    expect(isPersonVisibleOnSomeDay(v, "p", undefined, "2026-06-03", "2026-06-03")).toBe(false);
  });

  it("a scoped reach without any salon or person sees nobody but itself", () => {
    const v = readerVisibilityFrom({ kind: "scoped", salonIds: [], employeeIds: [] }, "me");
    expect(isPersonVisibleOnSomeDay(v, "p", days, "2026-06-01", "2026-06-04")).toBe(false);
    expect(isPersonVisibleOnSomeDay(v, "me", days, "2026-06-01", "2026-06-04")).toBe(true);
  });
});

describe("mergeDayRanges (shared by the calendar and the planner, D-840-20)", () => {
  it("returns an empty list for no ranges", () => {
    expect(mergeDayRanges([])).toEqual([]);
  });

  it("merges overlapping and touching ranges and keeps a gap of one day apart", () => {
    expect(
      mergeDayRanges([
        { startDate: "2026-06-08", endDate: "2026-06-10" },
        { startDate: "2026-06-01", endDate: "2026-06-03" },
        { startDate: "2026-06-04", endDate: "2026-06-05" },
        { startDate: "2026-06-02", endDate: "2026-06-02" },
      ]),
    ).toEqual([
      { startDate: "2026-06-01", endDate: "2026-06-05" },
      { startDate: "2026-06-08", endDate: "2026-06-10" },
    ]);
  });

  it("touches across a month and a year boundary", () => {
    expect(
      mergeDayRanges([
        { startDate: "2026-12-30", endDate: "2026-12-31" },
        { startDate: "2027-01-01", endDate: "2027-01-02" },
      ]),
    ).toEqual([{ startDate: "2026-12-30", endDate: "2027-01-02" }]);
  });

  it("strips every other key and does not mutate its input", () => {
    const input = [{ startDate: "2026-06-01", endDate: "2026-06-02", id: "x", typeCode: "SICK" }];
    const out = mergeDayRanges(input);
    expect(Object.keys(out[0]).sort()).toEqual(["endDate", "startDate"]);
    expect(input[0].endDate).toBe("2026-06-02");
  });
});

describe("clipDayRange and the window of maskCalendarRows (review WR-03)", () => {
  const WINDOW = { from: "2026-06-01", to: "2026-06-30" };

  it("clips a range to the window and drops one wholly outside", () => {
    expect(clipDayRange({ startDate: "2026-05-20", endDate: "2026-07-10" }, WINDOW)).toEqual({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
    });
    expect(clipDayRange({ startDate: "2026-06-10", endDate: "2026-06-12" }, WINDOW)).toEqual({
      startDate: "2026-06-10",
      endDate: "2026-06-12",
    });
    expect(clipDayRange({ startDate: "2026-07-01", endDate: "2026-07-05" }, WINDOW)).toBeNull();
    expect(clipDayRange({ startDate: "2026-05-01", endDate: "2026-05-31" }, WINDOW)).toBeNull();
  });

  it("a masked 200-day row and a one-month window give a range equal to the window", () => {
    const { masked } = maskCalendarRows(
      [row("p1", "2026-03-01", "2026-09-16")],
      () => false,
      EFFECTIVE,
      WINDOW,
    );
    expect(masked).toHaveLength(1);
    expect(masked[0]).toMatchObject({ startDate: "2026-06-01", endDate: "2026-06-30" });
  });

  it("clips before the merge, so a gap outside the window leaves no trace", () => {
    const { masked } = maskCalendarRows(
      [row("p1", "2026-05-25", "2026-06-02"), row("p1", "2026-06-29", "2026-07-04")],
      () => false,
      EFFECTIVE,
      WINDOW,
    );
    expect(masked.map((m) => [m.startDate, m.endDate])).toEqual([
      ["2026-06-01", "2026-06-02"],
      ["2026-06-29", "2026-06-30"],
    ]);
  });

  it("does not clip a detailed row", () => {
    const r = row("p1", "2026-05-20", "2026-07-10");
    const { detailed } = maskCalendarRows([r], () => true, EFFECTIVE, WINDOW);
    expect(detailed[0]).toBe(r);
  });
});
