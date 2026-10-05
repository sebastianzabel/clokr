/**
 * Issue #481 (R1, D-01, D-07, PD-01) — pure, DB-free kernel tests for the segment-aware
 * SHIFT_BASED pricing functions added by plan 481-01: `countShiftBasedLeaveDaysBySegments`,
 * `contractSegmentAt`.
 *
 * Every date is a fixed UTC `Date` literal (`new Date("YYYY-MM-DDT00:00:00.000Z")`) — no
 * calendar-relative anchors, no time bomb. Holiday sets are UTC "YYYY-MM-DD" strings, matching
 * `getHolidayMap()`'s own key format.
 *
 * Golden values are the owner-measured prod cases from #481 (Contract A, Contract B) plus the
 * planner-derived D-07/PD-01 boundary cases from 481-01-PLAN.md's <behavior> section.
 */
import { describe, it, expect } from "vitest";
import {
  countShiftBasedLeaveDaysBySegments,
  contractSegmentAt,
  type ShiftLeavePricingSegment,
} from "../vacation-calc";

function d(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

// Contract A (#481 golden case): 5 days Mo-Fr (usual Mo-Fr) until 31.07.2026, 4 days Di-Fr
// (usual Di-Fr) from 01.08.2026.
const CONTRACT_A: ShiftLeavePricingSegment[] = [
  { from: d("2025-09-01"), workDaysPerWeek: 5, usualWorkDays: [1, 2, 3, 4, 5] },
  { from: d("2026-08-01"), workDaysPerWeek: 4, usualWorkDays: [2, 3, 4, 5] },
];
const CONTRACT_A0: ShiftLeavePricingSegment[] = [
  { from: d("2025-09-01"), workDaysPerWeek: 5, usualWorkDays: [] },
  { from: d("2026-08-01"), workDaysPerWeek: 4, usualWorkDays: [] },
];

// Contract B (#481 golden case): 4 days Di-Fr since 18.05.2026 with usual Di-Fr.
const CONTRACT_B_SINGLE_ANGABE: ShiftLeavePricingSegment[] = [
  { from: d("2026-05-18"), workDaysPerWeek: 4, usualWorkDays: [2, 3, 4, 5] },
];
const CONTRACT_B_SINGLE_NO_ANGABE: ShiftLeavePricingSegment[] = [
  { from: d("2026-05-18"), workDaysPerWeek: 4, usualWorkDays: [] },
];

describe("countShiftBasedLeaveDaysBySegments (Issue #481, R1/D-01/D-07)", () => {
  it("Contract A, straddling week 27.07.-01.08.2026: 5 with Angabe, 6 without", () => {
    const withAngabe = countShiftBasedLeaveDaysBySegments(
      d("2026-07-27"),
      d("2026-08-01"),
      false,
      CONTRACT_A,
      new Set(),
    );
    expect(withAngabe.days).toBe(5);
    const withoutAngabe = countShiftBasedLeaveDaysBySegments(
      d("2026-07-27"),
      d("2026-08-01"),
      false,
      CONTRACT_A0,
      new Set(),
    );
    expect(withoutAngabe.days).toBe(6);
  });

  it("Contract A, straddling week 30.07.-04.08.2026: 3 with Angabe, 5 without", () => {
    const withAngabe = countShiftBasedLeaveDaysBySegments(
      d("2026-07-30"),
      d("2026-08-04"),
      false,
      CONTRACT_A,
      new Set(),
    );
    expect(withAngabe.days).toBe(3);
    const withoutAngabe = countShiftBasedLeaveDaysBySegments(
      d("2026-07-30"),
      d("2026-08-04"),
      false,
      CONTRACT_A0,
      new Set(),
    );
    expect(withoutAngabe.days).toBe(5);
  });

  it("single segment (Contract B, 4 days Di-Fr, usual Di-Fr): 12.06.-28.06. -> 9, 31.08.-15.09. -> 9", () => {
    const r1 = countShiftBasedLeaveDaysBySegments(
      d("2026-06-12"),
      d("2026-06-28"),
      false,
      CONTRACT_B_SINGLE_ANGABE,
      new Set(),
    );
    expect(r1.days).toBe(9);
    const r2 = countShiftBasedLeaveDaysBySegments(
      d("2026-08-31"),
      d("2026-09-15"),
      false,
      CONTRACT_B_SINGLE_ANGABE,
      new Set(),
    );
    expect(r2.days).toBe(9);
  });

  it("single segment (Contract B, no Angabe): the same two ranges each price 10", () => {
    const r1 = countShiftBasedLeaveDaysBySegments(
      d("2026-06-12"),
      d("2026-06-28"),
      false,
      CONTRACT_B_SINGLE_NO_ANGABE,
      new Set(),
    );
    expect(r1.days).toBe(10);
    const r2 = countShiftBasedLeaveDaysBySegments(
      d("2026-08-31"),
      d("2026-09-15"),
      false,
      CONTRACT_B_SINGLE_NO_ANGABE,
      new Set(),
    );
    expect(r2.days).toBe(10);
  });

  it("Contract B whole week 25.05.-30.05.2026 with a holiday on 25.05. (Mo): 3", () => {
    const result = countShiftBasedLeaveDaysBySegments(
      d("2026-05-25"),
      d("2026-05-30"),
      false,
      CONTRACT_B_SINGLE_ANGABE,
      new Set(["2026-05-25"]),
    );
    expect(result.days).toBe(3);
  });

  it("D-07 literal: a requested Sunday falling under the SECOND segment makes the Mo-Sa part a fragment", () => {
    const segments: ShiftLeavePricingSegment[] = [
      { from: d("2025-09-01"), workDaysPerWeek: 5, usualWorkDays: [1, 2, 3, 4, 5] },
      { from: d("2026-11-01"), workDaysPerWeek: 4, usualWorkDays: [2, 3, 4, 5] },
    ];
    const withAngabe = countShiftBasedLeaveDaysBySegments(
      d("2026-10-26"),
      d("2026-11-01"),
      false,
      segments,
      new Set(),
    );
    expect(withAngabe.days).toBe(5);

    const noAngabe: ShiftLeavePricingSegment[] = [
      { from: d("2025-09-01"), workDaysPerWeek: 5, usualWorkDays: [] },
      { from: d("2026-11-01"), workDaysPerWeek: 4, usualWorkDays: [] },
    ];
    const withoutAngabe = countShiftBasedLeaveDaysBySegments(
      d("2026-10-26"),
      d("2026-11-01"),
      false,
      noAngabe,
      new Set(),
    );
    expect(withoutAngabe.days).toBe(5);

    // With Angabe AND a Saturday holiday (31.10., a non-usual day under the second segment): the
    // Mo-Sa part is priced as a FRAGMENT (D-07) against the first segment's Angabe
    // [1,2,3,4,5] — Sa is not a usual day, so the holiday does not reduce the fragment's price;
    // a whole-week reading would instead deduct the Saturday holiday and give 4.
    const withHoliday = countShiftBasedLeaveDaysBySegments(
      d("2026-10-26"),
      d("2026-11-01"),
      false,
      segments,
      new Set(["2026-10-31"]),
    );
    expect(withHoliday.days).toBe(5);
  });

  it("PD-01: a boundary that changes neither the count nor the Angabe is not a pricing boundary", () => {
    const segments: ShiftLeavePricingSegment[] = [
      { from: d("2025-09-01"), workDaysPerWeek: 5, usualWorkDays: [] },
      { from: d("2026-10-01"), workDaysPerWeek: 5, usualWorkDays: [] },
    ];
    const result = countShiftBasedLeaveDaysBySegments(
      d("2026-09-28"),
      d("2026-10-03"),
      false,
      segments,
      new Set(["2026-10-03"]),
    );
    // Identical to the one-segment result (a holiday reduces a 5-day whole week by 1) — without
    // the PD-01 merge, the boundary at 01.10. would force a fragment split and give 5.
    expect(result.days).toBe(4);
  });

  it("Contract B prod variant: segments merge via PD-01 when the Angabe stays empty, not when it differs", () => {
    const beforeAngabe: ShiftLeavePricingSegment[] = [
      { from: d("2026-05-18"), workDaysPerWeek: 4, usualWorkDays: [] },
      { from: d("2026-10-01"), workDaysPerWeek: 4, usualWorkDays: [] },
    ];
    const r1 = countShiftBasedLeaveDaysBySegments(
      d("2026-06-12"),
      d("2026-06-28"),
      false,
      beforeAngabe,
      new Set(),
    );
    expect(r1.days).toBe(10);

    // Giving the FIRST segment the Angabe [2..5] (differs from the second segment's [] Angabe)
    // means the two segments are NOT coalesced — this is the R6 backfill case (PD-01's own
    // carve-out: rows differing only in the Angabe are never merged).
    const afterAngabe: ShiftLeavePricingSegment[] = [
      { from: d("2026-05-18"), workDaysPerWeek: 4, usualWorkDays: [2, 3, 4, 5] },
      { from: d("2026-10-01"), workDaysPerWeek: 4, usualWorkDays: [] },
    ];
    const r2 = countShiftBasedLeaveDaysBySegments(
      d("2026-06-12"),
      d("2026-06-28"),
      false,
      afterAngabe,
      new Set(),
    );
    expect(r2.days).toBe(9);
  });

  it("half days: the segment valid on the half-day date decides via the Angabe", () => {
    // 2026-09-14 is a Monday under Contract A's second segment (from 01.08.2026, Angabe
    // [2,3,4,5] = Di-Fr) — Monday is not usual, so a half day on it counts 0.
    const monday = countShiftBasedLeaveDaysBySegments(
      d("2026-09-14"),
      d("2026-09-14"),
      true,
      CONTRACT_A,
      new Set(),
    );
    expect(monday.days).toBe(0);

    // 2026-09-15 is a Tuesday, a usual day under the second segment -> 0.5.
    const tuesday = countShiftBasedLeaveDaysBySegments(
      d("2026-09-15"),
      d("2026-09-15"),
      true,
      CONTRACT_A,
      new Set(),
    );
    expect(tuesday.days).toBe(0.5);

    // 2026-07-27 is a Monday under the FIRST segment (Angabe Mo-Fr) -> usual -> 0.5.
    const mondayRow1 = countShiftBasedLeaveDaysBySegments(
      d("2026-07-27"),
      d("2026-07-27"),
      true,
      CONTRACT_A,
      new Set(),
    );
    expect(mondayRow1.days).toBe(0.5);
  });
});

describe("contractSegmentAt (Issue #481, R1)", () => {
  it("an instant before every segment's `from` resolves to the FIRST segment", () => {
    const segments: ShiftLeavePricingSegment[] = [
      { from: d("2025-09-01"), workDaysPerWeek: 5, usualWorkDays: [] },
      { from: d("2026-08-01"), workDaysPerWeek: 4, usualWorkDays: [] },
    ];
    const active = contractSegmentAt(segments, d("2020-01-01"));
    expect(active.workDaysPerWeek).toBe(5);
  });

  it("two segments with the same `from` resolve to the LATER one (array order)", () => {
    const earlier: ShiftLeavePricingSegment = {
      from: d("2026-06-01"),
      workDaysPerWeek: 3,
      usualWorkDays: [],
    };
    const later: ShiftLeavePricingSegment = {
      from: d("2026-06-01"),
      workDaysPerWeek: 4,
      usualWorkDays: [],
    };
    const active = contractSegmentAt([earlier, later], d("2026-06-01"));
    expect(active.workDaysPerWeek).toBe(4);
  });

  it("an empty segment list throws (fail-closed)", () => {
    expect(() => contractSegmentAt([], d("2026-01-01"))).toThrow();
  });
});
