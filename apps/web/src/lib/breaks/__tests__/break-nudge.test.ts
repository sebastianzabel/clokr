import { describe, it, expect } from "vitest";
import {
  summarizeUnconfirmedBreaks,
  breakNudgeHref,
  toBreakDayString,
  BREAK_NUDGE_EMPTY,
} from "../break-nudge";

// Phase 112 (GitHub issue #115). The first three tests ARE the phase: no test pinned the URL
// the dashboard nudge emits, which is why 18c27fcc could ship a link that crashed its own
// destination for a month without anyone noticing.

describe("breakNudgeHref — the URL pin that was missing", () => {
  it("Test 1: a full-ISO API date yields a plain yyyy-MM-dd deep link", () => {
    const href = breakNudgeHref(
      summarizeUnconfirmedBreaks([
        { date: "2026-08-05T00:00:00.000Z", breakStatus: "AUTO", isLocked: false },
      ]),
    );
    expect(href).toBe("/time-entries?view=list&date=2026-08-05");
  });

  it("Test 2: no time component can ever leak into the date param", () => {
    const href = breakNudgeHref(
      summarizeUnconfirmedBreaks([
        { date: "2026-08-05T00:00:00.000Z", breakStatus: "AUTO", isLocked: false },
      ]),
    );
    expect(href).not.toMatch(/date=[^&]*T/);
  });

  it("Test 3: the destination's own computation is VALID for the emitted param (and invalid for the raw API value)", () => {
    const href = breakNudgeHref(
      summarizeUnconfirmedBreaks([
        { date: "2026-08-05T00:00:00.000Z", breakStatus: "AUTO", isLocked: false },
      ]),
    );
    // Reproduces time-entries/+page.svelte's own line verbatim.
    const param = new URL(href, "http://x").searchParams.get("date")!;
    expect(Number.isNaN(new Date(param + "T12:00:00").getTime())).toBe(false);

    // Negative control — proves the assertion above discriminates. This is exactly what the
    // page computed before the fix, and it is why format() threw RangeError.
    expect(Number.isNaN(new Date("2026-08-05T00:00:00.000Z" + "T12:00:00").getTime())).toBe(true);
  });

  it("Test 4: an already-plain day is idempotent", () => {
    const href = breakNudgeHref(
      summarizeUnconfirmedBreaks([{ date: "2026-08-05", breakStatus: "AUTO", isLocked: false }]),
    );
    expect(href).toBe("/time-entries?view=list&date=2026-08-05");
  });

  it("Test 5: with no unconfirmed day the href is the bare list", () => {
    expect(breakNudgeHref(BREAK_NUDGE_EMPTY)).toBe("/time-entries?view=list");
  });
});

describe("summarizeUnconfirmedBreaks", () => {
  it("Test 6: CONFIRMED and WAIVED rows are ignored", () => {
    const summary = summarizeUnconfirmedBreaks([
      { date: "2026-08-05T00:00:00.000Z", breakStatus: "CONFIRMED", isLocked: false },
      { date: "2026-08-06T00:00:00.000Z", breakStatus: "WAIVED", isLocked: false },
    ]);
    expect(summary.count).toBe(0);
    expect(breakNudgeHref(summary)).toBe("/time-entries?view=list");
  });

  it("Test 7: a locked AUTO row is ignored — a closed month is not actionable", () => {
    const summary = summarizeUnconfirmedBreaks([
      { date: "2026-08-05T00:00:00.000Z", breakStatus: "AUTO", isLocked: true },
    ]);
    expect(summary).toEqual(BREAK_NUDGE_EMPTY);
  });

  it("Test 8: a missing isLocked is treated as NOT locked", () => {
    const summary = summarizeUnconfirmedBreaks([
      { date: "2026-08-05T00:00:00.000Z", breakStatus: "AUTO" },
    ]);
    expect(summary.count).toBe(1);
    expect(summary.earliestDay).toBe("2026-08-05");
  });

  it("Test 9: two rows on the same calendar day count once", () => {
    const summary = summarizeUnconfirmedBreaks([
      { date: "2026-08-05T00:00:00.000Z", breakStatus: "AUTO", isLocked: false },
      { date: "2026-08-05T22:00:00.000Z", breakStatus: "AUTO", isLocked: false },
    ]);
    expect(summary.count).toBe(1);
    expect(summary.days).toEqual(["2026-08-05"]);
  });

  it("Test 10: earliestDay is the smallest day across months and days are ascending", () => {
    const summary = summarizeUnconfirmedBreaks([
      { date: "2026-08-05T00:00:00.000Z", breakStatus: "AUTO", isLocked: false },
      { date: "2025-11-04T00:00:00.000Z", breakStatus: "AUTO", isLocked: false },
    ]);
    expect(summary.earliestDay).toBe("2025-11-04");
    expect(summary.days).toEqual(["2025-11-04", "2026-08-05"]);
  });

  it("Test 11: German copy — singular and plural are byte-identical to the shipped wording", () => {
    const one = summarizeUnconfirmedBreaks([
      { date: "2026-08-05T00:00:00.000Z", breakStatus: "AUTO" },
    ]);
    expect(one.label).toBe("1 Tag: Pause bestätigen");

    const three = summarizeUnconfirmedBreaks([
      { date: "2026-08-05T00:00:00.000Z", breakStatus: "AUTO" },
      { date: "2026-08-06T00:00:00.000Z", breakStatus: "AUTO" },
      { date: "2026-08-07T00:00:00.000Z", breakStatus: "AUTO" },
    ]);
    expect(three.label).toBe("3 Tage: Pause bestätigen");
  });

  it("Test 12: undefined and an empty array both yield the empty summary", () => {
    expect(summarizeUnconfirmedBreaks(undefined)).toEqual(BREAK_NUDGE_EMPTY);
    expect(summarizeUnconfirmedBreaks(null)).toEqual(BREAK_NUDGE_EMPTY);
    expect(summarizeUnconfirmedBreaks([])).toEqual(BREAK_NUDGE_EMPTY);
  });
});

describe("toBreakDayString", () => {
  it("Test 13: strips the time component and is idempotent on a plain day", () => {
    expect(toBreakDayString("2026-08-05T00:00:00.000Z")).toBe("2026-08-05");
    expect(toBreakDayString("2026-08-05")).toBe("2026-08-05");
  });
});
