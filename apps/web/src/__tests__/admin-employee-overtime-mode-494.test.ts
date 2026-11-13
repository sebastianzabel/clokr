// Issue #494 R5 — source pins for the "Überstunden-Modus" lock on admin/employees/[id].
//
// The route page cannot be mounted in vitest (no `$app/navigation` alias), so these are source
// pins; the component itself is proven by a mounted test. Every absence check first asserts that
// its surrounding marker is present (anti-vacuity), so a moved line turns the pin red.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

// fileURLToPath decodes the %28/%29 that the "(app)" route group produces in import.meta.url.
function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

// Since Issue #854 (plan 854-21) the contract form lives in the Vertrag tab component and its model.
const DETAIL = readRouteFile(
  "../lib/components/employees/detail/VertragTab.svelte",
  "src/lib/components/employees/detail/VertragTab.svelte",
);
const MODEL = readRouteFile(
  "../lib/employees/vertrag-form.ts",
  "src/lib/employees/vertrag-form.ts",
);
const PAGE = readRouteFile(
  "../routes/(app)/admin/employees/[id]/+page.svelte",
  "src/routes/(app)/admin/employees/[id]/+page.svelte",
);

describe("Überstunden-Modus lock on admin/employees/[id] (Issue #494 R5)", () => {
  it("imports and renders OvertimeModeField with type, monthly hours and the stored mode", () => {
    expect(DETAIL).toContain(
      'import OvertimeModeField from "$lib/components/schedule/OvertimeModeField.svelte";',
    );
    const start = DETAIL.indexOf("<OvertimeModeField");
    expect(start, "component usage not found").toBeGreaterThan(-1);
    const usage = DETAIL.slice(start, DETAIL.indexOf("/>", start));
    expect(usage).toContain("type={values.type}");
    expect(usage).toContain("monthlyHours={values.monthlyHours}");
    expect(usage).toContain("value={values.overtimeMode}");
  });

  it("no longer owns the select itself", () => {
    expect(DETAIL).toContain('label="Stunden pro Monat"'); // marker: the neighbouring field is still there
    expect(DETAIL).not.toContain('<select id="e-overtime-mode"');
    expect(DETAIL).not.toContain("bind:value={values.overtimeMode}");
    // The page holds no overtime-mode state any more.
    expect(PAGE).not.toContain("eOvertimeMode");
  });

  it("sends the stored mode unchanged (payload line verbatim)", () => {
    expect(MODEL).toContain(
      'overtimeMode: values.type === "MONTHLY_HOURS" ? values.overtimeMode : "CARRY_FORWARD",',
    );
  });

  it("never assigns TRACK_ONLY to the overtime mode (the lock is display only)", () => {
    expect(MODEL).toContain("overtimeMode: s?.overtimeMode ??"); // marker: the load assignment
    expect(DETAIL).not.toMatch(/overtimeMode\s*=\s*"TRACK_ONLY"/);
    expect(MODEL).not.toMatch(/overtimeMode\s*[=:]\s*"TRACK_ONLY"/);
  });

  it("does not duplicate the hint sentence (single source: work-schedule.ts)", () => {
    expect(DETAIL).toContain("OvertimeModeField");
    expect(DETAIL).not.toContain("nur erfasst, nicht übertragen");
  });
});
