// Issue #84 (D-11, D-12) — the decisions behind the dashboard's Team block, outside the page
// (the page imports `$app/*` and cannot be mounted here).
//
// Why the filter needs the showSalonOptions() guard (D-11): the salon-context store preselects the
// sole reachable salon (`resolveSelection`), so `selectedSalonId()` alone would put every one-salon
// tenant and every single-salon caller into filtered mode and hide their Soll — the AC-6 break.
import { describe, expect, it, vi } from "vitest";

// The store imports the api client, which pulls in the auth store and its localStorage bootstrap;
// a stand-in (as in salon-context.test.ts) keeps this file free of that. The factory defines
// ApiError itself because vi.mock is hoisted above any top-level class.
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
import {
  TEAM_SALDO_NOT_ATTRIBUTABLE_NOTE,
  TEAM_SALON_UNAVAILABLE_TEXT,
  TEAM_SOLL_NOT_ATTRIBUTABLE_NOTE,
  TEAM_SOLL_PARTIAL_SCOPE_NOTE,
  isTeamSalonRejected,
  teamSalonFilter,
  teamSalonViewSalon,
  teamTrendView,
  teamWeekHasElsewhere,
  teamViewLabel,
  upcomingFromResponse,
  withSalonId,
  type TeamTrendResponse,
} from "../team-view";

const A = { id: "salon-a", name: "Salon Nord" };
const B = { id: "salon-b", name: "Salon Ost" };

describe("teamSalonFilter — D-11: the only place the dashboard decides whether it filters", () => {
  it("a one-salon tenant sends no salonId although the store preselects its salon", () => {
    expect(teamSalonFilter({ isMultiSalon: false, salons: [A], selection: A.id })).toBeNull();
  });

  it("a multi-salon tenant whose caller reaches one salon sends no salonId", () => {
    expect(teamSalonFilter({ isMultiSalon: true, salons: [A], selection: A.id })).toBeNull();
  });

  it('"Alle Salons" sends no salonId', () => {
    expect(teamSalonFilter({ isMultiSalon: true, salons: [A, B], selection: "ALL" })).toBeNull();
  });

  it("a listed salon with options shown is sent", () => {
    expect(teamSalonFilter({ isMultiSalon: true, salons: [A, B], selection: A.id })).toBe(A.id);
  });

  it("a context that is not loaded yet sends no salonId", () => {
    expect(teamSalonFilter({ isMultiSalon: false, salons: [], selection: null })).toBeNull();
  });

  it("a selection that is not listed sends no salonId", () => {
    expect(teamSalonFilter({ isMultiSalon: true, salons: [A, B], selection: "gone" })).toBeNull();
  });
});

describe("withSalonId", () => {
  it("leaves the path alone without a salon", () => {
    expect(withSalonId("/dashboard/team-trend?months=6", null)).toBe(
      "/dashboard/team-trend?months=6",
    );
  });

  it("appends with & when the path already has a query", () => {
    expect(withSalonId("/dashboard/team-trend?months=6", "abc")).toBe(
      "/dashboard/team-trend?months=6&salonId=abc",
    );
  });

  it("appends with ? and encodes the value", () => {
    expect(withSalonId("/dashboard/team-upcoming-leave", "a b")).toBe(
      "/dashboard/team-upcoming-leave?salonId=a%20b",
    );
  });
});

function response(overrides: Partial<TeamTrendResponse> = {}): TeamTrendResponse {
  return {
    salonId: null,
    workedBasis: "ACCOUNT",
    sollUnavailableReason: null,
    months: [
      { month: "2026-05", workedMinutes: 125, shouldMinutes: 180, sickDays: 1 },
      { month: "2026-06", workedMinutes: 600, shouldMinutes: 600, sickDays: 0.5 },
    ],
    ...overrides,
  };
}

describe("teamTrendView — driven by the response codes, never by a display string", () => {
  it("unfiltered: Ist and Soll in hours, one decimal, German month labels", () => {
    const view = teamTrendView(response());
    expect(view.months.map((m) => m.label)).toEqual(["Mai 26", "Juni 26"]);
    expect(view.months.map((m) => m.month)).toEqual(["2026-05", "2026-06"]);
    expect(view.workedHours).toEqual([2.1, 10]);
    expect(view.shouldHours).toEqual([3, 10]);
    expect(view.sickDays).toEqual([1, 0.5]);
    expect(view.workedSeriesLabel).toBe("Ist (h)");
    expect(view.chartSub).toBe("Letzte 6 Monate");
    expect(view.sollNote).toBeNull();
    expect(view.trendNote).toBeNull();
  });

  it("filtered: no Soll series, the basis is named, both notes are set", () => {
    const view = teamTrendView(
      response({
        salonId: A.id,
        workedBasis: "SALON_ENTRIES",
        sollUnavailableReason: "SALON_FILTER",
        months: [{ month: "2026-05", workedMinutes: 90, shouldMinutes: null, sickDays: 2 }],
      }),
    );
    expect(view.shouldHours).toBeNull();
    expect(view.workedHours).toEqual([1.5]);
    expect(view.workedSeriesLabel).toBe("Erfasste Arbeitszeit im Salon (h)");
    expect(view.chartSub).toBe("Erfasste Arbeitszeit im Salon · Letzte 6 Monate");
    expect(view.sollNote).toBe(TEAM_SOLL_NOT_ATTRIBUTABLE_NOTE);
    expect(view.trendNote).toBe(TEAM_SALDO_NOT_ATTRIBUTABLE_NOTE);
  });

  it("no permission for Soll: the series is hidden without any note", () => {
    const view = teamTrendView(
      response({
        sollUnavailableReason: "NO_PERMISSION",
        months: [{ month: "2026-05", workedMinutes: 60, shouldMinutes: null, sickDays: 0 }],
      }),
    );
    expect(view.shouldHours).toBeNull();
    expect(view.sollNote).toBeNull();
    expect(view.trendNote).toBeNull();
    expect(view.workedSeriesLabel).toBe("Ist (h)");
  });

  it("any month without a Soll value hides the whole Soll series", () => {
    const view = teamTrendView(
      response({
        months: [
          { month: "2026-05", workedMinutes: 60, shouldMinutes: 60, sickDays: 0 },
          { month: "2026-06", workedMinutes: 60, shouldMinutes: null, sickDays: 0 },
        ],
      }),
    );
    expect(view.shouldHours).toBeNull();
  });
});

// Issue #85 D-06: a partially covering manager gets the entries in reach, never the account's Ist.
describe("teamTrendView — SCOPE_ENTRIES (Issue #85 D-06)", () => {
  const scoped = (reason: TeamTrendResponse["sollUnavailableReason"]) =>
    teamTrendView(
      response({
        workedBasis: "SCOPE_ENTRIES",
        sollUnavailableReason: reason,
        months: [{ month: "2026-05", workedMinutes: 90, shouldMinutes: null, sickDays: 2 }],
      }),
    );

  it("names the basis: recorded working time in the caller's reach, no Soll, no note", () => {
    const view = scoped("NO_PERMISSION");
    expect(view.workedSeriesLabel).toBe("Erfasste Arbeitszeit (h)");
    expect(view.chartSub).toBe("Erfasste Arbeitszeit in Ihrer Reichweite · Letzte 6 Monate");
    expect(view.workedHours).toEqual([1.5]);
    expect(view.shouldHours).toBeNull();
    expect(view.sollNote).toBeNull();
    expect(view.trendNote).toBeNull();
  });

  it("explains the missing Soll when the reason is SCOPE_ENTRIES", () => {
    const view = scoped("SCOPE_ENTRIES");
    expect(view.shouldHours).toBeNull();
    expect(view.sollNote).toBe(TEAM_SOLL_PARTIAL_SCOPE_NOTE);
    expect(view.sollNote).toBe(
      "Das Soll fehlt, weil ein Teil der Arbeitszeit in Salons außerhalb Ihrer Reichweite erfasst ist.",
    );
    expect(view.trendNote).toBeNull();
    expect(view.workedSeriesLabel).toBe("Erfasste Arbeitszeit (h)");
  });

  it("SCOPE_ENTRIES basis keeps its own label even if a Soll is delivered", () => {
    const view = teamTrendView(response({ workedBasis: "SCOPE_ENTRIES" }));
    expect(view.workedSeriesLabel).toBe("Erfasste Arbeitszeit (h)");
    expect(view.shouldHours).toEqual([3, 10]);
  });
});

// Issue #85 D-09: the Salonansicht always names one salon; teamSalonFilter stays the #64-guarded one.
describe("teamSalonViewSalon — D-09", () => {
  it("the sole reachable salon (preselected by the store) is the view's salon", () => {
    const state = { isMultiSalon: true, salons: [A], selection: A.id };
    expect(teamSalonViewSalon(state)).toBe(A.id);
    expect(teamSalonFilter(state)).toBeNull();
  });

  it("a one-salon tenant has a view salon while the filter stays null", () => {
    const state = { isMultiSalon: false, salons: [A], selection: A.id };
    expect(teamSalonViewSalon(state)).toBe(A.id);
    expect(teamSalonFilter(state)).toBeNull();
  });

  it('"Alle Salons" has no view salon', () => {
    expect(teamSalonViewSalon({ isMultiSalon: true, salons: [A, B], selection: "ALL" })).toBeNull();
  });

  it("one selected salon of several is the view's salon", () => {
    expect(teamSalonViewSalon({ isMultiSalon: true, salons: [A, B], selection: B.id })).toBe(B.id);
  });

  it("a context that is not loaded or a stale selection has no view salon", () => {
    expect(teamSalonViewSalon({ isMultiSalon: false, salons: [], selection: null })).toBeNull();
    expect(
      teamSalonViewSalon({ isMultiSalon: true, salons: [A, B], selection: "gone" }),
    ).toBeNull();
  });
});

describe("teamWeekHasElsewhere — the legend follows the data (Issue #85 D-04/D-05)", () => {
  it("is false for an empty team and for days without the key", () => {
    expect(teamWeekHasElsewhere([])).toBe(false);
    expect(teamWeekHasElsewhere([{ days: [{}, {}] }, { days: [] }])).toBe(false);
    expect(teamWeekHasElsewhere([{ days: [{ workedElsewhere: false }] }])).toBe(false);
  });

  it("is true as soon as one shown day carries workedElsewhere", () => {
    expect(
      teamWeekHasElsewhere([
        { days: [{}] },
        { days: [{ workedElsewhere: false }, { workedElsewhere: true }] },
      ]),
    ).toBe(true);
  });
});

describe("teamViewLabel — D-01: what the divider says the figures refer to", () => {
  it("no salon options: nothing extra", () => {
    expect(teamViewLabel({ isMultiSalon: false, salons: [A], selection: A.id })).toBeNull();
    expect(teamViewLabel({ isMultiSalon: true, salons: [A], selection: A.id })).toBeNull();
  });

  it('options with "Alle Salons"', () => {
    expect(teamViewLabel({ isMultiSalon: true, salons: [A, B], selection: "ALL" })).toBe(
      "Alle Salons",
    );
  });

  it("options with a salon: its name", () => {
    expect(teamViewLabel({ isMultiSalon: true, salons: [A, B], selection: B.id })).toBe(B.name);
  });
});

describe("isTeamSalonRejected — D-16: only a 404 is the calm empty state", () => {
  it("404 is a rejected salon", () => {
    expect(isTeamSalonRejected(new ApiError(404, "Salon nicht gefunden"))).toBe(true);
  });

  it("403, 500 and a plain Error are not", () => {
    expect(isTeamSalonRejected(new ApiError(403, "x"))).toBe(false);
    expect(isTeamSalonRejected(new ApiError(500, "x"))).toBe(false);
    expect(isTeamSalonRejected(new Error("404"))).toBe(false);
  });

  it("the empty-state text is the agreed German sentence", () => {
    expect(TEAM_SALON_UNAVAILABLE_TEXT).toBe(
      "Für diesen Salon liegt keine Teamansicht vor. Wählen Sie in der Kopfleiste „Alle Salons“ oder einen anderen Salon.",
    );
  });
});

describe("upcomingFromResponse", () => {
  it("maps the server items to the card shape and keeps the id as key", () => {
    expect(
      upcomingFromResponse([
        {
          id: "l1",
          employeeId: "e1",
          employeeName: "Max Muster",
          startDate: "2026-07-01",
          endDate: "2026-07-05",
          days: 3,
          leaveTypeName: "Urlaub",
          leaveTypeCode: "VACATION",
        },
      ]),
    ).toEqual([
      {
        id: "l1",
        employeeName: "Max Muster",
        startDate: "2026-07-01",
        endDate: "2026-07-05",
        days: 3,
        type: "Urlaub",
      },
    ]);
  });

  it("an empty list stays empty", () => {
    expect(upcomingFromResponse([])).toEqual([]);
  });
});
