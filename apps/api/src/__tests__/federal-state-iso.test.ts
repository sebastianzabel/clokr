import { describe, it, expect } from "vitest";
import { FederalState } from "@clokr/db";
import {
  federalStateToIso,
  isoToFederalState,
  ALL_FEDERAL_STATES,
} from "../utils/federal-state-iso";

describe("federal-state-iso mapping", () => {
  // Reference table of all 16 Bundesländer (ISO-3166-2:DE codes).
  const cases: Array<[FederalState, string]> = [
    ["BADEN_WUERTTEMBERG" as FederalState, "DE-BW"],
    ["BAYERN" as FederalState, "DE-BY"],
    ["BERLIN" as FederalState, "DE-BE"],
    ["BRANDENBURG" as FederalState, "DE-BB"],
    ["BREMEN" as FederalState, "DE-HB"],
    ["HAMBURG" as FederalState, "DE-HH"],
    ["HESSEN" as FederalState, "DE-HE"],
    ["MECKLENBURG_VORPOMMERN" as FederalState, "DE-MV"],
    ["NIEDERSACHSEN" as FederalState, "DE-NI"],
    ["NORDRHEIN_WESTFALEN" as FederalState, "DE-NW"],
    ["RHEINLAND_PFALZ" as FederalState, "DE-RP"],
    ["SAARLAND" as FederalState, "DE-SL"],
    ["SACHSEN" as FederalState, "DE-SN"],
    ["SACHSEN_ANHALT" as FederalState, "DE-ST"],
    ["SCHLESWIG_HOLSTEIN" as FederalState, "DE-SH"],
    ["THUERINGEN" as FederalState, "DE-TH"],
  ];

  describe("federalStateToIso", () => {
    it.each(cases)("maps %s → %s", (fs, iso) => {
      expect(federalStateToIso(fs)).toBe(iso);
    });

    it("covers all 16 federal states", () => {
      expect(cases.length).toBe(16);
    });
  });

  describe("isoToFederalState", () => {
    it.each(cases)("maps %s → %s", (fs, iso) => {
      expect(isoToFederalState(iso)).toBe(fs);
    });

    it("returns null for unknown ISO code (does not throw)", () => {
      expect(isoToFederalState("DE-XX")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(isoToFederalState("")).toBeNull();
    });

    it("returns null for completely unrelated string", () => {
      expect(isoToFederalState("FR-75")).toBeNull();
    });
  });

  describe("round-trip", () => {
    it.each(cases)("round-trips %s correctly", (fs) => {
      const iso = federalStateToIso(fs);
      expect(isoToFederalState(iso)).toBe(fs);
    });
  });

  describe("ALL_FEDERAL_STATES", () => {
    it("exports all 16 enum values", () => {
      expect(ALL_FEDERAL_STATES.length).toBe(16);
    });

    it("contains each cased state exactly once", () => {
      const set = new Set(ALL_FEDERAL_STATES);
      expect(set.size).toBe(16);
      for (const [fs] of cases) {
        expect(set.has(fs)).toBe(true);
      }
    });
  });
});
