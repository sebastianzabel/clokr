// Issue #613 (P-03, D-613-3) - the admin Monatsabschluss page shows "Austritt am ..." next to a
// person with an exit date. The route page is not mountable in the web test setup (no `$app`
// alias), so the wiring is pinned by source read; the formatting itself is unit-tested in
// `lib/month-close/__tests__/exit-label-613.test.ts`.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    try {
      return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
    } catch {
      throw new Error(`route file missing: ${relativeFromCwd} (page moved or renamed?)`);
    }
  }
}

const PAGE = readRouteFile(
  "../routes/(app)/admin/month-close/+page.svelte",
  "src/routes/(app)/admin/month-close/+page.svelte",
);

describe("/admin/month-close - exit date label (Issue #613)", () => {
  it("the page source is non-empty (the pins below are not vacuous)", () => {
    expect(PAGE.length).toBeGreaterThan(1000);
  });

  it("imports exitLabel from the lib module", () => {
    expect(PAGE).toMatch(
      /import \{[^}]*\bexitLabel\b[^}]*\} from "\$lib\/month-close\/exit-label"/,
    );
  });

  it("declares the additive exitDate on the status row", () => {
    expect(PAGE).toMatch(/exitDate\?: string \| null/);
  });

  it("renders the label of emp.exitDate in a gray badge, only when it is non-null", () => {
    expect(PAGE).toMatch(/exitLabel\(emp\.exitDate\)/);
    expect(PAGE).toMatch(/class="badge badge-gray"/);
  });
});
