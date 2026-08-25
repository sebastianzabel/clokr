import { describe, it, expect } from "vitest";
import { summarizeKarenzOverrun, karenzNudgeHref, KARENZ_NUDGE_EMPTY } from "../karenz-nudge";

describe("summarizeKarenzOverrun", () => {
  it("Test 1: counts distinct days, picks the earliest day and its owning request", () => {
    const summary = summarizeKarenzOverrun({
      graceDays: 3,
      overruns: [{ leaveRequestId: "r1", days: ["2026-08-10", "2026-08-11"] }],
      totalDays: 2,
    });
    expect(summary).toEqual({
      count: 2,
      earliestDay: "2026-08-10",
      targetRequestId: "r1",
      label: "2 Tage: Attest nachreichen",
    });
  });

  it("Test 2: a single day yields the singular label", () => {
    const summary = summarizeKarenzOverrun({
      graceDays: 3,
      overruns: [{ leaveRequestId: "r1", days: ["2026-08-10"] }],
      totalDays: 1,
    });
    expect(summary.label).toBe("1 Tag: Attest nachreichen");
    expect(summary.count).toBe(1);
  });

  it("Test 3: days are distinct across overruns — a shared day counts once", () => {
    const summary = summarizeKarenzOverrun({
      graceDays: 3,
      overruns: [
        { leaveRequestId: "r1", days: ["2026-08-10", "2026-08-11"] },
        { leaveRequestId: "r2", days: ["2026-08-11", "2026-08-12"] },
      ],
      totalDays: 3,
    });
    expect(summary.count).toBe(3);
  });

  it("Test 4: earliestDay is the lexicographically smallest ISO day across ALL overruns, and targetRequestId is its owner", () => {
    const summary = summarizeKarenzOverrun({
      graceDays: 3,
      overruns: [
        { leaveRequestId: "later-owner", days: ["2026-08-15", "2026-08-16"] },
        { leaveRequestId: "earliest-owner", days: ["2026-08-05", "2026-08-06"] },
      ],
      totalDays: 4,
    });
    expect(summary.earliestDay).toBe("2026-08-05");
    expect(summary.targetRequestId).toBe("earliest-owner");
  });

  it("Test 5: an empty/undefined response yields the empty summary", () => {
    expect(summarizeKarenzOverrun(undefined)).toEqual(KARENZ_NUDGE_EMPTY);
    expect(summarizeKarenzOverrun(null)).toEqual(KARENZ_NUDGE_EMPTY);
    expect(summarizeKarenzOverrun({ graceDays: 3, overruns: [], totalDays: 0 })).toEqual(
      KARENZ_NUDGE_EMPTY,
    );
  });
});

describe("karenzNudgeHref", () => {
  it("Test 6: returns a request-scoped deep link when a target exists, else the bare list", () => {
    expect(
      karenzNudgeHref({
        count: 1,
        earliestDay: "2026-08-10",
        targetRequestId: "r1",
        label: "1 Tag: Attest nachreichen",
      }),
    ).toBe("/leave?request=r1");
    expect(karenzNudgeHref(KARENZ_NUDGE_EMPTY)).toBe("/leave");
  });
});
