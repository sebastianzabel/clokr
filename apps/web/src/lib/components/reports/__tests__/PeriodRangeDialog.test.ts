// Issue #612 (D-612-1, UI-SPEC "„Zeitraum wählen“ dialog") — the range dialog, mounted.

import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, fireEvent, within, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import PeriodRangeDialog from "../PeriodRangeDialog.svelte";
import dialogSource from "../PeriodRangeDialog.svelte?raw";

const TODAY = { year: 2026, month: 10 };
const ym = (year: number, month: number) => ({ year, month });

function props(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    from: ym(2026, 8),
    to: ym(2026, 10),
    today: TODAY,
    onApply: vi.fn(),
    ...overrides,
  };
}

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }));
}

function field(group: "Von" | "Bis", name: "Monat" | "Jahr") {
  return within(screen.getByRole("group", { name: group })).getByLabelText(
    name,
  ) as HTMLSelectElement;
}

async function pick(group: "Von" | "Bis", name: "Monat" | "Jahr", value: number) {
  await fireEvent.change(field(group, name), { target: { value: String(value) } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PeriodRangeDialog — fields", () => {
  it("opens with the selects preset to the current period", async () => {
    stubMatchMedia(false);
    renderWithTheme(PeriodRangeDialog, props());
    expect(screen.getByRole("dialog", { name: "Zeitraum wählen" })).toBeInTheDocument();
    await waitFor(() => expect(field("Von", "Monat").value).toBe("8"));
    expect(field("Von", "Jahr").value).toBe("2026");
    expect(field("Bis", "Monat").value).toBe("10");
    expect(field("Bis", "Jahr").value).toBe("2026");
    expect(screen.getByText("Berichte")).toBeInTheDocument();
  });

  it("offers the current year and the ten before it", () => {
    stubMatchMedia(false);
    renderWithTheme(PeriodRangeDialog, props());
    const years = Array.from(field("Von", "Jahr").options).map((o) => o.value);
    expect(years[0]).toBe("2016");
    expect(years[years.length - 1]).toBe("2026");
    expect(years).toHaveLength(11);
    expect(field("Von", "Monat").options).toHaveLength(12);
    expect(field("Von", "Monat").options[0].textContent).toBe("Januar");
  });

  it("applies a valid choice and closes", async () => {
    stubMatchMedia(false);
    const p = props();
    renderWithTheme(PeriodRangeDialog, p);
    await waitFor(() => expect(field("Von", "Monat").value).toBe("8"));
    await pick("Von", "Monat", 7);
    await pick("Bis", "Monat", 9);
    await fireEvent.click(screen.getByRole("button", { name: "Zeitraum übernehmen" }));
    expect(p.onApply).toHaveBeenCalledWith(ym(2026, 7), ym(2026, 9));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("„Abbrechen“ closes without applying", async () => {
    stubMatchMedia(false);
    const p = props();
    renderWithTheme(PeriodRangeDialog, p);
    await fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(p.onApply).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("re-reads the period every time it opens", async () => {
    stubMatchMedia(false);
    const { rerender } = renderWithTheme(PeriodRangeDialog, props({ open: false }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await rerender({ open: true, from: ym(2026, 1), to: ym(2026, 3) });
    await waitFor(() => expect(field("Von", "Monat").value).toBe("1"));
    expect(field("Bis", "Monat").value).toBe("3");
  });
});

describe("PeriodRangeDialog — validation", () => {
  async function opened() {
    stubMatchMedia(false);
    const p = props();
    renderWithTheme(PeriodRangeDialog, p);
    await waitFor(() => expect(field("Von", "Monat").value).toBe("8"));
    return p;
  }

  it("a valid range shows no error and enables the apply button", async () => {
    await opened();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Zeitraum übernehmen" })).toBeEnabled();
  });

  it("„Bis“ before „Von“ is refused with the copy-deck text", async () => {
    const p = await opened();
    await pick("Bis", "Monat", 5);
    expect(screen.getByRole("alert")).toHaveTextContent("„Bis“ liegt vor „Von“.");
    const apply = screen.getByRole("button", { name: "Zeitraum übernehmen" });
    expect(apply).toBeDisabled();
    (apply as HTMLButtonElement).click();
    expect(p.onApply).not.toHaveBeenCalled();
  });

  it("more than twelve months is refused", async () => {
    await opened();
    await pick("Von", "Jahr", 2025);
    await pick("Von", "Monat", 9);
    expect(screen.getByRole("alert")).toHaveTextContent("Höchstens 12 Monate auf einmal.");
    expect(screen.getByRole("button", { name: "Zeitraum übernehmen" })).toBeDisabled();
  });

  it("exactly twelve months is accepted", async () => {
    await opened();
    await pick("Von", "Jahr", 2025);
    await pick("Von", "Monat", 11);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Zeitraum übernehmen" })).toBeEnabled();
  });

  it("a „Bis“ after the current month is refused", async () => {
    await opened();
    await pick("Bis", "Monat", 11);
    expect(screen.getByRole("alert")).toHaveTextContent("„Bis“ darf nicht in der Zukunft liegen.");
    expect(screen.getByRole("button", { name: "Zeitraum übernehmen" })).toBeDisabled();
  });

  it("clears the error again when the choice is fixed", async () => {
    await opened();
    await pick("Bis", "Monat", 5);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await pick("Bis", "Monat", 9);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("PeriodRangeDialog — initial focus and presets", () => {
  it("wide: the „Von“ month select carries data-autofocus and gets the focus", async () => {
    stubMatchMedia(false);
    renderWithTheme(PeriodRangeDialog, props());
    const select = field("Von", "Monat");
    await waitFor(() => expect(select).toHaveAttribute("data-autofocus"));
    await waitFor(() => expect(document.activeElement).toBe(select));
    expect(document.querySelectorAll("[data-autofocus]")).toHaveLength(1);
  });

  it("narrow: lists the five presets, focuses the pressed one and applies on click", async () => {
    stubMatchMedia(true);
    const p = props();
    renderWithTheme(PeriodRangeDialog, p);
    expect(screen.getByRole("heading", { name: "Schnellauswahl" })).toBeInTheDocument();
    const section = screen.getByRole("region", { name: "Schnellauswahl" });
    const names = within(section)
      .getAllByRole("button")
      .map((b) => b.textContent?.trim());
    expect(names).toEqual(["Dieser Monat", "Vormonat", "Quartal", "Jahr", "Letzte 3 Monate"]);
    // 2026-08..2026-10 is exactly „Letzte 3 Monate“
    const pressed = within(section).getByRole("button", { name: "Letzte 3 Monate" });
    expect(pressed).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(pressed).toHaveAttribute("data-autofocus"));
    await waitFor(() => expect(document.activeElement).toBe(pressed));
    expect(field("Von", "Monat")).not.toHaveAttribute("data-autofocus");
    await fireEvent.click(within(section).getByRole("button", { name: "Vormonat" }));
    expect(p.onApply).toHaveBeenCalledWith(ym(2026, 9), ym(2026, 9));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("narrow: focuses the first preset when none is pressed", async () => {
    stubMatchMedia(true);
    renderWithTheme(PeriodRangeDialog, props({ from: ym(2026, 2), to: ym(2026, 4) }));
    const section = screen.getByRole("region", { name: "Schnellauswahl" });
    const first = within(section).getByRole("button", { name: "Dieser Monat" });
    await waitFor(() => expect(document.activeElement).toBe(first));
  });

  it("hides the presets section above 960 px and imports nothing from the app modules", () => {
    expect(dialogSource).not.toContain("$app/");
    expect(dialogSource).toMatch(/\.range-presets\s*\{\s*display:\s*none;/);
    expect(dialogSource).toMatch(
      /@media \(max-width: 960px\)\s*\{\s*\.range-presets\s*\{\s*display:\s*block;/,
    );
  });
});
