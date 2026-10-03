// Issue #468 (D-12, A-2) — pure helper tests for the Elternzeit-Kürzung web module. No svelte
// import, no $api/$stores mocks needed — same "pure, dependency-free module" convention as
// storno.test.ts / vacation-balance.test.ts in this directory.

import { describe, it, expect } from "vitest";
import {
  showsParentalReductionAction,
  formatDays,
  PARENTAL_REDUCTION_HINT,
  PARENTAL_REDUCTION_PERMISSION,
  type ParentalReductionCandidate,
} from "../parental-reduction";

const PERMITTED = { permissions: [PARENTAL_REDUCTION_PERMISSION] };
const UNPERMITTED = { permissions: ["some-other:permission:SCOPE"] };

function req(overrides: Partial<ParentalReductionCandidate> = {}): ParentalReductionCandidate {
  return { typeCode: "PARENTAL", status: "APPROVED", ...overrides };
}

describe("showsParentalReductionAction", () => {
  it("true for PARENTAL + APPROVED + permission held", () => {
    expect(showsParentalReductionAction(req(), PERMITTED)).toBe(true);
  });

  it("false for VACATION + APPROVED, even with the permission", () => {
    expect(showsParentalReductionAction(req({ typeCode: "VACATION" }), PERMITTED)).toBe(false);
  });

  it("false for PARENTAL + PENDING", () => {
    expect(showsParentalReductionAction(req({ status: "PENDING" }), PERMITTED)).toBe(false);
  });

  it("false for PARENTAL + CANCELLATION_REQUESTED", () => {
    expect(showsParentalReductionAction(req({ status: "CANCELLATION_REQUESTED" }), PERMITTED)).toBe(
      false,
    );
  });

  it("false for PARENTAL + APPROVED without the permission", () => {
    expect(showsParentalReductionAction(req(), UNPERMITTED)).toBe(false);
  });

  it("false for a null user (fail-closed)", () => {
    expect(showsParentalReductionAction(req(), null)).toBe(false);
  });
});

describe("formatDays", () => {
  it("formats a whole number with no decimal part", () => {
    expect(formatDays(30)).toBe("30");
    expect(formatDays(7)).toBe("7");
    expect(formatDays(0)).toBe("0");
  });

  it("formats a fractional day with a German decimal comma", () => {
    expect(formatDays(7.5)).toBe("7,5");
  });

  it("rounds to two decimal places before formatting", () => {
    expect(formatDays(23.004)).toBe("23");
  });
});

describe("PARENTAL_REDUCTION_HINT", () => {
  it("quotes § 17 Abs. 1 BEEG verbatim", () => {
    expect(PARENTAL_REDUCTION_HINT).toBe(
      "Die Kürzung wirkt nur, wenn sie dem Mitarbeiter gegenüber erklärt wurde (§ 17 Abs. 1 BEEG).",
    );
  });
});
