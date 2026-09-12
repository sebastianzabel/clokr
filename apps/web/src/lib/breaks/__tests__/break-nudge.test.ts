import { describe, it, expect } from "vitest";
import {
  summarizeUnconfirmedBreakDays,
  breakNudgeHref,
  toBreakDayString,
  BREAK_NUDGE_EMPTY,
} from "../break-nudge";

// Phase 112 (GitHub issue #115). The first three tests ARE the phase: no test pinned the URL
// the dashboard nudge emits, which is why 18c27fcc could ship a link that crashed its own
// destination for a month without anyone noticing.
//
// Phase 126 (GitHub issue #126): these pins survive unchanged in intent. The input shape moved
// from row objects (`{ date, breakStatus, isLocked }`) to plain day strings, because the
// filtering that used to happen here now happens server-side (find-unconfirmed-break-days.ts) —
// but the URL contract this describes is unaffected.

describe("breakNudgeHref — the URL pin that was missing", () => {
  it("Test 1: a full-ISO API date yields a plain yyyy-MM-dd deep link", () => {
    const href = breakNudgeHref(summarizeUnconfirmedBreakDays(["2026-08-05T00:00:00.000Z"]));
    expect(href).toBe("/time-entries?view=list&date=2026-08-05");
  });

  it("Test 2: no time component can ever leak into the date param", () => {
    const href = breakNudgeHref(summarizeUnconfirmedBreakDays(["2026-08-05T00:00:00.000Z"]));
    expect(href).not.toMatch(/date=[^&]*T/);
  });

  it("Test 3: the destination's own computation is VALID for the emitted param (and invalid for the raw API value)", () => {
    const href = breakNudgeHref(summarizeUnconfirmedBreakDays(["2026-08-05T00:00:00.000Z"]));
    // Reproduces time-entries/+page.svelte's own line verbatim.
    const param = new URL(href, "http://x").searchParams.get("date")!;
    expect(Number.isNaN(new Date(param + "T12:00:00").getTime())).toBe(false);

    // Negative control — proves the assertion above discriminates. This is exactly what the
    // page computed before the fix, and it is why format() threw RangeError.
    expect(Number.isNaN(new Date("2026-08-05T00:00:00.000Z" + "T12:00:00").getTime())).toBe(true);
  });

  it("Test 4: an already-plain day is idempotent", () => {
    const href = breakNudgeHref(summarizeUnconfirmedBreakDays(["2026-08-05"]));
    expect(href).toBe("/time-entries?view=list&date=2026-08-05");
  });

  it("Test 5: with no unconfirmed day the href is the bare list", () => {
    expect(breakNudgeHref(BREAK_NUDGE_EMPTY)).toBe("/time-entries?view=list");
  });
});

// Phase 126 (issue #126): the breakStatus / isLocked / window filters that used to be
// asserted here moved server-side to find-unconfirmed-break-days.ts. They are pinned by
// apps/api/src/__tests__/dashboard-open-items-break.test.ts — deliberately NOT re-asserted
// here, because a second client-side assertion of the rule is how the divergence started.
describe("summarizeUnconfirmedBreakDays", () => {
  it("Test 9: two entries on the same calendar day count once", () => {
    const summary = summarizeUnconfirmedBreakDays([
      "2026-08-05T00:00:00.000Z",
      "2026-08-05T22:00:00.000Z",
    ]);
    expect(summary.count).toBe(1);
    expect(summary.days).toEqual(["2026-08-05"]);
  });

  it("Test 10: earliestDay is the smallest day across months and days are ascending", () => {
    const summary = summarizeUnconfirmedBreakDays(["2026-08-05T00:00:00.000Z", "2025-11-04"]);
    expect(summary.earliestDay).toBe("2025-11-04");
    expect(summary.days).toEqual(["2025-11-04", "2026-08-05"]);
  });

  it("Test 11: German copy — singular and plural are byte-identical to the shipped wording", () => {
    const one = summarizeUnconfirmedBreakDays(["2026-08-05"]);
    expect(one.label).toBe("1 Tag: Pause bestätigen");

    const three = summarizeUnconfirmedBreakDays(["2026-08-05", "2026-08-06", "2026-08-07"]);
    expect(three.label).toBe("3 Tage: Pause bestätigen");
  });

  it("Test 12 (D-08 fail-safe): undefined, null and an empty array all yield the empty summary — an absent list must never render as a '0'", () => {
    expect(summarizeUnconfirmedBreakDays(undefined)).toEqual(BREAK_NUDGE_EMPTY);
    expect(summarizeUnconfirmedBreakDays(null)).toEqual(BREAK_NUDGE_EMPTY);
    expect(summarizeUnconfirmedBreakDays([])).toEqual(BREAK_NUDGE_EMPTY);
  });
});

describe("toBreakDayString", () => {
  it("Test 13: strips the time component and is idempotent on a plain day", () => {
    expect(toBreakDayString("2026-08-05T00:00:00.000Z")).toBe("2026-08-05");
    expect(toBreakDayString("2026-08-05")).toBe("2026-08-05");
  });
});
