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
    expect(DETAIL).toMatch(/\{tabs\}|tabs=\{tabs\}/);
    expect(DETAIL).not.toMatch(/tabs=\{TABS\}/);
  });

  it("uses the German label, the English two-word label is gone", () => {
    expect(DETAIL).not.toContain(["Danger", "Zone"].join(" "));
  });
});

const LIST = readRouteFile(
  "../routes/(app)/admin/employees/+page.svelte",
  "src/routes/(app)/admin/employees/+page.svelte",
);

describe("/admin/employees/[id] - employment on today's model (Issue #86, D-01)", () => {
  it("renders the read-only Vertragsverlauf from contractHistoryRows(contractHistory)", () => {
    expect(DETAIL).toMatch(
      /import \{[^}]*\bcontractHistoryRows\b[^}]*\} from "\$lib\/employees\/contract-history"/,
    );
    expect(DETAIL).toMatch(/title="Vertragsverlauf"/);
    expect(DETAIL).toMatch(/contractHistoryRows\(contractHistory\)/);
  });

  it("words the exit date as the end of the employment and says the access stays active", () => {
    expect(DETAIL).toContain("Austrittsdatum (optional)");
    expect(DETAIL).toMatch(/beendet\s+das\s+Beschäftigungsverhältnis/);
    expect(DETAIL).toMatch(/bleibt\s+mit\s+allen\s+Daten\s+sichtbar/);
    expect(DETAIL).toMatch(
      /Zugang\s+zur\s+App\s+bleibt\s+aktiv,\s+bis\s+er\s+gesondert\s+gesperrt\s+wird/,
    );
  });
});

describe("/admin/employees - employment state and filter (Issue #86, AC-86-6)", () => {
  it("shows the label from employmentState and never reads a display string", () => {
    expect(LIST).toMatch(
      /import \{[^}]*\bemploymentState\b[^}]*\} from "\$lib\/employees\/employment-state"/,
    );
    expect(LIST).toMatch(/employmentState\([^)]*exitDate/);
  });

  it("offers the Beschäftigung select with the four options and filters by kind only", () => {
    expect(LIST).toMatch(/aria-label="Nach Beschäftigung filtern"/);
    for (const label of [
      "Alle Beschäftigungen",
      "Beschäftigt",
      "Austritt geplant",
      "Ausgeschieden",
    ]) {
      expect(LIST, label).toContain(label);
    }
    expect(LIST).toMatch(/filterEmployment/);
    expect(LIST).toMatch(/employmentState\([^)]*\)\.kind/);
  });

  it("lists ended employees by default (the filter starts on Alle)", () => {
    expect(LIST).toMatch(/let filterEmployment = \$state<[^>]*>\(""\)/);
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
