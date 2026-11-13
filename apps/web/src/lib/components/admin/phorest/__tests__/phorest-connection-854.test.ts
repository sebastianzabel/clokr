// Issue #854 (plan 16) - the „Verbindung“ tab of Verwalten › System › Phorest, mounted: the form shows the stored
// values and never the password, one SaveBar sends exactly the keys of the registry section, the branch is sent
// only while exactly one salon is active and the package allows a coupling (Issue #65, #566), an invalid value
// blocks the save, and the staff mapping pre-fills the server's suggestion without calling it unsaved. The route
// page cannot be mounted, so these mount tests are the panel's gate.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/svelte";

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
const del = vi.fn();
const success = vi.fn();
const error = vi.fn();

const stores = vi.hoisted(() => ({ salons: undefined as unknown }));

vi.mock("$api/client", () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    put: (...a: unknown[]) => put(...a),
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
vi.mock("$stores/auth", async () => {
  const { readable } = await import("svelte/store");
  return { authStore: readable({ user: { id: "u1" } }) };
});
vi.mock("$stores/salon-context", async () => {
  const { writable } = await import("svelte/store");
  const store = writable({ loaded: true, salons: [], isMultiSalon: false });
  stores.salons = Object.assign(store, { load: () => Promise.resolve() });
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
import { settingsSection } from "$lib/settings/settings-pages";
import Harness from "./PhorestHarness.svelte";

const salonStore = () => stores.salons as Writable<Record<string, unknown>>;
const keysOf = (id: string) => [...settingsSection(id).keys].sort();
const bar = () => screen.queryByRole("region", { name: "Speicherleiste" });

const CONFIG = {
  configured: true,
  phorestBusinessId: "biz-1",
  branchId: "branch-1",
  branchIdEditable: true,
  phorestUsername: "api@salon.test",
  phorestAutoSync: false,
  phorestSyncCron: "0 3 * * *",
  phorestSyncWindowDays: 7,
  phorestPrepMinutes: 5,
  phorestWrapupMinutes: 10,
};

const STAFF = {
  staff: [
    {
      phorestStaffId: "ps-1",
      name: "Anna Muster",
      email: "anna@salon.test",
      savedEmployeeId: "e1",
      suggestedEmployeeId: null,
    },
    {
      phorestStaffId: "ps-2",
      name: "Ben Probe",
      email: null,
      savedEmployeeId: null,
      suggestedEmployeeId: "e2",
    },
  ],
};
const EMPLOYEES = [
  { id: "e1", firstName: "Anna", lastName: "Muster" },
  { id: "e2", firstName: "Ben", lastName: "Probe" },
];

function route(config: Record<string, unknown> = CONFIG) {
  get.mockImplementation((path: string) => {
    if (path === "/integrations/phorest/config") return Promise.resolve(config);
    if (path === "/integrations/phorest/staff") return Promise.resolve(STAFF);
    if (path.startsWith("/employees")) return Promise.resolve(EMPLOYEES);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
}

/** The body of a PUT as the wire carries it: an undefined value is not sent. */
const wireBody = (call: number) => JSON.parse(JSON.stringify(put.mock.calls[call][1]));

async function mount(config: Record<string, unknown> = CONFIG) {
  route(config);
  const view = renderWithTheme(Harness, {});
  await screen.findByLabelText(/Business-ID/);
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  put.mockResolvedValue({ success: true });
  post.mockResolvedValue({});
  del.mockResolvedValue({});
  salonStore().set({ loaded: true, salons: [], isMultiSalon: false });
});

describe("the form", () => {
  it("shows the stored values, an empty password and no SaveBar", async () => {
    await mount();
    expect((screen.getByLabelText(/Business-ID/) as HTMLInputElement).value).toBe("biz-1");
    expect((screen.getByLabelText(/Branch-ID/) as HTMLInputElement).value).toBe("branch-1");
    expect((screen.getByLabelText(/API-Benutzername/) as HTMLInputElement).value).toBe(
      "api@salon.test",
    );
    expect((screen.getByLabelText("API-Passwort") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/Vorbereitungszeit/) as HTMLInputElement).value).toBe("5");
    expect(bar()).toBeNull();
    expect(screen.getByTestId("h-configured").textContent).toBe("true");
  });

  it("sends exactly the nine keys of the registry section, without a password nobody typed", async () => {
    await mount();
    await fireEvent.input(screen.getByLabelText(/Business-ID/), { target: { value: "biz-2" } });
    await fireEvent.click(
      await screen.findByRole("button", { name: "Phorest-Einstellungen speichern" }),
    );
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const body = wireBody(0);
    expect(put.mock.calls[0][0]).toBe("/integrations/phorest/config");
    expect(body).toEqual({
      phorestBusinessId: "biz-2",
      phorestUsername: "api@salon.test",
      phorestAutoSync: false,
      phorestSyncCron: "0 3 * * *",
      phorestSyncWindowDays: 7,
      phorestPrepMinutes: 5,
      phorestWrapupMinutes: 10,
      branchId: "branch-1",
    });
    // Every key sent belongs to the section, and only the unset password is missing from the nine.
    expect(Object.keys(body).sort()).toEqual(
      keysOf("phorest-verbindung").filter((key) => key !== "phorestPassword"),
    );
    await waitFor(() => expect(bar()).toBeNull());
    expect(success).toHaveBeenCalledWith("Phorest-Einstellungen gespeichert.");
  });

  it("sends a typed password once and empties the field afterwards (write-only)", async () => {
    await mount();
    const password = screen.getByLabelText("API-Passwort") as HTMLInputElement;
    await fireEvent.input(password, { target: { value: "geheim-123" } });
    // The presence of a typed password is a change; its value never enters the snapshot.
    expect(screen.getByTestId("h-changes").textContent).toBe("1");
    await fireEvent.click(
      await screen.findByRole("button", { name: "Phorest-Einstellungen speichern" }),
    );
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(wireBody(0).phorestPassword).toBe("geheim-123");
    expect(Object.keys(wireBody(0)).sort()).toEqual(keysOf("phorest-verbindung"));
    await waitFor(() => expect(password.value).toBe(""));
    expect(screen.getByTestId("h-changes").textContent).toBe("0");
    expect(document.body.textContent).not.toContain("geheim-123");
  });

  it("blocks a value outside its bounds and an empty required field", async () => {
    await mount();
    await fireEvent.input(screen.getByLabelText(/Vorbereitungszeit/), { target: { value: "31" } });
    await fireEvent.input(screen.getByLabelText(/Business-ID/), { target: { value: " " } });
    const region = await screen.findByRole("region", { name: "Speicherleiste" });
    expect(region.textContent).toContain("2 Fehler");
    expect(
      (screen.getByRole("button", { name: "Phorest-Einstellungen speichern" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(put).not.toHaveBeenCalled();
  });

  it("keeps the edit and says why when the save is refused", async () => {
    put.mockRejectedValueOnce(new Error("Diese Filiale ist schon gekoppelt."));
    await mount();
    const business = screen.getByLabelText(/Business-ID/) as HTMLInputElement;
    await fireEvent.input(business, { target: { value: "biz-2" } });
    await fireEvent.click(
      await screen.findByRole("button", { name: "Phorest-Einstellungen speichern" }),
    );
    await waitFor(() => expect(error).toHaveBeenCalledWith("Diese Filiale ist schon gekoppelt."));
    expect(business.value).toBe("biz-2");
    expect(bar()).not.toBeNull();
  });

  it("shows the auto-sync schedule only while the switch is on", async () => {
    await mount();
    expect(screen.queryByLabelText("Zeitplan")).toBeNull();
    await fireEvent.click(screen.getByLabelText("Automatischen Abgleich aktivieren"));
    expect(screen.getByLabelText("Zeitplan")).toBeTruthy();
  });
});

describe("the Branch-ID (Issue #65, #566)", () => {
  it("is locked with several active salons, explains it and is not sent", async () => {
    await mount({ ...CONFIG, branchId: null, branchIdEditable: false });
    expect((screen.getByLabelText(/Branch-ID/) as HTMLInputElement).disabled).toBe(true);
    expect(
      screen.getByText("Mehrere aktive Salons — die Phorest-Filiale wird je Salon gekoppelt."),
    ).toBeTruthy();
    await fireEvent.input(screen.getByLabelText(/Business-ID/), { target: { value: "biz-2" } });
    await fireEvent.click(
      await screen.findByRole("button", { name: "Phorest-Einstellungen speichern" }),
    );
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(wireBody(0)).not.toHaveProperty("branchId");
  });

  it("is locked with the package hint when Integrationen is not booked and no coupling exists", async () => {
    salonStore().set({ loaded: true, salons: [], packages: { bookedModules: [] } });
    await mount({ ...CONFIG, branchId: null });
    expect((screen.getByLabelText(/Branch-ID/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getAllByTestId("module-hint")).toHaveLength(1);
    await fireEvent.input(screen.getByLabelText(/Business-ID/), { target: { value: "biz-2" } });
    await fireEvent.click(
      await screen.findByRole("button", { name: "Phorest-Einstellungen speichern" }),
    );
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(wireBody(0)).not.toHaveProperty("branchId");
  });

  it("stays editable without the package when a coupling exists already", async () => {
    salonStore().set({ loaded: true, salons: [], packages: { bookedModules: [] } });
    await mount();
    expect((screen.getByLabelText(/Branch-ID/) as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByTestId("module-hint")).toBeNull();
  });
});

describe("the load", () => {
  it("shows a calm note on a 403 and no form", async () => {
    get.mockRejectedValue(new ApiError(403, "Forbidden"));
    renderWithTheme(Harness, {});
    expect(await screen.findByText(/fehlt dir die Berechtigung/)).toBeTruthy();
    expect(screen.queryByLabelText(/Business-ID/)).toBeNull();
  });

  it("shows a retry state, not an editable form, when the config cannot be read", async () => {
    get.mockRejectedValue(new Error("down"));
    renderWithTheme(Harness, {});
    expect(await screen.findByText(/konnten nicht geladen werden/)).toBeTruthy();
    expect(screen.queryByLabelText(/Business-ID/)).toBeNull();
  });

  it("an unconfigured tenant sees only the credentials and cannot test yet", async () => {
    await mount({
      ...CONFIG,
      configured: false,
      phorestBusinessId: null,
      phorestUsername: null,
      branchId: null,
    });
    expect(screen.queryByLabelText(/Vorbereitungszeit/)).toBeNull();
    expect(screen.queryByText("Mitarbeiter-Zuordnung")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Verbindung testen" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("the connection test", () => {
  it("reports success and failure and tells the status strip", async () => {
    await mount();
    post.mockResolvedValueOnce({ ok: true, staffCount: 4, branchName: "Mitte" });
    await fireEvent.click(screen.getByRole("button", { name: "Verbindung testen" }));
    expect(
      await screen.findByText(/Verbindung erfolgreich: Branch „Mitte“, 4 Mitarbeiter/),
    ).toBeTruthy();
    expect(screen.getByTestId("h-test").textContent).toBe("true");

    post.mockResolvedValueOnce({ ok: false, message: "Zugangsdaten abgelehnt." });
    await fireEvent.click(screen.getByRole("button", { name: "Verbindung testen" }));
    expect(await screen.findByText("Zugangsdaten abgelehnt.")).toBeTruthy();
    expect(screen.getByTestId("h-test").textContent).toBe("false");
    expect(post).toHaveBeenCalledWith("/integrations/phorest/test", {});
  });
});

describe("the staff mapping", () => {
  it("pre-fills the suggestion without counting it as unsaved and reports the figures", async () => {
    await mount();
    const table = await screen.findByRole("table");
    const ben = within(table).getByLabelText(
      "Clokr-Mitarbeiter für Ben Probe",
    ) as HTMLSelectElement;
    expect(ben.value).toBe("e2");
    expect(within(table).getByText("Zugeordnet")).toBeTruthy();
    expect(within(table).getByText("Vorschlag")).toBeTruthy();
    expect(screen.getByTestId("h-changes").textContent).toBe("0");
    expect(screen.getByTestId("h-mapped").textContent).toBe("1/2");
    expect(screen.getByText(/1 Phorest-Mitarbeitende ohne Zuordnung/)).toBeTruthy();
  });

  it("counts a changed selection, saves one row and moves the baseline", async () => {
    await mount();
    const table = await screen.findByRole("table");
    const ben = within(table).getByLabelText(
      "Clokr-Mitarbeiter für Ben Probe",
    ) as HTMLSelectElement;
    await fireEvent.change(ben, { target: { value: "e1" } });
    expect(screen.getByTestId("h-changes").textContent).toBe("1");

    const save = within(table).getAllByRole("button", { name: "Zuordnung speichern" })[1];
    await fireEvent.click(save);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/integrations/phorest/mappings", {
        phorestStaffId: "ps-2",
        employeeId: "e1",
      }),
    );
    await waitFor(() => expect(screen.getByTestId("h-changes").textContent).toBe("0"));
    expect(screen.getByTestId("h-mapped").textContent).toBe("2/2");
    expect(success).toHaveBeenCalledWith("Zuordnung gespeichert.");
  });

  it("removes a mapping only after the confirmation", async () => {
    await mount();
    const table = await screen.findByRole("table");
    await fireEvent.click(within(table).getByRole("button", { name: "Aufheben" }));
    expect(del).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    await fireEvent.click(within(dialog).getByRole("button", { name: "Aufheben" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/integrations/phorest/mappings/ps-1"));
    await waitFor(() => expect(screen.getByTestId("h-mapped").textContent).toBe("0/2"));
    expect(screen.getByTestId("h-changes").textContent).toBe("0");
  });
});
