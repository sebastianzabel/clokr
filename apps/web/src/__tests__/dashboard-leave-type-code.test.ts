// Phase 205 (GitHub issue #205), Plan 03 — finding 3, web half.
//
// The finding: the dashboard team grid picked its absence icon by comparing `day.reason` — for an
// APPROVED LeaveRequest this is the tenant-editable `LeaveType.name`, so a tenant renaming a leave
// type silently lost the medical/heart/users icon and fell through to the generic umbrella. This
// file proves the branch chain now compares the stable `leaveTypeCode`/`absenceType` fields
// (apps/api/src/composition/dashboard.ts's additive /team-week response) instead of `day.reason`.
//
// This is a STATIC proof only: it asserts the literal `day.reason === "<German literal>"`
// comparisons are gone and the `day.leaveTypeCode`/`day.absenceType` comparisons are present. The
// BEHAVIOURAL half of AK-3 (does the API actually return a rename-stable code?) is
// apps/api/src/composition/__tests__/dashboard.test.ts's "dashboard /team-week
// leaveTypeCode/absenceType (Issue #205, finding 3)" describe block, committed in the same plan.
//
// Why source-read and not mounted: apps/web/vitest.config.ts registers no `$app/*` alias, and this
// page imports `$app/*` directly — same wall, same remedy, as
// dashboard-today-shift-source.test.ts (Phase 267) and leave-overlap-fallback.test.ts (Phase 262)
// document.

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

const DASHBOARD = readRouteFile(
  "../routes/(app)/dashboard/+page.svelte",
  "src/routes/(app)/dashboard/+page.svelte",
);

describe("Phase 205 — the dashboard team grid branches on stable leave-type codes, not day.reason", () => {
  // Anti-vacuity gate (CLAUDE.md § Anti-vacuity gate): every `not.toContain` below is trivially
  // true against an empty string, so a wrong path or a moved/emptied file would turn this whole
  // test into a gate that passes while checking nothing. Prove the RIGHT source is really loaded
  // first — `team-grid__cell` anchors this specifically to the team grid markup, not just any
  // non-empty file.
  it("[vacuity gate] the dashboard source is actually loaded and contains the team grid", () => {
    expect(DASHBOARD.length).toBeGreaterThan(0);
    expect(DASHBOARD).toContain("team-grid__cell");
  });

  it("no longer compares day.reason against any of the four renamable German literals", () => {
    expect(DASHBOARD).not.toContain('day.reason === "Krankmeldung"');
    expect(DASHBOARD).not.toContain('day.reason === "Kinderkrank"');
    expect(DASHBOARD).not.toContain('day.reason === "Mutterschutz"');
    expect(DASHBOARD).not.toContain('day.reason === "Elternzeit"');
    expect(DASHBOARD).not.toContain('day.reason === "Berufsschule"');
  });

  it("branches on day.leaveTypeCode / day.absenceType for the four renamable types", () => {
    expect(DASHBOARD).toContain('day.leaveTypeCode === "SICK"');
    expect(DASHBOARD).toContain('day.leaveTypeCode === "SICK_CHILD"');
    expect(DASHBOARD).toContain('day.leaveTypeCode === "MATERNITY"');
    expect(DASHBOARD).toContain('day.leaveTypeCode === "PARENTAL"');
  });

  // Declared scope extension (see this plan's SUMMARY): the two `day.reason === "Berufsschule"`
  // comparisons (the `cell-badge--bs` class binding and the graduation-cap branch) are also
  // converted, even though `VOCATIONAL_SCHOOL`/Berufsschule was never one of the guard's four
  // tracked literals — leaving it on `reason` would mix two identity models in one `{#if}` chain,
  // and DISPLAY_NAME's own docblock marks it "DISPLAY TEXT ONLY … never compare against a value
  // here".
  it("branches on day.absenceType === 'VOCATIONAL_SCHOOL' for the Berufsschule badge/icon (declared scope extension)", () => {
    expect(DASHBOARD).toContain('day.absenceType === "VOCATIONAL_SCHOOL"');
  });
});
