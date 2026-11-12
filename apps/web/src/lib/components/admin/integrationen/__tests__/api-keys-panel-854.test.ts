// Issue #854 (plan 14) - the „API-Schlüssel“ tab of Verwalten › System › Integrationen, mounted: the keys load
// lazily, a new key is shown ONCE and forgotten on close (T-854-34), the scopes travel unchanged, a revocation
// waits for its confirmation, the package hint (#566) replaces the create action and a 403 is a calm note.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/svelte";

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
const success = vi.fn();
const error = vi.fn();

const stores = vi.hoisted(() => ({ salons: undefined as unknown }));

vi.mock("$api/client", () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    delete: (...a: unknown[]) => del(...a),
  },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));
vi.mock("$stores/toast", () => ({
  toasts: { success: (m: string) => success(m), error: (m: string) => error(m), info: vi.fn() },
}));
vi.mock("$stores/salon-context", async () => {
  const { writable } = await import("svelte/store");
  stores.salons = writable({ loaded: true, salons: [], isMultiSalon: false });
  return {
    salonContext: stores.salons,
    // Unknown state never reads as "not booked".
    moduleBooked: (s: { packages?: { bookedModules: string[] } }, module: string) =>
      s.packages ? s.packages.bookedModules.includes(module) : undefined,
  };
});

import type { Writable } from "svelte/store";
import { renderWithTheme } from "$tests/test-utils";
import { ApiError } from "$api/client";
import ApiKeysPanel from "../ApiKeysPanel.svelte";

const salonStore = () => stores.salons as Writable<Record<string, unknown>>;

function key(overrides: Record<string, unknown>) {
  return {
    id: "a1",
    name: "DATEV-Export",
    keyPrefix: "clk_ab12",
    scopes: ["read:employees", "admin"],
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: "2026-10-01T08:00:00.000Z",
    ...overrides,
  };
}

const LIST = [key({}), key({ id: "a2", name: "Alt", revokedAt: "2026-10-02T08:00:00.000Z" })];

function setBooked(booked: boolean) {
  salonStore().set({
    loaded: true,
    salons: [],
    packages: { bookedModules: booked ? ["INTEGRATIONS"] : [] },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue(LIST);
  post.mockResolvedValue({ rawKey: "clk_SECRET_ONCE" });
  del.mockResolvedValue(undefined);
  setBooked(true);
});

describe("ApiKeysPanel", () => {
  it("loads nothing while the tab is not shown and once when it is", async () => {
    const { rerender } = renderWithTheme(ApiKeysPanel, { active: false });
    expect(get).not.toHaveBeenCalled();
    await rerender({ active: true });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    expect(get).toHaveBeenCalledWith("/api-keys");
  });

  it("lists the keys with German scope labels and Widerrufen only on an active key", async () => {
    renderWithTheme(ApiKeysPanel, { active: true });
    const table = await screen.findByRole("table", { name: /API-Schlüssel/ });
    expect(table.textContent).toContain("clk_ab12…");
    expect(table.textContent).toContain("Mitarbeiter lesen, Voller Zugriff");
    const active = screen.getByText("DATEV-Export").closest("tr") as HTMLElement;
    expect(within(active).getByRole("button", { name: "Widerrufen" })).toBeTruthy();
    const revoked = screen.getByText("Alt").closest("tr") as HTMLElement;
    expect(within(revoked).queryByRole("button")).toBeNull();
  });

  it("a 403 is a calm note, any other failure a retry", async () => {
    get.mockRejectedValueOnce(new ApiError(403, "Forbidden"));
    const first = renderWithTheme(ApiKeysPanel, { active: true });
    expect(
      await screen.findByText("Für die API-Schlüssel fehlt dir die Berechtigung."),
    ).toBeTruthy();
    first.unmount();

    get.mockRejectedValueOnce(new Error("down"));
    renderWithTheme(ApiKeysPanel, { active: true });
    await screen.findByText(/Die API-Schlüssel konnten nicht geladen werden/);
    await fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    await screen.findByRole("table", { name: /API-Schlüssel/ });
  });

  it("creates a key with the default scopes and shows the secret once", async () => {
    renderWithTheme(ApiKeysPanel, { active: true });
    await screen.findByRole("table", { name: /API-Schlüssel/ });
    await fireEvent.click(screen.getByRole("button", { name: "Schlüssel anlegen" }));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("Mitarbeiter lesen") as HTMLInputElement).checked).toBe(
      true,
    );
    expect((within(dialog).getByLabelText("Voller Zugriff") as HTMLInputElement).checked).toBe(
      false,
    );
    await fireEvent.input(within(dialog).getByLabelText(/^Name/), {
      target: { value: " Export " },
    });
    await fireEvent.click(within(dialog).getByLabelText("Überstunden lesen"));
    await fireEvent.click(within(dialog).getByRole("button", { name: "Schlüssel erstellen" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]).toEqual([
      "/api-keys",
      { name: "Export", scopes: ["read:employees", "read:time-entries", "read:overtime"] },
    ]);
    const shown = await screen.findByTestId("one-time-key");
    expect(shown.textContent).toContain("clk_SECRET_ONCE");
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await fireEvent.click(within(shown).getByRole("button", { name: "Schließen" }));
    expect(document.body.textContent).not.toContain("clk_SECRET_ONCE");
  });

  it("needs a name and at least one scope, and a refusal stays in the dialog", async () => {
    renderWithTheme(ApiKeysPanel, { active: true });
    await screen.findByRole("table", { name: /API-Schlüssel/ });
    await fireEvent.click(screen.getByRole("button", { name: "Schlüssel anlegen" }));
    const dialog = await screen.findByRole("dialog");
    await fireEvent.click(within(dialog).getByRole("button", { name: "Schlüssel erstellen" }));
    expect(await within(dialog).findByText("Gib dem Schlüssel einen Namen.")).toBeTruthy();

    await fireEvent.input(within(dialog).getByLabelText(/^Name/), { target: { value: "Export" } });
    await fireEvent.click(within(dialog).getByLabelText("Mitarbeiter lesen"));
    await fireEvent.click(within(dialog).getByLabelText("Zeiteinträge lesen"));
    await fireEvent.click(within(dialog).getByRole("button", { name: "Schlüssel erstellen" }));
    expect(await within(dialog).findByText("Wähl mindestens eine Berechtigung aus.")).toBeTruthy();
    expect(post).not.toHaveBeenCalled();

    post.mockRejectedValueOnce(new ApiError(409, "Das Zusatzmodul ist nicht gebucht."));
    await fireEvent.click(within(dialog).getByLabelText("Berichte lesen"));
    await fireEvent.click(within(dialog).getByRole("button", { name: "Schlüssel erstellen" }));
    expect(await within(dialog).findByText("Das Zusatzmodul ist nicht gebucht.")).toBeTruthy();
    expect(screen.queryByTestId("one-time-key")).toBeNull();
  });

  it("revoking waits for the confirmation", async () => {
    renderWithTheme(ApiKeysPanel, { active: true });
    await screen.findByRole("table", { name: /API-Schlüssel/ });
    const row = screen.getByText("DATEV-Export").closest("tr") as HTMLElement;
    await fireEvent.click(within(row).getByRole("button", { name: "Widerrufen" }));
    const dialog = await screen.findByRole("dialog");
    expect(del).not.toHaveBeenCalled();
    await fireEvent.click(within(dialog).getByRole("button", { name: "Widerrufen" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/api-keys/a1"));
    await waitFor(() => expect(success).toHaveBeenCalledWith("API-Schlüssel widerrufen."));
  });

  it("a tenant without the module sees the hint instead of the create action, keys stay revocable", async () => {
    setBooked(false);
    renderWithTheme(ApiKeysPanel, { active: true });
    await screen.findByRole("table", { name: /API-Schlüssel/ });
    expect(screen.getByTestId("module-hint").getAttribute("data-module")).toBe("INTEGRATIONS");
    expect(screen.queryByRole("button", { name: "Schlüssel anlegen" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Widerrufen" }).length).toBe(1);
  });
});
