// Issue #854 (plan 10) - the „Einstellungen“ tab of Verwalten › Regeln › Dienstplan, mounted: every section
// saves exactly the keys of its registry section through its own SaveBar, a failed save keeps the edit, a
// section is shown only under the permission alternatives of the page it came from, and the tab strip is
// narrowed by the same rule (T-854-26).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/svelte";

const put = vi.fn();
const success = vi.fn();
const error = vi.fn();

vi.mock("$api/client", () => ({
  api: { put: (...a: unknown[]) => put(...a) },
}));
vi.mock("$stores/toast", () => ({
  toasts: { success: (m: string) => success(m), error: (m: string) => error(m), info: vi.fn() },
}));
vi.mock("$stores/auth", async () => {
  const { writable } = await import("svelte/store");
  const store = writable<{ user: { permissions: string[] } | null }>({ user: null });
  return { authStore: { subscribe: store.subscribe }, testAuth: store };
});

import { renderWithTheme } from "$tests/test-utils";
import * as authModule from "$stores/auth";
import { settingsSection } from "$lib/settings/settings-pages";
import { DIENSTPLAN_TABS, visibleDienstplanTabs } from "$lib/settings/dienstplan";
import DienstplanSettingsPanel from "../DienstplanSettingsPanel.svelte";

const testAuth = (
  authModule as unknown as {
    testAuth: { set: (v: { user: { permissions: string[] } | null }) => void };
  }
).testAuth;

const Z = (key: string) => `${key}:ZUGEWIESEN`;
const SYSTEM_ADMIN = [Z("tenant-settings:update")];
const SHIFT_MANAGER = [Z("shift-config:manage"), Z("shift:read"), Z("shift-pattern:read")];

const keysOf = (id: string) => [...settingsSection(id).keys].sort();
const bar = () => screen.queryByRole("region", { name: "Speicherleiste" });
/** The request body as the server receives it (undefined values are dropped by JSON). */
const sentBody = (call = 0) => JSON.parse(JSON.stringify(put.mock.calls[call][1]));

beforeEach(() => {
  vi.clearAllMocks();
  put.mockResolvedValue({});
  testAuth.set({ user: { permissions: SYSTEM_ADMIN } });
});

describe("Schichten und Öffnungszeiten", () => {
  const radio = (name: RegExp) => screen.getByRole("radio", { name }) as HTMLInputElement;

  it("shows the stored mode and offers all three choices", () => {
    renderWithTheme(DienstplanSettingsPanel, { config: { shiftStoreHoursMode: "STRICT" } });
    expect(radio(/^Strikt/).checked).toBe(true);
    expect(radio(/^Nur geschlossene Tage/).checked).toBe(false);
    expect(radio(/^Deaktiviert/).checked).toBe(false);
    expect(bar()).toBeNull();
  });

  it("reads a missing or unknown mode as the default (only closed days block)", () => {
    renderWithTheme(DienstplanSettingsPanel, { config: {} });
    expect(radio(/^Nur geschlossene Tage/).checked).toBe(true);
  });

  it("saves ONLY shiftStoreHoursMode, then the section is clean again", async () => {
    renderWithTheme(DienstplanSettingsPanel, { config: { shiftStoreHoursMode: "DAY_ONLY" } });
    await fireEvent.click(radio(/^Deaktiviert/));
    expect(await screen.findByText(/1 Änderung/)).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Prüfmodus speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0][0]).toBe("/settings/work");
    expect(sentBody()).toEqual({ shiftStoreHoursMode: "OFF" });
    expect(Object.keys(sentBody()).sort()).toEqual(keysOf("dienstplan-oeffnungszeiten"));
    await waitFor(() => expect(bar()).toBeNull());
    expect(success).toHaveBeenCalledWith("Prüfmodus gespeichert.");
  });

  it("a refused save keeps the edit and the SaveBar and says so", async () => {
    put.mockRejectedValue(new Error("Kein Zugriff."));
    renderWithTheme(DienstplanSettingsPanel, { config: { shiftStoreHoursMode: "DAY_ONLY" } });
    await fireEvent.click(radio(/^Strikt/));
    await fireEvent.click(await screen.findByRole("button", { name: "Prüfmodus speichern" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("Kein Zugriff."));
    expect(radio(/^Strikt/).checked).toBe(true);
    expect(bar()).not.toBeNull();
  });

  it("discard puts the stored mode back and removes the SaveBar", async () => {
    renderWithTheme(DienstplanSettingsPanel, { config: { shiftStoreHoursMode: "STRICT" } });
    await fireEvent.click(radio(/^Deaktiviert/));
    await fireEvent.click(await screen.findByRole("button", { name: "Verwerfen" }));
    expect(radio(/^Strikt/).checked).toBe(true);
    expect(bar()).toBeNull();
    expect(put).not.toHaveBeenCalled();
  });

  it("is not shown to a person without the alternatives of the System page", () => {
    testAuth.set({ user: { permissions: SHIFT_MANAGER } });
    renderWithTheme(DienstplanSettingsPanel, { config: {} });
    expect(screen.queryByText("Schichten und Öffnungszeiten")).toBeNull();
  });
});

describe("the tab strip (T-854-26)", () => {
  it("offers every tab to a person holding the alternatives of all sections", () => {
    const user = { permissions: [...SHIFT_MANAGER, ...SYSTEM_ADMIN] };
    expect(visibleDienstplanTabs(user).map((tab) => tab.value)).toEqual(
      DIENSTPLAN_TABS.map((tab) => tab.value),
    );
  });

  it("offers only the shift tabs to a person who manages shifts but holds no setting", () => {
    expect(visibleDienstplanTabs({ permissions: SHIFT_MANAGER }).map((tab) => tab.value)).toEqual([
      "vorlagen",
      "bedarf",
      "muster",
    ]);
  });

  it("offers only Einstellungen to a person who holds a setting but not the shift configuration", () => {
    expect(visibleDienstplanTabs({ permissions: SYSTEM_ADMIN }).map((tab) => tab.value)).toEqual([
      "einstellungen",
    ]);
  });

  it("offers nothing to a person without any of them, and to nobody", () => {
    expect(visibleDienstplanTabs({ permissions: [] })).toEqual([]);
    expect(visibleDienstplanTabs(null)).toEqual([]);
  });

  it("names only registry sections that exist (a typo would hide a tab for everyone)", () => {
    for (const tab of DIENSTPLAN_TABS)
      for (const id of tab.sections) expect(() => settingsSection(id), id).not.toThrow();
  });
});
