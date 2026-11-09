// Issue #843 (D-843-01 block 7): the one search normaliser.
import { describe, it, expect } from "vitest";
import { normaliseSearch, matchesSearch } from "../search";

describe("normaliseSearch", () => {
  it("trims and lower-cases with German rules", () => {
    expect(normaliseSearch("  Müller ")).toBe("müller");
    expect(normaliseSearch("ÄRZTIN")).toBe("ärztin");
  });

  it("turns a blank string into the empty string", () => {
    expect(normaliseSearch("   ")).toBe("");
  });
});

describe("matchesSearch", () => {
  it("finds a substring regardless of case and surrounding whitespace", () => {
    expect(matchesSearch("Ärztin Nord", "ärztin")).toBe(true);
    expect(matchesSearch("Salon Nord", "  NORD ")).toBe(true);
  });

  it("matches everything for an empty or blank query", () => {
    expect(matchesSearch("Salon Süd", "")).toBe(true);
    expect(matchesSearch("Salon Süd", "   ")).toBe(true);
  });

  it("rejects text that does not contain the query", () => {
    expect(matchesSearch("Salon Süd", "nord")).toBe(false);
  });
});
