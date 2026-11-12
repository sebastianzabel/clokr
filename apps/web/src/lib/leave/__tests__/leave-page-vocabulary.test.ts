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

// Phase 851 (owner acceptance, prototype): the Urlaubsjahr strip left /leave - the yearly figures are
// the Urlaubskonto ledger of Ich › Konto now (#594). The tile claims below therefore read that ledger;
// the retired terms stay pinned on /leave AND on Konto.
const KONTO_URL = new URL("../../../routes/(app)/ich/konto/+page.svelte", import.meta.url);
let KONTO: string;
try {
  KONTO = readFileSync(fileURLToPath(KONTO_URL), "utf8");
} catch {
  KONTO = readFileSync(resolve(process.cwd(), "src/routes/(app)/ich/konto/+page.svelte"), "utf8");
}
const LEDGER_START = KONTO.indexOf('<dl class="ledger">');
const LEDGER =
  LEDGER_START < 0 ? "" : KONTO.slice(LEDGER_START, KONTO.indexOf("</dl>", LEDGER_START));
const row = (label: string) => new RegExp(`<dt>${label.replace(/[()]/g, "\\$&")}</dt>`);

describe("leave page vocabulary — the ledger is found", () => {
  it("the Urlaubskonto ledger of Ich › Konto exists and is non-empty", () => {
    expect(LEDGER_START).toBeGreaterThan(-1);
    expect(LEDGER.length).toBeGreaterThan(0);
  });

  it("/leave has no Urlaubsjahr strip of its own any more", () => {
    expect(PAGE).not.toContain("vacYearItems");
    expect(PAGE).not.toContain("Urlaubsjahr {calYear}");
  });
});

describe("leave page vocabulary — RETIRED terms must not come back", () => {
  it("no strip tile is called `Resturlaub` — that tile meant carryOverRemaining (0), not the balance", () => {
    expect(LEDGER).not.toMatch(row("Resturlaub"));
    expect(PAGE).not.toContain('label: "Resturlaub"');
  });

  it("`Resturlaub Vorjahr` is gone — it meant the GROSS carry-over (14), a third meaning of the word", () => {
    expect(PAGE).not.toContain("Resturlaub Vorjahr");
  });

  it("the panel row `Verfügbar` is gone — it meant vacRemaining (7) while the card's `verfügbar` meant 38", () => {
    expect(PAGE).not.toContain('<span class="balance-label">Verfügbar</span>');
  });

  it("no strip tile is called `Geplant` — the days are submitted and awaiting approval, i.e. beantragt", () => {
    expect(LEDGER).not.toMatch(row("Geplant"));
    expect(PAGE).not.toContain('label: "Geplant"');
  });

  it("the old `von N verfügbar` template literal is gone", () => {
    expect(PAGE).not.toContain("verfügbar`");
  });

  it("the card's label is no longer a hardcoded, unconditional string", () => {
    expect(PAGE).not.toContain('label="Resturlaub"');
  });
});

describe("leave page vocabulary — the new terms must be PRESENT", () => {
  it("names the Vorjahresübertrag in its own ledger row, never as „Resturlaub“", () => {
    expect(LEDGER).toMatch(/<dt>Übertrag aus \{today\.year - 1\}<\/dt>/);
  });

  it("keeps the entitlement, the taken days and the remainder as their own rows", () => {
    expect(LEDGER).toMatch(row("Jahresanspruch"));
    expect(LEDGER).toMatch(row("Genommen und genehmigt"));
    expect(LEDGER).toMatch(row("Verbleibend"));
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
  it("has exactly four ledger rows on Konto", () => {
    expect(LEDGER.match(/<div class="ledger-row/g) ?? []).toHaveLength(4);
  });

  it("does not interpolate a year into any /leave Kennzahl label", () => {
    // loadVacationSummary() fetches the CURRENT year (deferred-items.md #1); a year in a label would lie.
    const items = PAGE.slice(PAGE.indexOf("let balanceItems = $derived<KpiItem[]>(["));
    const block = items.slice(0, items.indexOf("]);"));
    expect(block).not.toMatch(/label: `[^`]*\{calYear\}/);
    expect(block).not.toMatch(/label: "[^"]*\d{4}/);
  });
});
