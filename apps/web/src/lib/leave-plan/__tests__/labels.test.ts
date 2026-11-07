// Issue #835 — the planner wording is German, du-form, and never a control value.
import { describe, it, expect } from "vitest";
import {
  ADD_WISH_LABEL,
  DAY_LOAD_HINT,
  DAY_LOAD_LABEL,
  FORECAST_WARNING,
  HOLIDAY_LABEL,
  NO_WISHES_LABEL,
  PENDING_REASON_LABELS,
  PLAN_STATUS_LABELS,
  ROW_KIND_LABELS,
  ROW_STATE_LABELS,
  WISH_CONFLICT_HINT,
  WISH_FOREIGN_PLAN_HINT,
  WISH_READ_ONLY_HINT,
  WISH_TAKEN_OVER_HINT,
  forecastLabel,
  planStatusLabel,
  rowTypeLabel,
} from "../labels";

const ALL_TEXTS = [
  ...Object.values(PLAN_STATUS_LABELS),
  ...Object.values(ROW_STATE_LABELS),
  ...Object.values(ROW_KIND_LABELS),
  ...Object.values(PENDING_REASON_LABELS),
  HOLIDAY_LABEL,
  DAY_LOAD_LABEL,
  DAY_LOAD_HINT,
  FORECAST_WARNING,
  WISH_CONFLICT_HINT,
  WISH_TAKEN_OVER_HINT,
  WISH_FOREIGN_PLAN_HINT,
  WISH_READ_ONLY_HINT,
  NO_WISHES_LABEL,
  ADD_WISH_LABEL,
  forecastLabel(3),
];

describe("planner wording", () => {
  it("never uses the formal „Sie“", () => {
    for (const text of ALL_TEXTS) {
      expect(text).not.toMatch(/\bSie\b|\bIhr\b|\bIhre\b/);
    }
  });

  it("carries the fixed texts", () => {
    expect(PLAN_STATUS_LABELS.OPEN).toBe("Offen");
    expect(PLAN_STATUS_LABELS.TAKEN_OVER).toBe("Übernommen");
    expect(PLAN_STATUS_LABELS.PARTIALLY_TAKEN_OVER).toBe("Teilweise übernommen");
    expect(ROW_STATE_LABELS.GESETZT).toBe("gesetzt");
    expect(ROW_STATE_LABELS.BEANTRAGT).toBe("beantragt");
    expect(ROW_STATE_LABELS.WISH).toBe("Wunsch");
    expect(DAY_LOAD_LABEL).toBe("Urlaub");
    expect(DAY_LOAD_HINT).toBe(
      "Genehmigt, beantragt und gewünscht – ohne Krankheit, Berufsschule und Betriebsurlaub",
    );
    expect(PENDING_REASON_LABELS.OWN_WISH).toBe(
      "Eigener Wunsch – wartet auf eine zweite Genehmigung",
    );
    expect(PENDING_REASON_LABELS.OUTSIDE_APPROVE_REACH).toBe(
      "Wartet auf Genehmigung durch eine berechtigte Person",
    );
    expect(PENDING_REASON_LABELS.APPROVAL_REFUSED).toBe(
      "Genehmigung gescheitert – erneut übernehmen",
    );
    expect(FORECAST_WARNING).toBe("Der Plan übersteigt den Anspruch");
  });

  it("derives the plan status label from status and partial takeover", () => {
    expect(planStatusLabel({ status: "OPEN", partiallyTakenOver: false })).toBe("Offen");
    expect(planStatusLabel({ status: "OPEN", partiallyTakenOver: true })).toBe(
      "Teilweise übernommen",
    );
    expect(planStatusLabel({ status: "TAKEN_OVER", partiallyTakenOver: false })).toBe("Übernommen");
  });

  it("formats the forecast with a German decimal comma", () => {
    expect(forecastLabel(12.5)).toBe("Noch 12,5 Tage nach Plan");
    expect(forecastLabel(3)).toBe("Noch 3 Tage nach Plan");
  });
});

describe("rowTypeLabel", () => {
  it("uses the leave type display helper for a visible type", () => {
    expect(rowTypeLabel({ kind: "LEAVE", typeCode: "VACATION" })).toBe("Urlaub");
    expect(rowTypeLabel({ kind: "LEAVE", typeCode: "SPECIAL" })).toBe("Sonderurlaub");
  });

  it("is neutral „abwesend“ for a masked type", () => {
    expect(rowTypeLabel({ kind: "LEAVE", typeCode: null })).toBe("abwesend");
    expect(rowTypeLabel({ kind: "ABSENCE", typeCode: null })).toBe("abwesend");
  });

  it("names the Betriebsurlaub by its kind", () => {
    expect(rowTypeLabel({ kind: "COMPANY_SHUTDOWN", typeCode: null })).toBe("Betriebsurlaub");
  });

  it("falls back to the kind label for a code the helper does not know", () => {
    expect(rowTypeLabel({ kind: "ABSENCE", typeCode: "VOCATIONAL_SCHOOL" })).toBe("Abwesenheit");
  });
});
