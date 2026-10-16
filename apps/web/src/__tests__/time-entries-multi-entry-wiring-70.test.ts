// Issue #70 (Phase 70b-07, D-07/D-12/D-13) — wiring pins of the two time-entry pages.
//
// This is a source-read PIN, not a behaviour test: route pages cannot be mounted here because
// `apps/web/vitest.config.ts` has no `$app` alias (same reason as month-card-no-soll-wiring). The
// pure decisions are tested in `lib/time-entries/__tests__/day-entry-actions.test.ts`; what only a
// source scan can prove is that every NEW element sits inside the #64 gate (`showSalonOptions`),
// that the page delegates to the shared module, and that the header salon selection never becomes
// a booking salon (T-70b-29).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

// fileURLToPath decodes the %28/%29 that the "(app)" route group produces in import.meta.url.
function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

/** The page source with every balanced `{#if multiEntryUi}…{/if}` block removed. */
function withoutGatedBlocks(source: string): string {
  const open = "{#if multiEntryUi}";
  let out = source;
  for (;;) {
    const start = out.indexOf(open);
    if (start === -1) return out;
    let depth = 0;
    let cursor = start;
    let end = -1;
    while (cursor < out.length) {
      const nextOpen = out.indexOf("{#if", cursor);
      const nextClose = out.indexOf("{/if}", cursor);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1;
        cursor = nextOpen + 4;
      } else {
        depth -= 1;
        cursor = nextClose + 5;
        if (depth === 0) {
          end = cursor;
          break;
        }
      }
    }
    if (end === -1) throw new Error("unbalanced {#if} in the page source");
    out = out.slice(0, start) + out.slice(end);
  }
}

const PAGES = [
  {
    name: "/time-entries",
    source: readRouteFile(
      "../routes/(app)/time-entries/+page.svelte",
      "src/routes/(app)/time-entries/+page.svelte",
    ),
  },
  {
    name: "/team/time-entries",
    source: readRouteFile(
      "../routes/(app)/team/time-entries/+page.svelte",
      "src/routes/(app)/team/time-entries/+page.svelte",
    ),
  },
];

describe.each(PAGES)("multi-entry wiring (#70) — $name", ({ source }) => {
  it("reads a non-empty page source", () => {
    expect(source.length).toBeGreaterThan(0);
  });

  it("delegates the add and the cell click to the shared decisions", () => {
    expect(source).toMatch(
      /import \{[^}]*\baddActionForDay\b[^}]*\} from "\$lib\/time-entries\/day-entry-actions"/,
    );
    expect(source).toMatch(
      /import \{[^}]*\bcellClickAction\b[^}]*\} from "\$lib\/time-entries\/day-entry-actions"/,
    );
    expect(source).toContain("addActionForDay(");
    expect(source).toContain("cellClickAction(");
    expect(source).toContain("entryCountTitle(");
    expect(source).toContain("salonFieldOptions(");
    expect(source).toContain("salonIdToSend(");
  });

  it("decides the new elements by the #64 rule, in one derived value", () => {
    expect(source).toMatch(
      /import \{[^}]*\bshowSalonOptions\b[^}]*\} from "\$stores\/salon-context"/,
    );
    expect(source).toMatch(/let multiEntryUi = \$derived\(showSalonOptions\(\$salonContext\)\)/);
  });

  it("renders the Salon field, the Salon column and the per-day add only inside the gate", () => {
    const ungated = withoutGatedBlocks(source);
    // The words may appear in comments of the script; the markup pins below name the elements.
    expect(source).toContain('for="f-salon"');
    expect(source).toContain("<th>Salon</th>");
    expect(source).toContain("Weiteren Eintrag an diesem Tag");
    expect(ungated).not.toContain('for="f-salon"');
    expect(ungated).not.toContain("<th>Salon</th>");
    expect(ungated).not.toContain("Weiteren Eintrag an diesem Tag");
    expect(ungated).not.toContain("slot.salonName");
  });

  it("never lets the header salon selection decide a booking salon", () => {
    expect(source).not.toContain("selectedSalonId");
    expect(source).not.toMatch(/\$salonContext\.selection/);
    expect(source).not.toContain("$lib/dashboard/clock-salon");
  });

  it("offers the form the store's reachable salons, never the clock-salon answer", () => {
    expect(source).toMatch(/salonFieldOptions\(\$salonContext\.salons,/);
  });

  it("sends the salon to the save and to the preview only through salonIdToSend", () => {
    const sends = source.split("salonIdToSend(").length - 1;
    expect(sends).toBeGreaterThanOrEqual(1);
    expect(source).toMatch(/salonId: formSalonPayload/);
  });
});
