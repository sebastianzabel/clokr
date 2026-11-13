// Issue #854 (plan 14) - the „WLAN-Anwesenheit“ tab of Verwalten › System › Integrationen, mounted: sources, the
// pairing guide, the device list and the opt-in overview load when the tab is first shown; a source key is shown
// ONCE (T-854-34); revoke and unassign wait for their confirmation; a device is assigned in a Dialog; the package
// hint (#566) replaces the create action; a 403 is a calm note.
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
    moduleBooked: (s: { packages?: { bookedModules: string[] } }, module: string) =>
      s.packages ? s.packages.bookedModules.includes(module) : undefined,
  };
});

import type { Writable } from "svelte/store";
import { renderWithTheme } from "$tests/test-utils";
import { ApiError } from "$api/client";
import PresenceSourcesPanel from "../PresenceSourcesPanel.svelte";

const salonStore = () => stores.salons as Writable<Record<string, unknown>>;

const SOURCES = [
  {
    id: "p1",
    name: "FritzBox Büro",
    keyPrefix: "prs_ab12",
    adapterUrl: null,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: "2026-10-01T08:00:00.000Z",
  },
  {
    id: "p2",
    name: "Alt",
    keyPrefix: "prs_zz99",
    adapterUrl: null,
    lastUsedAt: null,
    revokedAt: "2026-10-02T08:00:00.000Z",
    createdAt: "2026-09-01T08:00:00.000Z",
  },
];
const DEVICES = [
  {
    mac: "AA:BB:CC:00:00:01",
    hostname: "iphone-anna",
    lastSeen: null,
    online: true,
    assignedEmployeeId: null,
    assignedEmployeeName: null,
  },
  {
    mac: "AA:BB:CC:00:00:02",
    hostname: "pixel-ben",
    lastSeen: null,
    online: false,
    assignedEmployeeId: "e2",
    assignedEmployeeName: "Ben Beispiel",
  },
];
const OPTED_IN = [
  {
    id: "e2",
    firstName: "Ben",
    lastName: "Beispiel",
    wifiPresenceEnabled: true,
    wifiOptInAt: "2026-10-03T08:00:00.000Z",
    wifiMacs: ["AA:BB:CC:00:00:02"],
  },
];
const EMPLOYEES = [
  { id: "e1", firstName: "Anna", lastName: "Muster" },
  { id: "e2", firstName: "Ben", lastName: "Beispiel" },
];

function route(path: string) {
  if (path === "/admin/presence-sources") return Promise.resolve({ sources: SOURCES });
  if (path === "/admin/presence-sources/p1/devices") return Promise.resolve({ devices: DEVICES });
  if (path === "/employees") return Promise.resolve(EMPLOYEES);
  if (path === "/admin/presence-sources/opted-in") return Promise.resolve({ employees: OPTED_IN });
  return Promise.reject(new Error(`unexpected GET ${path}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockImplementation(route);
  post.mockResolvedValue({ rawKey: "prs_SECRET_ONCE", source: SOURCES[0] });
  del.mockResolvedValue({ success: true, optInAutoDisabled: false });
  salonStore().set({ loaded: true, salons: [], packages: { bookedModules: ["HARDWARE_CLOCK"] } });
});

describe("PresenceSourcesPanel", () => {
  it("loads nothing while the tab is not shown; once shown it reads sources, opt-ins and the first device list", async () => {
    const { rerender } = renderWithTheme(PresenceSourcesPanel, { active: false });
    expect(get).not.toHaveBeenCalled();
    await rerender({ active: true });
    await screen.findByRole("table", { name: /WLAN-Geräte/ });
    const paths = get.mock.calls.map((call) => call[0]);
    expect(paths).toContain("/admin/presence-sources");
    expect(paths).toContain("/admin/presence-sources/p1/devices");
    expect(paths).toContain("/employees");
  });

  it("lists sources, devices and the opt-in overview, and renders the pairing guide in its own group", async () => {
    renderWithTheme(PresenceSourcesPanel, { active: true });
    const sources = await screen.findByRole("table", { name: /Präsenz-Quellen/ });
    expect(sources.textContent).toContain("FritzBox Büro");
    expect(sources.textContent).toContain("prs_ab12");
    const devices = await screen.findByRole("table", { name: /WLAN-Geräte/ });
    expect(devices.textContent).toContain("iphone-anna");
    expect(devices.textContent).toContain("Nicht zugewiesen");
    expect(devices.textContent).toContain("Ben Beispiel");
    const optIn = await screen.findByRole("table", { name: /Präsenzerkennung/ });
    expect(optIn.textContent).toContain("Ben Beispiel");
    expect(screen.getByRole("heading", { name: "Handys per QR-Code koppeln" })).toBeTruthy();
    expect(screen.getByLabelText("Adresse des Adapters im Salon-WLAN")).toBeTruthy();
  });

  it("a 403 is a calm note", async () => {
    get.mockRejectedValue(new ApiError(403, "Forbidden"));
    renderWithTheme(PresenceSourcesPanel, { active: true });
    expect(
      await screen.findByText("Für die WLAN-Anwesenheit fehlt dir die Berechtigung."),
    ).toBeTruthy();
  });

  it("creates a source, sends the adapter address only when typed, shows the key once", async () => {
    renderWithTheme(PresenceSourcesPanel, { active: true });
    await screen.findByRole("table", { name: /Präsenz-Quellen/ });
    await fireEvent.click(screen.getByRole("button", { name: "Quelle anlegen" }));
    const dialog = await screen.findByRole("dialog");
    await fireEvent.input(within(dialog).getByLabelText(/^Name/), { target: { value: " Büro " } });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Schlüssel erstellen" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]).toEqual([
      "/admin/presence-sources",
      { name: "Büro", adapterUrl: undefined },
    ]);
    const shown = await screen.findByTestId("one-time-key");
    expect(shown.textContent).toContain("prs_SECRET_ONCE");
    await fireEvent.click(within(shown).getByRole("button", { name: "Schließen" }));
    expect(document.body.textContent).not.toContain("prs_SECRET_ONCE");
  });

  it("a 409 shows the server's sentence, any other refusal the generic hint", async () => {
    renderWithTheme(PresenceSourcesPanel, { active: true });
    await screen.findByRole("table", { name: /Präsenz-Quellen/ });
    await fireEvent.click(screen.getByRole("button", { name: "Quelle anlegen" }));
    const dialog = await screen.findByRole("dialog");
    await fireEvent.click(within(dialog).getByRole("button", { name: "Schlüssel erstellen" }));
    expect(await within(dialog).findByText("Gib der Quelle einen Namen.")).toBeTruthy();
    await fireEvent.input(within(dialog).getByLabelText(/^Name/), { target: { value: "Büro" } });

    post.mockRejectedValueOnce(new ApiError(409, "Das Zusatzmodul ist nicht gebucht."));
    await fireEvent.click(within(dialog).getByRole("button", { name: "Schlüssel erstellen" }));
    expect(await within(dialog).findByText("Das Zusatzmodul ist nicht gebucht.")).toBeTruthy();

    post.mockRejectedValueOnce(new ApiError(500, "intern"));
    await fireEvent.click(within(dialog).getByRole("button", { name: "Schlüssel erstellen" }));
    expect(await within(dialog).findByText(/Schlüssel konnte nicht erstellt werden/)).toBeTruthy();
  });

  it("revoking a source waits for the confirmation", async () => {
    renderWithTheme(PresenceSourcesPanel, { active: true });
    await screen.findByRole("table", { name: /Präsenz-Quellen/ });
    await fireEvent.click(screen.getByRole("button", { name: "Quelle widerrufen" }));
    const dialog = await screen.findByRole("dialog");
    expect(del).not.toHaveBeenCalled();
    await fireEvent.click(within(dialog).getByRole("button", { name: "Widerrufen" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/admin/presence-sources/p1"));
    await waitFor(() => expect(success).toHaveBeenCalledWith("Präsenz-Quelle widerrufen."));
  });

  it("assigns a device to an employee from the dialog", async () => {
    post.mockResolvedValue({ employeeId: "e1", mac: "AA:BB:CC:00:00:01", optInAutoEnabled: true });
    renderWithTheme(PresenceSourcesPanel, { active: true });
    await screen.findByRole("table", { name: /WLAN-Geräte/ });
    await fireEvent.click(screen.getByRole("button", { name: "Zuweisen" }));
    const dialog = await screen.findByRole("dialog");
    const save = within(dialog).getByRole("button", {
      name: "Zuweisung speichern",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await fireEvent.change(within(dialog).getByLabelText("Mitarbeiter"), {
      target: { value: "e1" },
    });
    await fireEvent.click(save);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][0]).toBe(
      "/admin/presence-sources/p1/devices/AA%3ABB%3ACC%3A00%3A00%3A01/assign",
    );
    expect(post.mock.calls[0][1]).toEqual({ employeeId: "e1" });
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith(
        "Anna Muster zugewiesen. WLAN-Präsenz ist automatisch eingeschaltet.",
      ),
    );
  });

  it("unassigning waits for the confirmation", async () => {
    renderWithTheme(PresenceSourcesPanel, { active: true });
    await screen.findByRole("table", { name: /WLAN-Geräte/ });
    await fireEvent.click(screen.getByRole("button", { name: "Aufheben" }));
    const dialog = await screen.findByRole("dialog");
    expect(del).not.toHaveBeenCalled();
    expect(dialog.textContent).toContain("Ben Beispiel");
    await fireEvent.click(within(dialog).getByRole("button", { name: "Aufheben" }));
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith(
        "/admin/presence-sources/p1/devices/AA%3ABB%3ACC%3A00%3A00%3A02",
      ),
    );
    await waitFor(() => expect(success).toHaveBeenCalledWith("Zuweisung aufgehoben."));
  });

  it("a tenant without the module sees the hint instead of the create action, sources stay revocable", async () => {
    salonStore().set({ loaded: true, salons: [], packages: { bookedModules: [] } });
    renderWithTheme(PresenceSourcesPanel, { active: true });
    await screen.findByRole("table", { name: /Präsenz-Quellen/ });
    expect(screen.getByTestId("module-hint").getAttribute("data-module")).toBe("HARDWARE_CLOCK");
    expect(screen.queryByRole("button", { name: "Quelle anlegen" })).toBeNull();
    expect(screen.getByRole("button", { name: "Quelle widerrufen" })).toBeTruthy();
  });
});
