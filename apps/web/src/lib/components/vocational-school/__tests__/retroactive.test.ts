// Phase 103 — pure-function coverage for the retroactive confirm-dialog helpers.
// Mirrors ui/__tests__/ConfirmDialog.test.ts in location/structure convention, but
// these are plain function tests — no component mount needed. retroactive.ts is a
// pure, dependency-free module by design (see its module doc comment) so this logic
// is unit-testable without mounting a component.

import { describe, it, expect } from "vitest";
import {
  shouldOfferRetroactiveRun,
  formatIsoDateDe,
  type RetroactivePreview,
} from "../retroactive";

function basePreview(overrides: Partial<RetroactivePreview> = {}): RetroactivePreview {
  return {
    created: 0,
    skipped: {
      schoolHoliday: 0,
      existing: 0,
      locked: 0,
      preHire: 0,
      postExit: 0,
      outOfWindow: 0,
    },
    details: [],
    windowStart: null,
    windowEnd: null,
    ...overrides,
  };
}

describe("shouldOfferRetroactiveRun (Phase 103, D-01)", () => {
  it("returns false for an all-zero preview (purely-forward pattern change opens nothing)", () => {
    expect(shouldOfferRetroactiveRun(basePreview())).toBe(false);
  });

  it("returns true when created > 0", () => {
    expect(shouldOfferRetroactiveRun(basePreview({ created: 3 }))).toBe(true);
  });

  it("returns true when skipped.locked > 0, even with created === 0 (D-04)", () => {
    const preview = basePreview();
    preview.skipped.locked = 2;
    expect(shouldOfferRetroactiveRun(preview)).toBe(true);
  });

  it("returns false when only an unrelated skip counter is non-zero (e.g. schoolHoliday)", () => {
    const preview = basePreview();
    preview.skipped.schoolHoliday = 5;
    expect(shouldOfferRetroactiveRun(preview)).toBe(false);
  });

  it("returns true when both created and skipped.locked are non-zero", () => {
    expect(
      shouldOfferRetroactiveRun(
        basePreview({ created: 1, skipped: { ...basePreview().skipped, locked: 1 } }),
      ),
    ).toBe(true);
  });
});

describe("formatIsoDateDe (Phase 103)", () => {
  it("formats a two-digit day/month", () => {
    expect(formatIsoDateDe("2026-08-12")).toBe("12.08.2026");
  });

  it("formats a single-digit day and month, preserving the leading zero", () => {
    expect(formatIsoDateDe("2026-01-05")).toBe("05.01.2026");
  });

  it("formats the last day of a month", () => {
    expect(formatIsoDateDe("2026-12-31")).toBe("31.12.2026");
  });
});
