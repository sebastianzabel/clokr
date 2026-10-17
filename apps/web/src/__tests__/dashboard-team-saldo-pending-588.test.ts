// Issue #588 (orchestrator amendment 2) - the dashboard page, mounted: the card "Salden" never blocks
// the team block. While GET /dashboard/overtime-overview is pending the team week is on screen and
// the card shows its skeleton; a 403 hides the card and leaves the team week alone; a resolved
// answer fills the card; the card is not requested at all without the saldo rights.
const apiGet = vi.fn();
const gotoMock = vi.fn();

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
import DashboardPage from "../routes/(app)/dashboard/+page.svelte";

const EMPLOYEE_ID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";
const OVERVIEW_PATH = "/dashboard/overtime-overview";

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
  team: [
    {
      id: EMPLOYEE_ID,
      name: "Person A",
      employeeNumber: "1",
      days: [],
    },
  ],
};

const OVERVIEW = {
  employees: [
    {
      id: EMPLOYEE_ID,
      name: "Person A",
      employeeNumber: "1",
      balanceHours: 2,
      status: "NORMAL",
      confirmedMinutes: 120,
      openMonthMinutes: 0,
      hasClosedMonth: true,
      hasRecordedTime: true,
      trackOnly: false,
      unconfirmedMonths: 1,
    },
  ],
};

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

/** Resolves every other endpoint with an empty answer of the right rough shape. */
function answerOthers(path: string): Promise<unknown> {
  if (path === "/me/context") {
    return Promise.resolve({
      tenant: { id: "t1", name: "Mandant" },
      isMultiSalon: false,
      homeSalonId: null,
      salons: [],
    });
  }
  if (path.startsWith("/dashboard/team-week")) return Promise.resolve(TEAM_WEEK);
  if (path.startsWith("/dashboard/team-trend")) {
    return Promise.reject(new ApiError(500, "ignored in this test"));
  }
  if (path.startsWith("/dashboard/team-upcoming-leave")) return Promise.resolve({ items: [] });
  if (path === "/dashboard/open-items") return Promise.resolve({});
  if (path.startsWith("/time-entries")) return Promise.resolve([]);
  if (path === "/dashboard") return Promise.reject(new ApiError(500, "ignored in this test"));
  return Promise.reject(new ApiError(404, "not part of this test"));
}

const overviewCalls = () => apiGet.mock.calls.filter((c) => String(c[0]).startsWith(OVERVIEW_PATH));

beforeEach(async () => {
  apiGet.mockReset();
  gotoMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  await salonContext.load("u1", { force: true }).catch(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("dashboard page - the card Salden never blocks the team block (Issue #588)", () => {
  it("the team week renders while the overview is pending; the card shows its skeleton", async () => {
    asUser(["team-overview:read:ZUGEWIESEN", "overtime:read:ZUGEWIESEN"]);
    let resolveOverview: (value: unknown) => void = () => {};
    apiGet.mockImplementation((path: string) => {
      if (path.startsWith(OVERVIEW_PATH)) {
        return new Promise((resolve) => {
          resolveOverview = resolve;
        });
      }
      return answerOthers(path);
    });
    await salonContext.load("u1", { force: true });

    const { container } = renderWithTheme(DashboardPage, {});

    // The team week is on screen although the overview request has not answered.
    await screen.findByText("Team-Wochenübersicht");
    await waitFor(() => expect(overviewCalls()).toHaveLength(1));
    expect(screen.getByText("Salden")).toBeInTheDocument();
    expect(container.querySelector(".saldo-skeleton")).not.toBeNull();
    expect(screen.queryByTestId("team-saldo-values")).toBeNull();
    // The overview was asked after the team week was.
    const order = apiGet.mock.calls.map((c) => String(c[0]));
    expect(order.findIndex((p) => p.startsWith("/dashboard/team-week"))).toBeLessThan(
      order.findIndex((p) => p.startsWith(OVERVIEW_PATH)),
    );

    resolveOverview(OVERVIEW);
    await screen.findByTestId("team-saldo-values");
    expect(screen.getByTestId("team-saldo-median")).toHaveTextContent("Team-Median: +2:00");
    expect(container.querySelector(".saldo-skeleton")).toBeNull();
    expect(screen.getByText("Team-Wochenübersicht")).toBeInTheDocument();
  });

  it("a 403 on the overview hides the card silently and leaves the team week alone", async () => {
    asUser(["team-overview:read:ZUGEWIESEN", "overtime:read:ZUGEWIESEN"]);
    apiGet.mockImplementation((path: string) =>
      path.startsWith(OVERVIEW_PATH)
        ? Promise.reject(new ApiError(403, "Keine Berechtigung"))
        : answerOthers(path),
    );
    await salonContext.load("u1", { force: true });

    renderWithTheme(DashboardPage, {});

    await screen.findByText("Team-Wochenübersicht");
    await waitFor(() => expect(overviewCalls()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("Salden")).toBeNull());
    expect(screen.getByText("Team-Wochenübersicht")).toBeInTheDocument();
    const logged = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0]),
    );
    expect(logged.some((m) => m.includes("team saldo"))).toBe(false);
  });

  it("a caller without overtime:read gets the team block and never requests the overview", async () => {
    asUser(["team-overview:read:ZUGEWIESEN"]);
    apiGet.mockImplementation((path: string) => answerOthers(path));
    await salonContext.load("u1", { force: true });

    renderWithTheme(DashboardPage, {});

    await screen.findByText("Team-Wochenübersicht");
    expect(screen.queryByText("Salden")).toBeNull();
    expect(overviewCalls()).toHaveLength(0);
  });
});
