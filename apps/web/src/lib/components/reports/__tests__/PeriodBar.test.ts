// Issue #612 (AC-612-1, D-612-1, P-16, P-20) rebuilt for Issue #854 - the one period control of
// /reports, mounted. It is a PeriodPicker: the period label, the eyebrow, the arrows by period kind,
// the Monat / Quartal / Jahr zoom, and the label as the entry to the range dialog. Presets and the
// export action moved out (range dialog, page head).

import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, fireEvent, within } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import PeriodBar from "../PeriodBar.svelte";
import barSource from "../PeriodBar.svelte?raw";

const TODAY = { year: 2026, month: 10 };
const ym = (year: number, month: number) => ({ year, month });

function props(overrides: Record<string, unknown> = {}) {
  return {
    from: TODAY,
    to: TODAY,
    today: TODAY,
    loading: false,
    onChange: vi.fn(),
    onOpenRange: vi.fn(),
    ...overrides,
  };
}

function zoomOf(container: HTMLElement): string | null {
  const checked = container.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
  return checked ? (checked.textContent?.trim() ?? null) : null;
}

describe("PeriodBar — the period label, eyebrow and arrows", () => {
  it("a single month: label, eyebrow, disabled next arrow with the future title", () => {
    const { container } = renderWithTheme(PeriodBar, props());
    expect(screen.getByTestId("reports-period-label")).toHaveTextContent("Oktober 2026");
    expect(container.querySelector(".month-bar-eyebrow")).toHaveTextContent(/^Monat$/);
    const next = screen.getByTestId("reports-period-next");
    expect(next).toBeDisabled();
    expect(next).toHaveAttribute("title", "Spätere Zeiträume liegen in der Zukunft.");
    expect(next).toHaveAttribute("aria-label", "Nächster Monat");
    expect(screen.getByTestId("reports-period-prev")).toHaveAttribute(
      "aria-label",
      "Vorheriger Monat",
    );
  });

  it("a quarter: label, eyebrow and quarter arrows; prev steps one quarter back", async () => {
    const p = props({ from: ym(2026, 7), to: ym(2026, 9) });
    const { container } = renderWithTheme(PeriodBar, p);
    expect(screen.getByTestId("reports-period-label")).toHaveTextContent("Jul – Sep 2026");
    expect(container.querySelector(".month-bar-eyebrow")).toHaveTextContent(/^Quartal$/);
    expect(screen.getByTestId("reports-period-prev")).toHaveAttribute(
      "aria-label",
      "Vorheriges Quartal",
    );
    expect(screen.getByTestId("reports-period-next")).toHaveAttribute(
      "aria-label",
      "Nächstes Quartal",
    );
    expect(screen.getByTestId("reports-period-next")).not.toBeDisabled();
    await fireEvent.click(screen.getByTestId("reports-period-prev"));
    expect(p.onChange).toHaveBeenCalledWith(ym(2026, 4), ym(2026, 6));
  });

  it("a range keeps its length when stepped", async () => {
    const p = props({ from: ym(2026, 5), to: ym(2026, 7) });
    const { container } = renderWithTheme(PeriodBar, p);
    expect(container.querySelector(".month-bar-eyebrow")).toHaveTextContent("Zeitraum · 3 Monate");
    await fireEvent.click(screen.getByTestId("reports-period-next"));
    expect(p.onChange).toHaveBeenCalledWith(ym(2026, 8), ym(2026, 10));
  });
});

describe("PeriodBar — the zoom Segment", () => {
  it("offers Monat, Quartal and Jahr in a radiogroup and selects the period's own level", () => {
    const { container } = renderWithTheme(PeriodBar, props());
    const group = screen.getByRole("radiogroup", { name: "Ansicht des Zeitraums" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((r) => r.textContent?.trim()),
    ).toEqual(["Monat", "Quartal", "Jahr"]);
    expect(zoomOf(container)).toBe("Monat");
  });

  it("a quarter selects Quartal, a free range selects none", () => {
    const quarter = renderWithTheme(PeriodBar, props({ from: ym(2026, 7), to: ym(2026, 9) }));
    expect(zoomOf(quarter.container)).toBe("Quartal");
    quarter.unmount();
    const range = renderWithTheme(PeriodBar, props({ from: ym(2026, 5), to: ym(2026, 7) }));
    expect(zoomOf(range.container)).toBeNull();
  });

  it("zooming keeps the end of the period as the anchor and applies through onChange", async () => {
    const p = props({ from: ym(2026, 7), to: ym(2026, 9) });
    renderWithTheme(PeriodBar, p);
    await fireEvent.click(screen.getByRole("radio", { name: "Monat" }));
    expect(p.onChange).toHaveBeenLastCalledWith(ym(2026, 9), ym(2026, 9));
    await fireEvent.click(screen.getByRole("radio", { name: "Jahr" }));
    expect(p.onChange).toHaveBeenLastCalledWith(ym(2026, 1), ym(2026, 10));
  });

  it("a year other than the current one zooms to its twelve months", async () => {
    const p = props({ from: ym(2025, 3), to: ym(2025, 3) });
    renderWithTheme(PeriodBar, p);
    await fireEvent.click(screen.getByRole("radio", { name: "Jahr" }));
    expect(p.onChange).toHaveBeenLastCalledWith(ym(2025, 1), ym(2025, 12));
    await fireEvent.click(screen.getByRole("radio", { name: "Quartal" }));
    expect(p.onChange).toHaveBeenLastCalledWith(ym(2025, 1), ym(2025, 3));
  });
});

describe("PeriodBar — the range dialog entry, loading and structure", () => {
  it("the label hands over the element that was pressed to open the range dialog", async () => {
    const p = props();
    renderWithTheme(PeriodBar, p);
    const label = screen.getByTestId("reports-period-label");
    expect(label.tagName).toBe("BUTTON");
    expect(label).toHaveAttribute("title", "Zeitraum wählen");
    await fireEvent.click(label);
    expect(p.onOpenRange).toHaveBeenCalledWith(label);
  });

  it("has no preset row, no „Zeitraum…“ button and no export button of its own", () => {
    renderWithTheme(PeriodBar, props());
    expect(screen.queryByRole("group", { name: "Schnellauswahl Zeitraum" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Zeitraum…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Exportieren" })).toBeNull();
  });

  it("shows the Skeleton loading cue only while loading", () => {
    // #843 D-843-20: the cue is a Skeleton (role=status "Wird geladen"), no longer a Spinner.
    const { unmount } = renderWithTheme(PeriodBar, props());
    expect(screen.queryByRole("status", { name: "Wird geladen" })).toBeNull();
    unmount();
    renderWithTheme(PeriodBar, props({ loading: true }));
    expect(screen.getByRole("status", { name: "Wird geladen" })).toBeInTheDocument();
  });

  it("is a div.period-sticky, not a card, around the PeriodPicker with the testids", () => {
    const { container } = renderWithTheme(PeriodBar, props());
    const root = container.querySelector(".period-sticky");
    expect(root).toBeTruthy();
    expect(root!.tagName).toBe("DIV");
    expect(root!.classList.contains("card")).toBe(false);
    expect(root!.querySelector(".month-bar")).toBeTruthy();
    for (const id of [
      "reports-period",
      "reports-period-prev",
      "reports-period-next",
      "reports-period-label",
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
  });

  it("is built from the PeriodPicker block and imports nothing from the app modules", () => {
    expect(barSource).toContain("import PeriodPicker, { type PeriodZoom } from");
    expect(barSource).not.toContain("MonthBar");
    expect(barSource).not.toContain("$app/");
  });
});

describe("PeriodBar — sticky below the topbar", () => {
  it("is sticky above 640 px and static at 640 px and below (source of the component's own CSS)", () => {
    expect(barSource).toMatch(/\.period-sticky\s*\{[^}]*position: sticky;/);
    expect(barSource).toMatch(
      /@media \(max-width: 640px\)\s*\{\s*\.period-sticky\s*\{\s*position: relative;/,
    );
  });
});

// Issue #612 (612-05): the page needs the bar's height for the sticky table header.
describe("PeriodBar - reports its height (onHeight)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (HTMLElement.prototype as unknown as { offsetHeight?: number }).offsetHeight;
  });

  it("reports the rendered height once and again when the observer fires; disconnects on unmount", async () => {
    let height = 96;
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get: () => height,
    });
    const observers: Array<{ cb: () => void; disconnect: ReturnType<typeof vi.fn> }> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        disconnect = vi.fn();
        constructor(public cb: () => void) {
          observers.push(this);
        }
        observe() {}
      },
    );
    const onHeight = vi.fn();
    const { unmount } = renderWithTheme(PeriodBar, props({ onHeight }));
    await Promise.resolve();
    expect(onHeight).toHaveBeenLastCalledWith(96);
    height = 140;
    observers[0].cb();
    expect(onHeight).toHaveBeenLastCalledWith(140);
    unmount();
    expect(observers[0].disconnect).toHaveBeenCalled();
  });

  it("works without a ResizeObserver and without a listener", () => {
    expect(() => renderWithTheme(PeriodBar, props())).not.toThrow();
  });
});
