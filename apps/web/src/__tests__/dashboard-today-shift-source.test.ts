// Phase 267 (GitHub issue #267), Plan 04 — where the dashboard hero card gets "today's shift".
//
// The finding (D-04, reproduced on a live stack, not inferred): the card used to read
// `GET /shifts/week`, which returns the WHOLE TENANT's shifts ordered by `date` then `startTime`,
// and then took `shifts.filter(s => s.date.startsWith(today))[0]`. That expression selects the
// EARLIEST shift of the day in the tenant — not the caller's. A user whose own shift ran
// 14:00–18:00 was shown a colleague's 08:00–12:00 shift as hers. Present since Phase 49, and wrong
// for everyone whose shift is not the first of the day.
//
// `GET /shifts/my-week` has answered exactly this question since Phase 49: it returns `ownShifts`
// per day, already narrowed server-side to the caller. This file pins that the dashboard asks that
// endpoint and consumes that field.
//
// Why source-read and not mounted: apps/web/vitest.config.ts registers no `$app/*` alias, the page
// imports `$app/*`, and it is ~2900 lines that fire roughly twenty API calls in `onMount`. Same
// wall, and the same remedy, as leave-overlap-fallback.test.ts (Phase 262) documents.
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

/** Occurrences of `needle` in `haystack` — plain count, no regex escaping surprises. */
function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("Phase 267 — the dashboard reads its own shift, not the tenant's earliest", () => {
  // Test 0 — anti-vacuity (CLAUDE.md § Anti-vacuity gate). Every `not.toContain` below is
  // trivially true against an empty string, so a wrong path would turn this whole file into a
  // gate that passes while checking nothing. Prove the source is really loaded first.
  it("[vacuity gate] the dashboard source is actually loaded", () => {
    expect(DASHBOARD.length).toBeGreaterThan(50_000);
    expect(DASHBOARD).toContain("todayShift");
    expect(DASHBOARD).toContain("timer-shift-label");
  });

  it("asks GET /shifts/my-week for the hero card's shift", () => {
    expect(DASHBOARD).toContain("/shifts/my-week?date=");
  });

  // `"/shifts/my-week"` does not contain `"/shifts/week"`, so this count is unambiguous.
  it("no longer asks GET /shifts/week anywhere", () => {
    expect(countOf(DASHBOARD, "/shifts/week")).toBe(0);
  });

  // The selection must run over the list the SERVER already narrowed to the caller. A client-side
  // filter over a tenant-wide response was the bug itself, not an implementation detail of it.
  it("selects from ownShifts, not from a client-side filter over a tenant-wide list", () => {
    expect(DASHBOARD).toContain("ownShifts");
    expect(DASHBOARD).not.toContain("shiftData.shifts.filter");
  });

  // `/my-week` returns `templateName`/`templateColor` flat, not a nested `template` object, and
  // the markup never reads the field at all (it renders label/startTime/endTime only). A
  // declaration promising a shape the endpoint does not deliver is a trap for the next reader.
  it("declares no `template` field that /my-week never delivers and the markup never renders", () => {
    const start = DASHBOARD.indexOf("let todayShift");
    expect(start, "`let todayShift` declaration not found").toBeGreaterThan(-1);
    const end = DASHBOARD.indexOf("$state(null)", start);
    expect(end, "end of the todayShift declaration not found").toBeGreaterThan(start);
    const declaration = DASHBOARD.slice(start, end);

    expect(declaration).not.toContain("template");
    expect(countOf(DASHBOARD, "todayShift.template")).toBe(0);
  });
});
