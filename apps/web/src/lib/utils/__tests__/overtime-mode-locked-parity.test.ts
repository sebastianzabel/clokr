// Issue #494 R5 (review IN-05) — parity of the web lock with the server's track-only predicate.
//
// `overtimeModeLocked()` re-implements the monthly-hours clause of `isTrackOnlySchedule()`
// (apps/api/src/contexts/working-time-account/track-only-schedule.ts) because the web package
// cannot import it. Nothing else ties the two together, so this table mirrors the cases of the
// server test (apps/api/src/contexts/working-time-account/__tests__/track-only-rule-494.test.ts)
// and a source pin fails when the server expression changes without this helper following.
//
// Scope: the server predicate is also true for an explicit TRACK_ONLY mode WITH monthly hours;
// the web lock deliberately does not cover that case — the select then simply shows the stored
// TRACK_ONLY itself and stays editable, so it is not part of this table.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { overtimeModeLocked } from "../work-schedule";

type Case = { label: string; monthlyHours: number | string | null | undefined; noTarget: boolean };

// monthlyHours inputs as the form / API can deliver them, with whether the server reads them as
// "no target" (`!(Number(x ?? 0) > 0)`).
const MONTHLY_HOURS_CASES: Case[] = [
  { label: "null", monthlyHours: null, noTarget: true },
  { label: "undefined", monthlyHours: undefined, noTarget: true },
  { label: "0", monthlyHours: 0, noTarget: true },
  { label: '"0"', monthlyHours: "0", noTarget: true },
  { label: '"0.00" (Decimal-like string)', monthlyHours: "0.00", noTarget: true },
  { label: '"" (cleared input)', monthlyHours: "", noTarget: true },
  { label: "negative number", monthlyHours: -5, noTarget: true },
  { label: "negative string", monthlyHours: "-1", noTarget: true },
  { label: "NaN", monthlyHours: Number.NaN, noTarget: true },
  { label: "non-numeric string", monthlyHours: "abc", noTarget: true },
  { label: "15", monthlyHours: 15, noTarget: false },
  { label: '"15"', monthlyHours: "15", noTarget: false },
  { label: '"15.50" (Decimal-like string)', monthlyHours: "15.50", noTarget: false },
  { label: "0.5", monthlyHours: 0.5, noTarget: false },
];

const OTHER_TYPES = ["FIXED_SCHEDULE", "FLEXTIME", "SHIFT_BASED", "", null, undefined];

describe("overtimeModeLocked parity with the server track-only predicate (IN-05)", () => {
  describe.each(MONTHLY_HOURS_CASES)("MONTHLY_HOURS, monthlyHours $label", (c) => {
    it(`is ${c.noTarget ? "locked" : "unlocked"}`, () => {
      expect(overtimeModeLocked("MONTHLY_HOURS", c.monthlyHours)).toBe(c.noTarget);
    });
  });

  describe.each(OTHER_TYPES)("type %s is never locked", (type) => {
    it.each([null, 0, "0", 15])("monthlyHours %s", (monthlyHours) => {
      expect(overtimeModeLocked(type, monthlyHours)).toBe(false);
    });
  });

  it("the server predicate still uses the expression this helper mirrors", () => {
    const source = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../../../api/src/contexts/working-time-account/track-only-schedule.ts",
      ),
      "utf8",
    );
    expect(source).toContain('schedule?.type !== "MONTHLY_HOURS"');
    expect(source).toContain("!(Number(schedule.monthlyHours ?? 0) > 0)");
  });
});
