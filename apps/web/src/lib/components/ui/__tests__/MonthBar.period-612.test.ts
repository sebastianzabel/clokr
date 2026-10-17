// Issue #612 — MonthBar gains four OPTIONAL props (label, prevLabel, nextLabel, nextDisabled).
// The regression cases pin that a consumer passing none of them renders exactly as before
// (/time-entries, /team/time-entries, /teamcal, MonatSaldoCard).

import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import MonthBar from "../MonthBar.svelte";
import * as monthBarModule from "../MonthBar.svelte";

// The `*.svelte` type shim knows the default export only; the module-script constant is read
// through the namespace.
const NEXT_PERIOD_DISABLED_TITLE = (monthBarModule as unknown as Record<string, string>)
  .NEXT_PERIOD_DISABLED_TITLE;

const JULY = new Date(2026, 6, 1);

function props(overrides: Record<string, unknown> = {}) {
  return { date: JULY, onPrev: vi.fn(), onNext: vi.fn(), ...overrides };
}

describe("MonthBar — without the #612 props (regression)", () => {
  it("shows the Intl month of `date`, the German arrow names and an enabled next arrow", () => {
    renderWithTheme(MonthBar, props());
    expect(screen.getByTestId("month-bar-label")).toHaveTextContent("Juli 2026");
    const prev = screen.getByTestId("month-bar-prev");
    const next = screen.getByTestId("month-bar-next");
    expect(prev).toHaveAttribute("aria-label", "Vorheriger Monat");
    expect(prev).toHaveAttribute("title", "Vorheriger Monat");
    expect(next).toHaveAttribute("aria-label", "Nächster Monat");
    expect(next).toHaveAttribute("title", "Nächster Monat");
    expect(next).not.toBeDisabled();
  });

  it("still shows the Intl month in the picker variant", () => {
    renderWithTheme(MonthBar, props({ onSelectMonth: vi.fn() }));
    expect(screen.getByTestId("month-bar-label")).toHaveTextContent("Juli 2026");
  });

  it("still calls the handlers", async () => {
    const p = props();
    renderWithTheme(MonthBar, p);
    await fireEvent.click(screen.getByTestId("month-bar-prev"));
    await fireEvent.click(screen.getByTestId("month-bar-next"));
    expect(p.onPrev).toHaveBeenCalledTimes(1);
    expect(p.onNext).toHaveBeenCalledTimes(1);
  });
});

describe("MonthBar — #612 props", () => {
  it("`label` replaces the derived month in both label renderings", () => {
    const { unmount } = renderWithTheme(MonthBar, props({ label: "Jul – Sep 2026" }));
    expect(screen.getByTestId("month-bar-label")).toHaveTextContent("Jul – Sep 2026");
    expect(screen.getByTestId("month-bar-label")).not.toHaveTextContent("Juli 2026");
    unmount();
    renderWithTheme(MonthBar, props({ label: "Jul – Sep 2026", onSelectMonth: vi.fn() }));
    expect(screen.getByTestId("month-bar-label")).toHaveTextContent("Jul – Sep 2026");
  });

  it("`prevLabel` / `nextLabel` set aria-label AND title of the arrows", () => {
    renderWithTheme(
      MonthBar,
      props({ prevLabel: "Vorheriges Quartal", nextLabel: "Nächstes Quartal" }),
    );
    const prev = screen.getByTestId("month-bar-prev");
    const next = screen.getByTestId("month-bar-next");
    expect(prev).toHaveAttribute("aria-label", "Vorheriges Quartal");
    expect(prev).toHaveAttribute("title", "Vorheriges Quartal");
    expect(next).toHaveAttribute("aria-label", "Nächstes Quartal");
    expect(next).toHaveAttribute("title", "Nächstes Quartal");
  });

  it("`nextDisabled` renders a real disabled button with the future title", () => {
    const p = props({ nextDisabled: true, nextLabel: "Nächster Monat" });
    renderWithTheme(MonthBar, p);
    const next = screen.getByTestId("month-bar-next");
    expect(next).toBeDisabled();
    expect(next.tagName).toBe("BUTTON");
    expect(next).toHaveAttribute("title", NEXT_PERIOD_DISABLED_TITLE);
    expect(NEXT_PERIOD_DISABLED_TITLE).toBe("Spätere Zeiträume liegen in der Zukunft.");
    expect(next).toHaveAttribute("aria-label", "Nächster Monat");
    // HTMLElement.click() honours `disabled` like a browser; a synthetic dispatched event does not
    (next as HTMLButtonElement).click();
    expect(p.onNext).not.toHaveBeenCalled();
  });

  it("an enabled next arrow keeps its own title when `nextDisabled` is false", () => {
    renderWithTheme(MonthBar, props({ nextDisabled: false, nextLabel: "Nächstes Jahr" }));
    expect(screen.getByTestId("month-bar-next")).toHaveAttribute("title", "Nächstes Jahr");
  });
});
