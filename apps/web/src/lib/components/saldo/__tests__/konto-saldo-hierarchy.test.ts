// Issue #291 — the "Konto / Gesamt-Saldo" card used to render the CONFIRMED portion
// (`confirmedMinutes`, i.e. the closed-month carry-over) as its headline figure, with the
// actual lifetime saldo demoted to a 17px row underneath. Whenever no month has been closed
// for a while, `confirmedMinutes` is 0 — so the card headlined "±0:00" for an employee whose
// real saldo was −70:12 (measured on a production tenant, 2026-09-21).
//
// These tests pin the corrected hierarchy. Two of them are deliberately NOT existence checks:
// "which figure dominates" is a design question, and `toBeVisible()` cannot answer it (an
// unstyled element is visible too). They MEASURE font sizes via `getComputedStyle`.
//
// Measuring requires the component's own <style> block, and this environment does not inject
// component-scoped styles into jsdom (documented empirically in KontoSaldoCard.test.ts). So the
// block is lifted out of the .svelte source and injected by hand. `CONTROL` below proves that
// injection actually took effect — without it every `getComputedStyle` call could return the
// same jsdom default and the comparisons would pass vacuously.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { renderWithTheme } from "$tests/test-utils";
import KontoSaldoCard from "../KontoSaldoCard.svelte";

const COMPONENT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../KontoSaldoCard.svelte",
);

/** The production case from issue #291: nothing confirmed, real saldo −70:12. */
const BROKEN_CLOSE_CHAIN = {
  totalHours: -70.2,
  confirmedMinutes: 0,
  openMonthMinutes: -4212,
  hasClosedMonth: true,
};

let injected: HTMLStyleElement | null = null;

beforeAll(() => {
  const source = readFileSync(COMPONENT_PATH, "utf-8");
  const match = source.match(/<style>([\s\S]*)<\/style>/);
  if (!match) throw new Error("KontoSaldoCard.svelte has no <style> block to measure against");
  injected = document.createElement("style");
  // `:global(...)` is Svelte syntax, not CSS — jsdom's parser drops those rules. None of the
  // selectors measured below are wrapped in it, so the drop is harmless.
  injected.textContent = match[1];
  document.head.appendChild(injected);
});

afterAll(() => {
  injected?.remove();
  injected = null;
});

function fontPx(el: Element): number {
  return parseFloat(getComputedStyle(el).fontSize);
}

/** Every element in the card that carries a font-size from the injected stylesheet. */
function sizedElements(container: Element): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("*")).filter(
    (el) => el.textContent !== null && el.textContent.trim().length > 0,
  );
}

describe("KontoSaldoCard — the injected stylesheet really applies (control for the two measurements below)", () => {
  it("sizes .ksc-figure from the component stylesheet, and an invented class differently", () => {
    const { container } = renderWithTheme(KontoSaldoCard, BROKEN_CLOSE_CHAIN);
    const figure = container.querySelector(".ksc-figure");
    expect(figure).not.toBeNull();

    const control = document.createElement("div");
    // A class that exists nowhere in the stylesheet — it must NOT pick up .ksc-figure's size.
    control.className = "ksc-figure-control-does-not-exist";
    control.textContent = "control";
    document.body.appendChild(control);

    expect(fontPx(figure!)).toBe(38);
    expect(fontPx(control)).not.toBe(38);
    control.remove();
  });
});

describe("KontoSaldoCard — the dominant figure is the real saldo, not the confirmed portion (issue #291)", () => {
  it("renders the lifetime total as the headline figure", () => {
    const { container } = renderWithTheme(KontoSaldoCard, BROKEN_CLOSE_CHAIN);
    const figure = container.querySelector(".ksc-figure");
    expect(figure).toHaveTextContent("−70:12");
    expect(figure!.textContent).not.toContain("±0:00");
  });

  it("gives the largest type in the card to the total — never to the confirmed ±0:00", () => {
    const { container } = renderWithTheme(KontoSaldoCard, BROKEN_CLOSE_CHAIN);
    const card = container.querySelector<HTMLElement>('[data-testid="konto-saldo-card"]')!;

    const biggest = sizedElements(card).reduce((a, b) => (fontPx(b) > fontPx(a) ? b : a));

    expect(biggest.textContent).toContain("−70:12");
    expect(biggest.textContent).not.toContain("±0:00");
  });

  it("renders the confirmed figure strictly smaller than, and after, the headline", () => {
    const { container } = renderWithTheme(KontoSaldoCard, BROKEN_CLOSE_CHAIN);
    const card = container.querySelector<HTMLElement>('[data-testid="konto-saldo-card"]')!;
    const figure = card.querySelector<HTMLElement>(".ksc-figure")!;

    const confirmed = sizedElements(card).filter(
      (el) => el.children.length === 0 && el.textContent!.trim() === "±0:00",
    );
    expect(confirmed).toHaveLength(1);

    expect(fontPx(confirmed[0])).toBeLessThan(fontPx(figure));
    // Node.DOCUMENT_POSITION_FOLLOWING === 4 — the confirmed value comes after the headline.
    expect(figure.compareDocumentPosition(confirmed[0]) & 4).toBe(4);
  });
});

describe("KontoSaldoCard — missing-Monatsabschluss marker (issue #291)", () => {
  it("marks the card when nothing is confirmed but the saldo is not empty", () => {
    const { container } = renderWithTheme(KontoSaldoCard, BROKEN_CLOSE_CHAIN);
    const marker = container.querySelector(".ksc-missing-close");
    expect(marker).not.toBeNull();
    expect(marker!.querySelector(".badge.badge-yellow")).toHaveTextContent(
      "Monatsabschlüsse fehlen",
    );
  });

  it("does not mark a card whose confirmed portion is non-zero", () => {
    const { container } = renderWithTheme(KontoSaldoCard, {
      ...BROKEN_CLOSE_CHAIN,
      confirmedMinutes: -3000,
      openMonthMinutes: -1212,
    });
    expect(container.querySelector(".ksc-missing-close")).toBeNull();
  });

  it("does not mark a genuinely balanced account (confirmed 0 and total 0)", () => {
    const { container } = renderWithTheme(KontoSaldoCard, {
      totalHours: 0,
      confirmedMinutes: 0,
      openMonthMinutes: 0,
      hasClosedMonth: true,
    });
    expect(container.querySelector(".ksc-missing-close")).toBeNull();
  });

  it("does not mark a legacy/non-split card (no confirmedMinutes at all)", () => {
    const { container } = renderWithTheme(KontoSaldoCard, {
      totalHours: -70.2,
      confirmedMinutes: undefined,
      openMonthMinutes: undefined,
      hasClosedMonth: false,
    });
    expect(container.querySelector(".ksc-missing-close")).toBeNull();
  });
});
