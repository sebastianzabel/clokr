// Issue #854 (plan 854-08, tracer) - the two Monatsabschluss sections, mounted: each saves exactly the one key
// of its registry section through its own SaveBar, a failed save keeps the edit and shows the server text, and
// the dependency on the Pausen-Bestätigung (D-854-25) is explained read-only with a link and never sent.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/svelte";

const put = vi.fn();
const success = vi.fn();
const error = vi.fn();

vi.mock("$api/client", () => ({ api: { put: (...a: unknown[]) => put(...a) } }));
vi.mock("$stores/toast", () => ({
  toasts: { success: (m: string) => success(m), error: (m: string) => error(m), info: vi.fn() },
}));

import { renderWithTheme } from "$tests/test-utils";
import { settingsSection } from "$lib/settings/settings-pages";
import BreakBlockSection from "../BreakBlockSection.svelte";
import GapsSection from "../GapsSection.svelte";

const bar = () => screen.queryByRole("region", { name: "Speicherleiste" });

beforeEach(() => {
  vi.clearAllMocks();
  put.mockResolvedValue({});
});

describe("GapsSection", () => {
  const toggle = () =>
    screen.getByLabelText("Abschluss trotz fehlender Einträge erlauben") as HTMLInputElement;

  it("shows the stored value (default: allowed) and no SaveBar until it changes", () => {
    renderWithTheme(GapsSection, { config: {} });
    expect(toggle().checked).toBe(true);
    expect(bar()).toBeNull();
  });

  it("saves closeMonthWithGapsAllowed alone, nothing else", async () => {
    renderWithTheme(GapsSection, { config: { closeMonthWithGapsAllowed: true } });
    await fireEvent.click(toggle());
    await fireEvent.click(await screen.findByRole("button", { name: "Einstellung speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith("/settings/work", { closeMonthWithGapsAllowed: false });
    expect(Object.keys(put.mock.calls[0][1]).sort()).toEqual(
      [...settingsSection("monatsabschluss-luecken").keys].sort(),
    );
    await waitFor(() => expect(bar()).toBeNull());
    expect(success).toHaveBeenCalled();
  });

  it("keeps the edit and shows the server text when the save fails", async () => {
    put.mockRejectedValue(new Error("Der Monat ist gesperrt."));
    renderWithTheme(GapsSection, { config: { closeMonthWithGapsAllowed: true } });
    await fireEvent.click(toggle());
    await fireEvent.click(await screen.findByRole("button", { name: "Einstellung speichern" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("Der Monat ist gesperrt."));
    expect(toggle().checked).toBe(false);
    expect(bar()).not.toBeNull();
  });
});

describe("BreakBlockSection", () => {
  const toggle = () =>
    screen.getByLabelText("Abschluss bei offenen Pausenbefunden sperren") as HTMLInputElement;

  it("with the Pausen-Bestätigung on: says so, links to the Pausen section and saves its one key", async () => {
    renderWithTheme(BreakBlockSection, {
      config: { enforceBreakConfirmation: true, blockMonthCloseOnUnconfirmedBreak: false },
    });
    const link = screen.getByRole("link", { name: "Arbeitszeit & Verträge" });
    expect(link.getAttribute("href")).toBe("/verwalten/regeln/arbeitszeit#pausen");
    expect(screen.getByText(/Die Pausen-Bestätigung ist eingeschaltet/)).toBeTruthy();
    expect(toggle().disabled).toBe(false);

    await fireEvent.click(toggle());
    await fireEvent.click(await screen.findByRole("button", { name: "Einstellung speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    // Only the blocking switch goes out - the Pausen-Bestätigung is read-only here.
    expect(put).toHaveBeenCalledWith("/settings/work", {
      blockMonthCloseOnUnconfirmedBreak: true,
    });
  });

  it("with the Pausen-Bestätigung off: the switch is disabled and the note says the setting has no effect yet", () => {
    renderWithTheme(BreakBlockSection, { config: { enforceBreakConfirmation: false } });
    expect(toggle().disabled).toBe(true);
    expect(screen.getByText(/Die Pausen-Bestätigung ist ausgeschaltet/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Arbeitszeit & Verträge" })).toBeTruthy();
    expect(put).not.toHaveBeenCalled();
  });

  it("the Pausen section of the Arbeitszeit page carries the anchor the link points at", async () => {
    const { default: BreaksSection } = await import("../../arbeitszeit/BreaksSection.svelte");
    renderWithTheme(BreaksSection, { config: {} });
    expect(document.getElementById("pausen")?.tagName).toBe("SECTION");
  });
});
