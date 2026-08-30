// Phase 109 (Issue #35), Plan 09, Task 2 — Wave-0 gap-closure regression net for
// `admin/phorest/+page.svelte` (948 lines, zero prior test coverage).
//
// This is a source-read PIN, not a behaviour test: `apps/web/vitest.config.ts` has no `$app`
// alias, so a route page cannot be mounted (see `nav-guard.test.ts` for the established
// precedent of reading route source with `readFileSync` instead).

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
  "../routes/(app)/admin/phorest/+page.svelte",
  "src/routes/(app)/admin/phorest/+page.svelte",
);

function fnBody(marker: string): string {
  const start = PAGE.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const end = PAGE.indexOf("\n  }", start);
  expect(end, `unterminated function: ${marker}`).toBeGreaterThan(start);
  return PAGE.slice(start, end);
}

// Same extractor as admin-vacation-save-wiring.test.ts, copied (not imported) — each pin file
// is independently readable. Accepts both `key: value` and ES2015 shorthand object properties.
function extractObjectKeys(objectLiteralBody: string): string[] {
  const keys: string[] = [];
  for (const rawLine of objectLiteralBody.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("//")) continue;
    const m = line.match(/^([a-zA-Z][a-zA-Z0-9]*)[:,]/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

function sliceBalancedObject(source: string, openBraceIndex: number): string {
  let depth = 0;
  let i = openBraceIndex;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(openBraceIndex + 1, i);
}

describe("D-07 — Phorest credentials stay button-gated", () => {
  // Phorest credentials are security configuration and stay behind a button whatever the
  // control looks like (109-CONTEXT.md D-07) — the same rule that keeps SMTP and password
  // policy button-gated on admin/system.
  it("savePhorest is onclick-only, never onchange", () => {
    expect(PAGE).toContain("onclick={savePhorest}");
    expect(PAGE).not.toContain("onchange={savePhorest}");
  });
});

describe("savePhorest payload census — the field list plan 109-12 must snapshot", () => {
  // Measured against apps/web/src/routes/(app)/admin/phorest/+page.svelte on 2026-08-30.
  const PHOREST_KEYS = [
    "phorestBusinessId",
    "phorestBranchId",
    "phorestUsername",
    "phorestPassword",
    "phorestAutoSync",
    "phorestSyncCron",
    "phorestSyncWindowDays",
    "phorestPrepMinutes",
    "phorestWrapupMinutes",
  ] as const;

  it("PUT /integrations/phorest/config carries exactly the nine known keys", () => {
    const body = fnBody("async function savePhorest");
    const bodyStart = body.indexOf('api.put("/integrations/phorest/config", {');
    expect(
      bodyStart,
      'api.put("/integrations/phorest/config", {...}) call not found',
    ).toBeGreaterThan(-1);
    const objStart = body.indexOf("{", bodyStart);
    const keys = extractObjectKeys(sliceBalancedObject(body, objStart)).sort();
    expect(keys).toEqual([...PHOREST_KEYS].sort());
  });

  it("both Section footers that trigger savePhorest save all nine fields — 109-12 must re-take both snapshots on success", () => {
    const matches = PAGE.match(/\{#snippet footer\(\)\}[\s\S]*?onclick=\{savePhorest\}/g) ?? [];
    expect(matches.length).toBe(2);
  });
});

describe("the mapping table is pre-filled with server suggestions (not user edits)", () => {
  it("loadPhMapping seeds selectedEmployeeId from saved-or-suggested", () => {
    expect(fnBody("async function loadPhMapping")).toContain(
      "s.savedEmployeeId ?? s.suggestedEmployeeId",
    );
  });

  it("phRowStatus classifies a suggested-but-unsaved row as 'suggested'", () => {
    expect(fnBody("function phRowStatus")).toContain('"suggested"');
  });

  it("savePhMapping promotes the selection to saved on success", () => {
    expect(fnBody("async function savePhMapping")).toContain(
      "row.savedEmployeeId = row.selectedEmployeeId",
    );
  });

  // A naive `selected !== saved` dirty derivation would report the page as unsaved
  // immediately after load for every suggested row — a snapshot must therefore be taken at
  // the end of `loadPhMapping`, once `selectedEmployeeId` has already been pre-filled; the
  // password may only ever enter a snapshot as a presence boolean, never as its value.
  it("phPassword is never hydrated from the server", () => {
    const onMountBody = PAGE.slice(
      PAGE.indexOf("onMount(async ()"),
      PAGE.indexOf("async function savePhorest"),
    );
    expect(onMountBody).not.toContain("phPassword =");
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

  it("no text/number input on admin/phorest carries an inline write handler", () => {
    expect(textOrNumberInputHandlers(PAGE)).toEqual([]);
  });
});
