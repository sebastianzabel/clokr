// Quick task 260820-elk follow-up — KontoSaldoCard regression coverage for the three
// coordinator-measured visual deviations (see 260820-elk-SUMMARY.md "Follow-up" section):
//   1. (mid-label emphasis — covered in SollIstBar.test.ts, not this card)
//   2. "inkl. laufendem Monat" row value must be sized/coloured like a real figure
//   3. the headline (Gesamt-Saldo) figure must ALWAYS carry a sign, incl. "±0:00" at zero

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import KontoSaldoCard from "../KontoSaldoCard.svelte";

// The warning badges are pinned by reading the component's own source rather than via
// `getComputedStyle()`: this test environment injects no component-scoped <style> tags into jsdom,
// so a computed colour would be the browser default regardless of `data-mode`. A source-text pin is
// what this suite CAN verify against a returning workaround.
const COMPONENT_SOURCE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../KontoSaldoCard.svelte"),
  "utf-8",
);

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    totalHours: null as number | null,
    confirmedMinutes: 0,
    openMonthMinutes: 0 as number | null,
    hasClosedMonth: true,
    ...overrides,
  };
}

describe("KontoSaldoCard — headline figure (deviation #3 + issue #291)", () => {
  // Issue #291 moved the CONFIRMED portion out of the headline and put the lifetime TOTAL
  // there instead. The sign convention pinned by this block is unchanged — but the fixtures
  // are: every case below now sets confirmedMinutes and openMonthMinutes to DIFFERENT values,
  // so a regression that puts the confirmed portion back into the headline fails here instead
  // of quietly passing on a fixture where both happen to agree.
  it('renders "±0:00" at exact zero (NOT bare "0:00")', () => {
    // Addressed via .ksc-figure rather than getByText: since the sign convention was
    // unified, the "Bestätigt" row also renders "±0:00" when it is zero, so the bare text
    // is not unique in this card. Same assertion, unambiguous target.
    const { container } = renderWithTheme(
      KontoSaldoCard,
      baseProps({ confirmedMinutes: 0, openMonthMinutes: 0 }),
    );
    const figure = container.querySelector(".ksc-figure");
    expect(figure).not.toBeNull();
    expect(figure!.textContent).toContain("±0:00");
  });

  it("renders a muted (not faint) tone at exact zero", () => {
    const { container } = renderWithTheme(
      KontoSaldoCard,
      baseProps({ confirmedMinutes: 0, openMonthMinutes: 0 }),
    );
    const figure = container.querySelector(".ksc-figure");
    expect(figure).toHaveClass("ksc-figure--muted");
    expect(figure).not.toHaveClass("ksc-figure--faint");
  });

  it('renders "+2:00" for a total of +2:00 that is entirely unconfirmed', () => {
    const { container } = renderWithTheme(
      KontoSaldoCard,
      baseProps({ confirmedMinutes: 0, openMonthMinutes: 120 }),
    );
    const figure = container.querySelector(".ksc-figure");
    expect(figure).toHaveTextContent("+2:00");
    expect(figure).toHaveClass("ksc-figure--good");
  });

  it('renders "−1:30" for a total of −1:30 that is entirely unconfirmed', () => {
    const { container } = renderWithTheme(
      KontoSaldoCard,
      baseProps({ confirmedMinutes: 0, openMonthMinutes: -90 }),
    );
    const figure = container.querySelector(".ksc-figure");
    expect(figure).toHaveTextContent("−1:30");
    expect(figure).toHaveClass("ksc-figure--bad");
  });

  it("sums the confirmed and open-month parts rather than showing either one alone", () => {
    // +8:00 confirmed, −2:00 open month → the card must headline +6:00. Picked so that no
    // single part equals the total: neither a revert to the confirmed-only headline nor an
    // open-month-only headline can satisfy this.
    const { container } = renderWithTheme(
      KontoSaldoCard,
      baseProps({ confirmedMinutes: 480, openMonthMinutes: -120 }),
    );
    expect(container.querySelector(".ksc-figure")).toHaveTextContent("+6:00");
  });

  it("falls back to totalHours in legacy/non-split mode (no confirmedMinutes)", () => {
    const { container } = renderWithTheme(
      KontoSaldoCard,
      baseProps({ confirmedMinutes: undefined, openMonthMinutes: undefined, totalHours: -3.5 }),
    );
    expect(container.querySelector(".ksc-figure")).toHaveTextContent("−3:30");
    expect(container.querySelector(".ksc-row")).toBeNull();
  });
});

describe("KontoSaldoCard — 'Bestätigt' row (deviation #2, re-pointed by issue #291)", () => {
  // Before issue #291 this row carried the TOTAL under an "inkl. laufendem Monat" label and
  // the headline carried the confirmed portion. The two swapped places; the row's own
  // requirement did not change — it must still read as a real figure (size + sign colour),
  // not as quiet as its own label. Fixtures below keep the row value distinct from the
  // headline so the assertions cannot be satisfied by the wrong element.
  it("renders the row value as a sign-toned figure, not a quiet 13px value", () => {
    const { container } = renderWithTheme(
      KontoSaldoCard,
      baseProps({ confirmedMinutes: -480, openMonthMinutes: 120 }),
    );
    const rowValue = container.querySelector(".ksc-row-value");
    expect(rowValue).toHaveClass("ksc-row-value--bad");
    expect(rowValue).toHaveTextContent("−8:00");
    // ...and the headline is the TOTAL (−6:00), i.e. a different number entirely.
    expect(container.querySelector(".ksc-figure")).toHaveTextContent("−6:00");
  });

  it("tones the row value good for a positive confirmed figure, even when the total is negative", () => {
    const { container } = renderWithTheme(
      KontoSaldoCard,
      baseProps({ confirmedMinutes: 480, openMonthMinutes: -600 }),
    );
    expect(container.querySelector(".ksc-row-value")).toHaveClass("ksc-row-value--good");
    expect(container.querySelector(".ksc-figure")).toHaveClass("ksc-figure--bad");
  });

  it("tones the row value muted at exactly zero, even when the total is not zero", () => {
    const { container } = renderWithTheme(
      KontoSaldoCard,
      baseProps({ confirmedMinutes: 0, openMonthMinutes: -60 }),
    );
    expect(container.querySelector(".ksc-row-value")).toHaveClass("ksc-row-value--muted");
  });

  it('labels the row "Bestätigt" once a month has been closed', () => {
    const { container } = renderWithTheme(
      KontoSaldoCard,
      baseProps({ confirmedMinutes: -480, openMonthMinutes: 120, hasClosedMonth: true }),
    );
    expect(container.querySelector(".ksc-row-label")).toHaveTextContent("Bestätigt");
  });

  it('labels the row "noch kein Monatsabschluss" for a zero confirmed figure without a close', () => {
    const { container } = renderWithTheme(
      KontoSaldoCard,
      baseProps({ confirmedMinutes: 0, openMonthMinutes: 0, hasClosedMonth: false }),
    );
    expect(container.querySelector(".ksc-row-label")).toHaveTextContent(
      "noch kein Monatsabschluss",
    );
  });

  it('captions the headline "inkl. laufendem Monat" for exactly one unconfirmed month', () => {
    // Issue #588 (P-14): the wording follows the data; the migrated case names one month.
    const { container } = renderWithTheme(
      KontoSaldoCard,
      baseProps({ confirmedMinutes: -480, openMonthMinutes: 120, unconfirmedMonths: 1 }),
    );
    expect(container.querySelector(".ksc-caption")).toHaveTextContent("inkl. laufendem Monat");
  });

  it("captions the headline as the period since the closing for several unconfirmed months", () => {
    const { container } = renderWithTheme(
      KontoSaldoCard,
      baseProps({
        confirmedMinutes: -480,
        openMonthMinutes: 120,
        hasClosedMonth: true,
        unconfirmedMonths: 3,
      }),
    );
    const caption = container.querySelector(".ksc-caption");
    expect(caption).toHaveTextContent("inkl. Zeitraum seit Monatsabschluss");
    expect(caption).not.toHaveTextContent("laufendem Monat");
  });

  it("never claims the running month for an unknown count", () => {
    const { container } = renderWithTheme(
      KontoSaldoCard,
      baseProps({ confirmedMinutes: -480, openMonthMinutes: 120, hasClosedMonth: true }),
    );
    const caption = container.querySelector(".ksc-caption");
    expect(caption).toHaveTextContent("inkl. Zeitraum seit Monatsabschluss");
    expect(caption).not.toHaveTextContent("laufendem Monat");
  });

  it("captions the period since hire when no month was ever closed", () => {
    const { container } = renderWithTheme(
      KontoSaldoCard,
      baseProps({
        confirmedMinutes: 0,
        openMonthMinutes: 120,
        hasClosedMonth: false,
        unconfirmedMonths: 5,
      }),
    );
    expect(container.querySelector(".ksc-caption")).toHaveTextContent(
      "inkl. Zeitraum seit Eintritt",
    );
  });

  it("appends the roster qualifier in every wording", () => {
    for (const unconfirmedMonths of [1, 3, undefined]) {
      const { container, unmount } = renderWithTheme(
        KontoSaldoCard,
        baseProps({
          confirmedMinutes: -480,
          openMonthMinutes: 120,
          hasClosedMonth: true,
          unconfirmedMonths,
          rosterIncomplete: true,
        }),
      );
      expect(container.querySelector(".ksc-caption")).toHaveTextContent("· Restmonat unverplant");
      unmount();
    }
  });

  it("appends the roster qualifier to the headline caption, not to the Bestätigt row", () => {
    const { container } = renderWithTheme(
      KontoSaldoCard,
      baseProps({ confirmedMinutes: -480, openMonthMinutes: 120, rosterIncomplete: true }),
    );
    expect(container.querySelector(".ksc-caption")).toHaveTextContent("Restmonat unverplant");
    expect(container.querySelector(".ksc-row-label")).not.toHaveTextContent("Restmonat unverplant");
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

// Issue #842 (IN-03) - the dark-mode contrast fallbacks of Phase 100 / Issue #291 are gone. They
// existed because the v1.5 --warn stayed orange-brown in dark mode (2.73:1 on --warn-soft). In v2
// every theme overrides --warn for dark mode, and token-contrast-842.test.ts pins --warn on
// --warn-soft at 4.5:1 in all six combinations, so the badge needs no local colour.
describe("KontoSaldoCard - warning badges use the global warn roles only (#842)", () => {
  it("carries no dark-mode colour override for a badge", () => {
    expect(COMPONENT_SOURCE).not.toMatch(/\[data-mode=/);
  });

  it("does not redeclare the --warn token (it would repaint every --warn consumer)", () => {
    expect(COMPONENT_SOURCE).not.toMatch(/--warn\s*:/);
  });

  it("still renders both warning badges as the global .badge-yellow pill", () => {
    expect(COMPONENT_SOURCE).toMatch(/badge badge-yellow/);
  });

  it("leaves the global .badge-yellow on the warn roles (app.css)", () => {
    const appCssPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../app.css",
    );
    const appCss = readFileSync(appCssPath, "utf-8");
    expect(appCss).toMatch(
      /\.badge-yellow\s*\{[^}]*background-color:\s*var\(--warn-soft\)[^}]*color:\s*var\(--warn\)[^}]*\}/,
    );
  });
});
