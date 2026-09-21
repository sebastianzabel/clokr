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

// Phase 100 Plan 06 (Q1) — the dark-mode contrast fallback below is pinned by reading the
// component's own source rather than via `getComputedStyle()`. Confirmed empirically (not
// assumed) that this test environment does not inject component-scoped <style> tags into
// jsdom's `document.head` at all — `getComputedStyle()` on the badge returns the browser
// default `canvastext` regardless of `data-mode`, and `document.head.querySelectorAll("style")`
// is empty. This matches this codebase's own documented precedent in SaldoAnzeige.svelte:
// "Tests assert class + text content only; no visual regression is expected from missing
// global rules." A source-text pin is the one thing this suite CAN actually verify against
// silent regression (e.g. someone reverting the fallback or widening it to `--warn` itself).
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

  it('captions the headline "inkl. laufendem Monat"', () => {
    const { container } = renderWithTheme(
      KontoSaldoCard,
      baseProps({ confirmedMinutes: -480, openMonthMinutes: 120 }),
    );
    expect(container.querySelector(".ksc-caption")).toHaveTextContent("inkl. laufendem Monat");
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

// Phase 100 Plan 06 (Q1, owner checkpoint 2026-08-21) — dark-mode contrast fallback.
// Measured live: --warn text on the composited dark-mode --warn-soft background is 2.73:1,
// failing WCAG AA (4.5:1 normal / 3:1 large). Owner-approved fix: color: var(--text) on the
// same --warn-soft background (11.64:1), scoped to this one badge, dark mode only — see
// SOURCE comment above the CSS rule in KontoSaldoCard.svelte for the full measurement trail.
describe("KontoSaldoCard — Toleranzgrenze badge dark-mode contrast fallback (Phase 100 Plan 06, Q1)", () => {
  it('scopes color: var(--text) to the badge under [data-mode="dark"] via the .ksc-tolerance-warn ancestor', () => {
    const rule =
      /:global\(\[data-mode="dark"\]\)\s*\.ksc-tolerance-warn\s+\.badge-yellow\s*\{[^}]*color:\s*var\(--text\)[^}]*\}/;
    expect(COMPONENT_SOURCE).toMatch(rule);
  });

  it("does not override the --warn token itself (owner rejected the app-wide blast radius)", () => {
    // The fix must live as a scoped descendant-selector override (above), never as a local
    // redeclaration of the --warn custom property, which would repaint every --warn consumer
    // in the app (dashboard's cell-badge--requested, SaldoAnzeige's roster dot, etc.).
    expect(COMPONENT_SOURCE).not.toMatch(/--warn\s*:/);
  });

  it("leaves the global light-mode .badge-yellow color untouched (app.css)", () => {
    // Q1's fallback must not require any change to the shared global class — light mode
    // keeps reading color: var(--warn) from app.css exactly as every other .badge-yellow
    // consumer does. This guards the "light mode visually unchanged" acceptance criterion
    // against a future edit to the wrong file.
    const appCssPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../app.css",
    );
    const appCss = readFileSync(appCssPath, "utf-8");
    expect(appCss).toMatch(/\.badge-yellow\s*\{[^}]*color:\s*var\(--warn\)[^}]*\}/);
  });
});
