// Phase 109 (Issue #35), Plan 01, Task 1 — Wave-0 regression net for
// `admin/system/+page.svelte` (3211 lines, zero prior test coverage).
//
// This is a source-read PIN, not a behaviour test: `apps/web/vitest.config.ts` has no
// `$app` alias, so a route page cannot be mounted (see `layout-boundaries.test.ts` for the
// established precedent of reading route source with `readFileSync` instead).
//
// The DO-NOT-TOUCH lists this file locks down come from `109-CONTEXT.md`:
// - D-03 / N-11: nine handlers save instantly via `onchange=` and must stay that way. NOTE: this
//   file originally called all nine "already correct". For the eight checkbox ones that was
//   FALSE and the pin cemented the defect — see the WR-02 describe block below for the
//   corrected contract (rollback + loud failure), which the review reproduced live.
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

describe("D-03/N-11 — the nine instant handlers stay instant", () => {
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
  it("there are exactly nine instant handlers (D-03 correction, not five)", () => {
    expect(INSTANT_HANDLERS.length).toBe(9);
  });
});

// WR-02 — CORRECTION of this file's original claim.
//
// Plan 109-01 pinned the nine handlers above as "already correct". For the eight CHECKBOX ones
// that assertion was FALSE, and pinning it cemented the defect. They were wired one-way
// (`checked={state}`) with a pessimistic handler that wrote the state only on success. Nothing
// bounced back on failure: the browser had already flipped the DOM checkbox, the state never
// changed, so Svelte's template effect never re-ran — and `set_checked` early-returns when the
// new value equals the LAST APPLIED one, without ever reading `element.checked`.
//
// Reproduced live (109-BROWSER-UAT.md): with the API stopped, flipping "Pausen automatisch
// abziehen" left the checkbox `checked: true`, emitted no error, while `autoBreakEnabled` in the
// DB stayed `f`. Only a full reload corrected the display.
//
// `saveDefaultBreakStart` is excluded: it sits on a `type="time"` input, not a checkbox, so the
// DOM/state divergence described above does not apply to it.
describe("WR-02 — the eight instant checkbox toggles roll back and report on failure", () => {
  /** handler → the state variable it owns */
  const TOGGLES: Record<string, string> = {
    saveHolidayDeduction: "monthlyHoursHolidayDeduction",
    saveAvailabilityEnabled: "availabilityEnabled",
    saveVocationalSchoolAutoCleanupShifts: "vocationalSchoolAutoCleanupShifts",
    saveCloseMonthWithGaps: "closeMonthWithGapsAllowed",
    toggleAutoBreak: "autoBreakEnabled",
    toggleEnforceBreakConfirmation: "enforceBreakConfirmation",
    toggleBlockMonthCloseOnUnconfirmedBreak: "blockMonthCloseOnUnconfirmedBreak",
    toggleTwoFa: "twoFaEnabled",
  };
  const ENTRIES = Object.entries(TOGGLES);

  it("there are exactly eight of them (saveDefaultBreakStart is a time input, not a checkbox)", () => {
    expect(ENTRIES.length).toBe(8);
  });

  // This is the assertion that would have FAILED against the old source: every one of these
  // eight carried `checked={state}` and none carried `bind:checked={state}`.
  it.each(ENTRIES)("%s's checkbox uses bind:checked, not one-way checked=", (_handler, state) => {
    expect(PAGE).toContain(`bind:checked={${state}}`);
    // Lookbehind so the `checked={x}` inside `bind:checked={x}` does not match itself.
    expect(PAGE).not.toMatch(new RegExp(`(?<!bind:)checked=\\{${state}\\}`));
  });

  it.each(ENTRIES)("%s captures the pre-flip value as `previous`", (handler, state) => {
    expect(fnBody(`async function ${handler}`)).toContain(`const previous = !${state};`);
  });

  it.each(ENTRIES)("%s reverts the state on failure", (handler, state) => {
    const body = fnBody(`async function ${handler}`);
    const iCatch = body.indexOf("} catch");
    expect(iCatch).toBeGreaterThan(-1);
    // The revert must be in the catch, not merely somewhere in the function.
    expect(body.slice(iCatch)).toContain(`${state} = previous;`);
  });

  it.each(ENTRIES)("%s fails loudly — no bare catch {}", (handler) => {
    const body = fnBody(`async function ${handler}`);
    const tail = body.slice(body.indexOf("} catch"));
    // Either a toast or the section's own rendered inline error banner.
    expect(tail).toMatch(/toasts\.error\(|\w*Error = /);
  });

  // The old shape is what made the failure silent: assign the new value only after the await.
  // If `newValue` comes back, the pessimistic pattern has come back with it.
  it.each(ENTRIES)("%s no longer uses the pessimistic newValue shape", (handler) => {
    expect(fnBody(`async function ${handler}`)).not.toContain("const newValue =");
  });

  // Every early `return` guard bails BEFORE the try, so it too has to undo the browser's flip —
  // otherwise the checkbox stays flipped with no request and no message at all.
  it.each(ENTRIES)("%s reverts on every early-return guard as well", (handler, state) => {
    const body = fnBody(`async function ${handler}`);
    const guards = [...body.matchAll(/if \([^)]*\) \{([\s\S]*?)\n {4}\}/g)];
    for (const [, block] of guards) {
      if (!block.includes("return;")) continue;
      expect(block).toContain(`${state} = previous;`);
    }
  });

  it("the compliance-weighted three are covered by name (2FA, Monatsabschluss, § 4 ArbZG)", () => {
    expect(Object.keys(TOGGLES)).toEqual(
      expect.arrayContaining(["toggleTwoFa", "saveCloseMonthWithGaps", "toggleAutoBreak"]),
    );
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

  // WR-03: the markup binds one-way, so the state revert only reaches the DOM if Svelte flushes
  // between the optimistic write and the revert. Today the awaited fetch guarantees that task
  // boundary, but a pre-flight throw / cached response / sync guard ahead of the await would put
  // both writes in one batch — Svelte would see `previous → previous` and set_checked would
  // early-return, leaving the browser's own flip on screen. Writing el.checked removes the
  // dependency entirely.
  it("WR-03: the rollback writes the DOM directly, not only the state", () => {
    const body = fnBody("async function toggleEmailFlag");
    expect(body).toContain("if (el) el.checked = previous;");
  });

  it("WR-03: the handler accepts the element and every call site passes it", () => {
    expect(PAGE).toContain(
      "async function toggleEmailFlag(flag: EmailFlag, next: boolean, el?: HTMLInputElement)",
    );
    // One element argument per flag — all eight toggles, none left on the flush-dependent path.
    expect((PAGE.match(/^\s*ev\.currentTarget as HTMLInputElement,$/gm) ?? []).length).toBe(8);
  });

  it("AK-05: success feedback is the existing toast store, no new status component", () => {
    expect(fnBody("async function toggleEmailFlag")).toContain("toasts.success");
  });
});

describe("D-11/D-12 — unsaved markers on admin/system", () => {
  const SECTIONS = [
    "companyDirty",
    "storeHoursDirty",
    "coreDefaultsDirty",
    "breakDefaultsDirty",
    "retroWindowDirty",
    "bsSlotDirty",
    "sessionDirty",
    "pwDirty",
    "smtpDirty",
    "workDaysDirty",
  ] as const;

  it.each(SECTIONS)("%s is derived, not hand-set", (name) => {
    expect(PAGE).toContain(`let ${name} = $derived(`);
  });

  it("every button-gated Section receives a dirty prop", () => {
    expect((PAGE.match(/dirty=\{/g) ?? []).length).toBe(9);
  });

  it("the page registers itself under one id and de-registers on unmount", () => {
    expect(PAGE).toContain('markUnsaved("admin-system", snapshotsReady && anyUnsaved)');
    expect(PAGE).toContain('return () => markUnsaved("admin-system", false)');
  });

  // WR-01: every snapshot starts as "" and only gets its baseline at the end of onMount's try,
  // so every *Dirty flag reads true until then. A non-401 load failure (the first statement of
  // onMount is `await api.get("/settings/work")`) jumps to the catch and never reaches that
  // block — leaving the guard armed forever on a page that renders only an error banner.
  it("WR-01: registration is gated on snapshotsReady, never the bare anyUnsaved", () => {
    expect(PAGE).not.toContain('markUnsaved("admin-system", anyUnsaved)');
    expect(PAGE).toContain("let snapshotsReady = $state(false)");
  });

  it("WR-01: snapshotsReady is set only after the last baseline snapshot, inside the try", () => {
    const iWorkDays = PAGE.indexOf("workDaysSnapshot = snap(defaultWorkDays)");
    const iReady = PAGE.indexOf("snapshotsReady = true");
    const iCatch = PAGE.indexOf('error = e instanceof Error ? e.message : "Fehler beim Laden"');
    expect(iWorkDays).toBeGreaterThan(-1);
    // After the last snapshot assignment...
    expect(iReady).toBeGreaterThan(iWorkDays);
    // ...and before the catch, i.e. still inside the try that a load failure short-circuits.
    expect(iReady).toBeLessThan(iCatch);
  });

  it("T-109-22: the SMTP snapshot records password PRESENCE, never the password", () => {
    const line = PAGE.split("\n").find((l) => l.includes("smtpPassword.length > 0"));
    expect(line).toBeDefined();
    expect(PAGE).not.toContain("snap(smtpPassword)");
  });

  it("D-03: the Pausendauer snapshot excludes the two instant controls", () => {
    const slice = PAGE.slice(
      PAGE.indexOf("let breakDefaultsSnapshot"),
      PAGE.indexOf("let retroWindowSnapshot"),
    );
    expect(slice).not.toContain("autoBreakEnabled");
    expect(slice).not.toContain("defaultBreakStart");
  });

  // T-109-24: re-taking a snapshot inside `finally` would clear the "Nicht gespeichert" marker
  // after a FAILED save, telling the operator their change is persisted when it is not.
  it("T-109-24: no snapshot reset is the first statement of a finally block", () => {
    expect(PAGE).not.toMatch(/finally \{\s*\n\s*\w+Snapshot = snap\(/);
  });

  // WARNING-01 (plan-checker): saveBsSlots submits FOUR parsed values
  // (bsSlotFirstLong/Second/ShortDay/BlockWeek, see the v1..v4 parseSlot calls) — the snapshot
  // must cover all four or editing bsSlotBlockWeek alone would silently never mark the section.
  it("WARNING-01: the bsSlot snapshot covers all four fields the handler submits", () => {
    expect(PAGE).toContain(
      "snap(bsSlotFirstLong, bsSlotSecondLong, bsSlotShortDay, bsSlotBlockWeek)",
    );
  });
});
