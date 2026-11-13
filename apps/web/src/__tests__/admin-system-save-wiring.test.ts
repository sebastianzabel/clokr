// Phase 109 (Issue #35), Plan 01, Task 1 — Wave-0 regression net for the System settings page.
//
// This is a source-read PIN, not a behaviour test: `apps/web/vitest.config.ts` has no
// `$app` alias, so a route page cannot be mounted (see `layout-boundaries.test.ts` for the
// established precedent of reading route source with `readFileSync` instead). Issue #854 (plan 854-15)
// rewrote the page: its four sections are components of `lib/components/admin/allgemein/`, which this
// file reads together with the page. The sections are also mounted in `allgemein-854.test.ts`.
//
// The DO-NOT-TOUCH lists this file locks down come from `109-CONTEXT.md`:
// - D-03 / N-11: the 2FA switch saves instantly via `onchange` and must stay that way, with the rollback
//   and loud failure of WR-02.
// - D-07: security-relevant controls (password policy, session config incl. `rememberMeEnabled`) must stay
//   button-gated (the section's SaveBar), regardless of how toggle-shaped they look.
// - D-01: the remaining genuine form groups stay button-gated.
// - AK-02 (D-02): text/number inputs must never write outside a button-gated group.

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
const SECTIONS_DIR = "../lib/components/admin/allgemein/";
const section = (name: string) =>
  readRouteFile(
    `${SECTIONS_DIR}${name}.svelte`,
    `src/lib/components/admin/allgemein/${name}.svelte`,
  );
const TWO_FA = section("TwoFactorSection");
const COMPANY = section("CompanySection");
const PASSWORD = section("PasswordSection");
const SESSION = section("SessionSection");
const ALL_SOURCES = [PAGE, TWO_FA, COMPANY, PASSWORD, SESSION];

// Brace/paren-depth fnBody() slicer (Phase 109, Plan 01's admin-employee-save-wiring.test.ts
// correction) rather than the naive two-space-indent heuristic from vacation-summary.test.ts:
// robust against a function whose own parameter type contains braces before the real body starts.
function fnBody(marker: string): string {
  const PAGE = TWO_FA;
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
    expect(TWO_FA).toContain(`onchange={${name}}`);
    expect(TWO_FA).not.toContain(`onclick={${name}}`);
  });

  it("the instant switch lives in exactly one component of the page", () => {
    expect(ALL_SOURCES.filter((source) => source.includes("onchange={toggleTwoFa}")).length).toBe(
      1,
    );
  });

  // N-11: toggleTwoFa is 2FA, textbook security-relevant, but D-07's enumeration does not
  // name it. Owner decision recorded in 109-CONTEXT.md: leave it as-is (status quo) unless
  // explicitly decided otherwise. This count pins that the list above is exactly the one handler left
  // (Issue #433 removed the holiday-deduction toggle, Issue #854 moved the others to the SaveBars of their
  // new pages) - the controls no longer exist here, not because a check was relaxed.
  it("there is exactly one instant handler (#433 and #854 corrections)", () => {
    expect(INSTANT_HANDLERS.length).toBe(1);
    for (const source of [PAGE, COMPANY, PASSWORD, SESSION]) {
      expect(source).not.toMatch(/onchange=\{\s*(?:toggle|save)\w*\s*\}/);
    }
  });
});

// WR-02 — CORRECTION of this file's original claim.
//
// Plan 109-01 pinned the nine handlers above as "already correct". For the eight CHECKBOX ones that assertion
// was FALSE, and pinning it cemented the defect. They were wired one-way (`checked={state}`) with a pessimistic
// handler that wrote the state only on success. Nothing bounced back on failure: the browser had already
// flipped the DOM checkbox, the state never changed, so Svelte's template effect never re-ran - and
// `set_checked` early-returns when the new value equals the LAST APPLIED one, without ever reading
// `element.checked`. Reproduced live (109-BROWSER-UAT.md). The switch is bound with `bind:checked`
// (inside ToggleField, from the section's `bind:checked={twoFaEnabled}`) and `allgemein-854.test.ts`
// proves the rollback by mounting the section.
describe("WR-02 — the instant checkbox toggle rolls back and reports on failure", () => {
  /** handler -> the state variable it owns */
  const TOGGLES: Record<string, string> = {
    toggleTwoFa: "twoFaEnabled",
  };
  const ENTRIES = Object.entries(TOGGLES);

  it("there is exactly one of them", () => {
    expect(ENTRIES.length).toBe(1);
  });

  // This is the assertion that would have FAILED against the old source: every one of the old toggles
  // carried `checked={state}` and none carried `bind:checked={state}`.
  it.each(ENTRIES)("%s's checkbox uses bind:checked, not one-way checked=", (_handler, state) => {
    expect(TWO_FA).toContain(`bind:checked={${state}}`);
    // Lookbehind so the `checked={x}` inside `bind:checked={x}` does not match itself.
    expect(TWO_FA).not.toMatch(new RegExp(`(?<!bind:)checked=\\{${state}\\}`));
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

  it.each(ENTRIES)("%s fails loudly - no bare catch {}", (handler) => {
    const body = fnBody(`async function ${handler}`);
    const tail = body.slice(body.indexOf("} catch"));
    // Either a toast or the section's own rendered inline error.
    expect(tail).toMatch(/toasts\.error\(|\w*Error = /);
  });

  // The old shape is what made the failure silent: assign the new value only after the await.
  // If `newValue` comes back, the pessimistic pattern has come back with it.
  it.each(ENTRIES)("%s no longer uses the pessimistic newValue shape", (handler) => {
    expect(fnBody(`async function ${handler}`)).not.toContain("const newValue =");
  });

  // Every early `return` guard bails BEFORE the try, so it too has to undo the browser's flip -
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
  // The password policy and the session config are form groups of their own components: the section's SaveBar
  // (`SettingsGroup` `onSave={save}`) is the only write, no control of them carries an `onchange` save.
  const BUTTON_ONLY_SECURITY = [
    ["PasswordSection", PASSWORD],
    ["SessionSection", SESSION],
  ] as const;

  it.each(BUTTON_ONLY_SECURITY)("%s is saved via onSave=, never onchange=", (_name, source) => {
    expect(source).toContain("onSave={save}");
    expect(source).not.toMatch(/on(?:change|input|blur)=\{[^}]*(?:save|api\.)/);
  });

  it("rememberMeEnabled ('Angemeldet bleiben') is plain bind:checked, not converted", () => {
    // D-07 rationale: toggle-shaped, but part of the session-config form group, which the
    // owner explicitly kept security-relevant and button-gated.
    expect(SESSION).toContain("bind:checked={values.rememberMeEnabled}");
    expect(SESSION).not.toMatch(/ToggleField[^>]*onchange=/);
  });
});

describe("D-01 — genuine form groups stay button-gated", () => {
  // Issue #854 (plan 854-10): saveShiftHoursMode moved to Regeln › Dienstplan › Einstellungen, a section
  // with a SaveBar (dienstplan-settings-854.test.ts). Plan 854-07: saveCoreDefaults, saveBsSlots and
  // saveDefaultWorkDays moved to the Arbeitszeit page, where every section is button-gated through its SaveBar
  // (arbeitszeit-save-wiring-854.test.ts pins that no text/number input there writes inline).
  it("the company section (saveFederalState before #854) is saved via onSave=, never onchange=", () => {
    expect(COMPANY).toContain("onSave={save}");
    expect(COMPANY).not.toMatch(/on(?:change|input|blur)=\{[^}]*(?:save|api\.)/);
  });
});

describe("AK-02 — text/number inputs never write outside a button-gated group", () => {
  // Filtered to type="number" | type="text" and not "every input" on purpose: the only instant control is a
  // checkbox, which is not a D-02 concern.
  function textOrNumberInputHandlers(source: string): string[] {
    const found: string[] = [];
    for (const tag of source.match(/<input\b[\s\S]*?>/g) ?? []) {
      const type = tag.match(/type="([a-z]+)"/)?.[1];
      if (type !== "number" && type !== "text") continue;
      for (const m of tag.matchAll(/on(?:blur|change|input)=\{(\w+)\}/g)) found.push(m[1]);
    }
    return found;
  }

  it("AK-02: no text/number input of the page or its sections carries an inline write handler", () => {
    for (const source of ALL_SOURCES) expect(textOrNumberInputHandlers(source)).toEqual([]);
  });

  it("the census is not vacuous: the sections do carry text/number inputs", () => {
    const count = [COMPANY, PASSWORD, SESSION]
      .map((source) => (source.match(/type="(?:number|text)"/g) ?? []).length)
      .reduce((a, b) => a + b, 0);
    expect(count).toBeGreaterThanOrEqual(3);
  });
});

// Issue #854 (plan 854-08): the eight E-Mail-Benachrichtigungs-Toggles (`toggleEmailFlag`) and the SMTP server
// moved to Regeln › Benachrichtigungen & E-Mail. There the eight keys are ONE form group (`EmailSection`) with a
// SaveBar that sends exactly the registry keys of `benachrichtigungen-email` to PUT /settings/security. The pins
// of the instant handler (revert before the toast, minimal payload, DOM rollback, toast feedback) went with it;
// the replacement behaviour is pinned by settings-pages-854 (own fields only, every key sent) and
// benachrichtigungen-854.test.ts (mounted: one request with the eight keys, failed save keeps the edit).
describe("Issue #854 — the Kommunikation controls are gone from the System page", () => {
  it("carries neither the e-mail switches nor the SMTP form", () => {
    for (const source of ALL_SOURCES) {
      expect(source).not.toContain("toggleEmailFlag");
      expect(source).not.toContain("saveSmtp");
      expect(source).not.toContain("testSmtp");
      expect(source).not.toContain("smtpPassword");
      expect(source).not.toContain('id: "kommunikation"');
    }
  });

  it("carries no leftover of the moved sections or of the old tab layout", () => {
    for (const source of ALL_SOURCES) {
      expect(source).not.toContain("Erscheinungsbild");
      expect(source).not.toContain("SectionStack");
      expect(source).not.toContain("activeTab");
      expect(source).not.toContain("defaultWeeklyHours");
      expect(source).not.toContain("carryOverDeadline");
    }
  });
});

describe("D-11/D-12 — unsaved markers on the System page", () => {
  // The three form groups count their changes with `countChanges` against a snapshot (section-state.ts) and
  // report them through the bindable `changes`; the two-factor switch is instant and never unsaved.
  it.each([
    ["CompanySection", COMPANY],
    ["PasswordSection", PASSWORD],
    ["SessionSection", SESSION],
  ] as const)(
    "%s derives its change count from a snapshot, not a hand-set flag",
    (_name, source) => {
      expect(source).toContain(
        "const changeCount = $derived(countChanges(snapshot, values, keys));",
      );
      expect(source).toContain("changes = changeCount;");
    },
  );

  it("the page registers itself under one id and de-registers on unmount", () => {
    expect(PAGE).toContain('markUnsaved("admin-system", snapshotsReady && totalChanges > 0)');
    expect(PAGE).toContain('return () => markUnsaved("admin-system", false)');
  });

  // WR-01: a non-401 load failure must not leave the guard armed on a page that renders only an error.
  it("WR-01: registration is gated on snapshotsReady, never the bare change count", () => {
    expect(PAGE).not.toContain('markUnsaved("admin-system", totalChanges');
    expect(PAGE).toMatch(
      /const snapshotsReady = \$derived\(company\.status === "ready" \|\| security\.status === "ready"\)/,
    );
  });

  it("WR-01: a section is mounted only from a loaded answer, never from made-up defaults", () => {
    expect(PAGE).toContain('{#if company.status === "ready"}');
    expect(PAGE).toContain('{#if security.status === "ready"}');
  });

  // T-109-24: re-taking a snapshot inside `finally` would clear the "Nicht gespeichert" marker
  // after a FAILED save, telling the operator their change is persisted when it is not.
  it("T-109-24: no snapshot reset sits in a finally block", () => {
    for (const source of [COMPANY, PASSWORD, SESSION]) {
      expect(source).not.toMatch(/finally \{[^}]*snapshot = /);
    }
  });
});

describe("Issue #433 (D-04) — the retired holiday-deduction toggle is gone from the page", () => {
  it("the page carries neither the handler, the state flag, nor the removed toggle's label", () => {
    for (const source of ALL_SOURCES) {
      expect(source).not.toContain("saveHolidayDeduction");
      expect(source).not.toContain("monthlyHoursHolidayDeduction");
      expect(source).not.toContain("holidayDeductionSaving");
      expect(source).not.toContain("Feiertage kürzen Monatsstunden-Soll");
    }
  });
});
