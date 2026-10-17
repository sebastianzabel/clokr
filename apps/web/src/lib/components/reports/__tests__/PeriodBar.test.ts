// Issue #612 (AC-612-1, D-612-1, P-16, P-20) — the one period control of /reports, mounted.
// lib/components/reports/ is outside the lint:ui-classes gate (CLAUDE.md), so the structure, the
// pressed presets, the arrows and the responsive rules are proven here.

import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, fireEvent, within } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import { cssForViewport, probeAt, INVENTED_CLASS, styleBlockOf } from "$tests/media-query-probe";
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
    canExport: false,
    onChange: vi.fn(),
    onOpenRange: vi.fn(),
    onOpenExport: vi.fn(),
    ...overrides,
  };
}

const PRESET_NAMES = ["Dieser Monat", "Vormonat", "Quartal", "Jahr", "Letzte 3 Monate"];

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

  it("a future month chosen in the picker is clamped to the current month (P-16)", async () => {
    const p = props({ from: ym(2026, 3), to: ym(2026, 3) });
    renderWithTheme(PeriodBar, p);
    await fireEvent.click(screen.getByTestId("reports-period-label"));
    const picker = screen.getByTestId("reports-period-picker");
    await fireEvent.click(within(picker).getByRole("button", { name: "Jahr vor" }));
    await fireEvent.click(within(picker).getByRole("button", { name: "Mär" }));
    expect(p.onChange).toHaveBeenLastCalledWith(TODAY, TODAY);
  });

  it("a past month chosen in the picker becomes a single-month period", async () => {
    const p = props();
    renderWithTheme(PeriodBar, p);
    await fireEvent.click(screen.getByTestId("reports-period-label"));
    await fireEvent.click(
      within(screen.getByTestId("reports-period-picker")).getByRole("button", { name: "Mär" }),
    );
    expect(p.onChange).toHaveBeenLastCalledWith(ym(2026, 3), ym(2026, 3));
  });
});

describe("PeriodBar — presets", () => {
  it("renders the five presets as ghost buttons in a named group", () => {
    renderWithTheme(PeriodBar, props());
    const group = screen.getByRole("group", { name: "Schnellauswahl Zeitraum" });
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(PRESET_NAMES);
    for (const b of buttons) {
      expect(b).toHaveClass("btn", "btn-ghost", "sm");
      expect(b).toHaveAttribute("aria-pressed");
    }
  });

  it("presses every matching preset: this month and quarter at once (P-20)", () => {
    renderWithTheme(PeriodBar, props());
    const group = screen.getByRole("group", { name: "Schnellauswahl Zeitraum" });
    const pressed = within(group)
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.textContent?.trim());
    expect(pressed).toEqual(["Dieser Monat", "Quartal"]);
    expect(within(group).getByRole("button", { name: "Dieser Monat" })).toHaveClass("is-active");
  });

  it("presses no preset when the period matches none", () => {
    renderWithTheme(PeriodBar, props({ from: ym(2026, 2), to: ym(2026, 4) }));
    const group = screen.getByRole("group", { name: "Schnellauswahl Zeitraum" });
    for (const b of within(group).getAllByRole("button")) {
      expect(b).toHaveAttribute("aria-pressed", "false");
    }
  });

  it("applies a preset through onChange", async () => {
    const p = props();
    renderWithTheme(PeriodBar, p);
    await fireEvent.click(screen.getByRole("button", { name: "Vormonat" }));
    expect(p.onChange).toHaveBeenCalledWith(ym(2026, 9), ym(2026, 9));
    await fireEvent.click(screen.getByRole("button", { name: "Letzte 3 Monate" }));
    expect(p.onChange).toHaveBeenLastCalledWith(ym(2026, 8), ym(2026, 10));
    await fireEvent.click(screen.getByRole("button", { name: "Jahr" }));
    expect(p.onChange).toHaveBeenLastCalledWith(ym(2026, 1), ym(2026, 10));
  });
});

describe("PeriodBar — actions, loading and structure", () => {
  it("shows „Exportieren“ only with canExport and hands over its element", async () => {
    const { unmount } = renderWithTheme(PeriodBar, props());
    expect(screen.queryByRole("button", { name: "Exportieren" })).toBeNull();
    unmount();
    const p = props({ canExport: true });
    renderWithTheme(PeriodBar, p);
    const button = screen.getByRole("button", { name: "Exportieren" });
    await fireEvent.click(button);
    expect(p.onOpenExport).toHaveBeenCalledWith(button);
  });

  it("„Zeitraum…“ hands over the element that was pressed (bar row and narrow row)", async () => {
    const p = props();
    renderWithTheme(PeriodBar, p);
    const buttons = screen.getAllByRole("button", { name: "Zeitraum…" });
    expect(buttons).toHaveLength(2);
    for (const b of buttons) {
      await fireEvent.click(b);
      expect(p.onOpenRange).toHaveBeenLastCalledWith(b);
    }
  });

  it("shows the keep-label spinner only while loading", () => {
    const { unmount } = renderWithTheme(PeriodBar, props());
    expect(screen.queryByRole("status", { name: "Wird geladen" })).toBeNull();
    unmount();
    renderWithTheme(PeriodBar, props({ loading: true }));
    expect(screen.getByRole("status", { name: "Wird geladen" })).toBeInTheDocument();
  });

  it("is a div.period-sticky, not a card, with the presets row and the testids", () => {
    const { container } = renderWithTheme(PeriodBar, props());
    const root = container.querySelector(".period-sticky");
    expect(root).toBeTruthy();
    expect(root!.tagName).toBe("DIV");
    expect(root!.classList.contains("card")).toBe(false);
    expect(root!.querySelector("div.period-presets")).toBeTruthy();
    for (const id of [
      "reports-period",
      "reports-period-prev",
      "reports-period-next",
      "reports-period-label",
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
  });

  it("imports nothing from the SvelteKit app modules", () => {
    expect(barSource).not.toContain("$app/");
  });
});

describe("PeriodBar — responsive rules (measured on the component's own CSS)", () => {
  const css = styleBlockOf(barSource).replace(
    /@media \(pointer: coarse\)\s*\{[\s\S]*?\n {2}\}/,
    "",
  );

  afterEach(() => {
    document.head.querySelectorAll("style").forEach((s) => s.remove());
    document.body.querySelectorAll("span").forEach((s) => s.remove());
  });

  function at(width: number) {
    return probeAt(width, cssForViewport(css, width));
  }

  it("controls: an invented class computes like a class-less element", () => {
    const probe = at(1280);
    expect(probe.styles(INVENTED_CLASS).display).toBe(probe.styles("").display);
    expect(probe.styles("period-sticky").position).toBe("sticky");
  });

  it("is sticky above 640 px and static at 640 px and below", () => {
    expect(at(1280).styles("period-sticky").position).toBe("sticky");
    expect(at(641).styles("period-sticky").position).toBe("sticky");
    expect(at(640).styles("period-sticky").position).toBe("relative");
  });

  it("hides the presets and the wide „Zeitraum…“ at 960 px and below; shows the narrow one", () => {
    const wide = at(1280);
    expect(wide.styles("period-preset-group").display).not.toBe("none");
    expect(wide.styles("period-range-wide").display).not.toBe("none");
    expect(wide.styles("period-range-narrow").display).toBe("none");
    const narrow = at(960);
    expect(narrow.styles("period-preset-group").display).toBe("none");
    expect(narrow.styles("period-range-wide").display).toBe("none");
    expect(narrow.styles("period-range-narrow").display).not.toBe("none");
  });

  it("keeps the whole presets row away at 960 px and below while idle", () => {
    expect(at(960).styles("period-presets period-presets--idle").display).toBe("none");
    expect(at(1280).styles("period-presets period-presets--idle").display).not.toBe("none");
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
