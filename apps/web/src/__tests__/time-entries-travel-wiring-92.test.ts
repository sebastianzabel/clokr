// Issue #92 (Phase 92b-05, D-06/D-08) - wiring pins of the time-entry pages for the trip between
// two salons.
//
// A source-read PIN, like the 70b-07 wiring test: route pages cannot be mounted here (no `$app`
// alias in vitest). The pure decisions are tested in `lib/time-entries/__tests__/travel-entry-form
// .test.ts`; what only a source scan proves is that every travel element sits inside the #64 gate
// (`multiEntryUi`), that no request body can carry an entry kind, and that the header salon
// selection never becomes the departure or the arrival salon (T-92b-24, T-92b-25).

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
];

describe.each(PAGES)("travel wiring (#92) - $name", ({ source }) => {
  it("reads a non-empty page source", () => {
    expect(source.length).toBeGreaterThan(0);
  });

  it("delegates the payload, the mode and the label to the shared module", () => {
    for (const fn of ["travelPayload", "travelRouteLabel", "travelFormMode"]) {
      expect(source, fn).toMatch(
        new RegExp(
          `import \\{[^}]*\\b${fn}\\b[^}]*\\} from "\\$lib/time-entries/travel-entry-form"`,
        ),
      );
      expect(source, fn).toContain(`${fn}(`);
    }
  });

  it("renders the switch, the Von/Nach fields and the hint only inside the #64 gate", () => {
    const ungated = withoutGatedBlocks(source);
    const markers = [
      "TRAVEL_TEXTS.switchLabel",
      'for="f-travel-from"',
      'for="f-travel-to"',
      "TRAVEL_TEXTS.hint",
    ];
    for (const marker of markers) {
      expect(source, marker).toContain(marker);
      expect(ungated, marker).not.toContain(marker);
    }
    expect(ungated).not.toContain("travelRouteLabel(");
  });

  it("derives the dialog title of a trip from the gated form mode, never from a literal", () => {
    expect(source).toMatch(/travelMode === "travel"\s*\?\s*TRAVEL_TEXTS\.editTitle/);
    expect(source).not.toContain("Fahrzeit bearbeiten");
    expect(source).not.toContain("Fahrzeit zwischen Salons");
    expect(source).toMatch(
      /let travelMode = \$derived\(travelFormMode\(multiEntryUi, editEntry\)\)/,
    );
  });

  it("never names the entry kind field itself - every kind read goes through isTravelRow", () => {
    expect(source).not.toContain("activityKind");
    expect(source).toContain("isTravelRow(");
  });

  it("never lets the header salon selection decide the departure or the arrival salon", () => {
    expect(source).not.toContain("selectedSalonId");
    expect(source).not.toMatch(/\$salonContext\.selection/);
    expect(source).toMatch(/salonFieldOptions\(\$salonContext\.salons,/);
  });

  it("builds the travel request only through travelPayload", () => {
    expect(source).toMatch(/\.\.\.travelPayload\(|travelPayload\(\{/);
    expect(source).not.toMatch(/travelToSalonId:\s*formTravelTo/);
  });
});
