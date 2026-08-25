// Phase 103 — pure-function coverage for the retroactive wizard helpers. Mirrors
// ui/__tests__/ConfirmDialog.test.ts in location/structure convention, but these are
// plain function tests — no component mount needed. retroactive.ts is a pure,
// dependency-free module by design (see its module doc comment) so this logic is
// unit-testable without mounting a component.
//
// Plan 04 extends this file with the nine behaviors the 3-step wizard needs: the
// summary sentence (D-02), the closed-months note (D-04), the conflict list and its
// default disposition (D-05/D-07), the bulk/override wiring (D-06), and the
// post-apply result text (D-01). Assertions are on exact strings — the point of
// moving copy into this module is that it can be pinned.

import { describe, it, expect } from "vitest";
import {
  shouldOfferRetroactiveRun,
  formatIsoDateDe,
  buildRetroactiveSummary,
  monthLabelsFromDetails,
  conflictDaysFromPreview,
  hasConflicts,
  effectiveOverrideDates,
  buildApplyResultText,
  type RetroactivePreview,
  type RetroactiveDetail,
  type ConflictDay,
} from "../retroactive";

function basePreview(overrides: Partial<RetroactivePreview> = {}): RetroactivePreview {
  return {
    created: 0,
    removed: 0,
    skipped: {
      schoolHoliday: 0,
      existing: 0,
      locked: 0,
      removalLocked: 0,
      timeEntryConflict: 0,
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

function detail(overrides: Partial<RetroactiveDetail> = {}): RetroactiveDetail {
  return {
    employeeId: "emp-1",
    date: "2026-08-12",
    action: "skipped",
    ...overrides,
  };
}

describe("shouldOfferRetroactiveRun (Phase 103, D-01, widened by plan 04)", () => {
  it("returns false for an all-zero preview (purely-forward pattern change opens nothing)", () => {
    expect(shouldOfferRetroactiveRun(basePreview())).toBe(false);
  });

  it("returns true when created > 0", () => {
    expect(shouldOfferRetroactiveRun(basePreview({ created: 3 }))).toBe(true);
  });

  it("returns true when removed > 0", () => {
    expect(shouldOfferRetroactiveRun(basePreview({ removed: 1 }))).toBe(true);
  });

  it("returns true when skipped.locked > 0, even with created === 0 (D-04)", () => {
    const preview = basePreview();
    preview.skipped.locked = 2;
    expect(shouldOfferRetroactiveRun(preview)).toBe(true);
  });

  it("returns true when skipped.removalLocked > 0", () => {
    const preview = basePreview();
    preview.skipped.removalLocked = 1;
    expect(shouldOfferRetroactiveRun(preview)).toBe(true);
  });

  it("returns true when skipped.timeEntryConflict > 0", () => {
    const preview = basePreview();
    preview.skipped.timeEntryConflict = 1;
    expect(shouldOfferRetroactiveRun(preview)).toBe(true);
  });

  it("returns false when only an unrelated skip counter is non-zero (e.g. schoolHoliday)", () => {
    const preview = basePreview();
    preview.skipped.schoolHoliday = 5;
    expect(shouldOfferRetroactiveRun(preview)).toBe(false);
  });

  it("returns true when both created and skipped.locked are non-zero", () => {
    const preview = basePreview({ created: 1 });
    preview.skipped.locked = 1;
    expect(shouldOfferRetroactiveRun(preview)).toBe(true);
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

describe("buildRetroactiveSummary (Phase 103 plan 04, D-02)", () => {
  it('renders the exact CONTEXT.md example — "Ab 12.08.2026: 2 Tage entfallen, 1 Tag kommt hinzu."', () => {
    const preview = basePreview({ created: 1, removed: 2, windowStart: "2026-08-12" });
    expect(buildRetroactiveSummary(preview)).toBe(
      "Ab 12.08.2026: 2 Tage entfallen, 1 Tag kommt hinzu.",
    );
  });

  it("singular on both halves independently", () => {
    const preview = basePreview({ created: 1, removed: 1, windowStart: "2026-01-05" });
    expect(buildRetroactiveSummary(preview)).toBe(
      "Ab 05.01.2026: 1 Tag entfällt, 1 Tag kommt hinzu.",
    );
  });

  it("drops the removed clause when removed is 0", () => {
    const preview = basePreview({ created: 3, removed: 0, windowStart: "2026-08-12" });
    expect(buildRetroactiveSummary(preview)).toBe("Ab 12.08.2026: 3 Tage kommen hinzu.");
  });

  it("drops the created clause when created is 0", () => {
    const preview = basePreview({ created: 0, removed: 4, windowStart: "2026-08-12" });
    expect(buildRetroactiveSummary(preview)).toBe("Ab 12.08.2026: 4 Tage entfallen.");
  });

  it("with created: 0, removed: 0 but locked days present, omits the create/remove clause entirely", () => {
    const preview = basePreview({ windowStart: "2026-08-12" });
    preview.skipped.locked = 2;
    const summary = buildRetroactiveSummary(preview);
    expect(summary).not.toContain("0 Tage entfallen");
    expect(summary).not.toContain("0 Tage kommen hinzu");
    expect(summary).toBe("Ab 12.08.2026: keine Berufsschultage betroffen.");
  });
});

describe("monthLabelsFromDetails (Phase 103 plan 04, D-04)", () => {
  it('single month — exact string "Juli ist abgeschlossen — 2 Tage bleiben unverändert."', () => {
    const details = [
      detail({ date: "2026-07-06", reason: "locked" }),
      detail({ date: "2026-07-13", reason: "locked" }),
    ];
    expect(monthLabelsFromDetails(details)).toBe(
      "Juli ist abgeschlossen — 2 Tage bleiben unverändert.",
    );
  });

  it('multi-month plural — exact string "Juni, Juli sind abgeschlossen — 3 Tage bleiben unverändert." in chronological order', () => {
    const details = [
      detail({ date: "2026-07-06", reason: "locked" }),
      detail({ date: "2026-06-29", reason: "locked" }),
      detail({ date: "2026-07-13", reason: "removalLocked" }),
    ];
    expect(monthLabelsFromDetails(details)).toBe(
      "Juni, Juli sind abgeschlossen — 3 Tage bleiben unverändert.",
    );
  });

  it("counts locked and removalLocked together", () => {
    const details = [
      detail({ date: "2026-07-06", reason: "locked" }),
      detail({ date: "2026-07-13", reason: "removalLocked" }),
    ];
    expect(monthLabelsFromDetails(details)).toBe(
      "Juli ist abgeschlossen — 2 Tage bleiben unverändert.",
    );
  });

  it("returns null when no detail carries a locked reason", () => {
    const details = [detail({ reason: "timeEntryConflict" }), detail({ reason: "schoolHoliday" })];
    expect(monthLabelsFromDetails(details)).toBeNull();
  });

  it("returns null for an empty details array", () => {
    expect(monthLabelsFromDetails([])).toBeNull();
  });
});

describe("conflictDaysFromPreview (Phase 103 plan 04, D-05/D-07)", () => {
  it("returns one entry per timeEntryConflict detail, each defaulting to disposition skip", () => {
    const preview = basePreview({
      details: [
        detail({ date: "2026-08-10", reason: "timeEntryConflict" }), // Monday
        detail({ date: "2026-08-11", reason: "timeEntryConflict" }), // Tuesday
        detail({ date: "2026-08-12", reason: "locked" }),
      ],
    });
    const conflicts = conflictDaysFromPreview(preview);
    expect(conflicts).toHaveLength(2);
    expect(conflicts.every((c) => c.disposition === "skip")).toBe(true);
  });

  it("derives the correct German short weekday label", () => {
    const preview = basePreview({
      details: [
        detail({ date: "2026-08-10", reason: "timeEntryConflict" }), // Monday
        detail({ date: "2026-08-16", reason: "timeEntryConflict" }), // Sunday
      ],
    });
    const conflicts = conflictDaysFromPreview(preview);
    expect(conflicts[0]).toMatchObject({ date: "2026-08-10", weekdayLabel: "Mo" });
    expect(conflicts[1]).toMatchObject({ date: "2026-08-16", weekdayLabel: "So" });
  });

  it("returns an empty array when there are no timeEntryConflict details", () => {
    const preview = basePreview({ details: [detail({ reason: "locked" })] });
    expect(conflictDaysFromPreview(preview)).toEqual([]);
  });
});

describe("hasConflicts (Phase 103 plan 04)", () => {
  it("true iff conflictDaysFromPreview is non-empty", () => {
    const withConflict = basePreview({ details: [detail({ reason: "timeEntryConflict" })] });
    const withoutConflict = basePreview({ details: [detail({ reason: "locked" })] });
    expect(hasConflicts(withConflict)).toBe(true);
    expect(hasConflicts(withoutConflict)).toBe(false);
  });
});

describe("effectiveOverrideDates (Phase 103 plan 04, D-06)", () => {
  it("returns [] for an untouched conflict list (all default to skip)", () => {
    const days: ConflictDay[] = [
      { date: "2026-08-10", weekdayLabel: "Mo", disposition: "skip" },
      { date: "2026-08-11", weekdayLabel: "Di", disposition: "skip" },
    ];
    expect(effectiveOverrideDates(days)).toEqual([]);
  });

  it("returns every date when all are set to apply (bulk 'Alle übernehmen')", () => {
    const days: ConflictDay[] = [
      { date: "2026-08-10", weekdayLabel: "Mo", disposition: "apply" },
      { date: "2026-08-11", weekdayLabel: "Di", disposition: "apply" },
    ];
    expect(effectiveOverrideDates(days)).toEqual(["2026-08-10", "2026-08-11"]);
  });

  it("a mixed list after bulk-apply followed by flipping one day back omits that date", () => {
    const days: ConflictDay[] = [
      { date: "2026-08-10", weekdayLabel: "Mo", disposition: "apply" },
      { date: "2026-08-11", weekdayLabel: "Di", disposition: "skip" },
      { date: "2026-08-12", weekdayLabel: "Mi", disposition: "apply" },
    ];
    expect(effectiveOverrideDates(days)).toEqual(["2026-08-10", "2026-08-12"]);
  });
});

describe("buildApplyResultText (Phase 103 plan 04, D-01)", () => {
  it("names created, removed, closed-unchanged and skipped-conflict clauses together", () => {
    const result = basePreview({ created: 1, removed: 2 });
    result.skipped.locked = 2;
    result.skipped.timeEntryConflict = 1;
    const text = buildApplyResultText(result);
    expect(text).toContain("1 Tag angelegt");
    expect(text).toContain("2 Tage entfernt");
    expect(text).toContain("2 Tage unverändert (abgeschlossen)");
    expect(text).toContain("1 Tag übersprungen (bereits erfasste Zeit)");
  });

  it("omits every clause whose count is 0", () => {
    const result = basePreview({ created: 1 });
    const text = buildApplyResultText(result);
    expect(text).toBe("1 Tag angelegt.");
  });

  it("combines skipped.locked and skipped.removalLocked into one closed-unchanged clause", () => {
    const result = basePreview();
    result.skipped.locked = 1;
    result.skipped.removalLocked = 1;
    const text = buildApplyResultText(result);
    expect(text).toBe("2 Tage unverändert (abgeschlossen).");
  });

  it("renders a neutral sentence when every counter is 0", () => {
    expect(buildApplyResultText(basePreview())).toBe("Keine Änderungen — nichts zu tun.");
  });
});
