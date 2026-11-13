// Issue #647 D-10 — the salon of a coverage rule is chosen in the /admin/shifts form only under
// the #64 rule, is sent only while the select is shown, and the page stays exempt from the header
// salon. Source-read pins: a route page cannot be mounted (no `$app` alias), see
// admin-shifts-save-wiring.test.ts for the precedent. Issue #854 (plan 09): the rule form and list
// moved from the page into the component CoverageRulesPanel; the pins read that component (PAGE
// below is its source, the page itself stays exempt and is pinned by salon-filter-exempt-pages-558).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const PAGE = readRouteFile(
  "../lib/components/admin/dienstplan/CoverageRulesPanel.svelte",
  "src/lib/components/admin/dienstplan/CoverageRulesPanel.svelte",
);

// The route page itself: it stays exempt from the header salon (salon-filter-exempt-pages-558).
const ROUTE_PAGE = readRouteFile(
  "../routes/(app)/admin/shifts/+page.svelte",
  "src/routes/(app)/admin/shifts/+page.svelte",
);

function fnBody(marker: string): string {
  const start = PAGE.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const end = PAGE.indexOf("\n  }", start);
  expect(end, `unterminated function: ${marker}`).toBeGreaterThan(start);
  return PAGE.slice(start, end);
}

/** Every text between an opening `open` and the `{/if}` that closes it (nesting counted). */
function ifBlocks(open: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const start = PAGE.indexOf(open, from);
    if (start === -1) break;
    let depth = 0;
    const re = /\{#if\b|\{\/if\}/g;
    re.lastIndex = start;
    let m: RegExpExecArray | null;
    let end = -1;
    while ((m = re.exec(PAGE)) !== null) {
      depth += m[0] === "{/if}" ? -1 : 1;
      if (depth === 0) {
        end = m.index;
        break;
      }
    }
    expect(end, `unterminated block: ${open}`).toBeGreaterThan(-1);
    out.push(PAGE.slice(start, end));
    from = end;
  }
  expect(out.length, `marker not found: ${open}`).toBeGreaterThan(0);
  return out;
}

describe("Issue #647 D-10 - /admin/shifts salon choice", () => {
  it("[vacuity gate] the page source is read", () => {
    expect(PAGE.length).toBeGreaterThan(1000);
    expect(PAGE).toContain("/shifts/coverage-rules");
  });

  it("imports the one #64 rule and the four helpers", () => {
    expect(PAGE).toMatch(/import \{[^}]*\bsalonContext\b[^}]*\} from "\$stores\/salon-context"/);
    expect(PAGE).toMatch(
      /import \{[^}]*\bshowSalonOptions\b[^}]*\} from "\$stores\/salon-context"/,
    );
    const helper = PAGE.match(/import \{([^}]*)\} from "\$lib\/shifts\/coverage-rule-salon"/);
    expect(helper, "helper import missing").not.toBeNull();
    for (const name of [
      "coverageRuleSalonCell",
      "coverageRuleSalonChoices",
      "coverageRuleSalonPayload",
      "showCoverageSalonColumn",
    ]) {
      expect(helper![1]).toContain(name);
    }
  });

  it("decides the options through showSalonOptions and nothing else", () => {
    expect(PAGE).toContain("const salonOptionsShown = $derived(showSalonOptions($salonContext));");
  });

  it("saveRule spreads the payload rule into its payload", () => {
    expect(fnBody("async function saveRule")).toContain(
      "...coverageRuleSalonPayload(salonOptionsShown, salonId)",
    );
  });

  it("the editor state is reset on create and loaded on edit", () => {
    expect(fnBody("function openCreate")).toContain('salonId = ""');
    expect(fnBody("function openEdit")).toContain('salonId = rule.salonId ?? ""');
  });

  it("the select lives only inside the salonOptionsShown block of the rule dialog", () => {
    const blocks = ifBlocks("{#if salonOptionsShown}").join("\n");
    expect(blocks).toContain("bind:value={salonId}");
    expect(blocks).toContain("{#each salonChoices as choice");
    expect(PAGE.split("bind:value={salonId}")).toHaveLength(2);
  });

  it("the list has a salon column, and renders its cell, only under salonColumnShown", () => {
    // The column exists only through the conditional spread; the cell is rendered for that column.
    expect(PAGE).toMatch(/\.\.\.\(salonColumnShown \? \[\{ key: "salon"/);
    expect(PAGE.match(/key: "salon"/g)?.length ?? 0).toBe(1);
    const total = PAGE.match(/coverageRuleSalonCell\(/g)?.length ?? 0;
    expect(total).toBe(1);
    const cell = PAGE.indexOf('column.key === "salon"');
    expect(cell).toBeGreaterThan(-1);
    expect(PAGE.indexOf("coverageRuleSalonCell(", cell)).toBeGreaterThan(cell);
  });

  it("never compares a salon by name and never follows the header salon", () => {
    for (const forbidden of [
      "salonName ===",
      "salonPageFilter",
      "withSalonId(",
      "SalonScopeLabel",
      "selectedSalonId(",
      ".selection",
    ]) {
      expect(PAGE, forbidden).not.toContain(forbidden);
      expect(ROUTE_PAGE, forbidden).not.toContain(forbidden);
    }
  });
});
