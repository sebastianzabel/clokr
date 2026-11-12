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

// Issue #854 (plan 854-07): the Pausen section moved to Regeln › Arbeitszeit & Verträge, where it is ONE
// section with a SaveBar (`BreaksSection.svelte`). The three instant Pausen handlers (`toggleAutoBreak`,
// `saveDefaultBreakStart`, `toggleEnforceBreakConfirmation`) and `saveBreakDefaults` left this page with it.
// Their keys are pinned by settings-pages-854 ((1) one place per key, (3) the section sends its own keys and
// every registry key is sent) and the behaviour by arbeitszeit-save-wiring-854.test.ts and
// BreaksSection-854.test.ts; nothing here was relaxed, the controls no longer exist on this page.
// Issue #854 (plan 854-08): the two Monatsabschluss switches (`saveCloseMonthWithGaps`,
// `toggleBlockMonthCloseOnUnconfirmedBreak`) moved to Regeln › Monatsabschluss, where each is a section with a
// SaveBar (`GapsSection`, `BreakBlockSection`). The controls no longer exist here; their keys are pinned by
// settings-pages-854 and the behaviour by monatsabschluss-854.test.ts - nothing was relaxed.
// Issue #854 (plan 854-10): the two roster switches (`saveAvailabilityEnabled`,
// `saveVocationalSchoolAutoCleanupShifts`) moved to Regeln › Dienstplan › Einstellungen, where each is a
// section with a SaveBar (dienstplan-settings-854.test.ts: bind:checked, request keys, failed save keeps the
// edit). The controls no longer exist here; only the 2FA switch stays instant.
describe("D-03/N-11 — the instant handler stays instant", () => {
  const INSTANT_HANDLERS = ["toggleTwoFa"] as const;

  it.each(INSTANT_HANDLERS)("%s is wired via onchange=, never onclick=", (name) => {
    expect(PAGE).toContain(`onchange={${name}}`);
    expect(PAGE).not.toContain(`onclick={${name}}`);
  });

  // N-11: toggleTwoFa is 2FA, textbook security-relevant, but D-07's enumeration does not
  // name it. Owner decision recorded in 109-CONTEXT.md: leave it as-is (status quo) unless
  // explicitly decided otherwise. This count pins that the list above is exactly the eight
  // handlers the research established — not four, not five, not ten.
  // Issue #433 (D-04): the count dropped from nine to eight because saveHolidayDeduction and its
  // toggle were removed; Issue #854 took it to five (plan 854-07: the three Pausen handlers moved to the
  // Arbeitszeit page's SaveBar) and to three (plan 854-08: the two Monatsabschluss switches moved to their
  // own page's SaveBars) and to one (plan 854-10: the two roster switches moved to the Dienstplan page's
  // SaveBars) — the controls no longer exist here, not because a check was relaxed.
  it("there is exactly one instant handler (#433 and #854 corrections)", () => {
    expect(INSTANT_HANDLERS.length).toBe(1);
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
describe("WR-02 — the instant checkbox toggle rolls back and reports on failure", () => {
  /** handler → the state variable it owns */
  const TOGGLES: Record<string, string> = {
    toggleTwoFa: "twoFaEnabled",
  };
  const ENTRIES = Object.entries(TOGGLES);

  // Issue #433 (D-04) took the count from eight to seven (saveHolidayDeduction removed), Issue #854 from
  // seven to five (toggleAutoBreak and toggleEnforceBreakConfirmation moved to the Arbeitszeit page's
  // SaveBar) and to three (plan 854-08: saveCloseMonthWithGaps and toggleBlockMonthCloseOnUnconfirmedBreak
  // moved to the Monatsabschluss page's SaveBars) and to one (plan 854-10: the two roster switches moved to
  // the Dienstplan page's SaveBars) — the controls no longer exist here, not because a check was relaxed.
  it("there is exactly one of them", () => {
    expect(ENTRIES.length).toBe(1);
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

  it("the compliance-weighted one is covered by name (2FA)", () => {
    expect(Object.keys(TOGGLES)).toEqual(expect.arrayContaining(["toggleTwoFa"]));
  });
});

describe("D-07 — security-relevant settings stay button-gated", () => {
  // Issue #854 (plan 854-08): saveSmtp moved to Regeln › Benachrichtigungen & E-Mail (`SmtpSection`, a form
  // group with its own SaveBar; the SMTP credentials stay button-gated there - benachrichtigungen-854.test.ts).
  const BUTTON_ONLY_SECURITY = ["savePasswordPolicy", "saveSessionConfig"] as const;

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
    // Issue #854 (plan 854-10): saveShiftHoursMode moved to Regeln › Dienstplan › Einstellungen, a section
    // with a SaveBar (dienstplan-settings-854.test.ts).
    "saveFederalState",
    // Issue #854 (plan 854-07): saveCoreDefaults, saveBsSlots and saveDefaultWorkDays moved to the
    // Arbeitszeit page, where every section is button-gated through its SaveBar
    // (arbeitszeit-save-wiring-854.test.ts pins that no text/number input there writes inline).
  ] as const;

  it.each(BUTTON_ONLY_GROUPS)("%s is wired via onclick=, never onchange=", (name) => {
    expect(PAGE).toContain(`onclick={${name}}`);
    expect(PAGE).not.toContain(`onchange={${name}}`);
  });
});

describe("AK-02 — text/number inputs never write outside a button-gated group", () => {
  // Filtered to type="number" | type="text" and not "every input" on purpose:
  // `saveDefaultBreakStart` sits on a type="time" field that D-03 explicitly leaves instant,
  // and all eight instant handlers above are checkboxes — neither is a D-02 concern.
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

  // saveBreakDefaults and saveRetroEntryWindowDays (button-gated, never onblur, D-02/N-01) moved to the
  // Arbeitszeit page (#854, plan 854-07): the same rule is pinned there for every section.
});

// Issue #854 (plan 854-08): the eight E-Mail-Benachrichtigungs-Toggles (`toggleEmailFlag`) and the SMTP server
// moved to Regeln › Benachrichtigungen & E-Mail. There the eight keys are ONE form group (`EmailSection`) with a
// SaveBar that sends exactly the registry keys of `benachrichtigungen-email` to PUT /settings/security. The pins
// of the instant handler (revert before the toast, minimal payload, DOM rollback, toast feedback) went with it;
// the replacement behaviour is pinned by settings-pages-854 (own fields only, every key sent) and
// benachrichtigungen-854.test.ts (mounted: one request with the eight keys, failed save keeps the edit).
describe("Issue #854 — the Kommunikation controls are gone from admin/system", () => {
  it("carries neither the e-mail switches nor the SMTP form", () => {
    expect(PAGE).not.toContain("toggleEmailFlag");
    expect(PAGE).not.toContain("saveSmtp");
    expect(PAGE).not.toContain("testSmtp");
    expect(PAGE).not.toContain("smtpPassword");
    expect(PAGE).not.toContain('id: "kommunikation"');
  });
});

describe("D-11/D-12 — unsaved markers on admin/system", () => {
  // Issue #854 (plan 854-10): shiftHoursModeDirty left with the section (Regeln › Dienstplan).
  const SECTIONS = ["companyDirty", "sessionDirty", "pwDirty"] as const;

  it.each(SECTIONS)("%s is derived, not hand-set", (name) => {
    expect(PAGE).toContain(`let ${name} = $derived(`);
  });

  it("every button-gated Section receives a dirty prop", () => {
    expect((PAGE.match(/dirty=\{/g) ?? []).length).toBe(3);
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
    const iLastSnapshot = PAGE.indexOf("pwSnapshot = snap(");
    const iReady = PAGE.indexOf("snapshotsReady = true");
    const iCatch = PAGE.indexOf('error = e instanceof Error ? e.message : "Fehler beim Laden"');
    expect(iLastSnapshot).toBeGreaterThan(-1);
    // After the last snapshot assignment...
    expect(iReady).toBeGreaterThan(iLastSnapshot);
    // ...and before the catch, i.e. still inside the try that a load failure short-circuits.
    expect(iReady).toBeLessThan(iCatch);
  });

  // T-109-22 (the SMTP snapshot records password PRESENCE, never the password) moved with the SMTP form: the
  // section's snapshot is taken after the typed password was cleared (benachrichtigungen-854.test.ts).

  // T-109-24: re-taking a snapshot inside `finally` would clear the "Nicht gespeichert" marker
  // after a FAILED save, telling the operator their change is persisted when it is not.
  it("T-109-24: no snapshot reset is the first statement of a finally block", () => {
    expect(PAGE).not.toMatch(/finally \{\s*\n\s*\w+Snapshot = snap\(/);
  });
});

describe("Issue #433 (D-04) — the retired holiday-deduction toggle is gone from the page", () => {
  it("the page carries neither the handler, the state flag, nor the removed toggle's label", () => {
    expect(PAGE).not.toContain("saveHolidayDeduction");
    expect(PAGE).not.toContain("monthlyHoursHolidayDeduction");
    expect(PAGE).not.toContain("holidayDeductionSaving");
    expect(PAGE).not.toContain("Feiertage kürzen Monatsstunden-Soll");
  });
});
