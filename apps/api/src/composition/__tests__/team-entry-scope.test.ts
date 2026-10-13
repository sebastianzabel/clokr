/**
 * Issue #85 (D-04/D-05) — DB-free cases of the pure partition helpers behind the dashboard's
 * per-entry week grid. The Unterbau decides which entries are in scope; these helpers only
 * partition rows by that set.
 */
import { describe, it, expect } from "vitest";
import {
  outOfScopeValidCounts,
  fullyCoveredPersons,
  presenceEntriesWithStandIns,
  distinctEmployeeIds,
  personDayKey,
} from "../team-entry-scope";

type Row = { employeeId: string; day: string; isInvalid: boolean; endTime: Date | null };
const dayOf = (r: Row) => r.day;
const row = (employeeId: string, day: string, isInvalid = false, closed = true): Row => ({
  employeeId,
  day,
  isInvalid,
  endTime: closed ? new Date("2026-06-15T12:00:00Z") : null,
});

describe("outOfScopeValidCounts", () => {
  it("counts the valid rows of a person-day that are not in scope", () => {
    const all = [row("p", "d1"), row("p", "d1"), row("p", "d2")];
    const inScope = [row("p", "d1")];
    const counts = outOfScopeValidCounts(all, inScope, dayOf);
    expect(counts.get(personDayKey("p", "d1"))).toBe(1);
    expect(counts.get(personDayKey("p", "d2"))).toBe(1);
  });

  it("never counts invalid rows", () => {
    const all = [row("p", "d1", true), row("p", "d1")];
    const inScope = [row("p", "d1")];
    expect(outOfScopeValidCounts(all, inScope, dayOf).size).toBe(0);
  });

  it("omits a person-day that is covered completely", () => {
    const all = [row("p", "d1")];
    expect(outOfScopeValidCounts(all, [row("p", "d1")], dayOf).size).toBe(0);
    expect(outOfScopeValidCounts([], [], dayOf).size).toBe(0);
  });

  it("ignores in-scope rows of a person that has no row in allRows (population-only person)", () => {
    const counts = outOfScopeValidCounts([row("a", "d1")], [row("a", "d1"), row("z", "d1")], dayOf);
    expect(counts.size).toBe(0);
  });
});

describe("fullyCoveredPersons", () => {
  it("returns exactly the persons whose row counts match", () => {
    const all = [row("a", "d1"), row("b", "d1"), row("b", "d2")];
    const inScope = [row("a", "d1"), row("b", "d1")];
    const covered = fullyCoveredPersons(all, inScope);
    expect(covered.has("a")).toBe(true);
    expect(covered.has("b")).toBe(false);
  });

  it("treats a person with zero rows on both sides as covered", () => {
    const covered = fullyCoveredPersons([], [], ["q"]);
    expect(covered.has("q")).toBe(true);
  });

  it("does not cover a person who has in-scope rows but none in allRows", () => {
    expect(fullyCoveredPersons([], [row("z", "d1")]).has("z")).toBe(false);
  });
});

describe("presenceEntriesWithStandIns", () => {
  it("keeps the in-scope rows and adds closed valid stand-ins", () => {
    const entries = presenceEntriesWithStandIns([row("p", "d1", false, false)], 2);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({ endTime: null, isInvalid: false });
    expect(entries[1].endTime).not.toBeNull();
    expect(entries[1].isInvalid).toBe(false);
    expect(entries[2].endTime).not.toBeNull();
  });

  it("never produces an open entry for out-of-scope time", () => {
    const entries = presenceEntriesWithStandIns([], 3);
    expect(entries.every((e) => e.endTime !== null)).toBe(true);
  });

  it("adds nothing for a zero count", () => {
    expect(presenceEntriesWithStandIns([], 0)).toEqual([]);
  });
});

describe("distinctEmployeeIds", () => {
  it("returns each id once, sorted", () => {
    expect(distinctEmployeeIds([row("b", "d"), row("a", "d"), row("b", "d2")])).toEqual(["a", "b"]);
  });
});
