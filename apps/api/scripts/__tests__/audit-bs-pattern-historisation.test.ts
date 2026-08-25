/**
 * Phase 103 Plan 02 (Wave-0 fact-finding) — classification tests for the read-only
 * BS-pattern historisation audit (audit-bs-pattern-historisation.ts).
 *
 * Pure-function, DB-free: synthetic in-memory PatternRow fixtures only. The run-guard
 * (`import.meta.url === pathToFileURL(process.argv[1]).href`) in the script under test is
 * what makes this import side-effect-free — if that guard is ever removed this test will
 * hang or fail on a missing DATABASE_URL, which is intentional (mirrors
 * audit-saldo-chain-integrity.test.ts / audit-break-consistency.test.ts).
 */
import { describe, it, expect } from "vitest";
import { classifyPatternRows, truncId, type PatternRow } from "../audit-bs-pattern-historisation";

function mk(overrides: Partial<PatternRow> & { id: string }): PatternRow {
  return {
    id: overrides.id,
    validFrom: overrides.validFrom ?? new Date("2026-01-01T00:00:00.000Z"),
    validUntil: overrides.validUntil ?? null,
    isActive: overrides.isActive ?? true,
    createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
    daysOfWeek: overrides.daysOfWeek ?? [],
    blockWeeks: overrides.blockWeeks ?? [],
    blockYear: overrides.blockYear ?? null,
  };
}

describe("audit-bs-pattern-historisation classifyPatternRows (pure, DB-free)", () => {
  it("truncId returns the first 8 characters", () => {
    expect(truncId("f71c055c-1111-2222-3333-444444444444")).toBe("f71c055c");
    expect(truncId("f71c055c-1111-2222-3333-444444444444").length).toBe(8);
  });

  it("single active row with a closed history -> no flags", () => {
    const rows = [
      mk({
        id: "old1",
        isActive: false,
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
        validUntil: new Date("2026-04-30T00:00:00.000Z"), // properly closed
        daysOfWeek: [0, 2],
      }),
      mk({
        id: "new1",
        isActive: true,
        validFrom: new Date("2026-05-01T00:00:00.000Z"),
        validUntil: null,
        daysOfWeek: [1],
      }),
    ];
    expect(classifyPatternRows(rows).flags).toEqual([]);
  });

  it("two active rows -> MULTI_ACTIVE", () => {
    const rows = [
      mk({
        id: "a",
        isActive: true,
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
        validUntil: null,
        daysOfWeek: [5], // Sat -- deliberately disjoint from b, isolates MULTI_ACTIVE
      }),
      mk({
        id: "b",
        isActive: true,
        validFrom: new Date("2026-06-01T00:00:00.000Z"),
        validUntil: null,
        daysOfWeek: [1],
      }),
    ];
    const { flags } = classifyPatternRows(rows);
    expect(flags).toContain("MULTI_ACTIVE");
    expect(flags).not.toContain("OVERLAPPING_CLAIM"); // disjoint weekdays -> isolated signal
  });

  it("inactive row with validUntil: null -> UNCLOSED_HISTORY", () => {
    const rows = [
      mk({
        id: "old",
        isActive: false,
        validFrom: new Date("2026-05-01T00:00:00.000Z"),
        validUntil: null, // never closed -- the 103-BEFUND.md anomaly shape
        daysOfWeek: [0, 2],
      }),
      mk({
        id: "new",
        isActive: true,
        validFrom: new Date("2026-08-12T00:00:00.000Z"),
        validUntil: null,
        daysOfWeek: [1],
      }),
    ];
    expect(classifyPatternRows(rows).flags).toEqual(["UNCLOSED_HISTORY"]);
  });

  it("two rows with identical validFrom -> TIED_VALIDFROM (the documented f71c055c shape)", () => {
    const tiedDate = new Date("2026-05-01T00:00:00.000Z");
    const rows = [
      mk({ id: "r1", isActive: false, validFrom: tiedDate, validUntil: null, daysOfWeek: [0, 2] }),
      mk({ id: "r2", isActive: true, validFrom: tiedDate, validUntil: null, daysOfWeek: [1] }),
    ];
    const { flags } = classifyPatternRows(rows);
    expect(flags).toContain("TIED_VALIDFROM");
    // r1 is both inactive AND unclosed in this fixture -- both flags legitimately co-occur,
    // matching the real prod shape from 103-BEFUND.md exactly (two rows, one anomaly each).
    expect(flags).toContain("UNCLOSED_HISTORY");
  });

  it("two active rows with intersecting daysOfWeek and overlapping validity -> OVERLAPPING_CLAIM", () => {
    const rows = [
      mk({
        id: "x",
        isActive: true,
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
        validUntil: null,
        daysOfWeek: [0, 2], // Mo, Mi
      }),
      mk({
        id: "y",
        isActive: true,
        validFrom: new Date("2026-06-01T00:00:00.000Z"),
        validUntil: null,
        daysOfWeek: [2, 4], // Mi, Fr -- shares Mi (2) with x
      }),
    ];
    const { flags } = classifyPatternRows(rows);
    expect(flags).toContain("OVERLAPPING_CLAIM");
    expect(flags).toContain("MULTI_ACTIVE"); // legitimately co-occurs -- both rows are active
  });

  it("two active rows with non-overlapping validity ranges -> NOT OVERLAPPING_CLAIM despite identical daysOfWeek", () => {
    const rows = [
      mk({
        id: "x",
        isActive: true,
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
        validUntil: new Date("2026-04-30T00:00:00.000Z"), // closed BEFORE y starts
        daysOfWeek: [0, 2],
      }),
      mk({
        id: "y",
        isActive: true,
        validFrom: new Date("2026-05-01T00:00:00.000Z"),
        validUntil: null,
        daysOfWeek: [0, 2],
      }),
    ];
    const { flags } = classifyPatternRows(rows);
    expect(flags).not.toContain("OVERLAPPING_CLAIM");
    expect(flags).toContain("MULTI_ACTIVE"); // isActive is a raw-field flag, unaffected by dates
  });

  it("a daysOfWeek pattern landing inside another's blockWeeks/blockYear -> OVERLAPPING_CLAIM", () => {
    // Any Monday computed for ISO week 20/2026 is a Monday by construction (isoWeekMonday),
    // so a daysOfWeek:[0] (Mo) pattern always lands on the first of blockWeekDates' 5 dates,
    // regardless of which actual calendar date that Monday is.
    const rows = [
      mk({
        id: "weekday",
        isActive: true,
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
        validUntil: null,
        daysOfWeek: [0], // every Monday
      }),
      mk({
        id: "block",
        isActive: true,
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
        validUntil: null,
        blockWeeks: [20],
        blockYear: 2026,
      }),
    ];
    const { flags } = classifyPatternRows(rows);
    expect(flags).toContain("OVERLAPPING_CLAIM");
  });

  it("a weekend-only daysOfWeek pattern does NOT overlap a blockWeeks pattern (block weeks are Mo-Fr only)", () => {
    const rows = [
      mk({
        id: "weekend",
        isActive: true,
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
        validUntil: null,
        daysOfWeek: [5, 6], // Sa, So
      }),
      mk({
        id: "block",
        isActive: true,
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
        validUntil: null,
        blockWeeks: [20],
        blockYear: 2026,
      }),
    ];
    const { flags } = classifyPatternRows(rows);
    expect(flags).not.toContain("OVERLAPPING_CLAIM");
  });

  it("two blockWeeks patterns sharing a (blockYear, week) -> OVERLAPPING_CLAIM", () => {
    const rows = [
      mk({
        id: "block1",
        isActive: true,
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
        validUntil: null,
        blockWeeks: [20, 21],
        blockYear: 2026,
      }),
      mk({
        id: "block2",
        isActive: true,
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
        validUntil: null,
        blockWeeks: [21, 22],
        blockYear: 2026,
      }),
    ];
    const { flags } = classifyPatternRows(rows);
    expect(flags).toContain("OVERLAPPING_CLAIM");
  });

  it("two blockWeeks patterns in different blockYears never overlap even with the same week number", () => {
    const rows = [
      mk({
        id: "block1",
        isActive: true,
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
        validUntil: null,
        blockWeeks: [20],
        blockYear: 2026,
      }),
      mk({
        id: "block2",
        isActive: true,
        validFrom: new Date("2027-01-01T00:00:00.000Z"),
        validUntil: null,
        blockWeeks: [20],
        blockYear: 2027,
      }),
    ];
    const { flags } = classifyPatternRows(rows);
    expect(flags).not.toContain("OVERLAPPING_CLAIM");
  });

  it("no rows -> no flags (degenerate input)", () => {
    expect(classifyPatternRows([]).flags).toEqual([]);
  });

  it("a single row on its own is never MULTI_ACTIVE, TIED_VALIDFROM, or OVERLAPPING_CLAIM", () => {
    const rows = [
      mk({
        id: "solo",
        isActive: true,
        validFrom: new Date("2026-05-01T00:00:00.000Z"),
        validUntil: null,
        daysOfWeek: [0, 2],
      }),
    ];
    expect(classifyPatternRows(rows).flags).toEqual([]);
  });
});
