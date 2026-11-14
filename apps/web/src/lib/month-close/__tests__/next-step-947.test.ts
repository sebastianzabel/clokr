// Issue #947 - the decision logic and the texts of the month close for a reader who may not see the days.
import { describe, expect, it } from "vitest";
import {
  CLOSE_BLIND_LABEL,
  CLOSE_LABEL,
  READY_KPI,
  autoCloseHintText,
  closeLabelFor,
  closesBlind,
  nextStepText,
  shortName,
  withheldGapPersons,
} from "$lib/month-close/next-step";

const berta = {
  employeeName: "Berta Arndt",
  dayDetailsWithheld: true,
  missingDates: [],
  missingDateCount: 21,
};
const visible = {
  employeeName: "Carl Dorn",
  dayDetailsWithheld: false,
  missingDates: ["2026-01-05"],
  missingDateCount: 1,
};
const withheldZero = { employeeName: "Eva Fuchs", dayDetailsWithheld: true, missingDateCount: 0 };

describe("next step for withheld gaps", () => {
  it("names the person and the count", () => {
    expect(nextStepText(withheldGapPersons([berta, visible, withheldZero]))).toBe(
      "Bitte die Salonleitung, die Zeiten von Berta A. zu prüfen (21 Tage ohne Eintrag).",
    );
  });

  it("joins several persons and sums the days", () => {
    const two = withheldGapPersons([
      berta,
      { ...berta, employeeName: "Hans Ixen", missingDateCount: 1 },
    ]);
    expect(nextStepText(two)).toBe(
      "Bitte die Salonleitung, die Zeiten von Berta A. und Hans I. zu prüfen (zusammen 22 Tage ohne Eintrag).",
    );
  });

  it("is empty when nothing is withheld", () => {
    expect(nextStepText(withheldGapPersons([visible, withheldZero]))).toBe("");
  });

  it("shortens names", () => {
    expect(shortName("Berta Arndt")).toBe("Berta A.");
    expect(shortName("Berta")).toBe("Berta");
  });
});

describe("closing blind", () => {
  it("is blind only for withheld rows with a gap count above zero", () => {
    expect(closesBlind([berta])).toBe(true);
    expect(closesBlind([visible])).toBe(false);
    expect(closesBlind([withheldZero])).toBe(false);
    expect(closesBlind([])).toBe(false);
  });

  it("switches the button label", () => {
    expect(closeLabelFor([berta, visible])).toBe(CLOSE_BLIND_LABEL);
    expect(closeLabelFor([visible])).toBe(CLOSE_LABEL);
  });
});

describe("texts", () => {
  it("explains why the automatic close is over and what to do", () => {
    expect(autoCloseHintText(15, true)).toContain("ist für diesen Monat vorbei");
    expect(autoCloseHintText(15, true)).toContain("Schließe die offenen Monate selbst ab");
    expect(autoCloseHintText(15, true)).not.toContain("nur noch manuell");
    expect(autoCloseHintText(10, true)).toBe(
      "Der automatische Abschluss versucht es noch bis zum 10. des Monats.",
    );
    expect(autoCloseHintText(15, false)).toBeNull();
  });

  it("reads the ready KPI as label and caption", () => {
    expect(READY_KPI).toEqual({
      label: "Bereit",
      explanation: "Monate, in denen alle Personen bereit sind",
    });
  });
});
