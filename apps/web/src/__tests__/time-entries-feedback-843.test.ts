// #843 (D-843-08, D-843-19) - a saved time correction acknowledges its result. The real page is
// mounted; each save is pinned to the EXACT text the action-messages module builds, and a refused
// write (overlap 409) must never produce a success toast (T-843-28). The retro paths keep their own
// toasts and are not asserted here beyond "no second toast" on the normal path.
const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPut = vi.fn();

vi.mock("$app/stores", async () => {
  const { readable } = await import("svelte/store");
  return {
    page: readable({ url: new URL("http://localhost/time-entries?view=list"), params: {} }),
  };
});

vi.mock("$stores/auth", async () => {
  const { writable } = await import("svelte/store");
  return {
    authStore: writable({
      user: { id: "u1", employeeId: "emp-1", permissions: [] },
    }),
  };
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
      put: (...args: unknown[]) => apiPut(...args),
      patch: vi.fn(),
      delete: vi.fn(),
    },
  };
});

vi.mock("$lib/utils/logger", () => ({
  clientLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import { ApiError } from "$api/client";
import { toasts } from "$stores/toast";
import { correctionSaved } from "$lib/feedback/action-messages";
import TimeEntriesPage from "../routes/(app)/time-entries/+page.svelte";

const ENTRY_ID = "5d1c7e2a-3b4f-4c8d-9e0a-1b2c3d4e5f60";

// Local wall-clock instants, so every expectation holds in any time zone.
const local = (h: number, m: number) => new Date(2026, 10, 9, h, m, 0);

const ENTRY = {
  id: ENTRY_ID,
  date: "2026-11-09T00:00:00.000Z",
  startTime: local(8, 0).toISOString(),
  endTime: local(16, 0).toISOString(),
  breakMinutes: 30,
  breaks: [],
  type: "WORK",
  source: "MANUAL",
  note: null,
  salonId: null,
  salonName: null,
};

function serve(entries: unknown[]) {
  apiGet.mockImplementation((path: string) => {
    if (path.startsWith("/time-entries")) return Promise.resolve(entries);
    if (path.startsWith("/day-breaks/checks")) return Promise.resolve({ days: [] });
    if (path.startsWith("/employees/")) {
      return Promise.resolve({ hireDate: "2026-01-01T00:00:00.000Z", isTimeTrackingExempt: false });
    }
    if (path === "/settings/work") return Promise.resolve({ arbzgEnabled: true });
    if (path.startsWith("/holidays") || path.startsWith("/leave/requests")) {
      return Promise.resolve([]);
    }
    if (path.startsWith("/vocational-school")) return Promise.resolve([]);
    return Promise.reject(new ApiError(404, "not part of this test"));
  });
}

/** The save writes; the day-break preview the form runs on every edit is answered with an empty finding. */
function servePost(save: () => Promise<unknown>) {
  apiPost.mockImplementation((path: string) => {
    if (path === "/time-entries") return save();
    return Promise.resolve({ findings: [], warnings: [], autoBreak: null });
  });
}

let success: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiPut.mockReset();
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
  vi.spyOn(toasts, "warning").mockReturnValue(crypto.randomUUID());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function openEditAndSave() {
  renderWithTheme(TimeEntriesPage, {});
  // Issue #927: the row actions sit in the row's „…“ menu; open it, then choose „Bearbeiten“.
  await fireEvent.click(await screen.findByTestId(`time-entry-row-${ENTRY_ID}-menu`));
  await fireEvent.click(await screen.findByTestId(`time-entry-row-${ENTRY_ID}-edit`));
  await fireEvent.click(await screen.findByTestId("time-entry-modal-save"));
}

describe("time-entries acknowledges a saved correction (#843)", () => {
  it("an edited entry (PUT 200) toasts „Korrektur gespeichert“ once", async () => {
    serve([ENTRY]);
    servePost(() => Promise.resolve({}));
    apiPut.mockResolvedValue({ ...ENTRY });
    await openEditAndSave();
    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
    expect(success).toHaveBeenCalledWith(correctionSaved());
    expect(success).toHaveBeenCalledWith("Korrektur gespeichert");
    expect(error).not.toHaveBeenCalled();
  });

  it("a new manual entry (POST 201) toasts „Korrektur gespeichert“ once", async () => {
    serve([]);
    servePost(() => Promise.resolve({ ...ENTRY }));
    renderWithTheme(TimeEntriesPage, {});
    await fireEvent.click(await screen.findByTestId("time-entries-add"));
    await fireEvent.click(await screen.findByTestId("time-entry-modal-save"));
    await waitFor(() =>
      expect(apiPost.mock.calls.some(([path]) => path === "/time-entries")).toBe(true),
    );
    await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
    expect(success).toHaveBeenCalledWith(correctionSaved());
  });

  it("a refused edit (409 overlap) shows the error in the form and toasts no success", async () => {
    serve([ENTRY]);
    servePost(() => Promise.resolve({}));
    apiPut.mockRejectedValue(
      new ApiError(409, "Der Eintrag überschneidet sich mit einem anderen."),
    );
    await openEditAndSave();
    await waitFor(() =>
      expect(screen.getByTestId("time-entry-modal-error").textContent).toContain("überschneidet"),
    );
    expect(success).not.toHaveBeenCalled();
  });

  it("a refused new entry (409 overlap) toasts no success", async () => {
    serve([]);
    servePost(() =>
      Promise.reject(new ApiError(409, "Der Eintrag überschneidet sich mit einem anderen.")),
    );
    renderWithTheme(TimeEntriesPage, {});
    await fireEvent.click(await screen.findByTestId("time-entries-add"));
    await fireEvent.click(await screen.findByTestId("time-entry-modal-save"));
    await waitFor(() =>
      expect(screen.getByTestId("time-entry-modal-error").textContent).toContain("überschneidet"),
    );
    expect(success).not.toHaveBeenCalled();
  });
});
