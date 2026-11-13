// Issue #854 (plan 854-07) - the small sections that came from the Urlaub page, mounted: the negative
// balance limit sends its OWN request to /settings/security (one key), the ArbZG check and the open-entries
// limit send their single key to /settings/work, and an invalid value blocks the save.
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
import ComplianceSection from "../ComplianceSection.svelte";
import MaxNegativeSection from "../MaxNegativeSection.svelte";
import OpenEntriesSection from "../OpenEntriesSection.svelte";

const bar = () => screen.queryByRole("region", { name: "Speicherleiste" });

beforeEach(() => {
  vi.clearAllMocks();
  put.mockResolvedValue({});
});

describe("MaxNegativeSection", () => {
  it("is off without a stored limit and shows no hours field", () => {
    renderWithTheme(MaxNegativeSection, { config: { maxNegativeBalanceMinutes: null } });
    expect(
      (screen.getByLabelText("Limit für negatives Überstundensaldo") as HTMLInputElement).checked,
    ).toBe(false);
    expect(screen.queryByLabelText("Maximale Minusstunden (Stunden)")).toBeNull();
  });

  it("switching it on and entering hours sends minutes to /settings/security, one key", async () => {
    renderWithTheme(MaxNegativeSection, { config: {} });
    await fireEvent.click(screen.getByLabelText("Limit für negatives Überstundensaldo"));
    await fireEvent.input(screen.getByLabelText("Maximale Minusstunden (Stunden)"), {
      target: { value: "12.5" },
    });
    await fireEvent.click(await screen.findByRole("button", { name: "Limit speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith("/settings/security", { maxNegativeBalanceMinutes: 750 });
    await waitFor(() => expect(bar()).toBeNull());
  });

  it("a stored limit shows as hours; switching it off sends null", async () => {
    renderWithTheme(MaxNegativeSection, { config: { maxNegativeBalanceMinutes: 1200 } });
    expect(
      (screen.getByLabelText("Maximale Minusstunden (Stunden)") as HTMLInputElement).value,
    ).toBe("20");
    await fireEvent.click(screen.getByLabelText("Limit für negatives Überstundensaldo"));
    await fireEvent.click(await screen.findByRole("button", { name: "Limit speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith("/settings/security", { maxNegativeBalanceMinutes: null });
  });

  it("changing the hours while the limit is off is no change", async () => {
    renderWithTheme(MaxNegativeSection, { config: {} });
    await fireEvent.click(screen.getByLabelText("Limit für negatives Überstundensaldo"));
    await fireEvent.input(screen.getByLabelText("Maximale Minusstunden (Stunden)"), {
      target: { value: "5" },
    });
    await fireEvent.click(screen.getByLabelText("Limit für negatives Überstundensaldo"));
    await waitFor(() => expect(bar()).toBeNull());
  });

  it("blocks hours outside 1..999", async () => {
    renderWithTheme(MaxNegativeSection, { config: { maxNegativeBalanceMinutes: 600 } });
    await fireEvent.input(screen.getByLabelText("Maximale Minusstunden (Stunden)"), {
      target: { value: "1000" },
    });
    const region = await screen.findByRole("region", { name: "Speicherleiste" });
    expect(region.textContent).toContain("1 Fehler");
    expect(put).not.toHaveBeenCalled();
  });
});

describe("ComplianceSection", () => {
  it("is on by default and saves arbzgEnabled alone", async () => {
    renderWithTheme(ComplianceSection, { config: {} });
    const box = screen.getByLabelText("ArbZG-Verstöße anzeigen") as HTMLInputElement;
    expect(box.checked).toBe(true);
    await fireEvent.click(box);
    await fireEvent.click(await screen.findByRole("button", { name: "Prüfung speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith("/settings/work", { arbzgEnabled: false });
  });
});

describe("OpenEntriesSection", () => {
  it("saves autoDeleteOpenHours alone as a whole number; 0 is allowed", async () => {
    renderWithTheme(OpenEntriesSection, { config: { autoDeleteOpenHours: 14 } });
    const input = screen.getByLabelText(
      "Offene Einträge ungültig markieren nach (Stunden)",
    ) as HTMLInputElement;
    expect(input.value).toBe("14");
    await fireEvent.input(input, { target: { value: "0" } });
    await fireEvent.click(await screen.findByRole("button", { name: "Frist speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith("/settings/work", { autoDeleteOpenHours: 0 });
  });

  it("blocks more than 168 hours", async () => {
    renderWithTheme(OpenEntriesSection, { config: {} });
    await fireEvent.input(
      screen.getByLabelText("Offene Einträge ungültig markieren nach (Stunden)"),
      {
        target: { value: "169" },
      },
    );
    const region = await screen.findByRole("region", { name: "Speicherleiste" });
    expect(region.textContent).toContain("1 Fehler");
    expect(put).not.toHaveBeenCalled();
  });
});
