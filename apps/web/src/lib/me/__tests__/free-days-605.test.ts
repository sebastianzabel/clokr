import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  antragTypeCode,
  freeDaysLabel,
  showFreeDays,
  OVERTIME_COMP_REQUEST_HREF,
} from "../free-days";

describe("showFreeDays (Issue #605)", () => {
  it("shows when the API served a figure, even with a negative live total (confirmed > 0)", () => {
    expect(showFreeDays({ freeDaysEquivalent: 1.6 })).toBe(true);
  });
  it("hides when the API serves no figure, even with a positive live total (confirmed <= 0, track-only, no leave type, no daily Soll)", () => {
    expect(showFreeDays({ freeDaysEquivalent: null })).toBe(false);
    expect(showFreeDays({})).toBe(false);
    expect(showFreeDays({ freeDaysEquivalent: 0 })).toBe(false);
    expect(showFreeDays(null)).toBe(false);
  });
});

describe("freeDaysLabel", () => {
  it("uses one decimal and a decimal comma", () => {
    expect(freeDaysLabel(1.5)).toBe("etwa 1,5 freie Tage");
    expect(freeDaysLabel(2)).toBe("etwa 2,0 freie Tage");
  });
});

describe("request link", () => {
  it("points at the request dialog preset by leave type code", () => {
    expect(OVERTIME_COMP_REQUEST_HREF).toBe("/ich/abwesenheiten?antrag=ausgleich");
    expect(antragTypeCode("ausgleich")).toBe("OVERTIME_COMP");
    expect(antragTypeCode("urlaub")).toBe("VACATION");
    expect(antragTypeCode("krank")).toBe("SICK");
    expect(antragTypeCode("Überstundenausgleich")).toBeNull();
    expect(antragTypeCode(null)).toBeNull();
  });

  it("the Konto page renders the conversion and button only behind showFreeDays", () => {
    const src = readFileSync("src/routes/(app)/ich/konto/+page.svelte", "utf8");
    expect(src).toMatch(
      /\{#if overtime && showFreeDays\(overtime\)\}[\s\S]*Freizeitausgleich beantragen/,
    );
    // the page never converts on its own
    expect(src).not.toMatch(/\/\s*480|dailySoll/);
  });
});
