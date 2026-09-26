// Phase 76b (GitHub issue #76), Plan 03 — D-15: GET /dashboard/overtime-trend now requires
// overtime:read:ZUGEWIESEN (added server-side by this same phase). Every actor without that
// permission — a Mitarbeiter, a Salonmanager template, an Ausbilder template, … — now gets a
// 403 where it used to get 200. The web dashboard must degrade SILENTLY on that 403: no toast,
// no console.error, and no misleading all-zero "Überstunden-Trend" chart. `$stores/auth` carries
// only `role`, not a permission list, so the client cannot know in advance whether it holds
// overtime:read — it learns this from the response itself, per D-15's own "tolerate the 403"
// instruction.
//
// Why source-read and not mounted: apps/web/vitest.config.ts registers no `$app/*` alias, the
// page imports `$app/*`, and it is ~2900 lines that fire roughly twenty API calls in `onMount`.
// Same wall, and the same remedy, as dashboard-today-shift-source.test.ts (Phase 267) documents.
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

const TREND_FETCH_MARKER = 'api.get<OvertimeTrendResponse>("/dashboard/overtime-trend")';
/** The next line after the whole try/catch around the trend fetch, in source order. */
const AFTER_CATCH_MARKER = "labels = months.map";

describe("Phase 76b (Issue #76) — the dashboard hides the Überstunden-Trend card silently without overtime:read (D-15)", () => {
  // Test 0 — anti-vacuity (CLAUDE.md § Anti-vacuity gate). Every string-containment assertion
  // below is trivially true against an empty string, so a wrong path would turn this whole file
  // into a gate that passes while checking nothing. Prove the source is really loaded first.
  it("[vacuity gate] the dashboard source is actually loaded", () => {
    expect(DASHBOARD.length).toBeGreaterThan(50_000);
    expect(DASHBOARD).toContain("overtimeTrendAvailable");
    expect(DASHBOARD).toContain(TREND_FETCH_MARKER);
  });

  it("declares a component-level overtimeTrendAvailable state, starting false", () => {
    expect(DASHBOARD).toContain("let overtimeTrendAvailable = $state(false);");
  });

  it("imports ApiError from the api client", () => {
    expect(DASHBOARD).toContain('import { api, ApiError } from "$api/client";');
  });

  it("sets overtimeTrendAvailable true after a successful load and false in the catch", () => {
    const fetchIdx = DASHBOARD.indexOf(TREND_FETCH_MARKER);
    expect(fetchIdx, "overtime-trend fetch call not found").toBeGreaterThan(-1);
    const catchIdx = DASHBOARD.indexOf("} catch (err) {", fetchIdx);
    expect(catchIdx, "overtime-trend catch block not found").toBeGreaterThan(fetchIdx);
    const afterCatchIdx = DASHBOARD.indexOf(AFTER_CATCH_MARKER, catchIdx);
    expect(afterCatchIdx, "end of the try/catch block not found").toBeGreaterThan(catchIdx);

    const tryBlock = DASHBOARD.slice(fetchIdx, catchIdx);
    expect(tryBlock).toContain("overtimeTrendAvailable = true;");

    const catchBlock = DASHBOARD.slice(catchIdx, afterCatchIdx);
    expect(catchBlock).toContain("overtimeTrendAvailable = false;");
  });

  it("the trend's catch contains no toasts. call", () => {
    const fetchIdx = DASHBOARD.indexOf(TREND_FETCH_MARKER);
    const catchIdx = DASHBOARD.indexOf("} catch (err) {", fetchIdx);
    const afterCatchIdx = DASHBOARD.indexOf(AFTER_CATCH_MARKER, catchIdx);
    const catchBlock = DASHBOARD.slice(catchIdx, afterCatchIdx);

    expect(catchBlock).not.toContain("toasts.");
  });

  it("an ApiError with status 403 is not logged via console.error; every other failure still is", () => {
    const fetchIdx = DASHBOARD.indexOf(TREND_FETCH_MARKER);
    const catchIdx = DASHBOARD.indexOf("} catch (err) {", fetchIdx);
    const afterCatchIdx = DASHBOARD.indexOf(AFTER_CATCH_MARKER, catchIdx);
    const catchBlock = DASHBOARD.slice(catchIdx, afterCatchIdx);

    expect(catchBlock).toContain("err instanceof ApiError && err.status === 403");
    expect(catchBlock).toContain('console.error("Failed to load overtime trend:", err);');
  });

  it("the Überstunden-Trend card is rendered only while charts load or when the trend was successfully loaded", () => {
    const cardIdx = DASHBOARD.indexOf('title="Überstunden-Trend"');
    expect(cardIdx, "Überstunden-Trend card not found").toBeGreaterThan(-1);
    const guardIdx = DASHBOARD.lastIndexOf("{#if", cardIdx);
    expect(guardIdx, "no {#if guard found before the Überstunden-Trend card").toBeGreaterThan(-1);
    const guardLine = DASHBOARD.slice(guardIdx, cardIdx);

    expect(guardLine).toContain("chartsLoading || overtimeTrendAvailable");
  });
});
