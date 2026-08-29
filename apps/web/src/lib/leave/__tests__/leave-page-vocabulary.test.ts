// Phase 114 (Issue #117) — source-level regression shield for the /leave vocabulary.
//
// Issue #117: on ONE screen, „Resturlaub" named three different Größen (the balance 7, the
// gross Vorjahresübertrag 14, and the unused rest of that Übertrag 0) and „verfügbar" named
// two (38 in the card's delta line, 7 in the Urlaubskonto panel). This file is what stops any
// of those from coming back.
//
// Why it reads the page SOURCE instead of mounting the component: no test in `apps/web` has
// ever mounted a route page (all 24 pre-existing test files live under `src/lib/`), and the
// thing under test here is a set of German label strings, not behaviour. A source read gives
// the guarantee at zero mounting cost.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

// fileURLToPath decodes the %28/%29 that the "(app)" route group produces in import.meta.url.
const PAGE_URL = new URL("../../../routes/(app)/leave/+page.svelte", import.meta.url);
let PAGE: string;
try {
  PAGE = readFileSync(fileURLToPath(PAGE_URL), "utf8");
} catch {
  // Fallback: `pnpm --filter @clokr/web test` runs with cwd `apps/web`.
  PAGE = readFileSync(resolve(process.cwd(), "src/routes/(app)/leave/+page.svelte"), "utf8");
}

describe("leave page vocabulary — RETIRED terms must not come back", () => {
  it("no strip tile is called `Resturlaub` — that tile meant carryOverRemaining (0), not the balance", () => {
    expect(PAGE).not.toContain('<div class="vac-stat-label">Resturlaub</div>');
  });

  it("`Resturlaub Vorjahr` is gone — it meant the GROSS carry-over (14), a third meaning of the word", () => {
    expect(PAGE).not.toContain("Resturlaub Vorjahr");
  });

  it("the panel row `Verfügbar` is gone — it meant vacRemaining (7) while the card's `verfügbar` meant 38", () => {
    expect(PAGE).not.toContain('<span class="balance-label">Verfügbar</span>');
  });

  it("no strip tile is called `Geplant` — the days are submitted and awaiting approval, i.e. beantragt", () => {
    expect(PAGE).not.toContain('<div class="vac-stat-label">Geplant</div>');
  });

  it("the old `von N verfügbar` template literal is gone", () => {
    expect(PAGE).not.toContain("verfügbar`");
  });

  it("the card's label is no longer a hardcoded, unconditional string", () => {
    expect(PAGE).not.toContain('label="Resturlaub"');
  });
});

describe("leave page vocabulary — the new terms must be PRESENT", () => {
  it("names the gross Vorjahresübertrag in its own strip tile", () => {
    expect(PAGE).toContain('<div class="vac-stat-label">Übertrag Vorjahr</div>');
  });

  it("names the unused rest of that Übertrag distinctly", () => {
    expect(PAGE).toContain('<div class="vac-stat-label">Übertrag Vorjahr (Rest)</div>');
  });

  it("calls the pending days `Beantragt` — the same stem the card's qualifier uses", () => {
    expect(PAGE).toContain('<div class="vac-stat-label">Beantragt</div>');
  });

  it("keeps the three unchanged strip tiles, so a later edit cannot quietly rename them either", () => {
    expect(PAGE).toContain('<div class="vac-stat-label">Anspruch</div>');
    expect(PAGE).toContain('<div class="vac-stat-label">Genommen</div>');
    expect(PAGE).toContain('<div class="vac-stat-label">Verbleibend</div>');
  });

  it("takes the card's label from the tested conditional, not from a template literal", () => {
    expect(PAGE).toContain("vacationCardLabel(vacSummaryPlanned)");
  });

  it("takes the card's breakdown line from the tested copy function", () => {
    expect(PAGE).toContain("vacationCardDelta(");
  });

  it("keeps the one surviving `Resturlaub` string literal — the shortfall hint, which now carries the single meaning", () => {
    expect(PAGE).toContain("Nicht genug Resturlaub vorhanden");
  });

  it("leaves Phase 107 gap G-03's conditional label untouched", () => {
    // G-03's own comment ends "Do NOT collapse this back to a constant." Phase 114 obeys that;
    // this assertion is the proof that it did.
    expect(PAGE).toContain('"Verbraucht (bestätigt)"');
    expect(PAGE).toContain('<span class="balance-label">Verbraucht (vorläufig)</span>');
  });
});

describe("leave page vocabulary — structure", () => {
  it("has exactly six strip tiles (five before, plus the gross Übertrag)", () => {
    expect(PAGE.match(/vac-stat-label/g)!.length).toBe(6);
  });

  it("keeps the two Übertrag tiles adjacent — separated, `(Rest) 0` would be an orphaned number again", () => {
    const grossIdx = PAGE.indexOf('<div class="vac-stat-label">Übertrag Vorjahr</div>');
    const restIdx = PAGE.indexOf('<div class="vac-stat-label">Übertrag Vorjahr (Rest)</div>');
    expect(grossIdx).toBeGreaterThan(-1);
    expect(restIdx).toBeGreaterThan(grossIdx);
    expect(restIdx - grossIdx).toBeLessThan(400);
  });

  it("introduces no new CSS class — the new tiles reuse the existing recipe only", () => {
    expect(PAGE).not.toContain("vac-stat-carryover-value");
    const grossIdx = PAGE.indexOf('<div class="vac-stat-label">Übertrag Vorjahr</div>');
    const restEnd = PAGE.indexOf('<div class="vac-stat-label">Übertrag Vorjahr (Rest)</div>') + 800;
    const block = PAGE.slice(grossIdx - 200, restEnd);
    const allowed = new Set([
      "vac-stat",
      "vac-stat-label",
      "vac-stat-value",
      "vac-stat-unit",
      "vac-stat-carry",
    ]);
    for (const cls of block.match(/vac-stat[a-z-]*/g) ?? []) {
      expect(allowed.has(cls), `unexpected class "${cls}" in the Übertrag tiles`).toBe(true);
    }
  });

  it("does not interpolate a year into any Urlaubs-label", () => {
    // loadVacationSummary() always fetches the CURRENT year regardless of the viewed calYear
    // (see deferred-items.md #1), so a year in a label would be an outright false statement.
    expect(PAGE).not.toMatch(/vac-stat-label">[^<]*\{calYear\}/);
    expect(PAGE).not.toMatch(/vac-stat-label">[^<]*\d{4}/);
  });
});
