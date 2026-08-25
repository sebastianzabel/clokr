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
    // Stale since 1e289a32 ("Konto-Saldo-Zeile zeigt Gesamtsaldo statt Monatsanteil"): with
    // openMonthMinutes defaulting to 0, the "inkl. laufendem Monat" row now also totals to
    // "+2:00" (Bestätigt + 0), so screen.getByText was no longer unique in this card. Same
    // remedy as the "±0:00" test above — assert on .ksc-figure to target the headline only.
    const { container } = renderWithTheme(KontoSaldoCard, baseProps({ confirmedMinutes: 120 }));
    const figure = container.querySelector(".ksc-figure");
    expect(figure).toHaveTextContent("+2:00");
  });

  it('renders "−1:30" for a negative confirmed figure', () => {
    // Stale since 1e289a32 — same ambiguity as above: openMonthMinutes defaults to 0, so the
    // row also totals to "−1:30". Assert on .ksc-figure to target the headline unambiguously.
    const { container } = renderWithTheme(KontoSaldoCard, baseProps({ confirmedMinutes: -90 }));
    const figure = container.querySelector(".ksc-figure");
    expect(figure).toHaveTextContent("−1:30");
  });
});

describe("KontoSaldoCard — 'inkl. laufendem Monat' row (deviation #2)", () => {
  it("renders the row value as a sign-toned figure, not a quiet 13px value", () => {
    // Stale since 1e289a32: the row now renders Bestätigt + laufender Monat (the TOTAL), not
    // the open-month delta alone. The original confirmedMinutes: 60 no longer isolates the
    // open-month contribution — it shifts the total to −7:00, not the −8:00 this test still
    // expects. Keep confirmedMinutes at 0 so the row is legibly "nothing confirmed yet, all
    // forecast", which preserves both the original expected value and the test's intent (a
    // negative total carries --bad and a real figure).
    const { container } = renderWithTheme(
      KontoSaldoCard,
      baseProps({ confirmedMinutes: 0, openMonthMinutes: -480 }),
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
    // Stale since 1e289a32: the row is now toned off the TOTAL (confirmed + open month), not
    // the open-month delta alone. openMonthMinutes: 0 no longer means a zero row once
    // confirmedMinutes is nonzero (60 + 0 = +1:00 → good, not muted). Pick a pair that cancels
    // out so the TOTAL itself is zero, preserving the test's actual intent: "a zero row is
    // muted".
    const { container } = renderWithTheme(
      KontoSaldoCard,
      baseProps({ confirmedMinutes: 60, openMonthMinutes: -60 }),
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
