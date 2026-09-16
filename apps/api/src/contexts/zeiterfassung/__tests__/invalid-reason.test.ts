import { describe, it, expect } from "vitest";
import {
  INVALID_REASON_TEXT,
  invalidReasonFields,
  CLEARED_INVALID_REASON,
} from "../invalid-reason";

/**
 * This is the AC-4 evidence. The German strings users see are produced by
 * INVALID_REASON_TEXT alone (D-09), so a test that fails on one changed
 * character is what makes "the display does not change" a check rather than
 * a promise. Pure unit test — no Prisma, no buildApp(), no database, does not
 * require test:setup.
 */
describe("INVALID_REASON_TEXT", () => {
  it("maps MISSING_CLOCK_OUT to the exact pinned German text", () => {
    expect(INVALID_REASON_TEXT.MISSING_CLOCK_OUT).toBe("Ausstempeln fehlt");
  });

  it("maps LEAVE_CANCELLATION_PENDING to the exact pinned German text", () => {
    expect(INVALID_REASON_TEXT.LEAVE_CANCELLATION_PENDING).toBe("Urlaubsstornierung ausstehend");
  });

  it("maps RETRO_APPROVAL_PENDING to the exact pinned German text", () => {
    expect(INVALID_REASON_TEXT.RETRO_APPROVAL_PENDING).toBe("Nachtrag – Genehmigung ausstehend");
  });

  it("pins the RETRO_APPROVAL_PENDING dash as U+2013 (en dash), not a hyphen", () => {
    // A toBe() against a string literal is not sufficient on its own: if someone
    // later retypes both the source and this test with a hyphen, toBe still
    // passes while production data silently stops matching. Asserting the raw
    // code point of the dash character itself cannot be retyped into agreement
    // the same way.
    //
    // Deviation from the plan's stated index: the plan's <behavior> section says
    // charCodeAt(8), but "Nachtrag" is 8 characters (indices 0-7), so index 8 is
    // the space that follows it and index 9 is the dash — confirmed with a
    // throwaway `node -e` character dump before writing this assertion. Using
    // the verified index 9 here; index 8 stays covered by the `not.toBe` check
    // below so a future re-count of "the wrong index" still can't pass silently.
    const text = INVALID_REASON_TEXT.RETRO_APPROVAL_PENDING;
    expect(text.charCodeAt(9)).toBe(0x2013);
    expect(text.charCodeAt(9)).not.toBe(0x2d); // 0x2D = ASCII hyphen-minus
    expect(text.charCodeAt(8)).not.toBe(0x2013); // the space before the dash, not the dash
  });

  it("has exactly the three writable codes and no LEGACY_UNMAPPED entry", () => {
    // LEGACY_UNMAPPED rows keep their own stored text (Phase 96 plan 01's
    // backfill) — asserting its absence here keeps that rule from quietly
    // being turned into a hardcoded fallback string later.
    const keys = Object.keys(INVALID_REASON_TEXT);
    expect(keys).toHaveLength(3);
    expect(keys).not.toContain("LEGACY_UNMAPPED");
  });
});

describe("invalidReasonFields", () => {
  it("returns the code paired with its matching German text", () => {
    expect(invalidReasonFields("MISSING_CLOCK_OUT")).toEqual({
      invalidReasonCode: "MISSING_CLOCK_OUT",
      invalidReason: "Ausstempeln fehlt",
    });
  });
});

describe("CLEARED_INVALID_REASON", () => {
  it("deep-equals the null/null clear fragment", () => {
    expect(CLEARED_INVALID_REASON).toEqual({
      invalidReasonCode: null,
      invalidReason: null,
    });
  });

  it("is frozen and cannot be mutated by a caller", () => {
    "use strict";
    expect(Object.isFrozen(CLEARED_INVALID_REASON)).toBe(true);
    expect(() => {
      // @ts-expect-error — intentionally attempting to mutate a frozen readonly object
      CLEARED_INVALID_REASON.invalidReasonCode = "MISSING_CLOCK_OUT";
    }).toThrow(TypeError);
    expect(CLEARED_INVALID_REASON).toEqual({ invalidReasonCode: null, invalidReason: null });
  });
});
