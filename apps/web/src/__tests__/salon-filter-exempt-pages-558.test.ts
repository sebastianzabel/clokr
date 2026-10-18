// Issue #558 D-11/D-09 — pages that load people or leave and deliberately do NOT follow the
// header salon.
//
// These are configuration and mapping pickers: availability, company shutdowns and the Phorest
// staff mapping must offer every employee of the tenant, and the integrations page is tenant
// configuration. A header salon that silently hid people there would make a configuration
// incomplete. The pages stay unfiltered; this file pins that decision so a later change that wires
// the salon filter into one of them turns red and has to revisit the reason. Plans 558-03 and
// 558-05 extend the table with the pages they decide not to filter.
//
// Issue #542 adds a second table, `EXEMPT_BLOCKS`: the reports page DOES follow the header salon
// for three places, so it is not an exempt page, but its other blocks deliberately do not, and
// each is pinned here with its reason.
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

/**
 * Exempt page, its file (relative to `src/routes/`; `../lib/...` reaches a component), the request
 * text that proves the right file was read, and the reason it stays unfiltered.
 */
const EXEMPT_PAGES: ReadonlyArray<{
  page: string;
  file: string;
  loads: string;
  reason: string;
}> = [
  {
    page: "admin/availability",
    file: "(app)/admin/availability/+page.svelte",
    loads: "/employees",
    reason: "configuration picker: every employee must be selectable (D-11)",
  },
  {
    page: "admin/shutdowns",
    file: "(app)/admin/shutdowns/+page.svelte",
    loads: "/employees",
    reason: "configuration picker: a company shutdown applies to employees of every salon (D-11)",
  },
  {
    page: "admin/shutdowns/[id]",
    file: "(app)/admin/shutdowns/[id]/+page.svelte",
    loads: "/employees",
    reason: "configuration picker: exceptions may name any employee (D-11)",
  },
  {
    page: "admin/phorest",
    file: "(app)/admin/phorest/+page.svelte",
    loads: "/employees",
    reason: "mapping picker: the Phorest staff mapping needs every employee (D-11)",
  },
  {
    page: "admin/integrations",
    file: "(app)/admin/integrations/+page.svelte",
    loads: "/employees",
    reason: "tenant configuration, not a person view (D-11)",
  },
  {
    page: "inbox",
    file: "(app)/inbox/+page.svelte",
    loads: "/leave/requests",
    reason:
      "work queue: it must never hide a due approval, so it is unfiltered while Team-Anträge filter their queue with a visible label (D-09)",
  },
  {
    page: "LeaveReviewDialog",
    file: "../lib/components/leave/LeaveReviewDialog.svelte",
    loads: "/leave/overlap",
    reason:
      "decision support: the overlap check of an approval must see every colleague of the tenant, whatever salon the header shows (D-09)",
  },
  {
    page: "shifts/conflicts",
    file: "(app)/shifts/conflicts/+page.svelte",
    loads: "/shifts/conflicts",
    reason:
      "work queue whose buckets are tenant-only today (#645, D-15): a header salon would decorate an unscoped read and pretend a scope the server does not apply",
  },
  {
    page: "admin/shifts",
    file: "(app)/admin/shifts/+page.svelte",
    loads: "/shifts/coverage-rules",
    reason:
      "configuration of templates and coverage rules: the rules are tenant-wide (no salon column), so the page must not look filtered (D-15)",
  },
];

describe("Issue #558 D-11 — configuration pickers stay unfiltered", () => {
  it("[vacuity gate] the table names pages and every route file is read", () => {
    expect(EXEMPT_PAGES.length).toBeGreaterThanOrEqual(9);
  });

  for (const { page, file, loads, reason } of EXEMPT_PAGES) {
    it(`${page} loads ${loads} and never wires the salon filter (${reason})`, () => {
      const source = readRouteFile(`../routes/${file}`, `src/routes/${file}`);
      expect(source.length, `${file} is empty or missing`).toBeGreaterThan(1_000);
      expect(source).toContain(loads);
      expect(source).not.toContain("salonPageFilter");
      expect(source).not.toContain("withSalonId(");
      expect(source).not.toContain("SalonScopeLabel");
    });
  }
});

// ── Issue #542: blocks of the reports page that deliberately ignore the header salon ──────────────

const REPORTS_PAGE = readRouteFile(
  "../routes/(app)/reports/+page.svelte",
  "src/routes/(app)/reports/+page.svelte",
);

/** The body of `function <name>(` up to its closing brace at the top level of the script. */
function reportsFunctionBody(name: string): string {
  const start = REPORTS_PAGE.indexOf(`function ${name}(`);
  if (start === -1) return "";
  const end = REPORTS_PAGE.indexOf("\n  }\n", start);
  return end === -1 ? "" : REPORTS_PAGE.slice(start, end);
}

/** Block, the page function that loads it, the request it sends, and why it stays unfiltered. */
const EXEMPT_BLOCKS: ReadonlyArray<{
  block: string;
  fn: string;
  loads: string;
  reason: string;
}> = [
  {
    block: "DATEV download",
    fn: "downloadDatev",
    loads: "/reports/datev?month=",
    reason:
      "the payroll file must stay complete: a salon-narrowed DATEV would silently drop people from payroll (OD-2, § 41 EStG)",
  },
  {
    block: "per-person DATEV download",
    fn: "downloadEmployeeDatev",
    loads: "/reports/datev/employee",
    reason: "a document of one named person; the salon does not change what it contains",
  },
  {
    block: "per-person Stundennachweis",
    fn: "downloadEmployeePdf",
    loads: "/reports/monthly/pdf",
    reason: "a document of one named person; the salon does not change what it contains",
  },
  // Issue #612 (P-06): the vacation table (Urlaubsübersicht) and the Verfall column follow the
  // salon now - Stammsalon at the period end, whole personal values. They left this table; the
  // positive assertions are in "Issue #612 - the vacation tab follows the header salon" below.
];

describe("Issue #542 — blocks of Berichte that stay unfiltered", () => {
  it("[vacuity gate] the table names blocks and every function is found", () => {
    // Issue #612: the page shrank when the attendance list and the export cards moved out (measured
    // 47 618 bytes after 612-06); the floor keeps the check non-vacuous.
    expect(REPORTS_PAGE.length).toBeGreaterThan(30_000);
    expect(EXEMPT_BLOCKS.length).toBeGreaterThanOrEqual(3);
    for (const { fn } of EXEMPT_BLOCKS) {
      expect(reportsFunctionBody(fn).length, `function ${fn} not found`).toBeGreaterThan(100);
    }
  });

  for (const { block, fn, loads, reason } of EXEMPT_BLOCKS) {
    it(`${block} (${fn}) loads ${loads} and never sends the salon (${reason})`, () => {
      const body = reportsFunctionBody(fn);
      expect(body).toContain(loads);
      expect(body).not.toContain("withSalonId(");
      expect(body).not.toContain("pageSalonId");
    });
  }
});

// ── Issue #612 (P-06, orchestrator amendment 8): the vacation block follows the header salon ─────────
//
// Issue #612 (P-06): the vacation table follows the salon now - Stammsalon at the period end, whole
// personal values; resolves the #542 deferral. The two rows "Urlaubsübersicht" and "Verfall-Warnungen"
// above were REMOVED for that decided behaviour change (not a weakened assertion); the DATEV and
// person-document rows stay. What replaces them:

const VACATION_TAB = readRouteFile(
  "../lib/components/reports/VacationAbsenceTab.svelte",
  "src/lib/components/reports/VacationAbsenceTab.svelte",
);

describe("Issue #612 - the vacation tab follows the header salon", () => {
  it("[vacuity gate] the page and the component are loaded", () => {
    expect(REPORTS_PAGE.length).toBeGreaterThan(1_000);
    expect(VACATION_TAB.length).toBeGreaterThan(2_000);
  });

  it("the page asks for no separate vacation or carry-over read: they come with the period answer", () => {
    expect(REPORTS_PAGE).not.toContain("/reports/leave-overview");
    expect(REPORTS_PAGE).not.toContain("/reports/carryover-at-risk");
    expect(REPORTS_PAGE).not.toContain("loadLeaveOverview");
    expect(REPORTS_PAGE).not.toContain("loadCarryoverAtRisk");
  });

  it("the period request goes through the page filter (salonPageFilter -> periodReportPath)", () => {
    expect(REPORTS_PAGE).toContain("const pageSalonId = $derived(salonPageFilter($salonContext));");
    expect(reportsFunctionBody("loadPeriod")).toContain("periodReportPath(from, to, salon)");
    expect(REPORTS_PAGE).toMatch(
      /const salon = pageSalonId;\s+const wanted = canReportRead && periodTabActive;/,
    );
  });

  it("the vacation tab gets the filter flag and shows SALON_PERIOD_END_PERSONS_NOTE under it", () => {
    expect(REPORTS_PAGE).toMatch(/<VacationAbsenceTab[^>]*filterActive=\{pageSalonId !== null\}/s);
    expect(VACATION_TAB).toContain("{#if filterActive}");
    expect(VACATION_TAB).toContain("{SALON_PERIOD_END_PERSONS_NOTE}");
    expect(VACATION_TAB).toContain("{PERSON_VALUES_NOT_SPLIT_LABEL}");
  });

  it("the carry-over notice never sends the salon: it is a notice to one named person", () => {
    const body = reportsFunctionBody("sendCarryoverNotice");
    expect(body).toContain("/reports/carryover-warn");
    expect(body).not.toContain("withSalonId(");
    expect(body).not.toContain("pageSalonId");
  });
});
