// Phase 255 (GitHub issue #255) — pins the ONE named condition behind the BUrlG § 7 notice
// (showsBurlgSection7Notice, D-07/D-08/D-09) exhaustively against the full vocabulary, not by a
// hand-copied list. The table is DERIVED from LEAVE_TYPES so a future eleventh vocabulary member
// makes this test fail loudly instead of silently passing an incomplete table.

import { describe, it, expect } from "vitest";
import { showsBurlgSection7Notice } from "../leave-review";
import { LEAVE_TYPES } from "../team-calendar-visibility";

const ALL_CODES = LEAVE_TYPES.map((t) => t.code);

describe("showsBurlgSection7Notice", () => {
  it("covers every vocabulary member — the table must stay exhaustive", () => {
    // Anti-vacuity: an empty/truncated ALL_CODES would make every `it.each` below vacuously pass.
    expect(ALL_CODES.length).toBe(10);
  });

  it.each(ALL_CODES)("%s — notice fires only for VACATION and SPECIAL", (code) => {
    expect(showsBurlgSection7Notice(code)).toBe(code === "VACATION" || code === "SPECIAL");
  });

  it("exactly two codes trigger the notice — not more, not fewer", () => {
    const triggering = ALL_CODES.filter((code) => showsBurlgSection7Notice(code));
    expect(triggering.length).toBe(2);
    expect(triggering.sort()).toEqual(["SPECIAL", "VACATION"]);
  });
});
