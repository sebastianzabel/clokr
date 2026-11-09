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

// Phase 415 (#415): the request-form's OWN "Resturlaub" balance box — the shortfall hint and the
// Phase 107 G-03 conditional label both live inside it — moved into the shared
// `lib/components/leave/LeaveRequestForm.svelte`. The KPI strip's six tiles this file otherwise
// tests stayed page-owned and are unaffected (see that component's own doc comment for why the
// two are now independent reads of the same balance).
const SHARED_FORM_URL = new URL("../../components/leave/LeaveRequestForm.svelte", import.meta.url);
let SHARED_FORM: string;
try {
  SHARED_FORM = readFileSync(fileURLToPath(SHARED_FORM_URL), "utf8");
} catch {
  SHARED_FORM = readFileSync(
    resolve(process.cwd(), "src/lib/components/leave/LeaveRequestForm.svelte"),
    "utf8",
  );
}

// Issue #851 (D-851-04): the Urlaubsjahr tiles are the items of one KpiStrip now (`vacYearItems`),
// so the labels are read from that list instead of from tile markup. Same claims, new place.
const ITEMS_START = PAGE.indexOf("let vacYearItems = $derived<KpiItem[]>([");
const ITEMS = ITEMS_START < 0 ? "" : PAGE.slice(ITEMS_START, PAGE.indexOf("]);", ITEMS_START));
const tile = (label: string) => `label: "${label}"`;

describe("leave page vocabulary — the tile list is found", () => {
  it("vacYearItems exists and is non-empty", () => {
    expect(ITEMS_START).toBeGreaterThan(-1);
    expect(ITEMS.length).toBeGreaterThan(0);
  });
});

describe("leave page vocabulary — RETIRED terms must not come back", () => {
  it("no strip tile is called `Resturlaub` — that tile meant carryOverRemaining (0), not the balance", () => {
    expect(ITEMS).not.toContain(tile("Resturlaub"));
  });

  it("`Resturlaub Vorjahr` is gone — it meant the GROSS carry-over (14), a third meaning of the word", () => {
    expect(PAGE).not.toContain("Resturlaub Vorjahr");
  });

  it("the panel row `Verfügbar` is gone — it meant vacRemaining (7) while the card's `verfügbar` meant 38", () => {
    expect(PAGE).not.toContain('<span class="balance-label">Verfügbar</span>');
  });

  it("no strip tile is called `Geplant` — the days are submitted and awaiting approval, i.e. beantragt", () => {
    expect(ITEMS).not.toContain(tile("Geplant"));
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
    expect(ITEMS).toContain(tile("Übertrag Vorjahr"));
  });

  it("names the unused rest of that Übertrag distinctly", () => {
    expect(ITEMS).toContain(tile("Übertrag Vorjahr (Rest)"));
  });

  it("calls the pending days `Beantragt` — the same stem the card's qualifier uses", () => {
    expect(ITEMS).toContain(tile("Beantragt"));
  });

  it("keeps the three unchanged strip tiles, so a later edit cannot quietly rename them either", () => {
    expect(ITEMS).toContain(tile("Anspruch"));
    expect(ITEMS).toContain(tile("Genommen"));
    expect(ITEMS).toContain(tile("Verbleibend"));
  });

  it("takes the card's label from the tested conditional, not from a template literal", () => {
    expect(PAGE).toContain("vacationCardLabel(vacSummaryPlanned)");
  });

  it("takes the card's breakdown line from the tested copy function", () => {
    expect(PAGE).toContain("vacationCardDelta(");
  });

  it("keeps the one surviving `Resturlaub` string literal — the shortfall hint, which now carries the single meaning", () => {
    // Phase 415: this hint lives inside the shared create/edit dialog now, not the page itself.
    expect(SHARED_FORM).toContain("Nicht genug Resturlaub vorhanden");
    expect(PAGE).not.toContain("Nicht genug Resturlaub vorhanden");
  });

  it("leaves Phase 107 gap G-03's conditional label untouched", () => {
    // G-03's own comment ends "Do NOT collapse this back to a constant." Phase 114 obeys that;
    // this assertion is the proof that it did. Phase 415 moved the label itself into the shared
    // dialog (SHARED_FORM), not just this page.
    expect(SHARED_FORM).toContain('"Verbraucht (bestätigt)"');
    expect(SHARED_FORM).toContain('<span class="balance-label">Verbraucht (vorläufig)</span>');
  });
});

describe("leave page vocabulary — structure", () => {
  it("has exactly six strip tiles (five before, plus the gross Übertrag)", () => {
    expect(ITEMS.match(/\blabel: "/g)!.length).toBe(6);
  });

  it("keeps the two Übertrag tiles adjacent — separated, `(Rest) 0` would be an orphaned number again", () => {
    const grossIdx = ITEMS.indexOf(tile("Übertrag Vorjahr"));
    const restIdx = ITEMS.indexOf(tile("Übertrag Vorjahr (Rest)"));
    expect(grossIdx).toBeGreaterThan(-1);
    expect(restIdx).toBeGreaterThan(grossIdx);
    // No other tile sits between them.
    expect(ITEMS.slice(grossIdx + 1, restIdx).match(/\blabel: "/g) ?? []).toHaveLength(0);
  });

  it("builds the tiles from the block only — no page-own tile markup or bespoke selector", () => {
    expect(PAGE).not.toMatch(/class="vac-stat/);
    expect(PAGE).not.toContain(".vac-stat");
    expect(PAGE).toContain('<KpiStrip ariaLabel="Urlaubsjahr {calYear}" items={vacYearItems} />');
  });

  it("does not interpolate a year into any Urlaubs-label", () => {
    // loadVacationSummary() always fetches the CURRENT year regardless of the viewed calYear
    // (see deferred-items.md #1), so a year in a tile label would be an outright false statement.
    expect(ITEMS).not.toMatch(/label: `[^`]*\{calYear\}/);
    expect(ITEMS).not.toMatch(/label: "[^"]*\d{4}/);
  });
});
