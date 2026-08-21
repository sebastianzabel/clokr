// Quick task 260820-elk follow-up — KontoSaldoCard regression coverage for the three
// coordinator-measured visual deviations (see 260820-elk-SUMMARY.md "Follow-up" section):
//   1. (mid-label emphasis — covered in SollIstBar.test.ts, not this card)
//   2. "inkl. laufendem Monat" row value must be sized/coloured like a real figure
//   3. the headline (Gesamt-Saldo) figure must ALWAYS carry a sign, incl. "±0:00" at zero

import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import KontoSaldoCard from "../KontoSaldoCard.svelte";

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    totalHours: null as number | null,
    confirmedMinutes: 0,
    openMonthMinutes: 0 as number | null,
    hasClosedMonth: true,
    ...overrides,
  };
}

describe("KontoSaldoCard — headline figure sign (deviation #3)", () => {
  it('renders "±0:00" at exact zero (NOT bare "0:00")', () => {
    // Addressed via .ksc-figure rather than getByText: since the sign convention was
    // unified, the "inkl. laufendem Monat" row also renders "±0:00" when it is zero,
    // so the bare text is no longer unique in this card. Same assertion, unambiguous target.
    const { container } = renderWithTheme(KontoSaldoCard, baseProps({ confirmedMinutes: 0 }));
    const figure = container.querySelector(".ksc-figure");
    expect(figure).not.toBeNull();
    expect(figure!.textContent).toContain("±0:00");
  });

  it("renders a muted (not faint) tone at exact zero", () => {
    const { container } = renderWithTheme(KontoSaldoCard, baseProps({ confirmedMinutes: 0 }));
    const figure = container.querySelector(".ksc-figure");
    expect(figure).toHaveClass("ksc-figure--muted");
    expect(figure).not.toHaveClass("ksc-figure--faint");
  });

  it('renders "+2:00" for a positive confirmed figure', () => {
    renderWithTheme(KontoSaldoCard, baseProps({ confirmedMinutes: 120 }));
    expect(screen.getByText("+2:00")).toBeInTheDocument();
  });

  it('renders "−1:30" for a negative confirmed figure', () => {
    renderWithTheme(KontoSaldoCard, baseProps({ confirmedMinutes: -90 }));
    expect(screen.getByText("−1:30")).toBeInTheDocument();
  });
});

describe("KontoSaldoCard — 'inkl. laufendem Monat' row (deviation #2)", () => {
  it("renders the row value as a sign-toned figure, not a quiet 13px value", () => {
    const { container } = renderWithTheme(
      KontoSaldoCard,
      baseProps({ confirmedMinutes: 60, openMonthMinutes: -480 }),
    );
    const rowValue = container.querySelector(".ksc-row-value");
    expect(rowValue).toHaveClass("ksc-row-value--bad");
    expect(rowValue).toHaveTextContent("−8:00");
  });

  it("tones the row value good for a positive open-month figure", () => {
    const { container } = renderWithTheme(
      KontoSaldoCard,
      baseProps({ confirmedMinutes: 60, openMonthMinutes: 480 }),
    );
    const rowValue = container.querySelector(".ksc-row-value");
    expect(rowValue).toHaveClass("ksc-row-value--good");
  });

  it("tones the row value muted at exactly zero", () => {
    const { container } = renderWithTheme(
      KontoSaldoCard,
      baseProps({ confirmedMinutes: 60, openMonthMinutes: 0 }),
    );
    const rowValue = container.querySelector(".ksc-row-value");
    expect(rowValue).toHaveClass("ksc-row-value--muted");
  });
});

// Phase 100 (OTC-03) — the flag has been computed server-side since before this card
// existed and was discarded by every client; this is the first time it reaches the DOM.
describe("KontoSaldoCard — Toleranzgrenze badge (Phase 100 / OTC-03)", () => {
  it("renders no badge when both tolerance props are absent", () => {
    const { container } = renderWithTheme(KontoSaldoCard, baseProps());
    expect(container.querySelector(".ksc-tolerance-warn")).toBeNull();
  });

  it("renders no badge when isNegativeLimitExceeded is false", () => {
    const { container } = renderWithTheme(
      KontoSaldoCard,
      baseProps({ isNegativeLimitExceeded: false, maxNegativeBalanceMinutes: 600 }),
    );
    expect(container.querySelector(".ksc-tolerance-warn")).toBeNull();
  });

  it("renders the badge and hint when the tolerance limit is exceeded", () => {
    const { container } = renderWithTheme(
      KontoSaldoCard,
      baseProps({ isNegativeLimitExceeded: true, maxNegativeBalanceMinutes: 600 }),
    );
    const wrapper = container.querySelector(".ksc-tolerance-warn");
    expect(wrapper).not.toBeNull();
    expect(wrapper!.querySelector(".badge.badge-yellow")).toHaveTextContent(
      "Toleranzgrenze überschritten",
    );
    expect(wrapper!.querySelector(".ksc-tolerance-warn-hint")).toHaveTextContent(
      "erlaubt: 10:00 Std. Minus",
    );
  });

  it("zero-pads the minutes in the caption (90 min -> 1:30)", () => {
    renderWithTheme(
      KontoSaldoCard,
      baseProps({ isNegativeLimitExceeded: true, maxNegativeBalanceMinutes: 90 }),
    );
    expect(screen.getByText("erlaubt: 1:30 Std. Minus")).toBeInTheDocument();
  });

  it("renders no badge while loading, even when the flag is true", () => {
    const { container } = renderWithTheme(
      KontoSaldoCard,
      baseProps({
        isNegativeLimitExceeded: true,
        maxNegativeBalanceMinutes: 600,
        loading: true,
      }),
    );
    expect(container.querySelector(".ksc-tolerance-warn")).toBeNull();
  });

  it("renders in legacy/non-split mode (confirmedMinutes undefined) — pins the placement outside isSplit", () => {
    const { container } = renderWithTheme(
      KontoSaldoCard,
      baseProps({
        confirmedMinutes: undefined,
        totalHours: -3.5,
        isNegativeLimitExceeded: true,
        maxNegativeBalanceMinutes: 600,
      }),
    );
    expect(container.querySelector(".ksc-tolerance-warn")).not.toBeNull();
  });
});
