import { describe, it, expect } from "vitest";
import { breakBadgeClass, breakBadgeLabel, isUnconfirmedBreak } from "../break-badge";

// Phase 112 (GitHub issue #115). These tests are the proof that lifting the mapping out of
// routes/(app)/time-entries/+page.svelte changed nothing. The class names and the German copy
// are a UI-SPEC contract from Phase 93 (BREAK-07); pinning them makes a future "small copy
// tweak" visible instead of silent.

describe("breakBadgeClass", () => {
  it("Test 1: the three known states map to their Phase 93 classes", () => {
    expect(breakBadgeClass("CONFIRMED")).toBe("badge-green");
    expect(breakBadgeClass("WAIVED")).toBe("badge-gray");
    expect(breakBadgeClass("AUTO")).toBe("badge-yellow");
  });

  it("Test 2: fallback pin — anything unknown is treated as AUTO", () => {
    expect(breakBadgeClass(undefined)).toBe("badge-yellow");
    expect(breakBadgeClass(null)).toBe("badge-yellow");
    expect(breakBadgeClass("SOMETHING_NEW")).toBe("badge-yellow");
  });
});

describe("breakBadgeLabel", () => {
  it("Test 3: the three known states map to their German labels", () => {
    expect(breakBadgeLabel("CONFIRMED")).toBe("Pause bestätigt");
    expect(breakBadgeLabel("WAIVED")).toBe("Durchgearbeitet");
    expect(breakBadgeLabel("AUTO")).toBe("Pause unbestätigt");
  });

  it("Test 4: fallback pin — anything unknown reads as unbestätigt", () => {
    expect(breakBadgeLabel(undefined)).toBe("Pause unbestätigt");
    expect(breakBadgeLabel(null)).toBe("Pause unbestätigt");
    expect(breakBadgeLabel("SOMETHING_NEW")).toBe("Pause unbestätigt");
  });
});

describe("isUnconfirmedBreak", () => {
  it("Test 5: an open AUTO entry is actionable", () => {
    expect(isUnconfirmedBreak({ breakStatus: "AUTO" })).toBe(true);
    expect(isUnconfirmedBreak({ breakStatus: "AUTO", isLocked: false })).toBe(true);
  });

  it("Test 6: a locked AUTO entry is NOT actionable — a closed month is immutable", () => {
    expect(isUnconfirmedBreak({ breakStatus: "AUTO", isLocked: true })).toBe(false);
  });

  it("Test 7: confirmed and waived entries are not unconfirmed", () => {
    expect(isUnconfirmedBreak({ breakStatus: "CONFIRMED" })).toBe(false);
    expect(isUnconfirmedBreak({ breakStatus: "WAIVED" })).toBe(false);
  });

  it("Test 8: asymmetry with the label fallback is deliberate — no breakStatus is NOT unconfirmed", () => {
    // breakBadgeLabel would call this "Pause unbestätigt" (its AUTO fallback), but an entry
    // that carries no status at all must never be surfaced as actionable.
    expect(breakBadgeLabel(undefined)).toBe("Pause unbestätigt");
    expect(isUnconfirmedBreak({})).toBe(false);
    expect(isUnconfirmedBreak({ breakStatus: null })).toBe(false);
  });
});
