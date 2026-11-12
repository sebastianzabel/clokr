// Issue #840 G-3, G-8 - source pins of the inbox chrome: the header follows the leave pages'
// PageHead pattern and the type chip of a leave row is the one LeaveTypeChip (colour from the
// mapping, never the brand colour). The #558 constraints of this exempt page are re-asserted.
//
// Source-read for the same reason as `inbox-section9-840.test.ts`: the page imports `$app/*`,
// mounts several dialogs and fires its requests on mount. The chip itself is proven mounted in
// `lib/components/leave/__tests__/LeaveTypeChip.test.ts`, the colours in the browser by
// `apps/e2e/tests/leave-area-840.spec.ts` (test 7).

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

const INBOX = readRouteFile(
  "../routes/(app)/inbox/+page.svelte",
  "src/routes/(app)/inbox/+page.svelte",
);
// Issue #853 (D-853-06): the leave row is the TaskRow wrapper; the chip rule lives in its source.
const TASK_ROW = readRouteFile(
  "../lib/components/team/aufgaben/TaskRow.svelte",
  "src/lib/components/team/aufgaben/TaskRow.svelte",
);

describe("Issue #840 G-8 / G-3 - the inbox chrome", () => {
  it("[vacuity gate] the page source is loaded and is the inbox", () => {
    expect(INBOX.length).toBeGreaterThan(20_000);
    expect(INBOX).toContain("<TaskRow");
    expect(INBOX).toContain("<List ");
    expect(TASK_ROW.length).toBeGreaterThan(500);
  });

  it("[G-8] the header is the leave pages' PageHead: plain title „Aufgaben“ from page-labels.ts (Issue #574), no eyebrow and no accent (#853 D-853-19)", () => {
    expect(INBOX).toMatch(/<PageHead\s+title=\{pageLabel\("\/inbox"\)\}/);
    expect(INBOX).not.toMatch(/<PageHead[^>]*eyebrow=/);
    expect(INBOX).not.toMatch(/<PageHead[^>]*accent=/);
  });

  it("[G-3] the type chip of a leave row is LeaveTypeChip, dashed for a PENDING request", () => {
    expect(TASK_ROW).toContain(
      'import LeaveTypeChip from "$lib/components/leave/LeaveTypeChip.svelte"',
    );
    expect(TASK_ROW).toContain("<LeaveTypeChip");
    expect(TASK_ROW).toContain("code={row.typeCode}");
    expect(TASK_ROW).toContain("label={typeLabel ?? row.typeCode}");
    expect(TASK_ROW).toContain('requested={row.status === "PENDING"}');
    // The page hands the row the label of the existing type rule, never the code or the brand colour.
    expect(INBOX).toContain("typeLabel={row.typeCode ? typeName(row.typeCode) : undefined}");
    expect(INBOX).not.toMatch(/chip-brand">\{typeName\(/);
  });

  it("[#853 D-853-18] the old structure is gone: no KPI cards, no tab strip, one KpiStrip band", () => {
    expect(INBOX).not.toContain("KPIStat");
    expect(INBOX).not.toContain("kpi-row");
    expect(INBOX.split("<KpiStrip").length - 1).toBe(1);
  });

  it("[#558] the inbox stays an unfiltered work queue: no salon filter identifier, not even in a comment", () => {
    expect(INBOX).not.toContain("salonPageFilter");
    expect(INBOX).not.toContain("withSalonId(");
    expect(INBOX).not.toContain("SalonScopeLabel");
  });
});
