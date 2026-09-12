import { describe, it, expect } from "vitest";
import {
  summarizeKarenzOverrun,
  karenzNudgeHref,
  KARENZ_NUDGE_EMPTY,
  KARENZ_SUBMISSION_HINT,
  karenzOverrunDays,
  formatKarenzDay,
  hasNoOpenItems,
} from "../karenz-nudge";

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
      label: "2 Tage ohne Attest",
    });
  });

  it("Test 2: a single day yields the singular label", () => {
    const summary = summarizeKarenzOverrun({
      graceDays: 3,
      overruns: [{ leaveRequestId: "r1", days: ["2026-08-10"] }],
      totalDays: 1,
    });
    expect(summary.label).toBe("1 Tag ohne Attest");
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
        label: "1 Tag ohne Attest",
      }),
    ).toBe("/leave?request=r1");
    expect(karenzNudgeHref(KARENZ_NUDGE_EMPTY)).toBe("/leave");
  });
});

describe("hasNoOpenItems (D-21 follow-up: dashboard empty-state fix)", () => {
  it("Test 7: everything zero — the empty state is genuinely reachable", () => {
    expect(hasNoOpenItems(0, 0, 0)).toBe(true);
  });

  it("Test 8: openItems.total is 0 but a Karenz overrun exists — must NOT report empty", () => {
    expect(hasNoOpenItems(0, 1, 0)).toBe(false);
  });

  it("Test 9: openItems.total is 0 but unconfirmed break days exist — must NOT report empty (fixes the inherited Phase-92 gap)", () => {
    expect(hasNoOpenItems(0, 0, 2)).toBe(false);
  });

  it("Test 10: openItems.total alone is non-zero — never reports empty, regardless of the nudges", () => {
    expect(hasNoOpenItems(3, 0, 0)).toBe(false);
  });

  it("Test 11: a fail-safe zero Karenz count (API error path) does not block the empty state on its own", () => {
    expect(hasNoOpenItems(0, 0, 0)).toBe(true);
  });
});

describe("Phase 113 (issue #116): the copy promises nothing the product cannot do", () => {
  it("Test 12: the label states a fact and issues no instruction", () => {
    const singular = summarizeKarenzOverrun({
      graceDays: 3,
      overruns: [{ leaveRequestId: "r1", days: ["2026-08-10"] }],
      totalDays: 1,
    });
    const plural = summarizeKarenzOverrun({
      graceDays: 3,
      overruns: [
        { leaveRequestId: "r1", days: ["2026-08-10", "2026-08-11"] },
        { leaveRequestId: "r2", days: ["2026-08-12", "2026-08-13"] },
      ],
      totalDays: 4,
    });
    for (const label of [singular.label, plural.label]) {
      expect(label).not.toContain("nachreichen");
      expect(label).not.toContain("einreichen");
      expect(label).not.toContain("Bitte");
      expect(label).toContain("ohne Attest");
    }
    expect(plural.count).toBe(4);
  });

  it("Test 13: KARENZ_SUBMISSION_HINT names Clokr's limitation, not the tenant's process", () => {
    expect(KARENZ_SUBMISSION_HINT).toContain("Clokr nimmt keine Atteste entgegen");
    expect(KARENZ_SUBMISSION_HINT).toContain("zum Beispiel");
    expect(KARENZ_SUBMISSION_HINT).not.toContain(
      "Bitte reiche das Attest bei der Personalabteilung ein",
    );
  });
});

describe("karenzOverrunDays", () => {
  it("Test 14: returns distinct, ascending ISO days across all overruns", () => {
    expect(
      karenzOverrunDays({
        graceDays: 3,
        overruns: [
          { leaveRequestId: "r1", days: ["2026-08-11", "2026-08-10"] },
          { leaveRequestId: "r2", days: ["2026-08-11", "2026-08-09"] },
        ],
        totalDays: 4,
      }),
    ).toEqual(["2026-08-09", "2026-08-10", "2026-08-11"]);
  });

  it("Test 15: is fail-safe on an empty/undefined response", () => {
    expect(karenzOverrunDays(undefined)).toEqual([]);
    expect(karenzOverrunDays(null)).toEqual([]);
    expect(karenzOverrunDays({ graceDays: 3, overruns: [], totalDays: 0 })).toEqual([]);
  });
});

describe("formatKarenzDay", () => {
  it("Test 16: renders German DD.MM.YYYY", () => {
    expect(formatKarenzDay("2026-08-05")).toBe("05.08.2026");
    expect(formatKarenzDay("2027-01-31")).toBe("31.01.2027");
  });

  it("Test 17: returns the input unchanged when it is not an ISO day", () => {
    expect(formatKarenzDay("kaputt")).toBe("kaputt");
  });
});
