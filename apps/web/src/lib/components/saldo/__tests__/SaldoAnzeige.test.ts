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

// Phase 97-01 (TRACER, SALDO-DISP-01/03/05) — split mode: "Bestätigt" (confirmed) vs.
// "Laufender Monat (Prognose)" (forecast) vs. "Voraussichtlich gesamt" (combined). Split
// rendering activates only when `confirmedMinutes` is provided (!== undefined) — the
// regression test at the end proves omitting it still renders the pre-Phase-97 legacy value.
// States named per 97-UI-SPEC.md's State Matrix (A1–A4 confirmed, B1–B3 forecast, D combined).
describe("SaldoAnzeige — split mode (Phase 97-01)", () => {
  it("A1: confirmed positive renders +sign, .saldo--positive/.saldo--split, and 'Guthaben' caption", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 120,
      openMonthMinutes: 30,
      hasClosedMonth: true,
    });
    const root = screen.getByTestId("saldo-anzeige");
    expect(root).toHaveClass("saldo--positive");
    expect(root).toHaveClass("saldo--split");
    expect(screen.getByTestId("saldo-confirmed-value")).toHaveTextContent("+2:00");
    expect(screen.getByTestId("saldo-confirmed-caption")).toHaveTextContent("Guthaben");
  });

  it("A2: confirmed zero + hasClosedMonth=true renders 'ausgeglichen'", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 0,
      openMonthMinutes: 15,
      hasClosedMonth: true,
    });
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--zero");
    expect(screen.getByTestId("saldo-confirmed-value")).toHaveTextContent("0:00");
    expect(screen.getByTestId("saldo-confirmed-caption")).toHaveTextContent("ausgeglichen");
  });

  it("A3: confirmed zero + hasClosedMonth=false renders 'noch kein Monatsabschluss', NOT 'ausgeglichen'", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 0,
      openMonthMinutes: 15,
      hasClosedMonth: false,
    });
    const caption = screen.getByTestId("saldo-confirmed-caption");
    expect(caption).toHaveTextContent("noch kein Monatsabschluss");
    expect(caption).not.toHaveTextContent("ausgeglichen");
  });

  it("A4: confirmed negative renders U+2212 minus, .saldo--negative, and 'offen' caption", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: -90,
      openMonthMinutes: 0,
      hasClosedMonth: true,
    });
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--negative");
    expect(screen.getByTestId("saldo-confirmed-value")).toHaveTextContent("−1:30");
    expect(screen.getByTestId("saldo-confirmed-caption")).toHaveTextContent("offen");
  });

  it("B1: positive forecast renders the value without any good/bad/sign class (never colour-coded)", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 100,
      openMonthMinutes: 40,
      hasClosedMonth: true,
    });
    const fv = screen.getByTestId("saldo-forecast-value");
    expect(fv).toHaveTextContent("+0:40");
    expect(fv).not.toHaveClass("saldo--good");
    expect(fv).not.toHaveClass("saldo--bad");
    expect(fv).not.toHaveClass("saldo--positive");
    expect(fv).not.toHaveClass("saldo--negative");
  });

  it("B2: zero forecast renders 0:00 without any good/bad/sign class", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 100,
      openMonthMinutes: 0,
      hasClosedMonth: true,
    });
    const fv = screen.getByTestId("saldo-forecast-value");
    expect(fv).toHaveTextContent("0:00");
    expect(fv).not.toHaveClass("saldo--good");
    expect(fv).not.toHaveClass("saldo--bad");
  });

  it("B3: negative forecast renders U+2212 minus WITHOUT --bad (locked decision: forecast is never colour-coded)", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 100,
      openMonthMinutes: -25,
      hasClosedMonth: true,
    });
    const fv = screen.getByTestId("saldo-forecast-value");
    expect(fv).toHaveTextContent("−0:25");
    expect(fv).not.toHaveClass("saldo--bad");
    expect(fv).not.toHaveClass("saldo--negative");
  });

  it("D: combined value equals confirmed + forecast (pure display arithmetic, no new computation path)", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 100,
      openMonthMinutes: -25,
      hasClosedMonth: true,
    });
    // 100 + (-25) = 75min = +1:15
    expect(screen.getByTestId("saldo-combined-value")).toHaveTextContent("+1:15");
  });

  it("null-forecast (Task 1 fail-safe shape): renders en-dash and suppresses the combined line entirely", () => {
    renderWithTheme(SaldoAnzeige, {
      confirmedMinutes: 194,
      openMonthMinutes: null,
      hasClosedMonth: true,
    });
    expect(screen.getByTestId("saldo-forecast-value")).toHaveTextContent("—");
    expect(screen.queryByTestId("saldo-combined-value")).toBeNull();
  });

  it("regression: omitting confirmedMinutes still renders the legacy single value (no split)", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 120 });
    const root = screen.getByTestId("saldo-anzeige");
    expect(root).not.toHaveClass("saldo--split");
    expect(screen.getByTestId("saldo-value")).toHaveTextContent("+2:00");
    expect(screen.queryByTestId("saldo-confirmed-value")).toBeNull();
  });

  it("compact split mode collapses captions/combined line but keeps confirmed+forecast inline", () => {
    renderWithTheme(SaldoAnzeige, {
      variant: "compact",
      confirmedMinutes: 135,
      openMonthMinutes: 40,
      hasClosedMonth: true,
    });
    expect(screen.getByTestId("saldo-confirmed-value")).toHaveTextContent("+2:15");
    expect(screen.getByTestId("saldo-forecast-value")).toHaveTextContent("(+0:40)");
    expect(screen.queryByTestId("saldo-confirmed-caption")).toBeNull();
    expect(screen.queryByTestId("saldo-combined-value")).toBeNull();
    expect(screen.queryByTestId("saldo-forecast-label")).toBeNull();
  });

  it("compact A3 ('noch kein Monatsabschluss') is the ONE caption UI-SPEC keeps even in compact", () => {
    renderWithTheme(SaldoAnzeige, {
      variant: "compact",
      confirmedMinutes: 0,
      openMonthMinutes: 10,
      hasClosedMonth: false,
    });
    expect(screen.getByTestId("saldo-confirmed-caption")).toHaveTextContent(
      "noch kein Monatsabschluss",
    );
  });
});
