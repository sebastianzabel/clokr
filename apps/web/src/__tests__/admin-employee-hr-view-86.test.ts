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

// Since Issue #854 (plan 854-20) the Person tab is a component of its own.
const PERSON_TAB = readRouteFile(
  "../lib/components/employees/detail/PersonTab.svelte",
  "src/lib/components/employees/detail/PersonTab.svelte",
);

// Plan 854-21: the contract half of the Vertrag tab (form, timeline, Nachtrag) is a component too.
const VERTRAG_TAB = readRouteFile(
  "../lib/components/employees/detail/VertragTab.svelte",
  "src/lib/components/employees/detail/VertragTab.svelte",
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
    // #854: the hash is read by the one allow-list rule against the VISIBLE ids (aliases map the
    // former ids onto them), and the layout gets exactly the derived list.
    expect(DETAIL).toMatch(
      /tabFromHash\(\s*\$page\.url\.hash,\s*tabs\.map\(\(t\) => t\.id\),\s*DETAIL_TAB_ALIASES,?\s*\)/,
    );
    expect(DETAIL).toMatch(/tabs=\{tabs\.map\(/);
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
// Since Issue #854 the create form is the guided dialog; the page only mounts it.
const CREATE_DIALOG = readRouteFile(
  "../lib/components/employees/CreatePersonDialog.svelte",
  "src/lib/components/employees/CreatePersonDialog.svelte",
);
const CREATE_MODEL = readRouteFile(
  "../lib/employees/create-person.ts",
  "src/lib/employees/create-person.ts",
);

describe("/admin/employees/[id] - employment on today's model (Issue #86, D-01)", () => {
  it("renders the read-only Vertragsverlauf from contractHistoryRows(history)", () => {
    expect(VERTRAG_TAB).toMatch(
      /import \{[^}]*\bcontractHistoryRows\b[^}]*\} from "\$lib\/employees\/contract-history"/,
    );
    expect(VERTRAG_TAB).toMatch(/title="Vertragsverlauf"|>Vertragsverlauf</);
    expect(VERTRAG_TAB).toMatch(/contractHistoryRows\(history\)/);
    // The e2e hook of the timeline survives, and the page mounts the tab instead of owning a history.
    expect(VERTRAG_TAB).toContain('data-testid="contract-history"');
    expect(DETAIL).toContain("<VertragTab");
    expect(DETAIL).not.toContain("contractHistoryRows");
  });

  it("words the exit date as the end of the employment and says the access stays active", () => {
    expect(PERSON_TAB).toContain('label="Austrittsdatum"');
    expect(PERSON_TAB).toMatch(/Optional\.\s+Bei\s+gesetztem\s+Datum/);
    expect(PERSON_TAB).toMatch(/beendet\s+das\s+Beschäftigungsverhältnis/);
    expect(PERSON_TAB).toMatch(/bleibt\s+mit\s+allen\s+Daten\s+sichtbar/);
    expect(PERSON_TAB).toMatch(
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

  it("offers the Beschäftigung filter with the three kinds and filters by kind only", () => {
    // #854: the filter is a group of the toolbar popover („Alle“ is the toolbar's own option).
    expect(LIST).toMatch(/key: "employment",\s*label: "Beschäftigung"/);
    for (const label of ["Beschäftigt", "Austritt geplant", "Ausgeschieden"]) {
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

// #854 (plan 854-26): the page and its MonthStatusTable together are the month close's render and
// write sites; the pins below judge their joined source.
const MONTH_CLOSE =
  readRouteFile(
    "../routes/(app)/admin/month-close/+page.svelte",
    "src/routes/(app)/admin/month-close/+page.svelte",
  ) +
  readRouteFile(
    "../lib/components/admin/monatsabschluss/MonthStatusTable.svelte",
    "src/lib/components/admin/monatsabschluss/MonthStatusTable.svelte",
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
    expect(MONTH_CLOSE).toMatch(/missingDaysText\(e,\s*\{\s*iso: true/);
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
    // #844: the fallback is the team absences under their new URL, else the person's start page
    expect(TEAM_TIMES).toContain('"/team/abwesenheiten"');
    expect(TEAM_TIMES).toContain("homeHref($authStore.user)");
  });
});

describe("/admin/employees - Stammsalon in the create form (Issue #86, AC-86-1)", () => {
  it("[vacuity gate] the page mounts the dialog and the dialog source is loaded", () => {
    expect(LIST).toContain("<CreatePersonDialog");
    expect(CREATE_DIALOG.length).toBeGreaterThan(8_000);
    expect(CREATE_MODEL.length).toBeGreaterThan(3_000);
  });

  it("reads GET /salons only for a caller with salon:read", () => {
    expect(CREATE_DIALOG).toMatch(/salonAdminRights\(\$authStore\.user\)\.canRead/);
    expect(CREATE_DIALOG).toMatch(/if \(!canReadSalons\) \{\s*salons = null;\s*return;/);
    expect(CREATE_DIALOG).toMatch(/api\.get<\{ salons: SalonRef\[\] \}>\("\/salons"\)/);
  });

  it("renders the field, requires a Stammsalon before the step is left and re-reads the list whenever the dialog opens", () => {
    expect(CREATE_DIALOG).toMatch(
      /<HomeSalonField \{salons\} bind:value=\{draft\.homeSalonId\} error=\{errors\.homeSalonId\} \/>/,
    );
    expect(CREATE_DIALOG).toMatch(
      /homeSalonRequired:\s*salons !== null && offerHomeSalonChoice\(true,/,
    );
    expect(CREATE_MODEL).toMatch(/ctx\.homeSalonRequired && draft\.homeSalonId === ""/);
    expect(CREATE_DIALOG).toMatch(/untrack\(reset\)/);
    expect(CREATE_DIALOG).toMatch(/void loadSalons\(\);/);
  });

  it("sends homeSalonId only through homeSalonPayload and shows the server's German error", () => {
    expect(CREATE_MODEL).toMatch(
      /Object\.assign\(payload, homeSalonPayload\(draft\.homeSalonId\)\)/,
    );
    // the body builder never spells the key itself (the draft field of the same name is not the body)
    expect(
      CREATE_MODEL.slice(CREATE_MODEL.indexOf("export function employeeCreatePayload")),
    ).not.toMatch(/homeSalonId:/);
    expect(CREATE_DIALOG).toMatch(
      /submitError = e instanceof Error \? e\.message : "Fehler beim Anlegen"/,
    );
    expect(CREATE_DIALOG).toMatch(
      /\{#if submitError\}\s*<div role="alert"><Note tone="bad">\{submitError\}<\/Note><\/div>/,
    );
  });
});
