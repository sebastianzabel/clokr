// Phase 76-02 — SaldoAnzeige state coverage.
//
// 5 visual states × isLocked × variant matrix. Per D-06, every render wrapped
// in data-theme. The plan's must_haves.truths requires "at least one assertion
// per state" — the suite below exceeds that floor by also asserting:
//   - the rendered text content (formatted with U+2212 minus + zero-padding)
//   - the .saldo--{sign} class on the root testid
//   - the lock badge presence + aria-label when isLocked
//   - the label suppression / customisation when variant changes
// All assertions are independent (no shared mutable state); cleanup() between
// tests is wired by apps/web/src/__tests__/setup.ts (76-01 infrastructure).

import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import SaldoAnzeige from "../SaldoAnzeige.svelte";

describe("SaldoAnzeige — sign states", () => {
  it('renders 0h saldo as "0:00" with .saldo--zero class', () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 0 });
    const root = screen.getByTestId("saldo-anzeige");
    expect(root).toHaveClass("saldo--zero");
    expect(screen.getByTestId("saldo-value")).toHaveTextContent("0:00");
  });

  it("renders positive saldo with + sign and .saldo--positive class", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 120 });
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--positive");
    expect(screen.getByTestId("saldo-value")).toHaveTextContent("+2:00");
  });

  it("renders negative saldo with U+2212 minus and .saldo--negative class", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: -90 });
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--negative");
    expect(screen.getByTestId("saldo-value")).toHaveTextContent("−1:30");
  });

  it('renders null saldo as "Kein Stundenplan" with .saldo--no-schedule class', () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: null });
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--no-schedule");
    expect(screen.getByTestId("saldo-value")).toHaveTextContent("Kein Stundenplan");
  });
});

describe("SaldoAnzeige — locked state", () => {
  it("adds .saldo--locked class when isLocked=true", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 60, isLocked: true });
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--locked");
  });

  it("keeps sign class when isLocked co-occurs (no replacement)", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: -30, isLocked: true });
    const root = screen.getByTestId("saldo-anzeige");
    expect(root).toHaveClass("saldo--negative"); // sign preserved
    expect(root).toHaveClass("saldo--locked"); // modifier added
  });

  it("renders lock badge with aria-label when isLocked=true", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 0, isLocked: true });
    const badge = screen.getByTestId("saldo-locked-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute("aria-label", "Monat abgeschlossen");
  });
});

describe("SaldoAnzeige — variant", () => {
  it("hides label when variant=compact", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 60, variant: "compact" });
    expect(screen.queryByTestId("saldo-label")).toBeNull();
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--compact");
  });

  it("shows label when variant=expanded (default)", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 60 });
    expect(screen.getByTestId("saldo-label")).toHaveTextContent("Saldo");
  });

  it("renders custom label when label prop provided", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 60, label: "Übertrag" });
    expect(screen.getByTestId("saldo-label")).toHaveTextContent("Übertrag");
  });
});

describe("SaldoAnzeige — formatting", () => {
  it("zero-pads minute portion (e.g., +1:05 not +1:5)", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 65 });
    const value = screen.getByTestId("saldo-value");
    expect(value).toHaveTextContent("+1:05");
    // Cross-check: positive sign class lands on root even for the small +0:65 carry
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--positive");
    // And the value must not pick up any other sign class via co-render
    expect(screen.getByTestId("saldo-anzeige")).not.toHaveClass("saldo--negative");
    expect(screen.getByTestId("saldo-anzeige")).not.toHaveClass("saldo--zero");
  });
});

// Phase 76.7 (D-16, D-24, UI-V19-04) — § 18 ArbZG exempt rendering.
// When `exempt={true}`, the SaldoAnzeige hides the numeric saldo behind
// an em-dash "—" (U+2014) and tags the root with `saldo--exempt` so admin
// pages can later style it distinctly. Sign + locked modifiers are still
// allowed to co-render (exempt is orthogonal to those modifiers); the
// sign-state is collapsed to "exempt" so no misleading colour applies.
describe("SaldoAnzeige — exempt state (Phase 76.7 D-24, UI-V19-04)", () => {
  it('renders "—" (em-dash) when exempt=true regardless of saldoMinutes', () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 120, exempt: true });
    const root = screen.getByTestId("saldo-anzeige");
    expect(root).toHaveClass("saldo--exempt");
    expect(screen.getByTestId("saldo-value")).toHaveTextContent("—");
    // Must NOT leak through the numeric or signed render branch
    expect(screen.getByTestId("saldo-value")).not.toHaveTextContent("+2:00");
    expect(screen.getByTestId("saldo-value")).not.toHaveTextContent("0:00");
  });

  it('renders "—" when exempt=true even with saldoMinutes=null', () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: null, exempt: true });
    expect(screen.getByTestId("saldo-value")).toHaveTextContent("—");
    expect(screen.getByTestId("saldo-value")).not.toHaveTextContent("Kein Stundenplan");
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--exempt");
    expect(screen.getByTestId("saldo-anzeige")).not.toHaveClass("saldo--no-schedule");
  });

  it("preserves isLocked badge when exempt=true", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 60, exempt: true, isLocked: true });
    expect(screen.getByTestId("saldo-locked-badge")).toBeInTheDocument();
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--exempt");
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--locked");
    expect(screen.getByTestId("saldo-value")).toHaveTextContent("—");
  });

  it("regression: exempt=false (default) renders saldo number as today", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 120 });
    expect(screen.getByTestId("saldo-value")).toHaveTextContent("+2:00");
    expect(screen.getByTestId("saldo-anzeige")).not.toHaveClass("saldo--exempt");
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--positive");
  });
});
