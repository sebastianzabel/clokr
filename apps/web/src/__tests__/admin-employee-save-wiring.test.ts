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

// The plan's reference slicer (`vacation-summary.test.ts:47-55`) finds a function's end by
// searching for the next "\n  }" (a two-space-indented closing brace) after the marker. That
// heuristic breaks on this page: several save functions take an optional object-typed
// parameter — e.g. `async function doSaveSchedule(extra?: { keepOrphanShifts?: boolean; ... })`
// — whose OWN closing brace ("  }) {") is a two-space-indented "}" that appears before the
// function body even starts, so the naive slice would end before reaching anything inside the
// real body. `fnBody` here instead tracks paren/brace depth so a parameter type's braces can
// never be mistaken for the function body's closing brace.
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

describe("D-08/AK-10 — Vertragsdaten mit validFrom stay button-gated", () => {
  it("saveSchedule is wired via onclick=, never onchange=", () => {
    expect(PAGE).toContain("onclick={saveSchedule}");
    expect(PAGE).not.toContain("onchange={saveSchedule}");
  });

  it("the saveSchedule chain actually writes validFrom — not a same-named stub", () => {
    // `saveSchedule()` is a thin wrapper (`return doSaveSchedule()`); pinning "validFrom"
    // directly on its own body would prove nothing (it isn't there — it's one call deeper).
    // Trace the real chain instead: saveSchedule -> doSaveSchedule -> buildSchedulePayload,
    // where `validFrom: eValidFrom` is actually assembled into the PUT body.
    expect(fnBody("async function saveSchedule")).toContain("doSaveSchedule");
    expect(fnBody("async function doSaveSchedule")).toContain("buildSchedulePayload");
    expect(fnBody("function buildSchedulePayload")).toContain("validFrom");
  });

  // N-04 (Triage-Kommentar, 26.08.2026): "Autosave nur für Einstellungen, die sofort gelten.
  // Alles mit einem Gültigkeitsdatum behält einen expliziten Speichern-Button, weil Wert und
  // Stichtag EINE Entscheidung sind und nur gemeinsam korrekt sein können." A half-written
  // intermediate state (new value, stale validFrom or vice versa) must never be persisted.
});

describe("N-02 — every save path on this page is already button-gated", () => {
  const BUTTON_GATED = [
    "saveStammdaten",
    "saveSchedule",
    "savePausendauer",
    "savePhorestPuffer",
    "saveBsSlotEmp",
    "savePatterns",
    "saveVacation",
  ] as const;

  it.each(BUTTON_GATED)("%s is wired via onclick=, never onchange=", (name) => {
    expect(PAGE).toContain(`onclick={${name}}`);
    expect(PAGE).not.toContain(`onchange={${name}}`);
  });

  it("the § 18 ArbZG exemption toggle stays confirm-gated — the PATCH fires only on confirm", () => {
    expect(PAGE).toContain("onchange={onExemptToggleChange}");
    expect(PAGE).toContain("onConfirm={confirmExemptToggle}");
    // The change handler itself must only stage the intent and open the dialog; the actual
    // api.patch() must live in confirmExemptToggle, never here.
    expect(fnBody("function onExemptToggleChange")).not.toContain("api.patch");
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
  });
});
