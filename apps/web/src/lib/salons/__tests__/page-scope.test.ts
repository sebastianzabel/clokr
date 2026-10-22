// Issue #558 D-03/D-04 — the pure decisions of the shared page-scope layer. It adds no rule of its
// own: whether a page filters is `teamSalonFilter`, and these cases pin that the page-facing names
// are that very function and that the label wording follows the filter.
import { describe, expect, it, vi } from "vitest";

// The store imports the api client, which pulls in the auth store and its localStorage bootstrap;
// a stand-in (as in team-view.test.ts) keeps this file free of that.
vi.mock("$api/client", () => ({
  api: { get: vi.fn() },
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message = "err",
    ) {
      super(message);
    }
  },
}));
vi.mock("$lib/utils/logger", () => ({ clientLogger: { warn: vi.fn(), error: vi.fn() } }));

import { ApiError } from "$api/client";
import { teamSalonFilter, withSalonId as teamWithSalonId } from "$lib/dashboard/team-view";
import {
  ALL_SALONS_BLOCK_NOTE,
  DATEV_ALL_SALONS_NOTE,
  EXPORT_NO_STAMMSALON_NOTE,
  HOME_SALON_CHANGE_NOTE,
  PERSON_SALDO_BY_HOME_SALON_LABEL,
  PERSON_SALDO_NOT_SPLIT_LABEL,
  PERSON_VALUES_NOT_SPLIT_LABEL,
  SALON_CSV_PERSONS_NOTE,
  SALON_EXPORT_PERSONS_NOTE,
  SALON_HELPERS_HEADING,
  SALON_HELPERS_REACH_NOTE,
  SALON_HOME_PERSONS_NOTE,
  SALON_PERIOD_END_PERSONS_NOTE,
  SALON_SOLL_NOT_ATTRIBUTABLE_NOTE,
  SALON_VIEW_UNAVAILABLE_TEXT,
  SALON_WORKED_DELTA_NOTE,
  SALON_WORKED_LABEL,
  isSalonFilterRejected,
  salonNameLabel,
  salonPageFilter,
  salonScopeLabel,
  withSalonId,
  withoutHomeSalonNote,
} from "../page-scope";

const A = { id: "salon-a", name: "Salon Nord" };
const B = { id: "salon-b", name: "Salon Ost" };

describe("salonPageFilter — the same decision as the dashboard, under a page name", () => {
  it("is the very function of teamSalonFilter", () => {
    expect(salonPageFilter).toBe(teamSalonFilter);
    expect(withSalonId).toBe(teamWithSalonId);
  });

  it("a single-salon tenant sends no salonId although the store preselects its salon", () => {
    const state = { isMultiSalon: false, salons: [A], selection: A.id };
    expect(salonPageFilter(state)).toBeNull();
    expect(salonScopeLabel(state)).toBeNull();
  });

  it("a caller who reaches one salon of a multi-salon tenant sends no salonId", () => {
    const state = { isMultiSalon: true, salons: [A], selection: A.id };
    expect(salonPageFilter(state)).toBeNull();
    expect(salonScopeLabel(state)).toBeNull();
  });

  it("a stale selection sends no salonId", () => {
    const state = { isMultiSalon: true, salons: [A, B], selection: "gone" };
    expect(salonPageFilter(state)).toBeNull();
    expect(salonScopeLabel(state)).toBe("Alle Salons");
  });

  it("a request path without a salon stays untouched", () => {
    expect(withSalonId("/employees?includeAnonymized=true", null)).toBe(
      "/employees?includeAnonymized=true",
    );
    expect(withSalonId("/employees", A.id)).toBe("/employees?salonId=salon-a");
  });
});

describe("salonScopeLabel — German wording of what the page refers to", () => {
  it('options plus "Alle Salons" say „Alle Salons“', () => {
    const state = { isMultiSalon: true, salons: [A, B], selection: "ALL" };
    expect(salonPageFilter(state)).toBeNull();
    expect(salonScopeLabel(state)).toBe("Alle Salons");
  });

  it("options plus a chosen salon name it", () => {
    const state = { isMultiSalon: true, salons: [A, B], selection: A.id };
    expect(salonPageFilter(state)).toBe(A.id);
    expect(salonScopeLabel(state)).toBe("Salon: Salon Nord");
    expect(salonNameLabel("Ost")).toBe("Salon: Ost");
  });

  it("a context that is not loaded says nothing", () => {
    expect(salonScopeLabel({ isMultiSalon: false, salons: [], selection: null })).toBeNull();
  });
});

describe("isSalonFilterRejected — only the one 404 is a calm state", () => {
  it("is true for an ApiError 404 and false for any other failure", () => {
    expect(isSalonFilterRejected(new ApiError(404, "err"))).toBe(true);
    expect(isSalonFilterRejected(new ApiError(500, "err"))).toBe(false);
    expect(isSalonFilterRejected(new ApiError(403, "err"))).toBe(false);
    expect(isSalonFilterRejected(new Error("net"))).toBe(false);
    expect(isSalonFilterRejected(null)).toBe(false);
  });
});

describe("shared texts", () => {
  it("are German and address the reader with Sie", () => {
    expect(SALON_VIEW_UNAVAILABLE_TEXT).toContain("Wählen Sie");
    expect(SALON_SOLL_NOT_ATTRIBUTABLE_NOTE).toContain("Soll");
  });
});

describe("Issue #542 — the reports page texts", () => {
  it("name the person lists, the whole personal saldo and the unfiltered blocks in German", () => {
    expect(SALON_HOME_PERSONS_NOTE).toBe("Personen nach Stammsalon");
    expect(SALON_EXPORT_PERSONS_NOTE).toBe("Personen nach Stammsalon am Monatsende");
    expect(PERSON_SALDO_NOT_SPLIT_LABEL).toBe("Personensaldo, nicht nach Salon aufgeteilt");
    expect(ALL_SALONS_BLOCK_NOTE).toBe("Gilt für alle Salons Ihrer Reichweite");
    expect(DATEV_ALL_SALONS_NOTE).toBe("DATEV gilt für alle Salons Ihrer Reichweite");
  });

  it("says that persons without a Stammsalon on their Stichtag are only in the unfiltered export", () => {
    expect(EXPORT_NO_STAMMSALON_NOTE).toBe(
      "Personen ohne Stammsalon am Stichtag erscheinen nur im Export ohne Salonauswahl.",
    );
  });
});

// Issue #612 (P-06, P-07, amendment 16): the period report follows the header salon. The wording
// of what the shown people and days refer to is pinned here, character for character.
describe("Issue #612 - the period report's salon notes", () => {
  it("names who the vacation table lists under a filter: the Stammsalon at the end of the period", () => {
    expect(SALON_PERIOD_END_PERSONS_NOTE).toBe("Personen nach Stammsalon am Ende des Zeitraums");
    expect(PERSON_VALUES_NOT_SPLIT_LABEL).toBe("Personenwerte, nicht nach Salon aufgeteilt");
  });
});

// Issue #714 (owner decision 19.10.2026): under a salon filter the period report shows the whole
// personal values of the persons by Stammsalon at the period end. Each text is pinned here,
// character for character; the web computes none of the figures they describe.
describe("Issue #714 — the period report's Stammsalon notes", () => {
  it("names the circle: the whole personal saldo by Stammsalon", () => {
    expect(PERSON_SALDO_BY_HOME_SALON_LABEL).toBe(
      "Personensaldo nach Stammsalon, nicht nach Salon aufgeteilt",
    );
  });

  it("counts the persons without a Stammsalon in an active salon, singular and plural", () => {
    expect(withoutHomeSalonNote(3)).toBe(
      "3 Personen ohne Stammsalon in einem aktiven Salon – nur unter „Alle Salons“ enthalten",
    );
    expect(withoutHomeSalonNote(1)).toBe(
      "1 Person ohne Stammsalon in einem aktiven Salon – nur unter „Alle Salons“ enthalten",
    );
  });

  it("says where a mover counts and where the hours in the former salon appear", () => {
    expect(HOME_SALON_CHANGE_NOTE).toBe(
      "Wer im Zeitraum den Stammsalon gewechselt hat, zählt ganz zum Stammsalon am Ende des Zeitraums; die Stunden im früheren Salon stehen dort unter „Im Salon gearbeitet“.",
    );
  });

  it("labels the salon hours and the helpers", () => {
    expect(SALON_WORKED_LABEL).toBe("Im Salon gearbeitet");
    expect(SALON_WORKED_DELTA_NOTE).toBe("inkl. Aushilfen aus anderen Salons");
    expect(SALON_HELPERS_HEADING).toBe("Aushilfen aus anderen Salons");
  });

  it("tells a scoped reader that helpers outside the reach do not appear, and what the CSV lists", () => {
    expect(SALON_HELPERS_REACH_NOTE).toBe(
      "Aushilfen aus Salons außerhalb deiner Reichweite erscheinen hier nicht.",
    );
    expect(SALON_CSV_PERSONS_NOTE).toBe(
      "Die Datei listet die Personen nach Stammsalon am Ende des Zeitraums, ohne Aushilfen aus anderen Salons.",
    );
  });

  it("addresses the reader with du, never Sie, in the new texts", () => {
    for (const text of [HOME_SALON_CHANGE_NOTE, SALON_HELPERS_REACH_NOTE, SALON_CSV_PERSONS_NOTE]) {
      expect(text).not.toMatch(/\bSie\b|\bIhr/);
    }
    expect(SALON_HELPERS_REACH_NOTE).toContain("deiner");
  });
});
