// Issue #843 (D-843-01 block 2) - PeriodPicker is the one period control. The expected markup of
// the first block was captured from MonthBar and PeriodSwitcher BEFORE they delegated to it, so
// the block is proven to emit the legacy `.month-bar` DOM that the #553/#564 narrow-viewport
// proofs and every caller's test ids rely on. Scope-hash classes, Svelte's empty block markers
// and whitespace BETWEEN tags carry no information and are normalised on both sides.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { renderWithTheme } from "$tests/test-utils";
import { periodOf } from "$lib/leave/timeline-model";
import PeriodPicker from "../PeriodPicker.svelte";
import MonthBar from "../MonthBar.svelte";
import PeriodSwitcher from "../PeriodSwitcher.svelte";
import pickerSource from "../PeriodPicker.svelte?raw";
import monthBarSource from "../MonthBar.svelte?raw";
import switcherSource from "../PeriodSwitcher.svelte?raw";
import * as pickerModule from "../PeriodPicker.svelte";
import * as monthBarModule from "../MonthBar.svelte";

afterEach(() => cleanup());

function normalise(html: string): string {
  return html
    .replace(/ class="svelte-[a-z0-9]+"/g, "")
    .replace(/ svelte-[a-z0-9]+/g, "")
    .replace(/<!---->/g, "")
    .replace(/ class=""/g, "")
    .replace(/>\s+</g, "><");
}

const JULY = new Date(2026, 6, 1);
const extra = createRawSnippet(() => ({ render: () => "<button>PDF</button>" }));

// Captured from the pre-delegate MonthBar / PeriodSwitcher (see the file header).
const LEGACY_PLAIN =
  '<div class="month-bar" data-testid="month-bar"><div class="month-bar-nav"><button class="nav-btn" title="Vorheriger Monat" aria-label="Vorheriger Monat" data-testid="month-bar-prev"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg></button> <div class="month-bar-center"> <div class="month-bar-label" data-testid="month-bar-label">Juli 2026</div></div> <button class="nav-btn" title="Nächster Monat" aria-label="Nächster Monat" data-testid="month-bar-next"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg></button>  </div> </div>';
const LEGACY_FULL =
  '<div class="month-bar" data-testid="x"><div class="month-bar-nav"><button class="nav-btn" title="Vorheriger Monat" aria-label="Vorheriger Monat" data-testid="x-prev"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg></button> <div class="month-bar-center"><div class="month-bar-eyebrow">Buchungsmonat</div> <div class="month-bar-label" data-testid="x-label">Juli 2026</div></div> <button class="nav-btn" disabled="" title="Spätere Zeiträume liegen in der Zukunft." aria-label="Nächster Monat" data-testid="x-next"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg></button> <button class="btn btn-ghost btn-sm month-bar-today" data-testid="x-today">Heute</button> <div class="month-bar-extra"><button>PDF</button></div></div> <div class="month-bar-stats" data-testid="x-stats"><div class="mstat" data-testid="x-stat-Ist"><div class="mstat-label">Ist</div> <div class="mstat-value pos">12<span class="mstat-unit">h</span></div></div><div class="mstat" data-testid="x-stat-Soll"><div class="mstat-label">Soll</div> <div class="mstat-value">10</div></div></div></div>';
const LEGACY_MONTH_PICKER =
  '<div class="month-bar" data-testid="month-bar"><div class="month-bar-nav"><button class="nav-btn" title="Vorheriger Monat" aria-label="Vorheriger Monat" data-testid="month-bar-prev"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg></button> <div class="month-bar-center"> <button type="button" class="month-bar-label month-bar-label--picker" title="Monat/Jahr wählen" data-testid="month-bar-label">Juli 2026 <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg></button> </div> <button class="nav-btn" title="Nächster Monat" aria-label="Nächster Monat" data-testid="month-bar-next"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg></button> <button class="btn btn-ghost btn-sm month-bar-today" data-testid="month-bar-today">Heute</button> </div> </div>';
const LEGACY_SWITCHER =
  '<div class="month-bar" data-testid="lp"><div class="month-bar-nav"><button class="nav-btn" title="Vorheriges Quartal" aria-label="Vorheriges Quartal" data-testid="lp-prev"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg></button> <div class="month-bar-center"> <div class="month-bar-label" data-testid="lp-label">Q4 2026 · Okt–Dez</div></div> <button class="nav-btn" disabled="" title="Spätere Zeiträume liegen in der Zukunft." aria-label="Nächstes Quartal" data-testid="lp-next"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg></button> <button class="btn btn-ghost btn-sm month-bar-today" data-testid="lp-today">Heute</button> </div> </div>';

describe("MonthBar and PeriodSwitcher - legacy DOM through the PeriodPicker", () => {
  it("MonthBar without optional props", () => {
    const { container } = renderWithTheme(MonthBar, {
      date: JULY,
      onPrev: vi.fn(),
      onNext: vi.fn(),
    });
    expect(normalise(container.innerHTML)).toBe(normalise(LEGACY_PLAIN));
  });

  it("MonthBar with eyebrow, Heute, extra actions, disabled next arrow and stats", () => {
    const { container } = renderWithTheme(MonthBar, {
      date: JULY,
      eyebrow: "Buchungsmonat",
      onPrev: vi.fn(),
      onNext: vi.fn(),
      onToday: vi.fn(),
      extraActions: extra,
      nextDisabled: true,
      stats: [
        { label: "Ist", value: "12", unit: "h", tone: "pos" },
        { label: "Soll", value: "10" },
      ],
      testIdPrefix: "x",
    });
    expect(normalise(container.innerHTML)).toBe(normalise(LEGACY_FULL));
  });

  it("MonthBar with the month grid trigger", () => {
    const { container } = renderWithTheme(MonthBar, {
      date: JULY,
      onPrev: vi.fn(),
      onNext: vi.fn(),
      onToday: vi.fn(),
      onSelectMonth: vi.fn(),
    });
    expect(normalise(container.innerHTML)).toBe(normalise(LEGACY_MONTH_PICKER));
  });

  it("MonthBar still opens the month grid and reports the chosen month", async () => {
    const onSelectMonth = vi.fn();
    renderWithTheme(MonthBar, {
      date: JULY,
      onPrev: vi.fn(),
      onNext: vi.fn(),
      onSelectMonth,
    });
    await fireEvent.click(screen.getByTestId("month-bar-label"));
    const grid = screen.getByTestId("month-bar-picker");
    await fireEvent.click(within(grid).getByRole("button", { name: "Mär" }));
    expect(onSelectMonth).toHaveBeenCalledWith(3, 2026);
    expect(screen.queryByTestId("month-bar-picker")).toBeNull();
  });

  it("PeriodSwitcher", () => {
    const { container } = renderWithTheme(PeriodSwitcher, {
      period: periodOf("quartal", "2026-11-08"),
      onShift: vi.fn(),
      onToday: vi.fn(),
      nextDisabled: true,
      testIdPrefix: "lp",
    });
    expect(normalise(container.innerHTML)).toBe(normalise(LEGACY_SWITCHER));
  });

  it("both delegate: they render the block and keep no period markup of their own", () => {
    expect(monthBarSource).toContain("<PeriodPicker");
    expect(switcherSource).toContain("<PeriodPicker");
    expect(monthBarSource).not.toContain("month-bar-nav");
    expect(switcherSource).not.toContain("month-bar-nav");
  });

  it("NEXT_PERIOD_DISABLED_TITLE is one constant, still exported from MonthBar", () => {
    const fromPicker = (pickerModule as unknown as Record<string, string>)
      .NEXT_PERIOD_DISABLED_TITLE;
    const fromMonthBar = (monthBarModule as unknown as Record<string, string>)
      .NEXT_PERIOD_DISABLED_TITLE;
    expect(fromPicker).toBe("Spätere Zeiträume liegen in der Zukunft.");
    expect(fromMonthBar).toBe(fromPicker);
  });
});

describe("PeriodPicker", () => {
  function props(overrides: Record<string, unknown> = {}) {
    return {
      label: "November 2026",
      onPrev: vi.fn(),
      onNext: vi.fn(),
      ...overrides,
    };
  }

  it("renders the label and the arrows with default names and the legacy test ids", () => {
    const { container } = renderWithTheme(PeriodPicker, props());
    expect(screen.getByTestId("month-bar-label")).toHaveTextContent("November 2026");
    expect(screen.getByTestId("month-bar-prev")).toHaveAttribute(
      "aria-label",
      "Vorheriger Zeitraum",
    );
    expect(screen.getByTestId("month-bar-next")).toHaveAttribute("title", "Nächster Zeitraum");
    expect(screen.queryByTestId("month-bar-today")).toBeNull();
    expect(container.querySelector(".month-bar > .month-bar-nav > .nav-btn")).toBeTruthy();
    expect(container.querySelector(".month-bar-center > .month-bar-label")).toBeTruthy();
  });

  it("prefix, eyebrow and Heute", async () => {
    const onToday = vi.fn();
    const { container } = renderWithTheme(
      PeriodPicker,
      props({ testIdPrefix: "shift-week", eyebrow: "Woche", onToday }),
    );
    expect(container.querySelector(".month-bar-eyebrow")).toHaveTextContent("Woche");
    for (const part of ["", "-prev", "-next", "-today", "-label"]) {
      expect(screen.getByTestId(`shift-week${part}`)).toBeTruthy();
    }
    await fireEvent.click(screen.getByTestId("shift-week-today"));
    expect(onToday).toHaveBeenCalledTimes(1);
  });

  it("prev and next call their callbacks once; nextDisabled blocks next with the future title", async () => {
    const p = props();
    const { unmount } = renderWithTheme(PeriodPicker, p);
    await fireEvent.click(screen.getByTestId("month-bar-prev"));
    await fireEvent.click(screen.getByTestId("month-bar-next"));
    expect(p.onPrev).toHaveBeenCalledTimes(1);
    expect(p.onNext).toHaveBeenCalledTimes(1);
    unmount();

    const q = props({ nextDisabled: true, nextLabel: "Nächster Monat" });
    renderWithTheme(PeriodPicker, q);
    const next = screen.getByTestId("month-bar-next") as HTMLButtonElement;
    expect(next).toBeDisabled();
    expect(next).toHaveAttribute(
      "title",
      (pickerModule as unknown as Record<string, string>).NEXT_PERIOD_DISABLED_TITLE,
    );
    expect(next).toHaveAttribute("aria-label", "Nächster Monat");
    next.click();
    expect(q.onNext).not.toHaveBeenCalled();
  });

  it("prevDisabled (additive, #854) blocks the previous arrow with its own title", () => {
    const q = props({ prevDisabled: true });
    renderWithTheme(PeriodPicker, q);
    const prev = screen.getByTestId("month-bar-prev") as HTMLButtonElement;
    expect(prev).toBeDisabled();
    expect(prev).toHaveAttribute("title", "Frühere Zeiträume gibt es nicht.");
    prev.click();
    expect(q.onPrev).not.toHaveBeenCalled();
  });

  it("offers the zooms in the given order and reports a change once", async () => {
    const onZoom = vi.fn();
    const { container } = renderWithTheme(
      PeriodPicker,
      props({ zooms: ["jahr", "quartal", "monat", "woche"], zoom: "monat", onZoom }),
    );
    const group = screen.getByRole("radiogroup");
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.textContent?.trim())).toEqual(["Jahr", "Quartal", "Monat", "Woche"]);
    expect(radios[2]).toHaveAttribute("aria-checked", "true");
    expect(container.querySelector(".month-bar > .month-bar-zoom")).toBeTruthy();
    await fireEvent.click(radios[3]);
    expect(onZoom).toHaveBeenCalledTimes(1);
    expect(onZoom).toHaveBeenCalledWith("woche");
    expect(radios[3]).toHaveAttribute("aria-checked", "true");
  });

  it("a week-only page shows no Segment", () => {
    renderWithTheme(PeriodPicker, props({ zooms: ["woche"], label: "KW 46" }));
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("renders the aside snippet inside the bar, after the nav row", () => {
    const aside = createRawSnippet(() => ({
      render: () => '<div data-testid="aside-content">Stand</div>',
    }));
    const { container } = renderWithTheme(PeriodPicker, props({ aside }));
    const content = screen.getByTestId("aside-content");
    expect(content.parentElement).toBe(container.querySelector(".month-bar"));
    expect(content.previousElementSibling?.className).toContain("month-bar-nav");
  });

  it("keeps 44 px touch targets and the nav row inside the bar at narrow widths", () => {
    const style = pickerSource.slice(pickerSource.lastIndexOf("<style>"));
    expect(style).toMatch(/\.month-bar-nav \.nav-btn\s*\{[^}]*min-width:\s*44px/);
    expect(style).toMatch(/\.month-bar-today\s*\{[^}]*min-height:\s*44px/);
    // The narrow block wraps the bar, gives the nav row a full row and lays it out as a grid.
    expect(style).toMatch(/@media \(max-width: 640px\)[\s\S]*flex-wrap:\s*wrap/);
    expect(style).toMatch(/grid-template-columns:\s*auto minmax\(0, 1fr\) auto/);
  });

  it("wraps the zoom Segment onto its own row in a narrow container (#900)", () => {
    // A narrow container on a wide viewport fires no media query, so the base rule itself must
    // wrap; with nowrap the label overlapped the Segment in the example page's narrow frame.
    const style = pickerSource.slice(pickerSource.lastIndexOf("<style>"));
    const base = style.match(/\n {2}\.month-bar\s*\{([^}]*)\}/);
    expect(base).not.toBeNull();
    expect(base?.[1]).toMatch(/flex-wrap:\s*wrap/);
    expect(base?.[1]).not.toMatch(/flex-wrap:\s*nowrap/);
    expect(base?.[1]).toMatch(/gap:\s*\d+px \d+px/); // a row gap between the wrapped rows
  });

  it("carries no raw HTML, no literal id and no colour literal", () => {
    expect(pickerSource).not.toContain("{@html");
    expect(pickerSource).not.toMatch(/\bid="/);
    const rules = pickerSource
      .slice(pickerSource.lastIndexOf("<style>"))
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|italic|uppercase|letter-spacing/);
  });
});
