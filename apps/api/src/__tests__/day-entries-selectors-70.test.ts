/**
 * Issue #70 (Phase 70b-03) — the two selectors of `contexts/time-tracking/day-entries.ts` that
 * answer "which entry of the day does a clock event act on": `openEntryOf` and
 * `latestEndingClosed`. Pure functions, no database. Phase 92b adds its TRAVEL skip inside them.
 */
import { describe, it, expect } from "vitest";
import { openEntryOf, latestEndingClosed } from "../contexts/time-tracking/day-entries";

const t = (hhmm: string) => new Date(`2026-03-10T${hhmm}:00Z`);
const row = (id: string, from: string, to: string | null) => ({
  id,
  startTime: t(from),
  endTime: to === null ? null : t(to),
});

describe("openEntryOf", () => {
  it("returns the open row, null when every row is closed or the list is empty", () => {
    const open = row("b", "13:00", null);
    expect(openEntryOf([row("a", "08:00", "12:00"), open])).toBe(open);
    expect(openEntryOf([row("a", "08:00", "12:00")])).toBeNull();
    expect(openEntryOf([])).toBeNull();
  });
});

describe("latestEndingClosed", () => {
  it("picks the closed row with the latest end, whatever the list order, and ignores open rows", () => {
    const a = row("a", "08:00", "12:00");
    const b = row("b", "12:30", "16:00");
    const open = row("c", "17:00", null);
    expect(latestEndingClosed([a, b, open])).toBe(b);
    expect(latestEndingClosed([open, b, a])).toBe(b);
    expect(latestEndingClosed([open])).toBeNull();
    expect(latestEndingClosed([])).toBeNull();
  });

  it("breaks an end-time tie by the later start, then by the larger id", () => {
    const early = row("z", "08:00", "12:00");
    const late = row("a", "11:59", "12:00");
    expect(latestEndingClosed([early, late])).toBe(late);
    expect(latestEndingClosed([late, early])).toBe(late);
    const sameA = row("a", "12:00", "12:00");
    const sameB = row("b", "12:00", "12:00");
    expect(latestEndingClosed([sameA, sameB])).toBe(sameB);
    expect(latestEndingClosed([sameB, sameA])).toBe(sameB);
  });
});
