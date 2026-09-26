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

const VACATION_CARD_MARKER = 'label="Urlaubstage"';
const OVERTIME_NULL_GUARD = "{#if stats.overtime === null}";
const VACATION_GUARD = "{#if stats.vacation}";

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

  it("the Urlaubstage KPIStat is wrapped in an {#if stats.vacation} guard", () => {
    const guardIdx = DASHBOARD.indexOf(VACATION_GUARD);
    expect(guardIdx, "no {#if stats.vacation} guard found").toBeGreaterThan(-1);
    const cardIdx = DASHBOARD.indexOf(VACATION_CARD_MARKER, guardIdx);
    expect(cardIdx, "Urlaubstage card not found after the guard").toBeGreaterThan(guardIdx);
    // The guard's own {/if} must close before the next sibling card starts, i.e. the card sits
    // directly inside the guard, not merely somewhere later in the file.
    const closeIdx = DASHBOARD.indexOf("{/if}", cardIdx);
    expect(closeIdx, "no {/if} closing the vacation guard").toBeGreaterThan(cardIdx);
  });

  it("the Überstundenkonto tile renders nothing when stats.overtime is null, before the isExempt/split branches", () => {
    const nullGuardIdx = DASHBOARD.indexOf(OVERTIME_NULL_GUARD);
    expect(nullGuardIdx, "no {#if stats.overtime === null} guard found").toBeGreaterThan(-1);

    const exemptBranchIdx = DASHBOARD.indexOf("{:else if isExempt}", nullGuardIdx);
    expect(
      exemptBranchIdx,
      "isExempt branch not found after the null guard — the null check must come first",
    ).toBeGreaterThan(nullGuardIdx);

    const splitBranchIdx = DASHBOARD.indexOf(
      "{:else if stats.overtime.confirmedMinutes !== undefined}",
      exemptBranchIdx,
    );
    expect(splitBranchIdx, "confirmedMinutes branch not found").toBeGreaterThan(exemptBranchIdx);

    // Nothing rendered between the null-guard and the next branch — the null case is the
    // "intentionally empty" comment only, never a KPIStat/SaldoAnzeige.
    const nullBranchBody = DASHBOARD.slice(
      nullGuardIdx + OVERTIME_NULL_GUARD.length,
      exemptBranchIdx,
    );
    expect(nullBranchBody).not.toContain("<KPIStat");
    expect(nullBranchBody).not.toContain("<SaldoAnzeige");
  });
});
