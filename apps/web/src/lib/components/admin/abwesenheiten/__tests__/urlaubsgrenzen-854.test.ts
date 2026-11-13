// Issue #854 (plan 13) - the „Urlaubsgrenzen & Sperren“ tab of Verwalten › Regeln › Abwesenheiten (the #836 rules
// and blackouts), mounted: the rules load lazily, a rule or a Urlaubssperre is created in a Dialog with the
// unchanged payload, a removal waits for its confirmation, controls follow `canManage` and the permission, and the
// tab is offered under leave-limit:manage or leave-request:approve (T-854-32, T-854-33). The route page cannot be
// mounted, so these mount tests (plus admin-leave-limits-page-836 for the source) are the tab's gate.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/svelte";

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
const del = vi.fn();
const success = vi.fn();
const error = vi.fn();

const stores = vi.hoisted(() => ({ salons: undefined as unknown, auth: undefined as unknown }));

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
  const { writable } = await import("svelte/store");
  stores.auth = writable({ user: { permissions: [] } });
  return { authStore: stores.auth };
});
vi.mock("$stores/salon-context", async () => {
  const { writable } = await import("svelte/store");
  stores.salons = writable({ loaded: false, salons: [], isMultiSalon: false });
  return {
    salonContext: stores.salons,
    // The #64 rule, as in the real module.
    showSalonOptions: (s: { isMultiSalon: boolean; salons: unknown[] }) =>
      s.isMultiSalon && s.salons.length > 1,
  };
});

import type { Writable } from "svelte/store";
import { renderWithTheme } from "$tests/test-utils";
import { ApiError } from "$api/client";
import { ABWESENHEITEN_TABS, visibleAbwesenheitenTabs } from "$lib/settings/abwesenheiten";
import type { LeaveLimitRuleDto, LeaveLimitRulesResponse } from "$lib/leave-limits/types";
import UrlaubsgrenzenPanel from "../UrlaubsgrenzenPanel.svelte";

const salonStore = () => stores.salons as Writable<Record<string, unknown>>;
const authStore = () => stores.auth as Writable<Record<string, unknown>>;

function rule(overrides: Partial<LeaveLimitRuleDto>): LeaveLimitRuleDto {
  return {
    id: "r1",
    salonId: null,
    salonName: null,
    salonActive: null,
    groupKind: "ALL",
    classification: null,
    accessRoleId: null,
    accessRoleName: null,
    maxPersons: 2,
    validFrom: null,
    validUntil: null,
    name: "Sommerferien",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    canManage: true,
    ...overrides,
  };
}

const RESPONSE: LeaveLimitRulesResponse = {
  rules: [
    rule({}),
    rule({
      id: "r2",
      maxPersons: 0,
      name: "Weihnachtsgeschäft",
      validFrom: "2026-12-20",
      validUntil: "2026-12-31",
    }),
    rule({
      id: "r3",
      groupKind: "CLASSIFICATION",
      classification: "AZUBI",
      name: "Azubi-Grenze",
      canManage: false,
    }),
  ],
  canManageAllSalons: true,
  roleChoices: [{ id: "role1", name: "Salonmanager", isSystem: true }],
};

function setSalons(salons: { id: string; name: string }[], isMultiSalon: boolean) {
  salonStore().set({ loaded: true, salons, isMultiSalon });
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue(RESPONSE);
  post.mockResolvedValue({});
  put.mockResolvedValue({});
  del.mockResolvedValue(undefined);
  authStore().set({ user: { permissions: ["leave-limit:manage:ZUGEWIESEN"] } });
  setSalons([{ id: "s1", name: "Salon Mitte" }], false);
});

describe("tab gating (T-854-33)", () => {
  const tabsOf = (permissions: string[]) =>
    visibleAbwesenheitenTabs({ permissions }).map((tab) => tab.value);

  it("the tab needs leave-limit:manage or leave-request:approve, and nothing else opens it", () => {
    expect(tabsOf(["leave-limit:manage:ZUGEWIESEN"])).toEqual(["urlaubsgrenzen"]);
    expect(tabsOf(["leave-request:approve:ZUGEWIESEN"])).toEqual(["urlaubsgrenzen"]);
    expect(tabsOf(["leave-config:manage:ZUGEWIESEN"])).not.toContain("urlaubsgrenzen");
    expect(tabsOf(["company-shutdown:manage:ZUGEWIESEN"])).not.toContain("urlaubsgrenzen");
    expect(tabsOf(["tenant-settings:update:ZUGEWIESEN"])).not.toContain("urlaubsgrenzen");
    expect(tabsOf([])).toEqual([]);
  });

  it("a holder of everything sees the five tabs in strip order and only two read the tenant config", () => {
    expect(ABWESENHEITEN_TABS.map((tab) => tab.value)).toEqual([
      "urlaub",
      "sonderurlaub",
      "uebertrag",
      "betriebsurlaub",
      "urlaubsgrenzen",
    ]);
    expect(
      tabsOf([
        "tenant-settings:update:ZUGEWIESEN",
        "company-shutdown:manage:ZUGEWIESEN",
        "leave-limit:manage:ZUGEWIESEN",
      ]),
    ).toEqual(ABWESENHEITEN_TABS.map((tab) => tab.value));
    expect(ABWESENHEITEN_TABS.find((tab) => tab.value === "urlaubsgrenzen")?.usesConfig).toBe(
      false,
    );
  });
});

describe("UrlaubsgrenzenPanel", () => {
  it("loads nothing while the tab is not shown", () => {
    renderWithTheme(UrlaubsgrenzenPanel, { active: false });
    expect(get).not.toHaveBeenCalled();
  });

  it("waits for the salon context before the first load", async () => {
    salonStore().set({ loaded: false, salons: [], isMultiSalon: false });
    renderWithTheme(UrlaubsgrenzenPanel, { active: true });
    expect(get).not.toHaveBeenCalled();
    setSalons([{ id: "s1", name: "Salon Mitte" }], false);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
  });

  it("lists the rules with group, limit, window and a Sperre chip, and names no person", async () => {
    renderWithTheme(UrlaubsgrenzenPanel, { active: true });
    const table = await screen.findByRole("table", { name: /Urlaubsgrenzen und Sperren/ });
    // The sole reachable salon is the view.
    expect(get).toHaveBeenCalledWith("/leave/limits?salonId=s1");
    expect(table.textContent).toContain("Sommerferien");
    expect(table.textContent).toContain("höchstens 2 gleichzeitig im Urlaub");
    expect(table.textContent).toContain("ganzjährig");
    expect(table.textContent).toContain("Urlaub gesperrt");
    expect(table.textContent).toContain("20.12.2026 – 31.12.2026");
    expect(table.textContent).toContain("Sperre");
    expect(table.textContent).toContain("Azubi");
  });

  it("offers Bearbeiten and Entfernen only on a row the API marks canManage", async () => {
    renderWithTheme(UrlaubsgrenzenPanel, { active: true });
    await screen.findByRole("table", { name: /Urlaubsgrenzen/ });
    const managed = screen.getByText("Sommerferien").closest("tr") as HTMLElement;
    expect(within(managed).getByRole("button", { name: "Bearbeiten" })).toBeTruthy();
    expect(within(managed).getByRole("button", { name: "Entfernen" })).toBeTruthy();
    const foreign = screen.getByText("Azubi-Grenze").closest("tr") as HTMLElement;
    expect(within(foreign).queryByRole("button")).toBeNull();
  });

  it("without leave-limit:manage there is no create control", async () => {
    authStore().set({ user: { permissions: ["leave-request:approve:ZUGEWIESEN"] } });
    renderWithTheme(UrlaubsgrenzenPanel, { active: true });
    await screen.findByRole("table", { name: /Urlaubsgrenzen/ });
    expect(screen.queryByRole("button", { name: "Neue Regel" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Urlaubssperre" })).toBeNull();
  });

  it("a 403 shows the missing permission, any other failure a retry", async () => {
    get.mockRejectedValueOnce(new ApiError(403, "Forbidden"));
    const first = renderWithTheme(UrlaubsgrenzenPanel, { active: true });
    expect(
      await screen.findByText("Für die Urlaubsgrenzen fehlt dir die Berechtigung."),
    ).toBeTruthy();
    first.unmount();

    get.mockRejectedValueOnce(new Error("down"));
    renderWithTheme(UrlaubsgrenzenPanel, { active: true });
    await screen.findByText(/Die Urlaubsgrenzen konnten nicht geladen werden/);
    await fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    await screen.findByRole("table", { name: /Urlaubsgrenzen/ });
  });

  it("an empty list shows the empty state with a first-rule action", async () => {
    get.mockResolvedValue({ ...RESPONSE, rules: [] });
    renderWithTheme(UrlaubsgrenzenPanel, { active: true });
    expect(await screen.findByText("Noch keine Regeln")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Erste Regel anlegen" })).toBeTruthy();
  });

  it("with several salons the page has its own salon choice and reloads for it", async () => {
    setSalons(
      [
        { id: "s1", name: "Salon Mitte" },
        { id: "s2", name: "Salon Nord" },
      ],
      true,
    );
    renderWithTheme(UrlaubsgrenzenPanel, { active: true });
    await screen.findByRole("table", { name: /Urlaubsgrenzen/ });
    expect(get).toHaveBeenLastCalledWith("/leave/limits");
    await fireEvent.change(screen.getByLabelText("Salon"), { target: { value: "s2" } });
    await waitFor(() => expect(get).toHaveBeenLastCalledWith("/leave/limits?salonId=s2"));
  });

  async function openDialog(name: string) {
    renderWithTheme(UrlaubsgrenzenPanel, { active: true });
    await screen.findByRole("table", { name: /Urlaubsgrenzen/ });
    await fireEvent.click(screen.getByRole("button", { name }));
    return await screen.findByRole("dialog");
  }

  it("creates a rule from the dialog with the unchanged payload", async () => {
    const dialog = await openDialog("Neue Regel");
    expect(within(dialog).getByTestId("leave-limit-legal-hint").textContent).toContain(
      "§ 7 Abs. 1 und 2 BUrlG",
    );
    await fireEvent.input(within(dialog).getByLabelText(/^Höchstens gleichzeitig im Urlaub/), {
      target: { value: "3" },
    });
    await fireEvent.input(within(dialog).getByLabelText(/^Bezeichnung/), {
      target: { value: " Sommerferien " },
    });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][0]).toBe("/leave/limits");
    expect(post.mock.calls[0][1]).toEqual({
      salonId: "s1",
      groupKind: "ALL",
      classification: null,
      accessRoleId: null,
      maxPersons: 3,
      validFrom: null,
      validUntil: null,
      name: "Sommerferien",
    });
    await waitFor(() => expect(success).toHaveBeenCalledWith("Regel angelegt."));
    // The list is read again after the write.
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it("an invalid maximum sends nothing", async () => {
    const dialog = await openDialog("Neue Regel");
    await fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(await within(dialog).findByText(/Die Höchstzahl muss eine ganze Zahl/)).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it("a Urlaubssperre is everybody at most 0 and needs a window", async () => {
    const dialog = await openDialog("Urlaubssperre");
    expect(within(dialog).queryByLabelText(/^Höchstens gleichzeitig/)).toBeNull();
    await fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(await within(dialog).findByText(/braucht einen Zeitraum/)).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
    await fireEvent.input(within(dialog).getByLabelText(/^Von/), {
      target: { value: "2026-12-20" },
    });
    await fireEvent.input(within(dialog).getByLabelText(/^Bis/), {
      target: { value: "2026-12-31" },
    });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1]).toMatchObject({
      groupKind: "ALL",
      maxPersons: 0,
      validFrom: "2026-12-20",
      validUntil: "2026-12-31",
    });
  });

  it("editing sends a PUT to the rule's id", async () => {
    renderWithTheme(UrlaubsgrenzenPanel, { active: true });
    await screen.findByRole("table", { name: /Urlaubsgrenzen/ });
    const row = screen.getByText("Sommerferien").closest("tr") as HTMLElement;
    await fireEvent.click(within(row).getByRole("button", { name: "Bearbeiten" }));
    const dialog = await screen.findByRole("dialog");
    await fireEvent.input(within(dialog).getByLabelText(/^Höchstens gleichzeitig/), {
      target: { value: "4" },
    });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0][0]).toBe("/leave/limits/r1");
    expect(put.mock.calls[0][1]).toMatchObject({ maxPersons: 4, name: "Sommerferien" });
    expect(post).not.toHaveBeenCalled();
    await waitFor(() => expect(success).toHaveBeenCalledWith("Regel gespeichert."));
  });

  it("a refusal of the API stays in the dialog with the server's text", async () => {
    post.mockRejectedValue(new ApiError(409, "Für diesen Salon fehlt dir die Berechtigung."));
    const dialog = await openDialog("Neue Regel");
    await fireEvent.input(within(dialog).getByLabelText(/^Höchstens gleichzeitig/), {
      target: { value: "1" },
    });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(
      await within(dialog).findByText("Für diesen Salon fehlt dir die Berechtigung."),
    ).toBeTruthy();
    expect(success).not.toHaveBeenCalled();
  });

  it("removing waits for the confirmation and then uses the soft removal and reloads", async () => {
    renderWithTheme(UrlaubsgrenzenPanel, { active: true });
    await screen.findByRole("table", { name: /Urlaubsgrenzen/ });
    const row = screen.getByText("Sommerferien").closest("tr") as HTMLElement;
    await fireEvent.click(within(row).getByRole("button", { name: "Entfernen" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("bleibt nachvollziehbar");
    expect(del).not.toHaveBeenCalled();
    await fireEvent.click(within(dialog).getByRole("button", { name: "Entfernen" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/leave/limits/r1"));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(success).toHaveBeenCalledWith("Regel entfernt.");
  });

  it("cancelling the confirmation removes nothing", async () => {
    renderWithTheme(UrlaubsgrenzenPanel, { active: true });
    await screen.findByRole("table", { name: /Urlaubsgrenzen/ });
    const row = screen.getByText("Sommerferien").closest("tr") as HTMLElement;
    await fireEvent.click(within(row).getByRole("button", { name: "Entfernen" }));
    const dialog = await screen.findByRole("dialog");
    await fireEvent.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    expect(del).not.toHaveBeenCalled();
  });
});
