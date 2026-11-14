// Issue #943 — the dialog's break and working time equal the list's for an unchanged entry.
import { describe, it, expect } from "vitest";
import { dialogBreakMinutes, dialogNetMinutes, usesLegacyBreak } from "../entry-dialog-figures";

describe("entry dialog figures (Issue #943)", () => {
  it("an entry with only legacy breakMinutes counts them (09:30-20:10, 45 Min. = 9:55)", () => {
    const input = { slots: [], storedBreakRowCount: 0, storedBreakMinutes: 45 };
    expect(usesLegacyBreak(input)).toBe(true);
    const br = dialogBreakMinutes(input);
    expect(br).toBe(45);
    expect(dialogNetMinutes("09:30", "20:10", true, br)).toBe(9 * 60 + 55);
  });

  it("an entry with Break rows counts the slots (same figure as the list)", () => {
    const input = {
      slots: [
        { start: "12:00", end: "12:30" },
        { start: "15:00", end: "15:15" },
      ],
      storedBreakRowCount: 2,
      storedBreakMinutes: 45,
    };
    expect(usesLegacyBreak(input)).toBe(false);
    const br = dialogBreakMinutes(input);
    expect(br).toBe(45);
    expect(dialogNetMinutes("09:30", "20:10", true, br)).toBe(9 * 60 + 55);
  });

  it("a slot added to a legacy entry replaces the flat amount", () => {
    const input = {
      slots: [{ start: "12:00", end: "12:20" }],
      storedBreakRowCount: 0,
      storedBreakMinutes: 45,
    };
    expect(dialogBreakMinutes(input)).toBe(20);
  });

  it("a new entry and a running entry", () => {
    expect(dialogBreakMinutes({ slots: [], storedBreakRowCount: 0, storedBreakMinutes: 0 })).toBe(
      0,
    );
    expect(dialogNetMinutes("09:00", "17:00", false, 0)).toBeNull();
  });
});
