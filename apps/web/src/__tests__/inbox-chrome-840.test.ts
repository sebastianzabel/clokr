// Issue #840 G-3, G-8 - source pins of the inbox chrome: the header follows the leave pages'
// PageHead pattern and (since #853-19) the type of a leave row is a plain Chip, not the dashed
// LeaveTypeChip of #840 G-3. The #558 constraints of this exempt page are re-asserted.
//
// Source-read for the same reason as `inbox-section9-840.test.ts`: the page imports `$app/*`,
// mounts several dialogs and fires its requests on mount. The row chip is proven mounted in
// `lib/components/team/aufgaben/__tests__/TaskRow.test.ts`, the look in the browser by
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
// Issue #853 (D-853-06): the kind helper that gates the Nachtrag segment.
const TASK_MODEL = readRouteFile("../lib/team/task-model.ts", "src/lib/team/task-model.ts");

describe("Issue #840 G-8 / G-3 - the inbox chrome", () => {
  it("[vacuity gate] the page source is loaded and is the inbox", () => {
    expect(INBOX.length).toBeGreaterThan(20_000);
    expect(INBOX).toContain("<TaskRow");
    expect(INBOX).toContain("<List ");
    expect(TASK_ROW.length).toBeGreaterThan(500);
    expect(TASK_MODEL.length).toBeGreaterThan(500);
  });

  it("[G-8] the header is the leave pages' PageHead: plain title „Aufgaben“ from page-labels.ts (Issue #574), no eyebrow and no accent (#853 D-853-19)", () => {
    expect(INBOX).toMatch(/<PageHead\s+title=\{pageLabel\("\/inbox"\)\}/);
    expect(INBOX).not.toMatch(/<PageHead[^>]*eyebrow=/);
    expect(INBOX).not.toMatch(/<PageHead[^>]*accent=/);
  });

  it("[G-3, #853-19] the type chip of a leave row is a plain Chip: no LeaveTypeChip, no dashed border, the label comes from the type rule", () => {
    // #853-19 (prototype „Aufgaben“): the dashed LeaveTypeChip of #840 G-3 is replaced by the normal
    // Chip - the waiting state is said by the status chip and the list itself, not by a dashed border.
    expect(TASK_ROW).not.toContain("LeaveTypeChip");
    expect(TASK_ROW).not.toContain("requested=");
    expect(TASK_ROW).not.toContain("dashed");
    expect(TASK_ROW).toContain('{#if row.kind === "urlaub" && row.typeCode}');
    expect(TASK_ROW).toContain('<Chip tone="neutral">{typeLabel ?? row.typeCode}</Chip>');
    // The page hands the row the label of the existing type rule, never the code or the brand colour.
    expect(INBOX).toContain("typeLabel={row.typeCode ? typeName(row.typeCode) : undefined}");
    expect(INBOX).not.toMatch(/chip-brand">\{typeName\(/);
  });

  it("[#853 D-853-18] the old structure is gone: no KPI cards, no tab strip, one KpiStrip band", () => {
    expect(INBOX).not.toContain("KPIStat");
    expect(INBOX).not.toContain("kpi-row");
    expect(INBOX.split("<KpiStrip").length - 1).toBe(1);
  });

  it("[#853 D-853-06] one list, a type segment and an „Offen · Entschieden“ segment, no tab strip", () => {
    expect(INBOX).not.toContain("view-tab");
    expect(INBOX.split("<List ").length - 1).toBe(1);
    expect(INBOX).toContain('name="aufgaben-typ"');
    expect(INBOX).toContain('name="aufgaben-ansicht"');
    // The leave and the Zeitnachtrag rows share the list; both open the existing dialogs.
    expect(INBOX).toContain("openDetail(request)");
    expect(INBOX).toContain("openRetroDetail(retro)");
    // The type control is offered only when there is a choice, and only for kinds the caller can decide.
    expect(INBOX).toContain("{#if availableKinds.length > 1}");
    // The Nachtrag kind exists only for a caller who may decide Zeitnachträge: the page hands
    // `canRetro` (retro-request:approve) to the kind helper, which adds "nachtrag" only then.
    expect(INBOX).toContain("retro: canRetro,");
    expect(INBOX).toContain('["retro-request:approve:ZUGEWIESEN"]');
    expect(TASK_MODEL).toContain('if (input.retro) kinds.push("nachtrag");');
  });

  it("[#853 D-853-08] the review dialog receives the fact permissions from the caller's held keys", () => {
    expect(INBOX).toContain('"leave-entitlement:read:ZUGEWIESEN"');
    expect(INBOX).toContain('"shift:read:ZUGEWIESEN"');
    expect(INBOX).toContain('"employee:read:ZUGEWIESEN"');
    expect(INBOX.split("canReadEntitlement=").length - 1).toBe(1);
    expect(INBOX).not.toMatch(/user\??\.role\b/);
  });

  it("[#558] the inbox stays an unfiltered work queue: no salon filter identifier, not even in a comment", () => {
    expect(INBOX).not.toContain("salonPageFilter");
    expect(INBOX).not.toContain("withSalonId(");
    expect(INBOX).not.toContain("SalonScopeLabel");
  });
});
