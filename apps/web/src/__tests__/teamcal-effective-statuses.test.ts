// Issue #446 (D-04) — the Team-Kalender (/teamcal) loads and paints EFFECTIVE leave
// (APPROVED + CANCELLATION_REQUESTED), not APPROVED-only.
//
// Why source-read and not mounted: this page imports `$app/navigation` directly, and
// apps/web/vitest.config.ts registers no `$app/*` alias — the same wall
// dashboard-leave-type-code.test.ts (Phase 205) and leave-overlap-fallback.test.ts (Phase 262)
// document for their own pages. So its status source is pinned here in text instead of asserted
// at runtime.

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

const PAGE = readRouteFile(
  "../routes/(app)/teamcal/+page.svelte",
  "src/routes/(app)/teamcal/+page.svelte",
);

describe("Issue #446 (D-04) — /teamcal reads the effective leave statuses, not APPROVED-only", () => {
  it("[vacuity gate] the teamcal source is actually loaded and contains the month grid", () => {
    // Anti-vacuity: prove the RIGHT file is loaded, not just a non-empty one.
    expect(PAGE.length).toBeGreaterThan(1_000);
    expect(PAGE).toContain("gridCols");
  });

  it("imports and uses EFFECTIVE_LEAVE_STATUSES and isEffectiveLeaveStatus", () => {
    expect(PAGE).toContain("EFFECTIVE_LEAVE_STATUSES");
    expect(PAGE).toContain("isEffectiveLeaveStatus(r.status)");
  });

  it("no longer contains the old approved-only request URL", () => {
    expect(PAGE).not.toContain("status=APPROVED");
  });
});
