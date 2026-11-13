// Issue #854 (plan 14) - the „NFC-Terminals“ tab of Verwalten › System › Integrationen, mounted: the keys load
// lazily, a new key is shown ONCE and forgotten on close, a revocation waits for its confirmation, the salon
// binding (#541) is an instant save, the package hint (#566) replaces the create action and a 403 is a calm
// note (T-854-34, T-854-35). The route page cannot be mounted, so these mount tests are the tab's gate.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/svelte";

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const del = vi.fn();
const success = vi.fn();
const error = vi.fn();

const stores = vi.hoisted(() => ({ salons: undefined as unknown }));

vi.mock("$api/client", () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    patch: (...a: unknown[]) => patch(...a),
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
    showSalonOptions: (s: { isMultiSalon: boolean; salons: unknown[] }) =>
      s.isMultiSalon && s.salons.length > 1,
    // Unknown state never reads as "not booked".
    moduleBooked: (s: { packages?: { bookedModules: string[] } }, module: string) =>
      s.packages ? s.packages.bookedModules.includes(module) : undefined,
  };
});

import type { Writable } from "svelte/store";
import { renderWithTheme } from "$tests/test-utils";
import { ApiError } from "$api/client";
import TerminalsPanel from "../TerminalsPanel.svelte";

const salonStore = () => stores.salons as Writable<Record<string, unknown>>;

const SALONS = [
  { id: "s1", name: "Salon Mitte" },
  { id: "s2", name: "Salon Nord" },
];

function key(overrides: Record<string, unknown>) {
  return {
    id: "k1",
    name: "Kasse 1",
    keyPrefix: "clt_ab12",
    lastUsedAt: null,
    revokedAt: null,
    createdAt: "2026-10-01T08:00:00.000Z",
    salonId: null,
    salonName: null,
    salonActive: null,
    ...overrides,
  };
}

const LIST = {
  keys: [key({}), key({ id: "k2", name: "Kasse 2", revokedAt: "2026-10-02T08:00:00.000Z" })],
};

function setSalons(salons: typeof SALONS, isMultiSalon: boolean, booked = true) {
  salonStore().set({
    loaded: true,
    salons,
    isMultiSalon,
    packages: { bookedModules: booked ? ["HARDWARE_CLOCK"] : [] },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue(LIST);
  post.mockResolvedValue({ rawKey: "clt_SECRET_ONCE" });
  patch.mockResolvedValue(key({ salonId: "s2", salonName: "Salon Nord", salonActive: true }));
  del.mockResolvedValue(undefined);
  setSalons(SALONS, false);
});

describe("TerminalsPanel", () => {
  it("loads nothing while the tab is not shown and once when it is", async () => {
    const { rerender } = renderWithTheme(TerminalsPanel, { active: false });
    expect(get).not.toHaveBeenCalled();
    await rerender({ active: true });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    expect(get).toHaveBeenCalledWith("/terminals");
  });

  it("lists the keys with their status and offers Widerrufen only on an active key", async () => {
    renderWithTheme(TerminalsPanel, { active: true });
    const table = await screen.findByRole("table", { name: /NFC-Terminals/ });
    expect(table.textContent).toContain("Kasse 1");
    expect(table.textContent).toContain("clt_ab12");
    expect(table.textContent).toContain("Nie");
    const active = screen.getByText("Kasse 1").closest("tr") as HTMLElement;
    expect(within(active).getByText("Aktiv")).toBeTruthy();
    expect(within(active).getByRole("button", { name: "Widerrufen" })).toBeTruthy();
    const revoked = screen.getByText("Kasse 2").closest("tr") as HTMLElement;
    expect(within(revoked).getByText("Widerrufen", { selector: ".chip" })).toBeTruthy();
    expect(within(revoked).queryByRole("button")).toBeNull();
  });

  it("a 403 is a calm note, any other failure a retry", async () => {
    get.mockRejectedValueOnce(new ApiError(403, "Forbidden"));
    const first = renderWithTheme(TerminalsPanel, { active: true });
    expect(
      await screen.findByText("Für die Terminal-Schlüssel fehlt dir die Berechtigung."),
    ).toBeTruthy();
    first.unmount();

    get.mockRejectedValueOnce(new Error("down"));
    renderWithTheme(TerminalsPanel, { active: true });
    await screen.findByText(/Die Terminal-Schlüssel konnten nicht geladen werden/);
    await fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    await screen.findByRole("table", { name: /NFC-Terminals/ });
  });

  it("creates a key with the unchanged payload and shows the secret once", async () => {
    renderWithTheme(TerminalsPanel, { active: true });
    await screen.findByRole("table", { name: /NFC-Terminals/ });
    await fireEvent.click(screen.getByRole("button", { name: "Terminal anlegen" }));
    const dialog = await screen.findByRole("dialog");
    // Single-salon tenant: no salon field, and no salonId on the wire.
    expect(within(dialog).queryByLabelText("Salon")).toBeNull();
    await fireEvent.input(within(dialog).getByLabelText(/^Name/), {
      target: { value: " Kasse 3 " },
    });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Schlüssel erstellen" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]).toEqual(["/terminals", { name: "Kasse 3" }]);
    const shown = await screen.findByTestId("one-time-key");
    expect(shown.textContent).toContain("clt_SECRET_ONCE");
    expect(shown.textContent).toContain("Er wird nicht erneut angezeigt");
    // The list is read again after the write.
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    // Closing forgets the secret: it is rendered nowhere afterwards.
    await fireEvent.click(within(shown).getByRole("button", { name: "Schließen" }));
    expect(screen.queryByTestId("one-time-key")).toBeNull();
    expect(document.body.textContent).not.toContain("clt_SECRET_ONCE");
  });

  it("with salon options the dialog offers the salon and sends its id only when chosen", async () => {
    setSalons(SALONS, true);
    renderWithTheme(TerminalsPanel, { active: true });
    await screen.findByRole("table", { name: /NFC-Terminals/ });
    await fireEvent.click(screen.getByRole("button", { name: "Terminal anlegen" }));
    const dialog = await screen.findByRole("dialog");
    await fireEvent.input(within(dialog).getByLabelText(/^Name/), { target: { value: "Kasse 3" } });
    await fireEvent.change(within(dialog).getByLabelText("Salon"), { target: { value: "s2" } });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Schlüssel erstellen" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1]).toEqual({ name: "Kasse 3", salonId: "s2" });
  });

  it("an empty name sends nothing and a refusal stays in the dialog", async () => {
    renderWithTheme(TerminalsPanel, { active: true });
    await screen.findByRole("table", { name: /NFC-Terminals/ });
    await fireEvent.click(screen.getByRole("button", { name: "Terminal anlegen" }));
    const dialog = await screen.findByRole("dialog");
    await fireEvent.click(within(dialog).getByRole("button", { name: "Schlüssel erstellen" }));
    expect(await within(dialog).findByText("Gib dem Terminal einen Namen.")).toBeTruthy();
    expect(post).not.toHaveBeenCalled();

    post.mockRejectedValueOnce(new ApiError(409, "Das Zusatzmodul ist nicht gebucht."));
    await fireEvent.input(within(dialog).getByLabelText(/^Name/), { target: { value: "Kasse 3" } });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Schlüssel erstellen" }));
    expect(await within(dialog).findByText("Das Zusatzmodul ist nicht gebucht.")).toBeTruthy();
    expect(screen.queryByTestId("one-time-key")).toBeNull();
  });

  it("revoking waits for the confirmation", async () => {
    renderWithTheme(TerminalsPanel, { active: true });
    await screen.findByRole("table", { name: /NFC-Terminals/ });
    const row = screen.getByText("Kasse 1").closest("tr") as HTMLElement;
    await fireEvent.click(within(row).getByRole("button", { name: "Widerrufen" }));
    const dialog = await screen.findByRole("dialog");
    expect(del).not.toHaveBeenCalled();
    await fireEvent.click(within(dialog).getByRole("button", { name: "Widerrufen" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/terminals/k1"));
    await waitFor(() => expect(success).toHaveBeenCalledWith("Terminal-Schlüssel widerrufen."));
  });

  it("the salon column shows with salon options, saves a binding at once (#541)", async () => {
    setSalons(SALONS, true);
    renderWithTheme(TerminalsPanel, { active: true });
    await screen.findByRole("table", { name: /NFC-Terminals/ });
    expect(screen.getAllByTestId("terminal-salon-cell").length).toBeGreaterThan(0);
    const select = screen.getByLabelText("Salon für Kasse 1");
    await fireEvent.change(select, { target: { value: "s2" } });
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/terminals/k1", { salonId: "s2" }));
    await waitFor(() => expect(success).toHaveBeenCalledWith("Salon-Bindung gespeichert."));
  });

  it("a single-salon tenant shows the salon column only while a key is bound", async () => {
    renderWithTheme(TerminalsPanel, { active: true });
    await screen.findByRole("table", { name: /NFC-Terminals/ });
    expect(screen.queryByTestId("terminal-salon-cell")).toBeNull();
  });

  it("a tenant without the module sees the hint instead of the create action, keys stay revocable", async () => {
    setSalons(SALONS, false, false);
    renderWithTheme(TerminalsPanel, { active: true });
    await screen.findByRole("table", { name: /NFC-Terminals/ });
    expect(screen.getByTestId("module-hint").getAttribute("data-module")).toBe("HARDWARE_CLOCK");
    expect(screen.queryByRole("button", { name: "Terminal anlegen" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Widerrufen" }).length).toBe(1);
  });
});
