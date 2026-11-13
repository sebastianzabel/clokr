// Issue #854 (plan 854-07, tracer) - the Pausen section, mounted: a change makes the SaveBar count 1, the
// save sends exactly the five keys of the registry section (nothing else), a failed save keeps the edit
// and shows the server text, and an invalid minute count blocks the save.
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

import { renderWithTheme } from "$tests/test-utils";
import { settingsSection } from "$lib/settings/settings-pages";
import BreaksSection from "../BreaksSection.svelte";

const KEYS = [...settingsSection("arbeitszeit-pausen").keys].sort();

const CONFIG = {
  autoBreakEnabled: true,
  defaultBreakStart: "12:00",
  defaultBreakOver6h: 30,
  defaultBreakOver9h: 45,
  enforceBreakConfirmation: false,
};

function mount(config = CONFIG) {
  return renderWithTheme(BreaksSection, { config, canEdit: true });
}

const over6h = () => screen.getByLabelText("Pause ab 6 Stunden (Minuten)") as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  put.mockResolvedValue({});
});

describe("BreaksSection", () => {
  it("shows the stored values and no SaveBar until something changed", () => {
    mount();
    expect(over6h().value).toBe("30");
    expect((screen.getByLabelText("Pausen automatisch abziehen") as HTMLInputElement).checked).toBe(
      true,
    );
    expect(screen.queryByRole("region", { name: "Speicherleiste" })).toBeNull();
  });

  it("counts one change per edited field and sends exactly the section's five keys", async () => {
    mount();
    await fireEvent.input(over6h(), { target: { value: "45" } });
    await fireEvent.click(screen.getByLabelText("Pausen-Bestätigung erforderlich"));
    const bar = await screen.findByRole("region", { name: "Speicherleiste" });
    expect(bar.textContent).toContain("2 Änderungen");

    await fireEvent.click(screen.getByRole("button", { name: "Pausen speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const [path, body] = put.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/settings/work");
    expect(Object.keys(body).sort()).toEqual(KEYS);
    expect(body).toMatchObject({
      autoBreakEnabled: true,
      defaultBreakStart: "12:00",
      defaultBreakOver6h: 45,
      defaultBreakOver9h: 45,
      enforceBreakConfirmation: true,
    });
    await waitFor(() => expect(success).toHaveBeenCalledWith("Pausen gespeichert."));
    // The saved values are the new baseline: the bar is gone again.
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Speicherleiste" })).toBeNull(),
    );
  });

  it("switching the deduction off sends a null start time and hides the start field", async () => {
    mount();
    expect(screen.getByLabelText("Standard-Pausenbeginn")).toBeTruthy();
    await fireEvent.click(screen.getByLabelText("Pausen automatisch abziehen"));
    expect(screen.queryByLabelText("Standard-Pausenbeginn")).toBeNull();
    await fireEvent.click(await screen.findByRole("button", { name: "Pausen speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0][1]).toMatchObject({
      autoBreakEnabled: false,
      defaultBreakStart: null,
    });
  });

  it("blocks the save while a minute count is outside its bounds", async () => {
    mount();
    await fireEvent.input(over6h(), { target: { value: "10" } });
    const bar = await screen.findByRole("region", { name: "Speicherleiste" });
    expect(bar.textContent).toContain("1 Fehler");
    expect(
      (screen.getByRole("button", { name: "Pausen speichern" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(put).not.toHaveBeenCalled();
  });

  it("a refused save keeps the edit, shows the server's text and stays unsaved", async () => {
    put.mockRejectedValueOnce(new Error("Die Pause ist zu kurz."));
    mount();
    await fireEvent.input(over6h(), { target: { value: "45" } });
    await fireEvent.click(await screen.findByRole("button", { name: "Pausen speichern" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("Die Pause ist zu kurz."));
    expect(over6h().value).toBe("45");
    expect(screen.getByRole("region", { name: "Speicherleiste" })).toBeTruthy();
  });

  it("Verwerfen restores the stored values", async () => {
    mount();
    await fireEvent.input(over6h(), { target: { value: "45" } });
    await fireEvent.click(await screen.findByRole("button", { name: "Verwerfen" }));
    expect(over6h().value).toBe("30");
    expect(put).not.toHaveBeenCalled();
  });
});
