// Issue #449 (D-4) — unit tests for the shared half-day-single-date helpers, plus a source-read
// pin on the team page's Korrektur-Modal wiring (the page imports `$app/*` and cannot be mounted
// in vitest — apps/web/vitest.config.ts registers no `$app/*` alias, same technique as
// leave-halfday-sick-guard.test.ts).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";
import { HALF_DAY_SINGLE_DATE_MESSAGE, halfDayRangeError, endDateForHalfDay } from "../half-day";

function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const TEAM_PAGE = readRouteFile(
  "../../../routes/(app)/team/leave/+page.svelte",
  "src/routes/(app)/team/leave/+page.svelte",
);

describe("HALF_DAY_SINGLE_DATE_MESSAGE", () => {
  it("is the exact German sentence the API pins", () => {
    expect(HALF_DAY_SINGLE_DATE_MESSAGE).toBe(
      "Ein halber Tag ist nur für ein einzelnes Datum möglich.",
    );
  });
});

describe("halfDayRangeError", () => {
  it("returns the message when halfDay is ticked and the dates differ", () => {
    expect(halfDayRangeError(true, "2026-11-02", "2026-11-06")).toBe(HALF_DAY_SINGLE_DATE_MESSAGE);
  });

  it("returns null when halfDay is ticked and the dates are equal", () => {
    expect(halfDayRangeError(true, "2026-11-02", "2026-11-02")).toBeNull();
  });

  it("returns null when halfDay is not ticked, regardless of the dates", () => {
    expect(halfDayRangeError(false, "2026-11-02", "2026-11-06")).toBeNull();
  });

  it("returns null when either date is empty (required-field validation lives elsewhere)", () => {
    expect(halfDayRangeError(true, "", "2026-11-06")).toBeNull();
    expect(halfDayRangeError(true, "2026-11-02", "")).toBeNull();
  });
});

describe("endDateForHalfDay", () => {
  it("returns the start date when halfDay is ticked", () => {
    expect(endDateForHalfDay(true, "2026-11-02", "2026-11-06")).toBe("2026-11-02");
  });

  it("returns the end date unchanged when halfDay is not ticked", () => {
    expect(endDateForHalfDay(false, "2026-11-02", "2026-11-06")).toBe("2026-11-06");
  });
});

describe("team/leave Korrektur-Modal wiring (Issue #449, D-4)", () => {
  it("imports the shared half-day helper", () => {
    expect(TEAM_PAGE).toContain('from "$lib/leave/half-day"');
  });

  it("disables the correction end-date input while the effective half-day flag is set", () => {
    expect(TEAM_PAGE).toContain("disabled={correctHalfDayEffective}");
  });

  it("submitCorrection guards with halfDayRangeError before patching", () => {
    expect(TEAM_PAGE).toContain(
      "halfDayRangeError(correctHalfDayEffective, correctStart, correctEnd)",
    );
  });

  it("openCorrect never syncs the end date on open (a loaded legacy row must not be silently rewritten)", () => {
    const openStart = TEAM_PAGE.indexOf("function openCorrect");
    const closeStart = TEAM_PAGE.indexOf("function closeCorrect");
    expect(openStart).toBeGreaterThan(-1);
    expect(closeStart).toBeGreaterThan(openStart);
    const openCorrectBody = TEAM_PAGE.slice(openStart, closeStart);
    expect(openCorrectBody).not.toContain("endDateForHalfDay");
  });
});
