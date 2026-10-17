// Issue #617 (AC-617-2) - the page's vacation column labels must never silently drift from the
// Monatsexport's. The web tree cannot import API code (`apps/web/Dockerfile`'s `test ! -e
// /app/packages/db` gate), so this test reads the API source as TEXT and regex-extracts the quoted
// members, the pattern of `lib/leave/__tests__/effective-leave-statuses.test.ts`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { VACATION_YEAR_COLUMNS } from "../vacation-columns";

function readFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const API_SOURCE = readFile(
  "../../../../../api/src/composition/pdf.ts",
  "../api/src/composition/pdf.ts",
);
const PAGE = readFile(
  "../../../routes/(app)/reports/+page.svelte",
  "src/routes/(app)/reports/+page.svelte",
);

function apiLabels(): string[] {
  const match = API_SOURCE.match(/VACATION_YEAR_COLUMN_LABELS\s*=\s*\[([\s\S]*?)\]/);
  expect(match).not.toBeNull();
  return match![1].match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)) ?? [];
}

describe("VACATION_YEAR_COLUMNS mirrors the Monatsexport labels (Issue #617)", () => {
  it("[vacuity gate] the API source is loaded and declares the constant with seven labels", () => {
    expect(API_SOURCE.length).toBeGreaterThan(0);
    expect(API_SOURCE).toContain("VACATION_YEAR_COLUMN_LABELS");
    expect(apiLabels()).toHaveLength(7);
  });

  it("the web labels equal the API labels, in the same order", () => {
    expect([...VACATION_YEAR_COLUMNS]).toEqual(apiLabels());
  });

  it("names Resturlaub last and never the word Rest or Geplant", () => {
    expect(VACATION_YEAR_COLUMNS[VACATION_YEAR_COLUMNS.length - 1]).toBe("Resturlaub");
    expect([...VACATION_YEAR_COLUMNS]).not.toContain("Rest");
    expect([...VACATION_YEAR_COLUMNS]).not.toContain("Geplant");
  });
});

describe("the Urlaubsuebersicht on /reports uses the shared labels", () => {
  it("[vacuity gate] the page source is loaded", () => {
    expect(PAGE.length).toBeGreaterThan(0);
    expect(PAGE).toContain("leave-overview-table");
  });

  it("imports VACATION_YEAR_COLUMNS and renders the headers from it", () => {
    expect(PAGE).toContain("VACATION_YEAR_COLUMNS");
    expect(PAGE).toMatch(
      /import \{ VACATION_YEAR_COLUMNS \} from "\$lib\/reports\/vacation-columns"/,
    );
    expect(PAGE).toMatch(/\{#each VACATION_YEAR_COLUMNS as/);
  });

  it("no longer has the Rest column, the Geplant column or the Urlaubsart column", () => {
    expect(PAGE).not.toContain('<th class="numeric">Rest</th>');
    expect(PAGE).not.toContain('<th class="numeric">Geplant</th>');
    expect(PAGE).not.toContain("<th>Urlaubsart</th>");
  });

  it("keeps the pinned Uebertrag cell expression verbatim", () => {
    expect(PAGE).toContain("formatDays(row.carriedOverEffectiveDays ?? row.carriedOverDays)");
  });
});
