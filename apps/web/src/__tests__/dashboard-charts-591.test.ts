// Issue #591 (AC-591-3, D-591-3, P-591-05) - the dashboard page, mounted: a click on a month of a
// team chart opens the report of that month, and the offer exists only for a caller who may read
// that report. chart.js is stubbed so every built config is recorded and its handlers can be called
// the way chart.js calls them; `goto` is the spy that proves where the click leads.
/* eslint-disable @typescript-eslint/no-explicit-any -- recorded chart.js option trees */
const apiGet = vi.fn();
const gotoMock = vi.fn();
const recorded: Array<{ label: string; config: any }> = [];

vi.mock("$app/navigation", () => ({ goto: (...args: unknown[]) => gotoMock(...args) }));

vi.mock("$stores/auth", async () => {
  const { writable } = await import("svelte/store");
  return { authStore: writable({ user: null }) };
});

vi.mock("$api/client", () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public data?: unknown,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    api: {
      get: (...args: unknown[]) => apiGet(...args),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
  };
});

vi.mock("$lib/utils/logger", () => ({
  clientLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("chart.js", () => {
  class Chart {
    static register = vi.fn();
    static defaults = { font: {}, plugins: {} };
    constructor(el: HTMLElement, config: unknown) {
      recorded.push({ label: el.getAttribute("aria-label") ?? "", config });
    }
    destroy() {}
    update() {}
  }
  const stub = class {};
  return {
    Chart,
    BarController: stub,
    LineController: stub,
    DoughnutController: stub,
    BarElement: stub,
    LineElement: stub,
    PointElement: stub,
    ArcElement: stub,
    CategoryScale: stub,
    LinearScale: stub,
    Tooltip: stub,
    Legend: stub,
    Filler: stub,
  };
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import { authStore } from "$stores/auth";
import { salonContext } from "$stores/salon-context";
import { ApiError } from "$api/client";
import {
  TEAM_SALDO_TREND_CHART,
  TEAM_SICK_DAYS_CHART,
  teamHoursChartDescriptor,
} from "$lib/dashboard/team-charts";
import { chartAriaLabel } from "$lib/utils/chart-theme";
import DashboardPage from "../routes/(app)/dashboard/+page.svelte";

const SALON_A = "6f1d0c52-1a2b-4c3d-8e4f-5a6b7c8d9e01";
const SALON_B = "6f1d0c52-1a2b-4c3d-8e4f-5a6b7c8d9e02";

const MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];

function teamTrend(salonId: string | null) {
  return {
    salonId,
    workedBasis: salonId === null ? "ACCOUNT" : "SALON_ENTRIES",
    sollUnavailableReason: salonId === null ? null : "SALON_FILTER",
    months: MONTHS.map((month, i) => ({
      month,
      workedMinutes: 6000 + i * 60,
      shouldMinutes: salonId === null ? 6600 : null,
      sickDays: i + 1,
    })),
  };
}

const TEAM_WEEK = {
  weekStart: "2026-06-15",
  weekEnd: "2026-06-21",
  weekDays: [
    "2026-06-15",
    "2026-06-16",
    "2026-06-17",
    "2026-06-18",
    "2026-06-19",
    "2026-06-20",
    "2026-06-21",
  ],
  team: [],
};

const FULL_RIGHTS = [
  "team-overview:read:ZUGEWIESEN",
  "overtime:read:ZUGEWIESEN",
  "report:read:ZUGEWIESEN",
];

function asUser(permissions: string[]) {
  (authStore as unknown as { set: (v: unknown) => void }).set({
    user: {
      id: "u1",
      email: "u1@example.invalid",
      employeeId: null,
      firstName: "Test",
      permissions,
    },
  });
}

function answerOthers(path: string, multiSalon = false): Promise<unknown> {
  if (path === "/me/context") {
    return Promise.resolve({
      tenant: { id: "t1", name: "Mandant" },
      isMultiSalon: multiSalon,
      homeSalonId: multiSalon ? SALON_A : null,
      salons: multiSalon
        ? [
            { id: SALON_A, name: "Salon A" },
            { id: SALON_B, name: "Salon B" },
          ]
        : [],
    });
  }
  if (path.startsWith("/dashboard/team-week")) return Promise.resolve(TEAM_WEEK);
  if (path.startsWith("/dashboard/team-trend")) {
    const m = /salonId=([^&]+)/.exec(path);
    return Promise.resolve(teamTrend(m === null ? null : decodeURIComponent(m[1])));
  }
  if (path.startsWith("/dashboard/overtime-trend")) {
    return Promise.resolve({ snapshots: [], currentTeamBalanceMinutes: 120 });
  }
  if (path.startsWith("/dashboard/overtime-overview")) return Promise.resolve({ employees: [] });
  if (path.startsWith("/dashboard/team-upcoming-leave")) return Promise.resolve({ items: [] });
  if (path === "/dashboard/open-items") return Promise.resolve({});
  if (path.startsWith("/time-entries")) return Promise.resolve([]);
  if (path === "/dashboard") return Promise.reject(new ApiError(500, "ignored in this test"));
  return Promise.reject(new ApiError(404, "not part of this test"));
}

/** The latest recorded config whose canvas carries this aria-label. */
function configOf(label: string): any {
  const found = [...recorded].reverse().find((r) => r.label === label);
  expect(found, `no chart was built for "${label}"`).toBeDefined();
  return found!.config;
}

const SICK_LABEL = chartAriaLabel(TEAM_SICK_DAYS_CHART);
const TREND_LABEL = chartAriaLabel(TEAM_SALDO_TREND_CHART);
// The full-rights caller sees the Soll, so the hours chart is the grouped one.
const HOURS_LABEL = chartAriaLabel(teamHoursChartDescriptor({ shouldHours: [1] }));
const LINK_NAMES = {
  hours: "Arbeitsstunden im Bericht öffnen",
  trend: "Überstunden-Trend im Bericht öffnen",
  sick: "Krankheitstage im Bericht öffnen",
};

beforeEach(async () => {
  apiGet.mockReset();
  gotoMock.mockReset();
  recorded.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  await salonContext.load("u1", { force: true }).catch(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("dashboard page - a month of a team chart opens its report (Issue #591, AC-591-3)", () => {
  it("tracer: a month of Krankheitstage opens the urlaub tab of that month", async () => {
    asUser(FULL_RIGHTS);
    apiGet.mockImplementation((path: string) => answerOthers(path));
    await salonContext.load("u1", { force: true });

    renderWithTheme(DashboardPage, {});

    await waitFor(() => expect(recorded.some((r) => r.label === SICK_LABEL)).toBe(true));
    const sick = configOf(SICK_LABEL);
    expect(typeof sick.options.onClick).toBe("function");

    sick.options.onClick({}, [{ index: 5 }]);
    expect(gotoMock).toHaveBeenLastCalledWith("/reports?from=2026-06&to=2026-06&tab=urlaub");
    sick.options.onClick({}, [{ index: 0 }]);
    expect(gotoMock).toHaveBeenLastCalledWith("/reports?from=2026-01&to=2026-01&tab=urlaub");

    // An empty click, or a click on an index the view does not have, goes nowhere.
    gotoMock.mockClear();
    sick.options.onClick({}, []);
    sick.options.onClick({}, [{ index: 99 }]);
    expect(gotoMock).not.toHaveBeenCalled();

    expect(screen.getByRole("img", { name: SICK_LABEL })).toBeInTheDocument();
  });

  it("a caller without report:read gets no click handler on the sick chart", async () => {
    asUser(["team-overview:read:ZUGEWIESEN", "overtime:read:ZUGEWIESEN"]);
    apiGet.mockImplementation((path: string) => answerOthers(path));
    await salonContext.load("u1", { force: true });

    renderWithTheme(DashboardPage, {});

    await waitFor(() => expect(recorded.some((r) => r.label === SICK_LABEL)).toBe(true));
    expect(configOf(SICK_LABEL).options.onClick).toBeUndefined();
    expect(gotoMock).not.toHaveBeenCalled();
  });
});

describe("dashboard page - the other two charts, the keyboard links and the permission rule (Issue #591)", () => {
  it("opens the zeiten tab from the hours chart and the trend chart, the urlaub tab from the sick chart", async () => {
    asUser(FULL_RIGHTS);
    apiGet.mockImplementation((path: string) => answerOthers(path));
    await salonContext.load("u1", { force: true });

    renderWithTheme(DashboardPage, {});

    await waitFor(() => expect(recorded.map((r) => r.label)).toContain(TREND_LABEL));
    for (const label of [HOURS_LABEL, TREND_LABEL]) {
      const config = configOf(label);
      config.options.onClick({}, [{ index: 5 }]);
      expect(gotoMock).toHaveBeenLastCalledWith("/reports?from=2026-06&to=2026-06&tab=zeiten");
      config.options.onClick({}, [{ index: 0 }]);
      expect(gotoMock).toHaveBeenLastCalledWith("/reports?from=2026-01&to=2026-01&tab=zeiten");
    }
    expect(configOf(HOURS_LABEL).options.interaction).toEqual({ mode: "index", intersect: false });
    for (const label of [HOURS_LABEL, TREND_LABEL, SICK_LABEL]) {
      expect(screen.getByRole("img", { name: label })).toBeInTheDocument();
    }
  });

  it("offers a keyboard link per chart to the six months, named after the card", async () => {
    asUser(FULL_RIGHTS);
    apiGet.mockImplementation((path: string) => answerOthers(path));
    await salonContext.load("u1", { force: true });

    renderWithTheme(DashboardPage, {});

    const hours = await screen.findByRole("link", { name: LINK_NAMES.hours });
    const trend = await screen.findByRole("link", { name: LINK_NAMES.trend });
    const sick = await screen.findByRole("link", { name: LINK_NAMES.sick });
    expect(hours).toHaveAttribute("href", "/reports?from=2026-01&to=2026-06&tab=zeiten");
    expect(trend).toHaveAttribute("href", "/reports?from=2026-01&to=2026-06&tab=zeiten");
    expect(sick).toHaveAttribute("href", "/reports?from=2026-01&to=2026-06&tab=urlaub");
    for (const link of [hours, trend, sick]) {
      expect(link).toHaveTextContent("Bericht →");
      expect(link).toHaveClass("widget-action");
    }
  });

  it("a caller without report:read gets neither a handler nor a link, and the charts still render", async () => {
    asUser(["team-overview:read:ZUGEWIESEN", "overtime:read:ZUGEWIESEN"]);
    apiGet.mockImplementation((path: string) => answerOthers(path));
    await salonContext.load("u1", { force: true });

    renderWithTheme(DashboardPage, {});

    await waitFor(() => expect(recorded.map((r) => r.label)).toContain(TREND_LABEL));
    for (const label of [HOURS_LABEL, TREND_LABEL, SICK_LABEL]) {
      expect(configOf(label).options.onClick, label).toBeUndefined();
      expect(screen.getByRole("img", { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByText("Bericht →")).toBeNull();
    expect(screen.queryByRole("link", { name: /im Bericht öffnen/ })).toBeNull();
  });

  it("under a salon filter no link or click carries a salonId, and the trend card shows its note instead of a link", async () => {
    asUser(FULL_RIGHTS);
    apiGet.mockImplementation((path: string) => answerOthers(path, true));
    await salonContext.load("u1", { force: true });
    salonContext.setSelection(SALON_A);

    renderWithTheme(DashboardPage, {});

    await waitFor(() =>
      expect(
        apiGet.mock.calls.some((c) => /team-trend\?months=6&salonId=/.test(String(c[0]))),
      ).toBe(true),
    );
    await waitFor(() => expect(recorded.map((r) => r.label)).toContain(SICK_LABEL));
    // The Soll is withheld under a filter, so the hours chart is the plain-column one.
    const hoursFiltered = chartAriaLabel(teamHoursChartDescriptor({ shouldHours: null }));
    configOf(hoursFiltered).options.onClick({}, [{ index: 5 }]);
    configOf(SICK_LABEL).options.onClick({}, [{ index: 0 }]);
    expect(gotoMock.mock.calls.map((c) => String(c[0]))).toEqual([
      "/reports?from=2026-06&to=2026-06&tab=zeiten",
      "/reports?from=2026-01&to=2026-01&tab=urlaub",
    ]);

    const links = (await screen.findAllByRole("link", { name: /im Bericht öffnen/ })).map((l) =>
      l.getAttribute("href"),
    );
    expect(links).toEqual([
      "/reports?from=2026-01&to=2026-06&tab=zeiten",
      "/reports?from=2026-01&to=2026-06&tab=urlaub",
    ]);
    for (const href of [...links, ...gotoMock.mock.calls.map((c) => String(c[0]))]) {
      expect(href).not.toContain("salonId");
    }
    expect(screen.queryByRole("link", { name: LINK_NAMES.trend })).toBeNull();
    expect(screen.getByText(/Der Saldo ist eine Vertragsgröße/)).toBeInTheDocument();
  });
});
