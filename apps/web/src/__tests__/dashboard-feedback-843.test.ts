// #843 (D-843-08, D-843-19) - the dashboard acknowledges its four writes. Each action is mounted
// against the real page and pinned to the EXACT toast the action-messages module builds; a refused
// write must never produce a success toast (T-843-28).
const apiGet = vi.fn();
const apiPost = vi.fn();
const gotoMock = vi.fn();

vi.mock("$app/navigation", () => ({
  goto: (...args: unknown[]) => gotoMock(...args),
  afterNavigate: vi.fn(),
  replaceState: vi.fn(),
}));

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
      post: (...args: unknown[]) => apiPost(...args),
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
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import { ApiError } from "$api/client";
import { toasts } from "$stores/toast";
import {
  breakEnded,
  breakStarted,
  clockedIn,
  clockedOut,
  clockTime,
} from "$lib/feedback/action-messages";
import DashboardPage from "../routes/(app)/dashboard/+page.svelte";

const ENTRY_ID = "5d1c7e2a-3b4f-4c8d-9e0a-1b2c3d4e5f60";
const SALON = { id: "7a9b3c1d-2e4f-4a6b-8c0d-1e2f3a4b5c6d", name: "Salon Nord" };

// Local wall-clock instants, so every expectation holds in any time zone.
const local = (h: number, m: number) => new Date(2026, 10, 9, h, m, 0);

const NO_CHOICE = { offerChoice: false, preselectedSalonId: null, salons: [], fixedSalon: null };
const SALON_CHOICE = {
  offerChoice: true,
  preselectedSalonId: SALON.id,
  salons: [SALON],
  fixedSalon: null,
};

const RUNNING_ENTRY = {
  id: ENTRY_ID,
  startTime: local(8, 0).toISOString(),
  endTime: null,
  breakMinutes: 0,
};

/** The page's GET answers: today's rows and the clock-salon answer are the two the writes depend on. */
function serve(entries: unknown[], choice: unknown = NO_CHOICE) {
  apiGet.mockImplementation((path: string) => {
    if (path === "/time-entries/clock-salon") return Promise.resolve(choice);
    if (path.startsWith("/time-entries")) return Promise.resolve(entries);
    if (path === "/me/context") {
      return Promise.resolve({
        tenant: { id: "t1", name: "Mandant" },
        isMultiSalon: false,
        homeSalonId: null,
        salons: [],
      });
    }
    return Promise.reject(new ApiError(404, "not part of this test"));
  });
}

let success: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  gotoMock.mockReset();
  try {
    localStorage.clear();
  } catch {
    /* no storage in this environment; the page tolerates it */
  }
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(local(12, 3));
  vi.spyOn(console, "error").mockImplementation(() => {});
  success = vi.spyOn(toasts, "success").mockReturnValue(crypto.randomUUID());
  error = vi.spyOn(toasts, "error").mockReturnValue(crypto.randomUUID());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("dashboard - the four clock and break writes acknowledge their result (#843)", () => {
  it("clock in: toasts the start time of the returned entry and the picked salon", async () => {
    serve([], SALON_CHOICE);
    const started = local(10, 2).toISOString();
    apiPost.mockResolvedValue({
      resolution: {
        kind: "CLOCKED_IN",
        entry: {
          id: ENTRY_ID,
          startTime: started,
          endTime: null,
          employeeId: "e1",
          source: "MOBILE",
        },
      },
    });
    renderWithTheme(DashboardPage, {});

    const button = await screen.findByRole("button", { name: "Einstempeln" });
    await waitFor(() => expect(button).toBeEnabled());
    await fireEvent.click(button);

    await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith("/time-entries/clock-in", {
      source: "MOBILE",
      salonId: SALON.id,
    });
    expect(success).toHaveBeenCalledWith(clockedIn(clockTime(started), SALON.name));
    expect(success).toHaveBeenCalledWith("Eingestempelt 10:02 · Salon Nord");
    expect(error).not.toHaveBeenCalled();
  });

  it("clock in without any known salon leaves the salon part out", async () => {
    serve([]);
    const started = local(10, 2).toISOString();
    apiPost.mockResolvedValue({
      resolution: {
        kind: "CLOCKED_IN",
        entry: {
          id: ENTRY_ID,
          startTime: started,
          endTime: null,
          employeeId: "e1",
          source: "MOBILE",
        },
      },
    });
    renderWithTheme(DashboardPage, {});

    await fireEvent.click(await screen.findByRole("button", { name: "Einstempeln" }));

    await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
    expect(success).toHaveBeenCalledWith(clockedIn(clockTime(started), null));
    expect(success).toHaveBeenCalledWith("Eingestempelt 10:02");
  });

  it("a refused clock in toasts the error and never a success", async () => {
    serve([]);
    apiPost.mockRejectedValue(new ApiError(409, "Einstempeln nicht möglich"));
    renderWithTheme(DashboardPage, {});

    await fireEvent.click(await screen.findByRole("button", { name: "Einstempeln" }));

    await waitFor(() => expect(error).toHaveBeenCalledWith("Einstempeln nicht möglich"));
    expect(success).not.toHaveBeenCalled();
  });

  it("clock out: toasts the end time of the closed entry", async () => {
    serve([RUNNING_ENTRY]);
    const ended = local(18, 1).toISOString();
    apiPost.mockResolvedValue({
      resolution: { kind: "CLOCKED_OUT", entry: { id: ENTRY_ID, endTime: ended } },
    });
    renderWithTheme(DashboardPage, {});

    await fireEvent.click(await screen.findByRole("button", { name: "Ausstempeln" }));

    await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith(`/time-entries/${ENTRY_ID}/clock-out`, {});
    expect(success).toHaveBeenCalledWith(clockedOut(clockTime(ended)));
    expect(success).toHaveBeenCalledWith("Ausgestempelt 18:01");
  });

  // Issue #596 (#845): the running break is a server state — start AND end go to the server
  // (POST /time-entries/:id/break), each acknowledged only after it answered.
  it("break start and break end are acknowledged after the server answered", async () => {
    const entry = { ...RUNNING_ENTRY, breakStartedAt: null as string | null };
    serve([entry]);
    apiPost.mockImplementation((path: string, body: { action: string }) => {
      expect(path).toBe(`/time-entries/${ENTRY_ID}/break`);
      if (body.action === "start") {
        entry.breakStartedAt = local(12, 3).toISOString();
        return Promise.resolve({ breakStartedAt: entry.breakStartedAt, breakMinutes: 0 });
      }
      entry.breakStartedAt = null;
      return Promise.resolve({ breakStartedAt: null, breakMinutes: 30 });
    });
    renderWithTheme(DashboardPage, {});

    await fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith(`/time-entries/${ENTRY_ID}/break`, { action: "start" });
    expect(success).toHaveBeenLastCalledWith(breakStarted(clockTime(local(12, 3))));
    expect(success).toHaveBeenLastCalledWith("Pause gestartet 12:03");

    vi.setSystemTime(local(12, 33));
    await fireEvent.click(await screen.findByRole("button", { name: "Weiterarbeiten" }));
    await waitFor(() => expect(success).toHaveBeenCalledTimes(2));
    expect(apiPost).toHaveBeenLastCalledWith(`/time-entries/${ENTRY_ID}/break`, { action: "end" });
    expect(success).toHaveBeenLastCalledWith(breakEnded(clockTime(local(12, 33))));
    expect(success).toHaveBeenLastCalledWith("Pause beendet 12:33");
  });

  it("a refused break end toasts the error and no success", async () => {
    serve([{ ...RUNNING_ENTRY, breakStartedAt: local(12, 3).toISOString() }]);
    apiPost.mockRejectedValue(new ApiError(409, "Es läuft keine Pause."));
    renderWithTheme(DashboardPage, {});

    await fireEvent.click(await screen.findByRole("button", { name: "Weiterarbeiten" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("Es läuft keine Pause."));
    expect(success).not.toHaveBeenCalled();
  });
});
