// Phase 76b (GitHub issue #76), code review CR-01/WR-01 — GET /dashboard/ now returns
// `overtime: null` / `vacation: null` when the caller holds no overtime:read:EIGENE /
// leave-entitlement:read:EIGENE permission (a bare Salonmanager or Ausbilder template holder,
// D-05/D-08, without the optional Mitarbeiter role). The web dashboard must hide the
// corresponding KPI card silently in that case — no error, no toast, no fabricated zero-value
// card — mirroring the sibling degrade test for the Überstunden-Trend chart
// (dashboard-overtime-trend-degrade.test.ts, D-15).
//
// Why source-read and not mounted: same wall as dashboard-overtime-trend-degrade.test.ts —
// apps/web/vitest.config.ts registers no `$app/*` alias, and the page is ~2900 lines firing
// roughly twenty API calls in `onMount`.
//
// `lint:ui-classes` does not scan `routes/**`. This file is the only automated net for this path.

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

// Issue #845: the cards are cells of the Mein-Tag KpiStrip, built in the `kpiItems` derivation.
const VACATION_CARD_MARKER = 'label: "Resturlaub"';
const OVERTIME_NULL_GUARD = "if (stats && stats.overtime === null) {";
const VACATION_GUARD = "if (stats?.vacation) {";

describe("Phase 76b (Issue #76), CR-01/WR-01 — the dashboard hides saldo/vacation cards silently without EIGENE permission", () => {
  // Test 0 — anti-vacuity (CLAUDE.md § Anti-vacuity gate). Every string-containment assertion
  // below is trivially true against an empty string, so a wrong path would turn this whole file
  // into a gate that passes while checking nothing. Prove the source is really loaded first.
  it("[vacuity gate] the dashboard source is actually loaded", () => {
    expect(DASHBOARD.length).toBeGreaterThan(50_000);
    expect(DASHBOARD).toContain(VACATION_CARD_MARKER);
    expect(DASHBOARD).toContain(OVERTIME_NULL_GUARD);
  });

  it("the DashboardStats type declares overtime and vacation as nullable (CR-01/WR-01)", () => {
    expect(DASHBOARD).toMatch(/}\s*\|\s*null;\s*\n\s*vacation:.*\|\s*null;/s);
  });

  it("the Resturlaub cell is pushed only inside an `if (stats?.vacation)` guard", () => {
    const guardIdx = DASHBOARD.indexOf(VACATION_GUARD);
    expect(guardIdx, "no {#if stats.vacation} guard found").toBeGreaterThan(-1);
    const cardIdx = DASHBOARD.indexOf(VACATION_CARD_MARKER, guardIdx);
    expect(cardIdx, "Urlaubstage card not found after the guard").toBeGreaterThan(guardIdx);
    // The cell sits directly inside the guard: no other block opens between guard and cell, and
    // no Resturlaub cell exists anywhere outside it.
    const between = DASHBOARD.slice(guardIdx + VACATION_GUARD.length, cardIdx);
    expect(between).not.toContain("}");
    expect(DASHBOARD.indexOf(VACATION_CARD_MARKER)).toBe(cardIdx);
  });

  it("the Überstundenkonto tile renders nothing when stats.overtime is null, before the isExempt/split branches", () => {
    const nullGuardIdx = DASHBOARD.indexOf(OVERTIME_NULL_GUARD);
    expect(nullGuardIdx, "no {#if stats.overtime === null} guard found").toBeGreaterThan(-1);

    const exemptBranchIdx = DASHBOARD.indexOf("} else if (isExempt) {", nullGuardIdx);
    expect(
      exemptBranchIdx,
      "isExempt branch not found after the null guard — the null check must come first",
    ).toBeGreaterThan(nullGuardIdx);

    const splitBranchIdx = DASHBOARD.indexOf("} else if (ownOvertime) {", exemptBranchIdx);
    expect(splitBranchIdx, "confirmedMinutes branch not found").toBeGreaterThan(exemptBranchIdx);

    // Nothing pushed between the null-guard and the next branch — the null case is the
    // "intentionally empty" comment only, never a cell.
    const nullBranchBody = DASHBOARD.slice(
      nullGuardIdx + OVERTIME_NULL_GUARD.length,
      exemptBranchIdx,
    );
    expect(nullBranchBody).not.toContain("items.push");
    expect(nullBranchBody).toContain("intentionally empty");
    // And no saldo work for that caller: GET /overtime/:id is only requested when overtime is readable.
    expect(DASHBOARD).toMatch(
      /stats !== null && \(stats as DashboardStats\)\.overtime !== null\s*\?\s*api\.get<OvertimeAnswer>/,
    );
  });
});
