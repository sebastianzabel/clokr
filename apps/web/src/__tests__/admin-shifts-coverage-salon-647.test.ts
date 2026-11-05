// Issue #647 D-10 — the salon of a coverage rule is chosen in the /admin/shifts form only under
// the #64 rule, is sent only while the select is shown, and the page stays exempt from the header
// salon. Source-read pins: a route page cannot be mounted (no `$app` alias), see
// admin-shifts-save-wiring.test.ts for the precedent.
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
      "...coverageRuleSalonPayload(salonOptionsShown, ruleSalonId)",
    );
  });

  it("the editor state is reset on create and loaded on edit", () => {
    expect(fnBody("function openCreateRule")).toContain('ruleSalonId = ""');
    expect(fnBody("function openEditRule")).toContain('ruleSalonId = rule.salonId ?? ""');
  });

  it("the select lives only inside the salonOptionsShown block of the rule modal", () => {
    const blocks = ifBlocks("{#if salonOptionsShown}").join("\n");
    expect(blocks).toContain('id="rule-salon"');
    expect(PAGE.split('id="rule-salon"')).toHaveLength(2);
  });

  it("the list renders the salon cell only inside salonColumnShown", () => {
    const inside = ifBlocks("{#if salonColumnShown}").join("\n");
    const total = PAGE.match(/coverageRuleSalonCell\(/g)?.length ?? 0;
    expect(total).toBeGreaterThan(0);
    expect(inside.match(/coverageRuleSalonCell\(/g)?.length ?? 0).toBe(total);
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
    }
  });
});
