// Phase 109 (Issue #35), Plan 01, Task 1 — Wave-0 regression net for
// `admin/system/+page.svelte` (3211 lines, zero prior test coverage).
//
// This is a source-read PIN, not a behaviour test: `apps/web/vitest.config.ts` has no
// `$app` alias, so a route page cannot be mounted (see `layout-boundaries.test.ts` for the
// established precedent of reading route source with `readFileSync` instead).
//
// The DO-NOT-TOUCH lists this file locks down come from `109-CONTEXT.md`:
// - D-03 / N-11: nine handlers already save instantly via `onchange=` and must stay that way.
// - D-07: security-relevant controls (password policy, session config incl. `rememberMeEnabled`,
//   SMTP) must stay button-gated (`onclick=`), regardless of how toggle-shaped they look.
// - D-01: the remaining genuine form groups stay button-gated.
// - AK-02 (D-02): text/number inputs must never write outside a button-gated group. Plan 109-03
//   removed the two former violations (`saveBreakDefaults`, `saveRetroEntryWindowDays`, both now
//   button-gated) — the census assertion below is the empty set.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

// fileURLToPath decodes the %28/%29 that the "(app)" route group produces in import.meta.url.
function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    // Fallback: `pnpm --filter @clokr/web test` runs with cwd `apps/web`.
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const PAGE = readRouteFile(
  "../routes/(app)/admin/system/+page.svelte",
  "src/routes/(app)/admin/system/+page.svelte",
);

// Brace/paren-depth fnBody() slicer (Phase 109, Plan 01's admin-employee-save-wiring.test.ts
// correction) rather than the naive two-space-indent heuristic from vacation-summary.test.ts:
// robust against a function whose own parameter type contains braces before the real body starts.
function fnBody(marker: string): string {
  const start = PAGE.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);

  let i = start;
  let parenDepth = 0;
  let bodyStart = -1;
  while (i < PAGE.length) {
    const ch = PAGE[i];
    if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth--;
    else if (ch === "{" && parenDepth === 0) {
      bodyStart = i;
      break;
    }
    i++;
  }
  expect(bodyStart, `function body opening brace not found for: ${marker}`).toBeGreaterThan(-1);

  let depth = 0;
  let j = bodyStart;
  for (; j < PAGE.length; j++) {
    if (PAGE[j] === "{") depth++;
    else if (PAGE[j] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  expect(j, `unterminated function: ${marker}`).toBeLessThan(PAGE.length);
  return PAGE.slice(bodyStart, j + 1);
}

describe("D-03/N-11 — the nine already-correct instant handlers stay instant", () => {
  const INSTANT_HANDLERS = [
    "saveAvailabilityEnabled",
    "saveVocationalSchoolAutoCleanupShifts",
    "saveHolidayDeduction",
    "saveDefaultBreakStart",
    "saveCloseMonthWithGaps",
    "toggleAutoBreak",
    "toggleEnforceBreakConfirmation",
    "toggleBlockMonthCloseOnUnconfirmedBreak",
    "toggleTwoFa",
  ] as const;

  it.each(INSTANT_HANDLERS)("%s is wired via onchange=, never onclick=", (name) => {
    expect(PAGE).toContain(`onchange={${name}}`);
    expect(PAGE).not.toContain(`onclick={${name}}`);
  });

  // N-11: toggleTwoFa is 2FA, textbook security-relevant, but D-07's enumeration does not
  // name it. Owner decision recorded in 109-CONTEXT.md: leave it as-is (status quo) unless
  // explicitly decided otherwise. This count pins that the list above is exactly the nine
  // handlers the research established — not four, not five, not ten.
  it("there are exactly nine already-correct instant handlers (D-03 correction, not five)", () => {
    expect(INSTANT_HANDLERS.length).toBe(9);
  });
});

describe("D-07 — security-relevant settings stay button-gated", () => {
  const BUTTON_ONLY_SECURITY = ["savePasswordPolicy", "saveSessionConfig", "saveSmtp"] as const;

  it.each(BUTTON_ONLY_SECURITY)("%s is wired via onclick=, never onchange=", (name) => {
    expect(PAGE).toContain(`onclick={${name}}`);
    expect(PAGE).not.toContain(`onchange={${name}}`);
  });

  it("rememberMeEnabled ('Angemeldet bleiben') is plain bind:checked, not converted", () => {
    // D-07 rationale: toggle-shaped, but part of the session-config form group, which the
    // owner explicitly kept security-relevant and button-gated.
    expect(PAGE).toContain("bind:checked={rememberMeEnabled}");
  });
});

describe("D-01 — genuine form groups stay button-gated", () => {
  const BUTTON_ONLY_GROUPS = [
    "saveStoreHours",
    "saveFederalState",
    "saveCoreDefaults",
    "saveBsSlots",
    // Pitfall 4: D-02 is a type-based carve-out for text/number inputs that overrides D-01's
    // atomic-value framing — a lone number field still belongs behind a button, so this stays
    // button-gated even though it could otherwise look like a single atomic value.
    "saveDefaultWorkDays",
  ] as const;

  it.each(BUTTON_ONLY_GROUPS)("%s is wired via onclick=, never onchange=", (name) => {
    expect(PAGE).toContain(`onclick={${name}}`);
    expect(PAGE).not.toContain(`onchange={${name}}`);
  });
});

describe("AK-02 — text/number inputs never write outside a button-gated group", () => {
  // Filtered to type="number" | type="text" and not "every input" on purpose:
  // `saveDefaultBreakStart` sits on a type="time" field that D-03 explicitly leaves instant,
  // and all nine instant handlers above are checkboxes — neither is a D-02 concern.
  function textOrNumberInputHandlers(source: string): string[] {
    const found: string[] = [];
    for (const tag of source.match(/<input\b[\s\S]*?>/g) ?? []) {
      const type = tag.match(/type="([a-z]+)"/)?.[1];
      if (type !== "number" && type !== "text") continue;
      for (const m of tag.matchAll(/on(?:blur|change|input)=\{(\w+)\}/g)) found.push(m[1]);
    }
    return found;
  }

  it("AK-02: no text/number input in admin/system carries an inline write handler", () => {
    expect(textOrNumberInputHandlers(PAGE)).toEqual([]);
  });

  it.each(["saveBreakDefaults", "saveRetroEntryWindowDays"])(
    "%s is button-gated, never onblur (D-02/N-01)",
    (name) => {
      expect(PAGE).toContain(`onclick={${name}}`);
      expect(PAGE).not.toContain(`onblur={${name}}`);
    },
  );
});

describe("D-01/AK-01 — the eight E-Mail-Benachrichtigungs-Toggles save instantly", () => {
  const EMAIL_FLAGS = [
    "emailNotificationsEnabled",
    "emailOnLeaveRequest",
    "emailOnLeaveDecision",
    "emailOnOvertimeWarning",
    "emailOnMissingEntries",
    "emailOnClockOutReminder",
    "emailOnMonthClose",
    "emailOnRetroEntry",
  ] as const;

  it.each(EMAIL_FLAGS)("%s is wired to toggleEmailFlag, not to a button", (flag) => {
    // Prettier wraps the multi-line arrow-function call, so `toggleEmailFlag(` and the flag
    // literal land on separate lines — match across whitespace rather than a single substring.
    expect(PAGE).toMatch(new RegExp(`toggleEmailFlag\\(\\s*"${flag}"`));
  });

  it("the section no longer has a save button", () => {
    expect(PAGE).not.toContain("saveEmailConfig");
  });

  it("AK-03: the catch branch reverts BEFORE it toasts (toggleWifi order)", () => {
    const body = fnBody("async function toggleEmailFlag");
    const iRevert = body.indexOf("emailFlags[flag] = previous");
    const iToast = body.indexOf("toasts.error");
    expect(iRevert).toBeGreaterThan(-1);
    expect(iToast).toBeGreaterThan(iRevert);
  });

  it("N-09: the payload is minimal — no _gOtherFields snapshot", () => {
    expect(fnBody("async function toggleEmailFlag")).not.toContain("_gOtherFields");
  });

  it("AK-05: success feedback is the existing toast store, no new status component", () => {
    expect(fnBody("async function toggleEmailFlag")).toContain("toasts.success");
  });
});
