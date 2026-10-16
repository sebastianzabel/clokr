// Issue #86 (D-04, AC-86-3) - the employee pages for the Personalabteilung. The route pages are not
// mountable in the web test setup (no `$app` alias, see admin-employee-save-wiring.test.ts), so the
// wiring is pinned by source read; every decision itself is unit-tested in its `$lib` module.
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

const DETAIL = readRouteFile(
  "../routes/(app)/admin/employees/[id]/+page.svelte",
  "src/routes/(app)/admin/employees/[id]/+page.svelte",
);

describe("/admin/employees/[id] - tabs follow permissions (Issue #86, D-04)", () => {
  it("imports employeeDetailTabs and derives its tab list from it", () => {
    expect(DETAIL).toMatch(
      /import \{[^}]*\bemployeeDetailTabs\b[^}]*\} from "\$lib\/employees\/detail-tabs"/,
    );
    expect(DETAIL).toMatch(/\$derived\(employeeDetailTabs\(rights\)\)/);
    expect(DETAIL).not.toMatch(/const TABS = \[/);
  });

  it("restores the hash only for a tab of the derived list and hands that list to the layout", () => {
    expect(DETAIL).toMatch(/tabs\.some\(\(t\) => t\.id === hash\)/);
    expect(DETAIL).toMatch(/tabs=\{tabs\}/);
    expect(DETAIL).not.toMatch(/tabs=\{TABS\}/);
  });

  it("uses the German label, the English two-word label is gone", () => {
    expect(DETAIL).not.toContain(["Danger", "Zone"].join(" "));
  });
});

describe("/admin/employees/[id] - no day-level data (Issue #86, AC-86-3, T-86b-14)", () => {
  it("names no time-tracking or month-saldo request path", () => {
    for (const path of [
      "/time-entries",
      "/day-breaks",
      "/retro-entry-requests",
      "/overtime/month-saldo",
    ]) {
      expect(
        DETAIL.includes(`"${path}`) || DETAIL.includes(`\`${path}`) || DETAIL.includes(`'${path}`),
        path,
      ).toBe(false);
    }
  });
});
