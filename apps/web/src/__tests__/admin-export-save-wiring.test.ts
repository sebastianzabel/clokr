// Phase 109 (Issue #35), Plan 10 - regression net for `admin/export/+page.svelte`, rewritten by plan 854-24.
//
// A source-read PIN, not a behaviour test: `apps/web/vitest.config.ts` has no `$app` alias, so a route page
// cannot be mounted (see `nav-guard.test.ts` for the established `readRouteFile` shape this file follows).
//
// What this pins (T-109-38):
// - D-01: `saveDatev` (the DATEV-Einrichtung, registry section `export-datev-einrichtung`) writes only via its
//   section's SaveBar, never on a field event.
// - The payload is `pickSection(datev, settingsSection("export-datev-einrichtung").keys)` - exactly the six
//   `datev*` keys, no spread of loaded settings (the former `_gOtherFields` spread was the N-09 lost-update race,
//   Issue #878; `settings-pages-854` pins the exact key set of the registry section).
// - `saveDatev` is a provable no-op after a failed load (`if (!snapshotsReady) return;`), and the unsaved marker
//   is gated on the same flag (WR-01): a "Nicht gespeichert" marker on a page whose save cannot write is a lie.
// - The downloads (month, person, period, hint) are read state, never part of the unsaved state.
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

/** Brace/paren-depth fnBody() slicer, robust against functions whose own parameter types contain braces. */
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

/** AK-02 census helper - the handler names on text/number inputs. */
function textOrNumberInputHandlers(source: string): string[] {
  const found: string[] = [];
  for (const tag of source.match(/<input\b[\s\S]*?>/g) ?? []) {
    const type = tag.match(/type="([a-z]+)"/)?.[1];
    if (type !== "number" && type !== "text") continue;
    for (const m of tag.matchAll(/on(?:blur|change|input)=\{(\w+)\}/g)) found.push(m[1]);
  }
  return found;
}

describe("D-01 - the DATEV-Einrichtung saves only on its section button", () => {
  it("saveDatev is wired as the SettingsGroup onSave", () => {
    expect(PAGE).toContain("onSave={saveDatev}");
  });

  it("saveDatev is never wired via onchange= / oninput=", () => {
    expect(PAGE).not.toMatch(/on(?:change|input|blur)=\{saveDatev\}/);
  });
});

describe("saveDatev payload census", () => {
  it("sends the registry section's keys through pickSection and spreads nothing (Issue #878)", () => {
    const body = fnBody("async function saveDatev");
    expect(body).not.toContain("...");
    expect(body).toContain('settingsSection("export-datev-einrichtung").keys');
    expect(body).toContain("pickSection(");
    expect((body.match(/api\.\w+\(/g) ?? []).length).toBe(1);
    expect(PAGE).not.toContain("_gOtherFields");
  });

  it("the form value carries exactly the six datev* keys", () => {
    const start = PAGE.indexOf("type DatevValues = {");
    expect(start).toBeGreaterThan(-1);
    const slice = PAGE.slice(start, PAGE.indexOf("};", start));
    const keys = new Set(slice.match(/datev[A-Za-z]+/g) ?? []);
    expect(keys).toEqual(
      new Set([
        "datevNormalstundenNr",
        "datevUrlaubNr",
        "datevKrankNr",
        "datevSonderurlaubNr",
        "datevBeraterNr",
        "datevMandantenNr",
      ]),
    );
  });
});

describe("saveDatev is a no-op after a failed load", () => {
  it("saveDatev bails out while the settings are not loaded", () => {
    expect(fnBody("async function saveDatev")).toContain("if (!snapshotsReady");
  });

  it("loadDatev is the only place snapshotsReady is set, after both baselines, never in finally", () => {
    const body = fnBody("async function loadDatev");
    expect(body.indexOf("datevSnapshot = datevFrom(cfg)")).toBeGreaterThan(-1);
    expect(body.indexOf("snapshotsReady = true")).toBeGreaterThan(
      body.indexOf("datevSnapshot = datevFrom(cfg)"),
    );
    expect(PAGE.match(/snapshotsReady = true/g)).toHaveLength(1);
    expect(PAGE).not.toMatch(/finally\s*\{[^}]*snapshotsReady/s);
  });

  it("a server-side 403 stays the authority: the save is not hidden behind a client-only check", () => {
    // `canEditSettings` only disables the inputs (presentation); the PUT itself is still sent.
    expect(fnBody("async function saveDatev")).not.toContain("canEditSettings");
  });
});

describe("the downloads are read state - no marker for them", () => {
  it("the page writes exactly one thing: the DATEV-Einrichtung", () => {
    expect((PAGE.match(/api\.(put|post|patch|delete)\(/g) ?? []).length).toBe(1);
  });

  it("the month, person, period and busy flag never reach the unsaved marker or a write body", () => {
    const start = PAGE.indexOf('markUnsaved("admin-export"');
    const line = PAGE.slice(start, PAGE.indexOf(")", start + 30) + 1);
    expect(line).not.toMatch(/exportMonth|personId|csvFrom|csvTo|busy/);
    const body = fnBody("async function saveDatev");
    for (const name of ["exportMonth", "personId", "csvFrom", "csvTo"]) {
      expect(body).not.toContain(name);
    }
  });
});

describe("AK-02", () => {
  it("no text/number input in admin/export carries an inline write handler", () => {
    expect(textOrNumberInputHandlers(PAGE)).toEqual([]);
  });
});

describe("D-11/D-12 - unsaved marker and guard registration on admin/export", () => {
  it("the change count is countChanges(snapshot, values, keys) over the registry keys", () => {
    expect(PAGE).toContain(
      "const datevChanges = $derived(countChanges(datevSnapshot, datev, datevKeys));",
    );
    expect(PAGE).toContain('settingsSection("export-datev-einrichtung").keys');
  });

  it("the registration is gated on snapshotsReady (WR-01)", () => {
    expect(PAGE).toContain('markUnsaved("admin-export", snapshotsReady && datevChanges > 0)');
    expect(PAGE).not.toContain('markUnsaved("admin-export", datevChanges > 0)');
  });

  it("the effect de-registers on unmount", () => {
    expect(PAGE).toContain('return () => markUnsaved("admin-export", false);');
  });

  it("T-109-24 - the snapshot moves after the successful write, before the catch, never in finally", () => {
    const body = fnBody("async function saveDatev");
    const snapPoint = body.indexOf("datevSnapshot = $state.snapshot(datev)");
    const catchPoint = body.indexOf("} catch");
    expect(snapPoint).toBeGreaterThan(-1);
    expect(snapPoint).toBeLessThan(catchPoint);
    expect(PAGE).not.toMatch(/finally\s*\{[^}]*datevSnapshot =/s);
  });
});
