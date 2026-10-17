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
  {
    block: "Urlaubsübersicht",
    fn: "loadLeaveOverview",
    loads: "/reports/leave-overview",
    reason:
      "not one of the four places of #542; it follows the salon with #612, until then the block says it covers every salon of the reach",
  },
  {
    block: "Verfall-Warnungen",
    fn: "loadCarryoverAtRisk",
    loads: "/reports/carryover-at-risk",
    reason:
      "not one of the four places of #542; it follows the salon with #612, until then the block says it covers every salon of the reach",
  },
];

describe("Issue #542 — blocks of Berichte that stay unfiltered", () => {
  it("[vacuity gate] the table names blocks and every function is found", () => {
    expect(REPORTS_PAGE.length).toBeGreaterThan(60_000);
    expect(EXEMPT_BLOCKS.length).toBeGreaterThanOrEqual(5);
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
