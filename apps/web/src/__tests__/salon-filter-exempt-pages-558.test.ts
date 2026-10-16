// Issue #558 D-11/D-09 — pages that load people or leave and deliberately do NOT follow the
// header salon.
//
// These are configuration and mapping pickers: availability, company shutdowns and the Phorest
// staff mapping must offer every employee of the tenant, and the integrations page is tenant
// configuration. A header salon that silently hid people there would make a configuration
// incomplete. The pages stay unfiltered; this file pins that decision so a later change that wires
// the salon filter into one of them turns red and has to revisit the reason. Plans 558-03 and
// 558-05 extend the table with the pages they decide not to filter.
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
];

describe("Issue #558 D-11 — configuration pickers stay unfiltered", () => {
  it("[vacuity gate] the table names pages and every route file is read", () => {
    expect(EXEMPT_PAGES.length).toBeGreaterThanOrEqual(7);
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
