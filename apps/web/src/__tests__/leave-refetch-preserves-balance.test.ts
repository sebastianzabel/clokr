// Issue #258 (hardening) — a failed REFETCH must not destroy an already-displayed KPI value.
//
// The shared create/edit dialog (`lib/components/leave/LeaveRequestForm.svelte`, Phase 415,
// #415) re-fetches its own balance box every time the selected type changes while it is open —
// the SAME `loadBalanceForType()` this test used to pin on `/leave`'s own page before the
// extraction. Both of that function's catch arms used to blank their state on a failed refetch,
// so ONE transient failure wiped a value the first, successful fetch of that type had already
// shown — and the box stayed empty until the dialog was closed and reopened. In a network trace
// that reads as "GET /leave/overtime-balance -> 200, box empty anyway" — the shape of the report
// in #258.
//
// Why source-read and not mounted: this file predates the component's own mounted test suite
// (`lib/components/leave/__tests__/LeaveRequestForm.test.ts`, Phase 415) and targets the same
// structural invariant that suite does not directly assert — WHICH assignments a catch arm is
// allowed to contain. Kept as source-read rather than folded into the mounted suite because the
// invariant is about source shape (an empty catch body vs. a guarded clear), not observable
// behaviour a render assertion can cheaply distinguish from "never failed at all".

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

const SHARED_FORM = readRouteFile(
  "../lib/components/leave/LeaveRequestForm.svelte",
  "src/lib/components/leave/LeaveRequestForm.svelte",
);

/** Body of `loadBalanceForType`, from its signature to the `scheduleOverlapLoad` that follows it
 *  in the shared component (Phase 415 — the order differs from the pre-extraction page, where
 *  `loadSpecialLeaveRules` followed it instead). */
function loadBalanceForTypeBody(): string {
  const start = SHARED_FORM.indexOf("async function loadBalanceForType(");
  const end = SHARED_FORM.indexOf("function scheduleOverlapLoad(", start);
  return SHARED_FORM.slice(start, end);
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

/** The six pieces of state the OVERTIME_COMP balance box renders from. `rosterIncomplete` was
 *  dropped from this list in Phase 415: the shared component never renders it (that field is
 *  read only by `/leave`'s own, page-owned KPI-strip card, which the dialog no longer feeds —
 *  see LeaveRequestForm.svelte's own doc comment on why the two are now independent reads). */
const OVERTIME_STATE = [
  "overtimeBalance",
  "confirmedMinutes",
  "openMonthMinutes",
  "hasClosedMonth",
  "maxNegativeBalanceMinutes",
  "isNegativeLimitExceeded",
];

describe("LeaveRequestForm.svelte — a failed refetch keeps the displayed balance (issue #258)", () => {
  // Anti-vacuity control. Every assertion below reads a slice of the component; if a rename or a
  // refactor moved the function, the slices would come back empty and the "contains no
  // assignment" checks would pass while checking nothing at all.
  it("the slices under test are actually found and non-empty", () => {
    const body = loadBalanceForTypeBody();
    expect(
      body.length,
      "loadBalanceForType body not located in the component source",
    ).toBeGreaterThan(200);
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

  it("the OVERTIME_COMP catch arm clears none of the box's state", () => {
    const arm = catchArmAfter(loadBalanceForTypeBody(), '"OVERTIME_COMP"');
    for (const name of OVERTIME_STATE) {
      expect(
        arm,
        `${name} is cleared when the refetch fails — a failed second call must not destroy the ` +
          `value already shown (issue #258)`,
      ).not.toMatch(new RegExp(`\\b${name}\\s*=`));
    }
  });

  it("the VACATION catch arm clears only when entitlementYear moved in flight (keeps issue #122 closed)", () => {
    const body = loadBalanceForTypeBody();
    const arm = catchArmAfter(body, '"VACATION"');
    // Phase 415: the shared component has no page-level `calYear` to capture before awaiting —
    // `year` is the function's own parameter (closure-captured at call time), compared against
    // the LIVE `entitlementYear` prop instead. Functionally identical guard, different variable.
    expect(arm, "vacationBalance is cleared unconditionally").not.toMatch(
      /^\s*vacationBalance\s*=\s*null\s*;/m,
    );
    expect(arm, "the clear is not guarded by the in-flight year comparison").toMatch(
      /if\s*\(\s*year\s*!==\s*entitlementYear\s*\)\s*vacationBalance\s*=\s*null\s*;/,
    );
  });
});
