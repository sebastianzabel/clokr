// Issue #482 (owner decision 2026-10-04) — pins the display-mirror helpers against the four-step
// chain the server's resolveVacationBaseDays() resolves authoritatively (G-7: this module
// computes no entitlement itself).

import { describe, it, expect } from "vitest";
import {
  vacationBaseDefaultFor,
  annualVacationDaysPayload,
  vacationBaseDefaultPlaceholder,
} from "../vacation-base-default";

describe("vacationBaseDefaultFor (Issue #482)", () => {
  it("AZUBI -> the Azubi-Standard", () => {
    expect(vacationBaseDefaultFor("AZUBI", 30, 22.5)).toBe(22.5);
  });

  it.each(["VOLLZEIT", "TEILZEIT", "MINIJOB"] as const)(
    "%s -> the Mandanten-Standard",
    (classification) => {
      expect(vacationBaseDefaultFor(classification, 30, 22.5)).toBe(30);
    },
  );

  it("a null input passes through as null", () => {
    expect(vacationBaseDefaultFor("AZUBI", 30, null)).toBeNull();
    expect(vacationBaseDefaultFor("VOLLZEIT", null, 22.5)).toBeNull();
  });
});

describe("annualVacationDaysPayload (Issue #482, G-5)", () => {
  it("null -> null", () => {
    expect(annualVacationDaysPayload(null, "AZUBI", 30, 22.5)).toBeNull();
  });

  it("AZUBI 22.5 with Azubi-Standard 22.5 -> null (collapses to the own Standard)", () => {
    expect(annualVacationDaysPayload(22.5, "AZUBI", 30, 22.5)).toBeNull();
  });

  it("AZUBI 25 -> 25 (an explicit override stays explicit)", () => {
    expect(annualVacationDaysPayload(25, "AZUBI", 30, 22.5)).toBe(25);
  });

  it("VOLLZEIT 30 with tenant default 30 -> null (#435 D-13 regression)", () => {
    expect(annualVacationDaysPayload(30, "VOLLZEIT", 30, 22.5)).toBeNull();
  });

  it("VOLLZEIT 22.5 (equals the apprentice value, not the tenant one) -> 22.5", () => {
    expect(annualVacationDaysPayload(22.5, "VOLLZEIT", 30, 22.5)).toBe(22.5);
  });

  it("AZUBI 20 with an unknown (null) Azubi-Standard -> 20 (never collapse against unknown)", () => {
    expect(annualVacationDaysPayload(20, "AZUBI", 30, null)).toBe(20);
  });
});

describe("vacationBaseDefaultPlaceholder (Issue #482, AC-6)", () => {
  it("AZUBI, 30, 22.5 -> 'Azubi-Standard (22,5)'", () => {
    expect(vacationBaseDefaultPlaceholder("AZUBI", 30, 22.5)).toBe("Azubi-Standard (22,5)");
  });

  it("VOLLZEIT, 30, 22.5 -> 'Mandanten-Standard (30)'", () => {
    expect(vacationBaseDefaultPlaceholder("VOLLZEIT", 30, 22.5)).toBe("Mandanten-Standard (30)");
  });
});
