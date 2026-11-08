// Issue #840 (D-840-13/31) — PeriodSwitcher: the one ‹ period › Heute control, a MonthBar wrapper.

import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import { periodOf, type Zoom } from "$lib/leave/timeline-model";
import PeriodSwitcher from "../PeriodSwitcher.svelte";
import switcherSource from "../PeriodSwitcher.svelte?raw";

function props(zoom: Zoom, datum: string, overrides: Record<string, unknown> = {}) {
  return {
    period: periodOf(zoom, datum),
    onShift: vi.fn(),
    onToday: vi.fn(),
    ...overrides,
  };
}

describe("PeriodSwitcher", () => {
  it.each([
    ["jahr", "2026-11-08", "2026", "Vorheriges Jahr", "Nächstes Jahr"],
    ["quartal", "2026-11-08", "Q4 2026 · Okt–Dez", "Vorheriges Quartal", "Nächstes Quartal"],
    ["monat", "2026-11-08", "November 2026", "Vorheriger Monat", "Nächster Monat"],
  ] as const)(
    "zoom %s shows the label %s and names the arrows",
    (zoom, datum, label, prevName, nextName) => {
      renderWithTheme(PeriodSwitcher, props(zoom, datum));
      expect(screen.getByTestId("month-bar-label")).toHaveTextContent(label);
      const prev = screen.getByRole("button", { name: prevName });
      const next = screen.getByRole("button", { name: nextName });
      expect(prev).toBe(screen.getByTestId("month-bar-prev"));
      expect(next).toBe(screen.getByTestId("month-bar-next"));
    },
  );

  it("calls onShift(-1), onShift(1) and onToday", async () => {
    const p = props("quartal", "2026-11-08");
    renderWithTheme(PeriodSwitcher, p);
    await fireEvent.click(screen.getByTestId("month-bar-prev"));
    await fireEvent.click(screen.getByTestId("month-bar-next"));
    await fireEvent.click(screen.getByRole("button", { name: "Heute" }));
    expect(p.onShift).toHaveBeenNthCalledWith(1, -1);
    expect(p.onShift).toHaveBeenNthCalledWith(2, 1);
    expect(p.onToday).toHaveBeenCalledTimes(1);
  });

  it("nextDisabled disables the next arrow only", () => {
    renderWithTheme(PeriodSwitcher, props("monat", "2026-11-08", { nextDisabled: true }));
    expect(screen.getByTestId("month-bar-next")).toBeDisabled();
    expect(screen.getByTestId("month-bar-prev")).not.toBeDisabled();
  });

  it("passes a test-id prefix through", () => {
    renderWithTheme(PeriodSwitcher, props("jahr", "2026-01-01", { testIdPrefix: "leave-period" }));
    expect(screen.getByTestId("leave-period-label")).toHaveTextContent("2026");
    expect(screen.getByTestId("leave-period-prev")).toBeTruthy();
  });

  it("renders the MonthBar root and no class outside the MonthBar recipe", () => {
    const { container } = renderWithTheme(PeriodSwitcher, props("quartal", "2026-11-08"));
    const root = container.querySelector(".month-bar");
    expect(root).toBeTruthy();
    // The wrapper's own markup is the MonthBar call and nothing else.
    expect(switcherSource).not.toMatch(/class=/);
    expect(switcherSource).not.toMatch(/<style/);
    const classes = new Set<string>();
    for (const el of container.querySelectorAll("[class]")) {
      for (const c of el.classList) classes.add(c);
    }
    const allowed = new Set([
      "month-bar",
      "month-bar-nav",
      "nav-btn",
      "month-bar-center",
      "month-bar-label",
      "btn",
      "btn-ghost",
      "btn-sm",
      "month-bar-today",
    ]);
    // A Svelte scoping hash class (svelte-xxxx) comes from MonthBar's own style block.
    const foreign = [...classes].filter((c) => !allowed.has(c) && !c.startsWith("svelte-"));
    expect(foreign).toEqual([]);
  });

  it("moves the cursor with the period (the label never comes from the clock)", () => {
    renderWithTheme(PeriodSwitcher, props("monat", "2027-02-10"));
    expect(screen.getByTestId("month-bar-label")).toHaveTextContent("Februar 2027");
  });
});
