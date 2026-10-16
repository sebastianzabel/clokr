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

  it("mounts the salon assignments section in the Salons tab with canEdit from employee:update", () => {
    expect(DETAIL).toMatch(
      /import SalonAssignmentsSection from "\$lib\/components\/employees\/SalonAssignmentsSection\.svelte"/,
    );
    expect(DETAIL).toMatch(/tab === "salons"/);
    expect(DETAIL).toMatch(
      /<SalonAssignmentsSection \{employeeId\} canEdit=\{rights\.canUpdate\} \/>/,
    );
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

const MONTH_CLOSE = readRouteFile(
  "../routes/(app)/admin/month-close/+page.svelte",
  "src/routes/(app)/admin/month-close/+page.svelte",
);
const TEAM_TIMES = readRouteFile(
  "../routes/(app)/team/time-entries/+page.svelte",
  "src/routes/(app)/team/time-entries/+page.svelte",
);

describe("/admin/month-close - withheld day lists render as counts (Issue #86, D-02)", () => {
  it("imports its date-list texts from lib/month-close/day-lists", () => {
    expect(MONTH_CLOSE).toMatch(/from "\$lib\/month-close\/day-lists"/);
    for (const fn of [
      "missingDaysText",
      "gapCountOf",
      "breakFindingHintFor",
      "karenzOverrunTitle",
    ]) {
      expect(MONTH_CLOSE, fn).toContain(fn);
    }
  });

  it("the deferred list prints the stored ISO dates (visual baseline 09)", () => {
    expect(MONTH_CLOSE).toMatch(/missingDaysText\(e, \{ iso: true \}\)/);
  });

  it("no render site formats a date list or reads an array length itself", () => {
    expect(MONTH_CLOSE).not.toMatch(/function formatMissing/);
    expect(MONTH_CLOSE).not.toMatch(/\.missingDates(\?)?\.length/);
    expect(MONTH_CLOSE).not.toMatch(/\.karenzOverrunDays(\?)?\.length/);
    expect(MONTH_CLOSE).not.toMatch(/gapDates\.join/);
    expect(MONTH_CLOSE).not.toMatch(/breakFindingMonthCloseHint\(/);
  });

  it("shows the one neutral hint when any row was withheld", () => {
    expect(MONTH_CLOSE).toMatch(/anyDayDetailsWithheld\(/);
    expect(MONTH_CLOSE).toContain("DAY_DETAILS_WITHHELD_HINT");
  });

  it("decides confirmGaps by the count, never by the array", () => {
    expect(MONTH_CLOSE).toMatch(/confirmGaps: gapCountOf\(emp\) > 0/);
    expect(MONTH_CLOSE).toMatch(/confirmGaps: pendingGapCount > 0/);
    expect(MONTH_CLOSE).not.toMatch(/confirmGaps: pendingGaps/);
  });
});

describe("/team/time-entries - guards itself by its own permission (Issue #86, AC-86-3)", () => {
  it("calls mayOpenTeamPage before its first api call and falls back to the leave page", () => {
    expect(TEAM_TIMES).toMatch(
      /import \{[^}]*\bmayOpenTeamPage\b[^}]*\} from "\$lib\/nav\/team-nav"/,
    );
    const guard = TEAM_TIMES.indexOf('mayOpenTeamPage("/team/time-entries"');
    expect(guard).toBeGreaterThan(-1);
    const onMount = TEAM_TIMES.indexOf("onMount(async () => {");
    expect(onMount).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(onMount);
    // no request between the start of onMount and the guard
    expect(TEAM_TIMES.slice(onMount, guard)).not.toMatch(/api\./);
    expect(TEAM_TIMES).toMatch(/mayOpenTeamPage\("\/team\/leave"/);
    expect(TEAM_TIMES).toContain('"/dashboard"');
  });
});

describe("/admin/employees - Stammsalon in the create form (Issue #86, AC-86-1)", () => {
  it("reads GET /salons only for a caller with salon:read", () => {
    expect(LIST).toMatch(/salonAdminRights\(\$authStore\.user\)\.canRead/);
    expect(LIST).toMatch(/if \(!canReadSalons\) \{\s*createSalons = null;\s*return;/);
    expect(LIST).toMatch(/api\.get<\{ salons: SalonRef\[\] \}>\("\/salons"\)/);
  });

  it("renders the field, blocks the submit while a required Stammsalon is missing and refreshes the list when the dialog opens", () => {
    expect(LIST).toMatch(/<HomeSalonField salons=\{createSalons\} bind:value=\{cHomeSalonId\} \/>/);
    expect(LIST).toMatch(/createBlockedByHomeSalon[\s\S]{0,160}offerHomeSalonChoice\(true,/);
    expect(LIST).toMatch(
      /disabled=\{creating \|\| createBlockedByUsualWorkDays \|\| createBlockedByHomeSalon\}/,
    );
    expect(LIST).toMatch(/cHomeSalonId = "";\s*void loadCreateSalons\(\);/);
  });

  it("sends homeSalonId only through homeSalonPayload and shows the server's German error", () => {
    expect(LIST).toMatch(/Object\.assign\(payload, homeSalonPayload\(cHomeSalonId\)\)/);
    expect(LIST).not.toMatch(/homeSalonId:/);
    expect(LIST).toMatch(/createError = e instanceof Error \? e\.message : "Fehler beim Anlegen"/);
    expect(LIST).toMatch(/\{#if createError\}\s*<div class="callout error">\{createError\}<\/div>/);
  });
});
