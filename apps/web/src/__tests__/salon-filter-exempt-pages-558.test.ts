// Issue #558 D-11 — pages that load `/employees` and deliberately do NOT follow the header salon.
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

/** Exempt page, its route file and the reason it stays unfiltered. */
const EXEMPT_PAGES: ReadonlyArray<{ page: string; file: string; reason: string }> = [
  {
    page: "admin/availability",
    file: "(app)/admin/availability/+page.svelte",
    reason: "configuration picker: every employee must be selectable (D-11)",
  },
  {
    page: "admin/shutdowns",
    file: "(app)/admin/shutdowns/+page.svelte",
    reason: "configuration picker: a company shutdown applies to employees of every salon (D-11)",
  },
  {
    page: "admin/shutdowns/[id]",
    file: "(app)/admin/shutdowns/[id]/+page.svelte",
    reason: "configuration picker: exceptions may name any employee (D-11)",
  },
  {
    page: "admin/phorest",
    file: "(app)/admin/phorest/+page.svelte",
    reason: "mapping picker: the Phorest staff mapping needs every employee (D-11)",
  },
  {
    page: "admin/integrations",
    file: "(app)/admin/integrations/+page.svelte",
    reason: "tenant configuration, not a person view (D-11)",
  },
];

describe("Issue #558 D-11 — configuration pickers stay unfiltered", () => {
  it("[vacuity gate] the table names pages and every route file is read", () => {
    expect(EXEMPT_PAGES.length).toBeGreaterThanOrEqual(5);
  });

  for (const { page, file, reason } of EXEMPT_PAGES) {
    it(`${page} loads /employees and never wires the salon filter (${reason})`, () => {
      const source = readRouteFile(`../routes/${file}`, `src/routes/${file}`);
      expect(source.length, `${file} is empty or missing`).toBeGreaterThan(1_000);
      expect(source).toContain("/employees");
      expect(source).not.toContain("salonPageFilter");
      expect(source).not.toContain("withSalonId(");
      expect(source).not.toContain("SalonScopeLabel");
    });
  }
});
