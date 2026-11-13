// Issue #895 (D-854-14) - the tab „Verläufe“ of Berichte, mounted. chart.js is replaced by a stub
// that records every config and `destroy` (jsdom has no canvas), so the three trend charts are
// asserted on what the one chart builders hand over. The api client is a stand-in: the requests
// the tab makes, the salon filter on them and the calm states (403, 404) are what is pinned.
/* eslint-disable @typescript-eslint/no-explicit-any -- the recorded chart.js config is asserted as-is */
const charts: Array<{ config: any; destroyed: boolean }> = [];

vi.mock("chart.js", () => {
  class Chart {
    static register = vi.fn();
    config: any;
    destroyed = false;
    constructor(_canvas: unknown, config: any) {
      this.config = config;
      charts.push(this as unknown as { config: any; destroyed: boolean });
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const stub = class {};
  return {
    Chart,
    BarController: stub,
    LineController: stub,
    BarElement: stub,
    LineElement: stub,
    PointElement: stub,
    CategoryScale: stub,
    LinearScale: stub,
    Tooltip: stub,
    Legend: stub,
  };
});

const hoisted = vi.hoisted(() => ({
  get: vi.fn(),
  goto: vi.fn(),
  user: { value: null as { permissions: string[] } | null },
}));

vi.mock("$api/client", () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message = "err",
    ) {
      super(message);
    }
  }
  return { ApiError, api: { get: (...a: unknown[]) => hoisted.get(...a) } };
});
vi.mock("$app/navigation", () => ({ goto: (...a: unknown[]) => hoisted.goto(...a) }));
vi.mock("$stores/auth", () => ({
  authStore: {
    subscribe: (run: (value: unknown) => void) => {
      run({ user: hoisted.user.value });
      return () => {};
    },
  },
}));
vi.mock("$lib/utils/logger", () => ({ clientLogger: { warn: vi.fn(), error: vi.fn() } }));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import { ApiError } from "$api/client";
import type { TeamTrendResponse } from "$lib/dashboard/team-view";
import { SALON_VIEW_UNAVAILABLE_TEXT } from "$lib/salons/page-scope";
import TeamTrendsTab from "../TeamTrendsTab.svelte";
import source from "../TeamTrendsTab.svelte?raw";

const ADMIN = [
  "team-overview:read:ZUGEWIESEN",
  "overtime:read:ZUGEWIESEN",
  "report:read:ZUGEWIESEN",
];
const SALON = "11111111-1111-4111-8111-111111111111";

const TREND: TeamTrendResponse = {
  salonId: null,
  workedBasis: "ACCOUNT",
  sollUnavailableReason: null,
  months: ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"].map((month, i) => ({
    month,
    workedMinutes: 600 + i * 60,
    shouldMinutes: 720,
    sickDays: i,
  })),
};

const OVERTIME_TREND = {
  snapshots: [{ month: "2026-05-01", teamCarryOverMinutes: 120 }],
  currentTeamBalanceMinutes: 300,
};

function answer(path: string): unknown {
  if (path.startsWith("/dashboard/team-trend")) return TREND;
  if (path.startsWith("/dashboard/overtime-trend")) return OVERTIME_TREND;
  throw new Error(`unexpected request ${path}`);
}

function mount(props: Record<string, unknown> = {}) {
  return renderWithTheme(TeamTrendsTab, {
    salonId: null,
    ready: true,
    saldoRows: [],
    saldoFiltered: false,
    saldoLoading: false,
    saldoError: "",
    ...props,
  });
}

const requested = () => hoisted.get.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  charts.length = 0;
  hoisted.get.mockReset();
  hoisted.get.mockImplementation(async (path: string) => answer(path));
  hoisted.user.value = { permissions: ADMIN };
  document.documentElement.style.setProperty("--text-2", "rgb(90, 90, 90)");
  document.documentElement.style.setProperty("--line", "rgb(220, 220, 220)");
});

afterEach(() => {
  cleanup();
});

describe("TeamTrendsTab (Issue #895)", () => {
  it("draws the three trends with the builders' labels and links each to its report tab", async () => {
    mount();
    await waitFor(() => expect(charts).toHaveLength(3));
    expect(charts.map((c) => c.config.type).sort()).toEqual(["bar", "bar", "line"]);
    expect(
      screen.getByRole("img", { name: /^Gruppiertes Säulendiagramm: .*Arbeitsstunden/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /^Liniendiagramm: Überstunden-Saldo/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /^Säulendiagramm: Krankheitstage/ }),
    ).toBeInTheDocument();

    const hours = screen.getByRole("link", { name: "Arbeitsstunden im Bericht öffnen" });
    const trend = screen.getByRole("link", { name: "Überstunden-Trend im Bericht öffnen" });
    const sick = screen.getByRole("link", { name: "Krankheitstage im Bericht öffnen" });
    expect(hours).toHaveAttribute("href", "/reports?from=2026-05&to=2026-10&tab=zeiten");
    expect(trend).toHaveAttribute("href", "/reports?from=2026-05&to=2026-10&tab=zeiten");
    expect(sick).toHaveAttribute("href", "/reports?from=2026-05&to=2026-10&tab=urlaub");
  });

  it("a month click opens the report of that month", async () => {
    mount();
    await waitFor(() => expect(charts).toHaveLength(3));
    const sick = charts.find((c) => c.config.data.datasets[0].label === "Krankheitstage")!;
    sick.config.options.onClick({}, [{ index: 2 }]);
    expect(hoisted.goto).toHaveBeenCalledWith("/reports?from=2026-07&to=2026-07&tab=urlaub");
  });

  it("the saldo trend ends on the live balance and fills a missing month forward", async () => {
    mount();
    await waitFor(() => expect(charts).toHaveLength(3));
    const line = charts.find((c) => c.config.type === "line")!;
    expect(line.config.data.datasets[0].data).toEqual([2, 2, 2, 2, 2, 5]);
  });

  it("requests the trend without a salon and the saldo trend; a salon filter sends salonId and skips the saldo trend", async () => {
    mount();
    await waitFor(() => expect(charts).toHaveLength(3));
    expect(requested()).toEqual(["/dashboard/team-trend?months=6", "/dashboard/overtime-trend"]);

    cleanup();
    charts.length = 0;
    hoisted.get.mockClear();
    mount({ salonId: SALON });
    await waitFor(() => expect(charts.length).toBeGreaterThan(0));
    expect(requested()).toEqual([`/dashboard/team-trend?months=6&salonId=${SALON}`]);
  });

  it("under a salon filter the saldo trend is replaced by the server's note (a contract figure is not split)", async () => {
    hoisted.get.mockImplementation(async (path: string) =>
      path.startsWith("/dashboard/team-trend")
        ? {
            ...TREND,
            salonId: SALON,
            workedBasis: "SALON_ENTRIES",
            sollUnavailableReason: "SALON_FILTER",
          }
        : answer(path),
    );
    mount({ salonId: SALON });
    await waitFor(() => expect(screen.getByText("Überstunden-Trend")).toBeInTheDocument());
    // Hours and sick days are drawn; the line chart is not.
    await waitFor(() => expect(charts).toHaveLength(2));
    expect(charts.some((c) => c.config.type === "line")).toBe(false);
    expect(screen.queryByRole("img", { name: /^Liniendiagramm/ })).toBeNull();
  });

  it("a 403 of the saldo trend (no overtime:read) is calm: no section, no error", async () => {
    hoisted.user.value = { permissions: ["team-overview:read:ZUGEWIESEN"] };
    hoisted.get.mockImplementation(async (path: string) => {
      if (path.startsWith("/dashboard/overtime-trend")) throw new ApiError(403, "no");
      return answer(path);
    });
    mount();
    await waitFor(() => expect(charts).toHaveLength(2));
    expect(screen.queryByText("Überstunden-Trend")).toBeNull();
    expect(screen.queryByTestId("team-trends-error")).toBeNull();
    // Without overtime:read the saldo trend is not even requested, and the card „Salden“ is absent.
    expect(requested()).toEqual(["/dashboard/team-trend?months=6"]);
    expect(screen.queryByTestId("team-trends-saldo")).toBeNull();
  });

  it("a salon the server rejects (404) is the calm salon text, no chart", async () => {
    hoisted.get.mockRejectedValue(new ApiError(404, "x"));
    mount({ salonId: SALON });
    await waitFor(() => expect(screen.getByText(SALON_VIEW_UNAVAILABLE_TEXT)).toBeInTheDocument());
    expect(charts).toHaveLength(0);
  });

  it("another failure is an error state with a retry that loads again", async () => {
    hoisted.get.mockRejectedValueOnce(new Error("boom"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mount();
    await waitFor(() => expect(screen.getByTestId("team-trends-error")).toBeInTheDocument());
    hoisted.get.mockImplementation(async (path: string) => answer(path));
    screen.getByRole("button", { name: "Erneut versuchen" }).click();
    await waitFor(() => expect(charts).toHaveLength(3));
    spy.mockRestore();
  });

  it("waits for the salon context: nothing is requested before the page is ready", () => {
    mount({ ready: false });
    expect(hoisted.get).not.toHaveBeenCalled();
  });

  it("shows the card „Salden“ with the page's rows for a reader with both rights, and the page's failure instead of it", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("team-trends-saldo")).toBeInTheDocument());
    expect(screen.getByText("Salden")).toBeInTheDocument();

    cleanup();
    mount({ saldoError: "Fehler beim Laden der Überstunden-Übersicht" });
    await waitFor(() =>
      expect(screen.getByText("Fehler beim Laden der Überstunden-Übersicht")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("team-trends-saldo")).toBeNull();
  });

  it("destroys its charts on unmount", async () => {
    mount();
    await waitFor(() => expect(charts).toHaveLength(3));
    cleanup();
    expect(charts.every((c) => c.destroyed)).toBe(true);
  });

  it("builds exactly three charts, every one through a builder (source scan)", () => {
    expect(source.match(/new Chart\(/g)).toHaveLength(3);
  });
});
