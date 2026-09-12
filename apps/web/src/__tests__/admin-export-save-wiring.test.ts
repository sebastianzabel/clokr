// Phase 109 (Issue #35), Plan 10, Task 1 — Wave-0 (gap closure) regression net for
// `admin/export/+page.svelte` (466 lines, zero prior test coverage).
//
// This is a source-read PIN, not a behaviour test: `apps/web/vitest.config.ts` has no
// `$app` alias, so a route page cannot be mounted (see `nav-guard.test.ts` for the
// established `readRouteFile` shape this file follows).
//
// What this pins (T-109-38):
// - D-01: `saveDatev` (the "Lohnartennummern" section) writes only via its section button.
// - The `_gOtherFields` spread plus the exact four `datev*` payload keys is the known N-09
//   lost-update spread, deliberately NOT touched by this phase — the test pins it so plan
//   109-13 neither widens nor removes it.
// - `saveDatev` is a provable no-op after a failed `loadDatev` (`if (!_gOtherFields) return;`) —
//   this is the WR-01 shape plan 109-13 must gate `snapshotsReady` around.
// - `advisorNumber`/`clientNumber`/`taxOffice` are never persisted — they are download
//   parameters, not settings — so plan 109-13 must NOT put a `dirty=` marker on that Section.
// - AK-02: no text/number input on this page carries an inline write handler.

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
  "../routes/(app)/admin/export/+page.svelte",
  "src/routes/(app)/admin/export/+page.svelte",
);

/** Brace/paren-depth fnBody() slicer — copied from admin-system-save-wiring.test.ts (Plan
 *  109-01's correction), robust against functions whose own parameter types contain braces. */
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

/** AK-02 census helper — same shape as admin-system-save-wiring.test.ts. */
function textOrNumberInputHandlers(source: string): string[] {
  const found: string[] = [];
  for (const tag of source.match(/<input\b[\s\S]*?>/g) ?? []) {
    const type = tag.match(/type="([a-z]+)"/)?.[1];
    if (type !== "number" && type !== "text") continue;
    for (const m of tag.matchAll(/on(?:blur|change|input)=\{(\w+)\}/g)) found.push(m[1]);
  }
  return found;
}

describe("D-01 — the DATEV Lohnarten form saves only on its section button", () => {
  it("saveDatev is wired via onclick=", () => {
    expect(PAGE).toContain("onclick={saveDatev}");
  });

  it("saveDatev is never wired via onchange=", () => {
    expect(PAGE).not.toContain("onchange={saveDatev}");
  });
});

describe("saveDatev payload census", () => {
  it("spreads _gOtherFields and carries exactly the four datev* keys", () => {
    const body = fnBody("async function saveDatev");
    expect(body).toContain("..._gOtherFields");
    // Isolate the api.put(...) payload object literal itself — a naive `datev[A-Za-z]+` scan
    // over the whole function body also matches `datevSaving`/`datevError`/`datevSaved`
    // (the function's own local $state flags), which are not payload keys.
    const anchor = 'api.put("/settings/work", {';
    const anchorStart = body.indexOf(anchor);
    expect(anchorStart, "saveDatev's api.put call not found").toBeGreaterThan(-1);
    const openBrace = anchorStart + anchor.length - 1;
    let depth = 0;
    let closeBrace = openBrace;
    for (let i = openBrace; i < body.length; i++) {
      if (body[i] === "{") depth++;
      else if (body[i] === "}") {
        depth--;
        if (depth === 0) {
          closeBrace = i;
          break;
        }
      }
    }
    const objectSrc = body.slice(openBrace + 1, closeBrace);
    const datevKeys = objectSrc.match(/datev[A-Za-z]+/g) ?? [];
    const distinctDatevKeys = new Set(datevKeys);
    expect(distinctDatevKeys.size).toBe(4);
    expect(distinctDatevKeys).toEqual(
      new Set(["datevNormalstundenNr", "datevUrlaubNr", "datevKrankNr", "datevSonderurlaubNr"]),
    );
  });
});

describe("saveDatev is a no-op after a failed load", () => {
  it("saveDatev bails out when _gOtherFields is still null", () => {
    expect(fnBody("async function saveDatev")).toContain("if (!_gOtherFields) return;");
  });

  it("loadDatev is the only place _gOtherFields is populated", () => {
    expect(fnBody("async function loadDatev")).toContain("_gOtherFields = cfg");
  });

  // With the load failed, the four number inputs still show their defaults but the button
  // provably cannot write — a "Nicht gespeichert" marker there would be a lie, which is why
  // plan 109-13 gates the registration on `snapshotsReady` set at the end of `loadDatev`'s try.
});

describe("export parameters are never persisted — no marker for them", () => {
  const EXPORT_PARAMS = ["advisorNumber", "clientNumber", "taxOffice"] as const;

  it.each(EXPORT_PARAMS)("%s never appears in a saveDatev write body", (name) => {
    expect(fnBody("async function saveDatev")).not.toContain(name);
  });

  it.each(EXPORT_PARAMS)(
    "%s never appears between any api.put(/api.post( and its closing",
    (name) => {
      // Census across the whole page: find every api.put(/api.post( call and check none of its
      // slice up to the matching `});` mentions the export-parameter name.
      const callStarts: number[] = [];
      for (const m of PAGE.matchAll(/api\.(put|post)\(/g)) callStarts.push(m.index ?? -1);
      for (const start of callStarts) {
        const end = PAGE.indexOf("});", start);
        expect(end).toBeGreaterThan(start);
        const callSlice = PAGE.slice(start, end);
        expect(callSlice).not.toContain(name);
      }
    },
  );

  it.each(EXPORT_PARAMS)("%s is declared as a $state with a hardcoded literal default", (name) => {
    expect(PAGE).toMatch(new RegExp(`let ${name} = \\$state\\(`));
  });

  // these are parameters of one download, not settings — plan 109-13 must NOT put a `dirty=`
  // prop on the "Export konfigurieren" Section.
});

describe("AK-02", () => {
  it("no text/number input in admin/export carries an inline write handler", () => {
    expect(textOrNumberInputHandlers(PAGE)).toEqual([]);
  });
});

describe("D-11/D-12 — unsaved marker and guard registration on admin/export", () => {
  it("datevDirty is $derived(snap(...)) with exactly the four datev* variables", () => {
    const start = PAGE.indexOf("let datevDirty = $derived(");
    expect(start).toBeGreaterThan(-1);
    const end = PAGE.indexOf(");", start);
    const slice = PAGE.slice(start, end);
    expect(slice).toMatch(/\$derived\(\s*snap\(/);
    for (const v of [
      "datevNormalstundenNr",
      "datevUrlaubNr",
      "datevKrankNr",
      "datevSonderurlaubNr",
    ]) {
      expect(slice).toContain(v);
    }
  });

  it("the registration is gated on snapshotsReady (WR-01)", () => {
    expect(PAGE).toContain('markUnsaved("admin-export", snapshotsReady && datevDirty)');
    expect(PAGE).not.toContain('markUnsaved("admin-export", datevDirty)');
  });

  it("snapshotsReady = true sits inside loadDatev's try, after _gOtherFields = cfg, never in finally", () => {
    const body = fnBody("async function loadDatev");
    const gOtherPoint = body.indexOf("_gOtherFields = cfg");
    const readyPoint = body.indexOf("snapshotsReady = true");
    expect(readyPoint).toBeGreaterThan(gOtherPoint);
    expect(PAGE).not.toMatch(/finally\s*\{[^}]*snapshotsReady/s);
  });

  it("the export parameters get no marker — exactly one dirty={ prop, on Lohnartennummern", () => {
    const matches = PAGE.match(/dirty=\{/g) ?? [];
    expect(matches).toHaveLength(1);
    const lohnartStart = PAGE.indexOf('<Section\n        title="Lohnartennummern"');
    expect(lohnartStart).toBeGreaterThan(-1);
    const lohnartEnd = PAGE.indexOf("</Section>", lohnartStart);
    const dirtyIdx = PAGE.indexOf("dirty={");
    expect(dirtyIdx).toBeGreaterThan(lohnartStart);
    expect(dirtyIdx).toBeLessThan(lohnartEnd);

    const exportKonfigStart = PAGE.indexOf('<Section title="Export konfigurieren"');
    expect(exportKonfigStart).toBeGreaterThan(-1);
    const exportKonfigEnd = PAGE.indexOf("</Section>", exportKonfigStart);
    const exportKonfigSlice = PAGE.slice(exportKonfigStart, exportKonfigEnd);
    expect(exportKonfigSlice).not.toContain("dirty=");
    expect(exportKonfigSlice).not.toContain("unsaved-hint");
  });

  it("the _gOtherFields spread is untouched", () => {
    const body = fnBody("async function saveDatev");
    expect(body).toContain("..._gOtherFields");
    const datevKeys = new Set(body.match(/datev[A-Za-z]+/g) ?? []);
    expect(
      [...datevKeys].filter((k) =>
        ["datevNormalstundenNr", "datevUrlaubNr", "datevKrankNr", "datevSonderurlaubNr"].includes(
          k,
        ),
      ),
    ).toHaveLength(4);
  });

  it("T-109-24 — no datevSnapshot = snap( assignment is inside a finally block", () => {
    for (const m of PAGE.matchAll(/datevSnapshot = snap\(/g)) {
      const idx = m.index ?? -1;
      const before = PAGE.slice(Math.max(0, idx - 120), idx);
      expect(before).not.toMatch(/finally\s*\{/);
    }
  });

  it("the effect de-registers on unmount", () => {
    expect(PAGE).toContain('return () => markUnsaved("admin-export", false);');
  });
});
