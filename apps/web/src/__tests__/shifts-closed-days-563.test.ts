// Issue #563 (AC-563-2, AC-563-3, D-03, D-15) — source pins on the /shifts page: it takes its closed
// days from the week read through `closedDaysFor()`, never from the settings read, names the salon in
// the tooltip, shows the hint, and carries no trace of the retired tenant column. The page imports
// `$app/*` and cannot be mounted here, so the wiring is pinned in the source.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(resolve(HERE, "../routes/(app)/shifts/+page.svelte"), "utf8");

describe("Issue #563 — /shifts closed days per salon", () => {
  it("the page is non-empty and has its week read", () => {
    expect(PAGE.length).toBeGreaterThan(1000);
    expect(PAGE).toContain("/shifts/week?date=");
  });

  it("imports closedDaysFor and the salon context and derives the view from the week field", () => {
    expect(PAGE).toMatch(/import \{[^}]*closedDaysFor[^}]*\} from "\$lib\/shifts\/closed-days"/);
    expect(PAGE).toMatch(/import \{[^}]*salonContext[^}]*\} from "\$stores\/salon-context"/);
    expect(PAGE).toMatch(/closedDaysFor\(\s*week\?\.salonOpeningHours,\s*\$salonContext\s*\)/);
  });

  it("no longer requests /settings/work", () => {
    expect(PAGE).not.toContain("/settings/work");
  });

  it("the closed cell's title names the salon; the hint is rendered", () => {
    expect(PAGE).toMatch(/title=\{`\$\{closedView\.salonName[^`]*ist an diesem Tag geschlossen`\}/);
    expect(PAGE).toContain("closedView.hint");
  });

  it("carries no trace of the retired column, comments included", () => {
    expect(PAGE).not.toMatch(/\bstoreHours\b/);
  });

  it("the selection never filters shifts or employees", () => {
    expect(PAGE).not.toMatch(/selectedSalonId/);
    expect(PAGE).not.toMatch(/\$salonContext\.selection/);
  });
});
