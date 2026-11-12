// Phase 109 (Issue #35), Plan 01, Task 2 — Wave-0 regression net for
// `admin/employees/[id]/+page.svelte` (3856 lines, zero prior test coverage).
//
// Same source-read technique as `admin-system-save-wiring.test.ts` (this page isn't mountable
// either — no `$app` alias in `apps/web/vitest.config.ts`). Per 109-RESEARCH.md / N-02, every
// save path on this page is ALREADY button-gated — this pin exists so a later plan cannot
// silently convert one of them, not because a conversion is planned here.
//
// D-08/AK-10 is the sharpest edge on this page: `saveSchedule` carries `validFrom`, a
// `WorkSchedule` change's effective date, and N-04 requires "Wert und Stichtag" to be written
// together, never half-finished — so this control must never become an instant write.

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
  "../routes/(app)/admin/employees/[id]/+page.svelte",
  "src/routes/(app)/admin/employees/[id]/+page.svelte",
);

// Since Issue #854 (plan 854-20) the Stammdaten live in the Person tab component: three groups with
// their own SaveBar, snapshot and PATCH, and the § 18 ArbZG exemption with its confirm dialog.
const PERSON_TAB = readRouteFile(
  "../lib/components/employees/detail/PersonTab.svelte",
  "src/lib/components/employees/detail/PersonTab.svelte",
);

// The Urlaub tab (plan 854-20) owns the vacation form: one group, one snapshot, one PUT.
const URLAUB_TAB = readRouteFile(
  "../lib/components/employees/detail/UrlaubTab.svelte",
  "src/lib/components/employees/detail/UrlaubTab.svelte",
);
const URLAUB_MODEL = readRouteFile(
  "../lib/employees/urlaub-form.ts",
  "src/lib/employees/urlaub-form.ts",
);

// The Vertrag tab (plan 854-21) owns the contract form: one group, one snapshot, one PUT with validFrom.
const VERTRAG_TAB = readRouteFile(
  "../lib/components/employees/detail/VertragTab.svelte",
  "src/lib/components/employees/detail/VertragTab.svelte",
);
const VERTRAG_MODEL = readRouteFile(
  "../lib/employees/vertrag-form.ts",
  "src/lib/employees/vertrag-form.ts",
);

// The per-person override groups (plan 854-22): Pausendauer and Phorest, each with its own SaveBar.
const VERTRAG_OVERRIDES = readRouteFile(
  "../lib/components/employees/detail/VertragOverrides.svelte",
  "src/lib/components/employees/detail/VertragOverrides.svelte",
);

// The Berufsschule section (plan 854-22): the patterns (one PUT) and the person's slots (one PATCH).
const BERUFSSCHULE = readRouteFile(
  "../lib/components/employees/detail/BerufsschuleSection.svelte",
  "src/lib/components/employees/detail/BerufsschuleSection.svelte",
);

// The plan's reference slicer (`vacation-summary.test.ts:47-55`) finds a function's end by
// searching for the next "\n  }" (a two-space-indented closing brace) after the marker. That
// heuristic breaks on this page: several save functions take an optional object-typed
// parameter — e.g. `async function doSaveSchedule(extra?: { keepOrphanShifts?: boolean; ... })`
// — whose OWN closing brace ("  }) {") is a two-space-indented "}" that appears before the
// function body even starts, so the naive slice would end before reaching anything inside the
// real body. `fnBody` here instead tracks paren/brace depth so a parameter type's braces can
// never be mistaken for the function body's closing brace.
function fnBody(marker: string, source: string = PAGE): string {
  const PAGE = source;
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

describe("D-08/AK-10 — Vertragsdaten mit validFrom stay button-gated", () => {
  it("the contract group saves through its SaveBar, never through a change handler", () => {
    expect(VERTRAG_TAB).toContain("onSave={() => save()}");
    expect(VERTRAG_TAB).not.toContain("onchange={save}");
    expect(VERTRAG_TAB).not.toMatch(/onchange=\{\(\) => save\(/);
    // The page no longer owns any contract save.
    expect(PAGE).not.toContain("saveSchedule");
  });

  it("the save chain actually writes validFrom — not a same-named stub", () => {
    // `save()` hands the values to buildSchedulePayload, where `validFrom` is assembled into the PUT body.
    expect(fnBody("async function save", VERTRAG_TAB)).toContain("buildSchedulePayload(values");
    expect(fnBody("export function buildSchedulePayload", VERTRAG_MODEL)).toContain("validFrom");
    expect(fnBody("async function save", VERTRAG_TAB)).toContain("`/settings/work/${employeeId}`");
  });

  // N-04 (Triage-Kommentar, 26.08.2026): "Autosave nur für Einstellungen, die sofort gelten.
  // Alles mit einem Gültigkeitsdatum behält einen expliziten Speichern-Button, weil Wert und
  // Stichtag EINE Entscheidung sind und nur gemeinsam korrekt sein können." A half-written
  // intermediate state (new value, stale validFrom or vice versa) must never be persisted.
});

describe("N-02 — every save path on this page is already button-gated", () => {
  it("the page owns no save of its own any more: every write sits in a tab component", () => {
    expect(PAGE).not.toMatch(/async function save\w+/);
    expect(PAGE).not.toContain("api.put(");
    expect(PAGE).not.toContain("api.patch(");
  });

  it("the Berufsschule groups save through their SaveBar, never through a change handler", () => {
    for (const name of ["savePatterns", "saveSlots"]) {
      expect(BERUFSSCHULE, name).toContain(`onSave={${name}}`);
      expect(BERUFSSCHULE, name).not.toContain(`onchange={${name}}`);
    }
    // the slots send exactly their own four keys (#878), the patterns replace the list in one PUT
    const slots = fnBody("async function saveSlots", BERUFSSCHULE);
    expect(slots).toContain("pickSection(");
    expect(slots).toContain("BS_SLOT_KEYS");
    expect(slots).toContain("api.patch");
    expect(fnBody("async function savePatterns", BERUFSSCHULE)).toContain("api.put<");
  });

  it("the override groups save through their SaveBar, never through a change handler", () => {
    for (const name of ["savePause", "savePhorest"]) {
      expect(VERTRAG_OVERRIDES, name).toContain(`onSave={${name}}`);
      expect(VERTRAG_OVERRIDES, name).not.toContain(`onchange={${name}}`);
      // each group sends exactly its own keys (#878), never a spread of the record
      expect(fnBody(`async function ${name}`, VERTRAG_OVERRIDES), name).toContain("pickSection(");
      expect(fnBody(`async function ${name}`, VERTRAG_OVERRIDES), name).toContain("api.patch");
    }
    expect(fnBody("async function savePause", VERTRAG_OVERRIDES)).toContain("PAUSE_KEYS");
    expect(fnBody("async function savePhorest", VERTRAG_OVERRIDES)).toContain("PHOREST_KEYS");
  });

  it("the Urlaub tab saves through its SaveBar, never through a change handler", () => {
    expect(URLAUB_TAB).toContain("onSave={saveVacation}");
    expect(URLAUB_TAB).not.toContain("onchange={saveVacation}");
    expect(fnBody("async function saveVacation", URLAUB_TAB)).toContain("vacationBody");
  });

  it("the Person tab groups save through their SaveBar, never through a change handler", () => {
    for (const name of ["saveIdentity", "saveStructure", "saveEmployment"]) {
      expect(PERSON_TAB, name).toContain(`onSave={${name}}`);
      expect(PERSON_TAB, name).not.toContain(`onchange={${name}}`);
      expect(fnBody(`async function ${name}`, PERSON_TAB), name).toContain("patchEmployee");
    }
  });

  it("the § 18 ArbZG exemption toggle stays confirm-gated — the PATCH fires only on confirm", () => {
    expect(PERSON_TAB).toContain("onchange={onExemptToggleChange}");
    expect(PERSON_TAB).toContain("onConfirm={confirmExemptToggle}");
    // The change handler itself must only stage the intent and open the dialog; the actual
    // api.patch() must live in confirmExemptToggle, never here.
    expect(fnBody("function onExemptToggleChange", PERSON_TAB)).not.toContain("api.patch");
    expect(fnBody("async function confirmExemptToggle", PERSON_TAB)).toContain("api.patch");
  });
});

describe("AK-02 — no text/number input writes inline on this page", () => {
  function textOrNumberInputHandlers(source: string): string[] {
    const found: string[] = [];
    for (const tag of source.match(/<input\b[\s\S]*?>/g) ?? []) {
      const type = tag.match(/type="([a-z]+)"/)?.[1];
      if (type !== "number" && type !== "text") continue;
      for (const m of tag.matchAll(/on(?:blur|change|input)=\{(\w+)\}/g)) found.push(m[1]);
    }
    return found;
  }

  it("returns the empty array today and must stay empty", () => {
    expect(textOrNumberInputHandlers(PAGE)).toEqual([]);
    // [anti-vacuity] the Person tab does hold text and number inputs, and none writes inline.
    expect(PERSON_TAB.match(/type="(?:text|number)"/g)?.length ?? 0).toBeGreaterThan(3);
    expect(textOrNumberInputHandlers(PERSON_TAB)).toEqual([]);
    expect(VERTRAG_TAB.match(/type="(?:text|number)"/g)?.length ?? 0).toBeGreaterThan(3);
    expect(textOrNumberInputHandlers(VERTRAG_TAB)).toEqual([]);
  });
});

describe("D-11/D-12 — unsaved markers on admin/employees/[id]", () => {
  it("every group counts its changes against its own snapshot, the page keeps no snapshot", () => {
    expect(PAGE).not.toMatch(/Snapshot\s*=\s*snap\(/);
    expect(PAGE).not.toMatch(/Dirty\s*=\s*\$derived\(/);
    expect(BERUFSSCHULE).toContain("patternChangeCount(saved, drafts)");
    expect(BERUFSSCHULE).toContain("countChanges(slotSnapshot, slots, BS_SLOT_KEYS)");
    expect(VERTRAG_OVERRIDES).toContain("countChanges(pauseSnapshot, pause, PAUSE_KEYS)");
    expect(VERTRAG_OVERRIDES).toContain("countChanges(phorestSnapshot, phorest, PHOREST_KEYS)");
  });

  // Issue #580 removed the footer of the Berechtigungen tab: role assignments save in their own
  // dialog (docs/ADMIN_STRUCTURE.md §3.2.1). Since #854 every tab and override group owns its groups
  // and reports its change count (`bind:changes`); no footer Section is left on this page.
  it("no footer Section is left on the page", () => {
    expect(PAGE).not.toContain("dirty={");
    expect(PAGE).not.toMatch(/<Section\b/);
  });

  it("the Person, Vertrag and Urlaub tabs' unsaved changes are summed into the one registration", () => {
    expect(PAGE).toContain("bind:changes={personChanges}");
    expect(PAGE).toContain("bind:changes={vertragChanges}");
    expect(PAGE).toContain("bind:changes={vacationChanges}");
    expect(PAGE).toContain("bind:changes={overrideChanges}");
    expect(PAGE).toContain("bind:changes={berufsschuleChanges}");
    expect(PAGE).toContain("overrideChanges > 0");
    expect(PAGE).toContain("berufsschuleChanges > 0");
    expect(PAGE).toContain("vertragChanges > 0");
    expect(PAGE).toMatch(/let anyUnsaved = \$derived\(\s*personChanges > 0/);
    expect(PAGE).toContain("vacationChanges > 0");
  });

  it("registers under its own id and de-registers on unmount", () => {
    expect(PAGE).toContain('markUnsaved("admin-employee-detail", snapshotsReady && anyUnsaved)');
    expect(PAGE).toContain('return () => markUnsaved("admin-employee-detail", false)');
  });

  // WR-01: the page hydrates at the end of onMount's try (the tabs take their baselines from it).
  // The early `if (empRes.status === "rejected") { loadError = …; return; }` skips that block, so
  // registering the bare `anyUnsaved` traps the operator on a stale bookmark to a deleted employee
  // behind a discard dialog — on a page that renders only an error and shows no marker.
  it("WR-01: registration is gated on snapshotsReady, never the bare anyUnsaved", () => {
    expect(PAGE).not.toContain('markUnsaved("admin-employee-detail", anyUnsaved)');
    expect(PAGE).toContain("let snapshotsReady = $state(false)");
  });

  it("WR-01: snapshotsReady is set only after the record is hydrated, inside the try", () => {
    const iVacation = PAGE.indexOf("tenantBreakConfig = cfgRes.status");
    const iReady = PAGE.indexOf("snapshotsReady = true");
    const iCatch = PAGE.indexOf('loadError = "Fehler beim Laden des Mitarbeiters."');
    expect(iVacation).toBeGreaterThan(-1);
    // After the last hydration of page state...
    expect(iReady).toBeGreaterThan(iVacation);
    // ...and before the catch, i.e. still inside the try that a load failure short-circuits.
    expect(iReady).toBeLessThan(iCatch);
  });

  it("uses a different registry id than admin/system, so the pages cannot clear each other", () => {
    expect(PAGE).not.toContain('markUnsaved("admin-system"');
  });

  it("N-02: no control on this page was converted to instant save", () => {
    // The exempt toggle is the ONLY onchange-to-write path here and it was already correct.
    const onchangeWrites = [...PAGE.matchAll(/onchange=\{(save\w+)\}/g)].map((m) => m[1]);
    expect(onchangeWrites).toEqual([]);
  });

  it("AK-10: the contract snapshot covers validFrom (N-04 — Wert und Stichtag sind eine Entscheidung)", () => {
    expect(VERTRAG_TAB).toContain("countChanges(snapshot, values, CONTRACT_KEYS)");
    const keys = VERTRAG_MODEL.slice(VERTRAG_MODEL.indexOf("export const CONTRACT_KEYS"));
    expect(keys.slice(0, keys.indexOf("]"))).toContain('"validFrom"');
  });

  it("T-109-26: the contract snapshot is re-taken only after the PUT succeeded", () => {
    const body = fnBody("async function save", VERTRAG_TAB);
    const put = body.indexOf("api.put<");
    const retake = body.indexOf("snapshot = snapshotOfValues()");
    expect(put).toBeGreaterThan(-1);
    expect(retake).toBeGreaterThan(put);
    expect(body.indexOf("finally")).toBeGreaterThan(retake);
  });

  it("T-109-26: no snapshot reset is the first statement of a finally block", () => {
    // Mirrors 109-06's equivalent pin (T-109-24) — a failed save must keep the marker.
    const lines = PAGE.split("\n");
    lines.forEach((line, i) => {
      if (/Snapshot = snap\(/.test(line)) {
        const precedingFinally = lines
          .slice(Math.max(0, i - 3), i)
          .some((l) => l.includes("finally"));
        expect(precedingFinally).toBe(false);
      }
    });
  });
});

describe("Issue #435 — server-driven vacation values", () => {
  it("no client-side '30 * eWorkingDays' vacation formula remains (D-14)", () => {
    expect(PAGE).not.toMatch(/30\s*\*\s*eWorkingDays/);
  });

  it("the suggestion is derived from the server's regularDays, not a local formula", () => {
    expect(URLAUB_TAB).not.toMatch(/30\s*\*\s*eWorkingDays/);
    const line = URLAUB_TAB.split("\n").find((l) => l.includes("const suggestion = $derived("));
    expect(line, "suggestion derivation not found").toBeDefined();
    expect(line).toContain("regularDays");
  });

  it("the Person tab's change count covers annualVacationDays (D-13)", () => {
    // The employment group counts its keys against its snapshot; annualVacationDays is one of them.
    expect(PERSON_TAB).toContain("countChanges(snapshot, values, EMPLOYMENT_KEYS)");
    const model = readRouteFile(
      "../lib/employees/person-form.ts",
      "src/lib/employees/person-form.ts",
    );
    const keys = model.slice(model.indexOf("export const EMPLOYMENT_KEYS"));
    expect(keys.slice(0, keys.indexOf("]"))).toContain('"annualVacationDays"');
  });
});

describe("Issue #451 D-09 — carry-over reason select/note stay button-gated and snapshotted", () => {
  /** The element opened by `<tag` after the FormField labelled `label`, up to its close. */
  function controlAfter(label: string, tag: "select" | "textarea"): string | undefined {
    const from = URLAUB_TAB.indexOf(`label="${label}"`);
    if (from < 0) return undefined;
    return URLAUB_TAB.slice(from).match(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`))?.[0];
  }

  it("the Übertragsgrund select carries no onchange=/oninput= handler", () => {
    const tag = controlAfter("Übertragsgrund", "select");
    expect(tag, "Übertragsgrund select not found").toBeDefined();
    expect(tag).not.toMatch(/on(?:change|input)=\{/);
  });

  it("the Notiz zum Übertrag textarea carries no onchange=/oninput= handler", () => {
    const tag = controlAfter("Notiz zum Übertrag", "textarea");
    expect(tag, "Notiz textarea not found").toBeDefined();
    expect(tag).not.toMatch(/on(?:change|input)=\{/);
  });

  // The vacation group counts reason and note against its snapshot together with the amounts, and
  // the body carries them change-only against what the server last confirmed (#445 D-16).
  it("the change count covers the reason and the note", () => {
    expect(URLAUB_TAB).toContain("countChanges(snapshot, values, VACATION_KEYS)");
    const keys = URLAUB_MODEL.slice(URLAUB_MODEL.indexOf("export const VACATION_KEYS"));
    const list = keys.slice(0, keys.indexOf("]"));
    expect(list).toContain('"carryOverReason"');
    expect(list).toContain('"carryOverNote"');
  });

  it("saveVacation re-takes the snapshot and the confirmed pair only on the success path", () => {
    const body = fnBody("async function saveVacation", URLAUB_TAB);
    const put = body.indexOf("api.put(");
    expect(put).toBeGreaterThan(-1);
    for (const retake of ["loadedReason = values.carryOverReason", "snapshot = { ...values }"]) {
      expect(body.indexOf(retake), retake).toBeGreaterThan(put);
    }
    expect(body.indexOf("finally")).toBeGreaterThan(body.indexOf("snapshot = { ...values }"));
  });

  it("the body is built change-only against the confirmed pair", () => {
    expect(fnBody("async function saveVacation", URLAUB_TAB)).toContain(
      "{ reason: loadedReason, note: loadedNote }",
    );
    expect(URLAUB_MODEL).toContain("carryOverReasonPatch(loaded,");
  });

  it("a legacy stored value is shown read-only via a disabled option, never silently dropped", () => {
    expect(URLAUB_TAB).toContain("disabled selected");
    expect(URLAUB_TAB).toContain("carryOverReasonLabel(values.carryOverReason)");
  });

  it("the Notiz field shows the carry-over hint with it", () => {
    const idx = URLAUB_TAB.indexOf('label="Notiz zum Übertrag"');
    expect(idx, "Notiz field not found").toBeGreaterThan(-1);
    expect(URLAUB_TAB.slice(idx, idx + 300)).toContain("hint");
  });
});
