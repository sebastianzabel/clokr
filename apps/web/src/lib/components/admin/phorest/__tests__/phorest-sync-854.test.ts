// Issue #854 (plan 16) - the „Abgleich“ tab of Verwalten › System › Phorest, mounted: the runs are read once the
// connection is configured, „Jetzt abgleichen“ posts the chosen or the default window and reports the result, a
// refused run shows its reason, the latest run is a KpiStrip and the history a DataTable with the server's paging.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/svelte";

const get = vi.fn();
const post = vi.fn();
const success = vi.fn();
const error = vi.fn();

vi.mock("$api/client", () => ({
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));
vi.mock("$stores/toast", () => ({
  toasts: { success: (m: string) => success(m), error: (m: string) => error(m), info: vi.fn() },
}));

// The harness also imports the connection panel, which reads these two stores.
vi.mock("$stores/auth", async () => {
  const { readable } = await import("svelte/store");
  return { authStore: readable({ user: { id: "u1" } }) };
});
vi.mock("$stores/salon-context", async () => {
  const { writable } = await import("svelte/store");
  return {
    salonContext: Object.assign(writable({ loaded: true, salons: [] }), {
      load: () => Promise.resolve(),
    }),
    moduleBooked: () => undefined,
  };
});

import { renderWithTheme } from "$tests/test-utils";
import Harness from "./PhorestHarness.svelte";

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    startedAt: "2026-11-10T03:00:00.000Z",
    finishedAt: "2026-11-10T03:00:05.000Z",
    status: "SUCCESS",
    created: 12,
    updated: 3,
    cancelled: 1,
    unmapped: 2,
    error: null,
    skippedVocationalSchool: 4,
    replaced: 0,
    ...overrides,
  };
}

function runsAnswer(latest: Record<string, unknown> | null, history = latest ? [latest] : []) {
  get.mockImplementation((path: string) => {
    if (path.startsWith("/integrations/phorest/sync-runs")) {
      return Promise.resolve({ latest, history, total: history.length });
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ status: "SUCCESS", created: 5, updated: 1, cancelled: 0, unmapped: 1 });
});

describe("before the connection is configured", () => {
  it("asks for the credentials first and reads nothing", async () => {
    renderWithTheme(Harness, { panel: "sync", configured: false });
    expect(await screen.findByText(/Speichere zuerst die Zugangsdaten/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Jetzt abgleichen" })).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});

describe("the runs", () => {
  it("shows the latest run as figures and the history as a table", async () => {
    runsAnswer(run(), [
      run(),
      run({ id: "r0", status: "ERROR", error: "Phorest antwortet nicht." }),
    ]);
    renderWithTheme(Harness, { panel: "sync", configured: true });
    const strip = await screen.findByRole("group", { name: "Zahlen des letzten Laufs" });
    expect(within(strip).getByText("Importiert")).toBeTruthy();
    expect(within(strip).getByText("12")).toBeTruthy();
    expect(within(strip).getByText("BS übersprungen")).toBeTruthy();
    const table = await screen.findByRole("table", { name: /Verlauf der Abgleiche/ });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByText("Fehler")).toBeTruthy();
    expect(get).toHaveBeenCalledWith("/integrations/phorest/sync-runs?limit=10&page=0");
    expect(screen.getByTestId("h-latest").textContent).toBe("SUCCESS");
  });

  it("names the reason of a failed or suspect latest run", async () => {
    runsAnswer(run({ status: "SUSPECT", error: "Auffällig viele Absagen." }));
    renderWithTheme(Harness, { panel: "sync", configured: true });
    expect(await screen.findByText("Auffällig viele Absagen.")).toBeTruthy();
  });

  it("says so when no run exists yet", async () => {
    runsAnswer(null);
    renderWithTheme(Harness, { panel: "sync", configured: true });
    expect(await screen.findByText(/Noch kein Abgleich gelaufen/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("Jetzt abgleichen", () => {
  it("posts the window of today up to today plus the sync window when no range is chosen", async () => {
    runsAnswer(run());
    renderWithTheme(Harness, { panel: "sync", configured: true });
    await screen.findByRole("group", { name: "Zahlen des letzten Laufs" });
    await fireEvent.click(screen.getByRole("button", { name: "Jetzt abgleichen" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, body] = post.mock.calls[0];
    expect(path).toBe("/integrations/phorest/sync-shifts");
    expect(body.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const days = (Date.parse(body.endDate) - Date.parse(body.startDate)) / 86_400_000;
    expect(days).toBe(7);
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith(
        "5 Schichten importiert · 0 abgesagt · 1 ohne Zuordnung",
      ),
    );
    // The run list is read again and the owner (the mapping table) is told.
    await waitFor(() => expect(screen.getByTestId("h-synced").textContent).toBe("1"));
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("posts the explicit range when both dates are set", async () => {
    runsAnswer(run());
    renderWithTheme(Harness, { panel: "sync", configured: true });
    await screen.findByRole("group", { name: "Zahlen des letzten Laufs" });
    await fireEvent.input(screen.getByLabelText("Von"), { target: { value: "2026-12-01" } });
    await fireEvent.input(screen.getByLabelText("Bis"), { target: { value: "2026-12-14" } });
    await fireEvent.click(screen.getByRole("button", { name: "Jetzt abgleichen" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/integrations/phorest/sync-shifts", {
        startDate: "2026-12-01",
        endDate: "2026-12-14",
      }),
    );
  });

  it("shows the reason of a refused run, cancels nothing and says so", async () => {
    runsAnswer(run());
    post.mockResolvedValueOnce({
      status: "ERROR",
      created: 0,
      updated: 0,
      cancelled: 0,
      unmapped: 0,
      error: "Zu viele Absagen.",
    });
    renderWithTheme(Harness, { panel: "sync", configured: true });
    await screen.findByRole("group", { name: "Zahlen des letzten Laufs" });
    await fireEvent.click(screen.getByRole("button", { name: "Jetzt abgleichen" }));
    expect(
      await screen.findByText(/Zu viele Absagen\. Es wurden keine Schichten abgesagt/),
    ).toBeTruthy();
    expect(error).toHaveBeenCalledWith("Der Abgleich war nicht erfolgreich.");
  });

  it("shows a failed request as a note and keeps the button usable afterwards", async () => {
    runsAnswer(run());
    post.mockRejectedValueOnce(new Error("Phorest nicht erreichbar."));
    renderWithTheme(Harness, { panel: "sync", configured: true });
    await screen.findByRole("group", { name: "Zahlen des letzten Laufs" });
    await fireEvent.click(screen.getByRole("button", { name: "Jetzt abgleichen" }));
    expect(await screen.findByText("Phorest nicht erreichbar.")).toBeTruthy();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Jetzt abgleichen" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  it("is disabled while a run is in progress", async () => {
    runsAnswer(run());
    let finish: (value: unknown) => void = () => {};
    post.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    renderWithTheme(Harness, { panel: "sync", configured: true });
    await screen.findByRole("group", { name: "Zahlen des letzten Laufs" });
    await fireEvent.click(screen.getByRole("button", { name: "Jetzt abgleichen" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: /Jetzt abgleichen/ }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    finish({ status: "SUCCESS", created: 0, updated: 0, cancelled: 0, unmapped: 0 });
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: /Jetzt abgleichen/ }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });
});
