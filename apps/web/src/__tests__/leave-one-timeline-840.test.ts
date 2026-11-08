// Issue #840 (plan 840-12; E-01, D-840-07, AC-6, T-840-41) - there is ONE person-by-day absence
// timeline in the web. The team calendar page and the planner's own timeline are gone, the one
// component `AbsenceTimeline` is mounted by the Team Übersicht, the Mein Bereich Team tab and the
// `LeavePlanningPanel` (which both hosts mount), the lane and column helpers of `lib/leave-plan/
// timeline.ts` are imported only by the component, and no other file builds an absence lane grid.
//
// Source walk, like `leave-days-label-guard-595.test.ts`: the pages are not mountable (no `$app`
// alias in `apps/web/vitest.config.ts`). Walks `.svelte` and `.ts` under `apps/web/src`, excluding
// `__tests__`. The first test is the anti-vacuity gate (the apps/api `lint-guard-vacuity` rule): a
// moved or emptied directory turns the guard red instead of letting it report success on nothing.
//
// Mutation proof (Phase 840-12, `cp` backup/restore) - recorded here, not re-run by CI
//   M1 a `<AbsenceTimeline` added to routes/(app)/dashboard/+page.svelte -> red: "[mount sites] ..."
//   M2 a `buildLaneMap(` added to lib/leave/timeline-model.ts             -> red: "[no second lane grid] ..."

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

function srcRoot(): string {
  try {
    return resolve(fileURLToPath(new URL("..", import.meta.url)));
  } catch {
    return resolve(process.cwd(), "src");
  }
}

const SRC_ROOT = srcRoot();

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      out.push(...walk(full));
    } else if (name.endsWith(".svelte") || name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const FILES = walk(SRC_ROOT);

function rel(file: string): string {
  return relative(SRC_ROOT, file).split("\\").join("/");
}

function source(relativePath: string): string {
  return readFileSync(join(SRC_ROOT, relativePath), "utf8");
}

/** The files (relative to src) whose text matches `pattern`, sorted. */
function filesMatching(pattern: RegExp): string[] {
  return FILES.filter((f) => pattern.test(readFileSync(f, "utf8")))
    .map(rel)
    .sort((a, b) => a.localeCompare(b));
}

const TEAM_HOST = "routes/(app)/team/leave/+page.svelte";
const MY_HOST = "routes/(app)/leave/+page.svelte";
const PANEL = "lib/components/leave/LeavePlanningPanel.svelte";
const TIMELINE = "lib/components/leave/timeline/AbsenceTimeline.svelte";

describe("Issue #840 AC-6 - one absence timeline", () => {
  it("[vacuity gate] walks a real source tree that contains the timeline component and its hosts", () => {
    expect(FILES.length).toBeGreaterThan(100);
    const walked = FILES.map(rel);
    for (const must of [TIMELINE, TEAM_HOST, MY_HOST, PANEL, "lib/leave-plan/timeline.ts"]) {
      expect(walked, must).toContain(must);
    }
  });

  it("[gone] the team calendar page and the planner's own timeline do not exist any more", () => {
    expect(existsSync(join(SRC_ROOT, "routes/(app)/teamcal/+page.svelte"))).toBe(false);
    expect(existsSync(join(SRC_ROOT, "lib/components/leave/LeavePlanTimeline.svelte"))).toBe(false);
    // The redirect that replaced the page is a load-only route.
    expect(existsSync(join(SRC_ROOT, "routes/(app)/teamcal/+page.ts"))).toBe(true);
    // No source names the deleted component any more (a comment would hide a live import).
    expect(filesMatching(/\bLeavePlanTimeline\b/)).toEqual([]);
  });

  it("[mount sites] <AbsenceTimeline appears only in the Team Übersicht, the Mein Bereich Team tab and the planning panel", () => {
    expect(filesMatching(/<AbsenceTimeline\b/)).toEqual([MY_HOST, PANEL, TEAM_HOST].sort());
  });

  it("[mount sites] both hosts mount the planning panel, so the planner is the same timeline on both", () => {
    for (const host of [TEAM_HOST, MY_HOST]) {
      expect(source(host), host).toContain("<LeavePlanningPanel");
    }
    expect(source(PANEL)).toContain("<AbsenceTimeline");
    // The panel is the only component that mounts the planner timeline; no other component does.
    expect(filesMatching(/<LeavePlanningPanel\b/)).toEqual([MY_HOST, TEAM_HOST].sort());
  });

  it("[helpers] the lane and column helpers of lib/leave-plan/timeline are imported only by the model and the component", () => {
    const allowed = new Set([
      "lib/leave/timeline-model.ts",
      TIMELINE,
      // The module itself and its siblings in the same directory (relative `./timeline`).
      ...FILES.map(rel).filter((f) => f.startsWith("lib/leave-plan/")),
    ]);
    const importers = filesMatching(/from\s+["'](?:[^"']*\/leave-plan\/timeline|\.\/timeline)["']/);
    // Anti-vacuity: the component really imports it, otherwise this test checks nothing.
    expect(importers).toContain(TIMELINE);
    const offenders = importers.filter((f) => !allowed.has(f));
    expect(offenders).toEqual([]);
  });

  it("[no second lane grid] no file outside the allow-list builds an absence lane grid", () => {
    // Where the lane builders legitimately appear: the helper itself, the one component, and the
    // documented out-of-scope grid below.
    const allowed = new Set([
      "lib/leave-plan/timeline.ts",
      TIMELINE,
      // Out of scope, named with the reason (see OUT_OF_SCOPE): the own month calendar of Mein Bereich.
      MY_HOST,
    ]);
    const builders = filesMatching(/\b(?:buildLaneMap|assignLanes)\(/);
    expect(builders).toContain(TIMELINE);
    expect(builders.filter((f) => !allowed.has(f))).toEqual([]);
  });

  it("[out of scope] the grids that are not an absence timeline exist, are named with their reason, and mount no timeline", () => {
    // Each entry is a surface that draws a grid but not the person-by-day absence timeline of AC-6.
    const OUT_OF_SCOPE: Array<{ file: string; reason: string }> = [
      {
        file: "routes/(app)/shifts/+page.svelte",
        reason: "Schichtplan week grid (Schichtplanung): shifts, not absences",
      },
      {
        file: "routes/(app)/dashboard/+page.svelte",
        reason:
          "dashboard team-week (Zeiterfassung presence status, #587): a day status, not leave bars",
      },
      {
        file: "routes/(app)/time-entries/+page.svelte",
        reason: "time-entry month calendar of ONE person (Zeiterfassung)",
      },
      {
        file: "routes/(app)/team/time-entries/+page.svelte",
        reason: "time-entry month calendar of ONE person (Zeiterfassung)",
      },
      {
        file: MY_HOST,
        reason:
          "Kalender tab: the own month calendar, own absences only (scope=own), drag-select creates a request (D-840-16, E-03); a single-person month grid, not the person-by-day timeline. Its Team tab uses the one timeline",
      },
    ];
    const walked = new Set(FILES.map(rel));
    for (const { file, reason } of OUT_OF_SCOPE) {
      expect(walked.has(file), `${file} (${reason})`).toBe(true);
      if (file !== MY_HOST) {
        expect(source(file), file).not.toContain("<AbsenceTimeline");
      }
    }
    // The own calendar is the only out-of-scope surface that builds absence lanes (see above).
    expect(source(MY_HOST)).toContain("buildLaneMap(");
    expect(source(MY_HOST)).toContain("scope=own");
  });
});
