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
  SALON_SOLL_NOT_ATTRIBUTABLE_NOTE,
  SALON_VIEW_UNAVAILABLE_TEXT,
  isSalonFilterRejected,
  salonNameLabel,
  salonPageFilter,
  salonScopeLabel,
  withSalonId,
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
