// Issue #258 (hardening) — a failed REFETCH must not destroy an already-displayed KPI value.
//
// `/leave` fills both balance tiles in onMount (the overtime loader and the year-scoped
// vacation-summary loader) and then refetches through `loadBalanceForType()` every time the
// request form opens. Both of that function's catch arms used to blank their state, so ONE
// transient failure of the SECOND call wiped a value the first had fetched correctly, and the
// tile stayed empty until a full page reload. In a network trace that reads as
// "GET /leave/overtime-balance -> 200, tile empty anyway" — the shape of the report in #258.
//
// Why source-read and not mounted: apps/web/vitest.config.ts registers no `$app/*` alias and the
// page imports `$app/stores`, so it cannot be mounted here — the same wall
// leave-overlap-fallback.test.ts (Phase 262) and team-leave-type-visibility.test.ts (Phase 257)
// document. The invariant is structural anyway: it is about which assignments a catch arm is
// allowed to contain.

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

const LEAVE_PAGE = readRouteFile(
  "../routes/(app)/leave/+page.svelte",
  "src/routes/(app)/leave/+page.svelte",
);

/** Body of `loadBalanceForType`, from its signature to the `loadSpecialLeaveRules` that follows. */
function loadBalanceForTypeBody(): string {
  const start = LEAVE_PAGE.indexOf("async function loadBalanceForType(");
  const end = LEAVE_PAGE.indexOf("async function loadSpecialLeaveRules(", start);
  return LEAVE_PAGE.slice(start, end);
}

/** The `catch { ... }` block that follows `marker` inside `body`. */
function catchArmAfter(body: string, marker: string): string {
  const from = body.indexOf(marker);
  const catchStart = body.indexOf("} catch {", from);
  const open = body.indexOf("{", catchStart + 1);
  let depth = 0;
  for (let i = open; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") {
      depth--;
      if (depth === 0) return body.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced catch block after ${marker}`);
}

/** The seven pieces of state the Überstundenkonto tile renders from. */
const OVERTIME_STATE = [
  "overtimeBalance",
  "confirmedMinutes",
  "openMonthMinutes",
  "hasClosedMonth",
  "rosterIncomplete",
  "maxNegativeBalanceMinutes",
  "isNegativeLimitExceeded",
];

describe("/leave — a failed refetch keeps the displayed balance (issue #258)", () => {
  // Anti-vacuity control. Every assertion below reads a slice of the page; if a rename or a
  // refactor moved the function, the slices would come back empty and the "contains no
  // assignment" checks would pass while checking nothing at all.
  it("the slices under test are actually found and non-empty", () => {
    const body = loadBalanceForTypeBody();
    expect(body.length, "loadBalanceForType body not located in the page source").toBeGreaterThan(
      200,
    );
    expect(body).toContain('if (type === "OVERTIME_COMP")');
    expect(body).toContain('} else if (type === "VACATION")');
    // Both arms still HAVE a catch — the hardening must not have deleted error handling.
    expect(catchArmAfter(body, '"OVERTIME_COMP"').length).toBeGreaterThan(0);
    expect(catchArmAfter(body, '"VACATION"').length).toBeGreaterThan(0);
    // The success paths still assign — proving the state names below are the real ones and
    // this test would notice if they were renamed out from under it.
    for (const name of OVERTIME_STATE) {
      expect(body, `${name} is no longer written on the success path`).toContain(`${name} = r.`);
    }
  });

  it("the OVERTIME_COMP catch arm clears none of the tile's state", () => {
    const arm = catchArmAfter(loadBalanceForTypeBody(), '"OVERTIME_COMP"');
    for (const name of OVERTIME_STATE) {
      expect(
        arm,
        `${name} is cleared when the refetch fails — a failed second call must not destroy the ` +
          `value onMount already fetched (issue #258)`,
      ).not.toMatch(new RegExp(`\\b${name}\\s*=`));
    }
  });

  it("the VACATION catch arm clears only when the year moved in flight (keeps issue #122 closed)", () => {
    const body = loadBalanceForTypeBody();
    const arm = catchArmAfter(body, '"VACATION"');
    // It captures the year BEFORE awaiting — without that there is nothing to compare against.
    expect(body, "calYear is not captured before the await").toMatch(
      /const\s+yearAtRequest\s*=\s*calYear\s*;/,
    );
    // And the only clear is guarded by that comparison.
    expect(arm, "vacationBalance is cleared unconditionally").not.toMatch(
      /^\s*vacationBalance\s*=\s*null\s*;/m,
    );
    expect(arm, "the clear is not guarded by the in-flight year comparison").toMatch(
      /if\s*\(\s*yearAtRequest\s*!==\s*calYear\s*\)\s*vacationBalance\s*=\s*null\s*;/,
    );
  });
});
