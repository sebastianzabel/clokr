// Phase 109 (Issue #35), Plan 10 - Wave-0 regression net for the audit page, rewritten by plan 854-23.
//
// A source-read PIN, not a behaviour test: `apps/web/vitest.config.ts` has no `$app` alias for routes,
// so a route page cannot be mounted (see `nav-guard.test.ts` for the established `readRouteFile` shape).
//
// What this pins (T-109-39):
// - D-01: the retention setting (section „Aufbewahrung“, now `RetentionSection.svelte`, registry section
//   `protokoll-aufbewahrung`) writes only through its section's SaveBar - the retention period controls
//   the annual deletion (§ 147 AO / § 41 EStG); an accidentally-instant select would write on every
//   scroll-through of a dropdown.
// - The single-field `PUT /settings/work` payload is exactly `dataRetentionYears`.
// - The log filters are read state (URL + query), never form state: the page itself writes nothing, and a
//   filter never arms the unsaved-navigation guard.
// - AK-02: no text/number input carries an inline write handler.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

// fileURLToPath decodes the %28/%29 that the "(app)" route group produces in import.meta.url.
function readSource(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    // Fallback: `pnpm --filter @clokr/web test` runs with cwd `apps/web`.
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const PAGE = readSource(
  "../routes/(app)/admin/audit/+page.svelte",
  "src/routes/(app)/admin/audit/+page.svelte",
);
const SECTION = readSource(
  "../lib/components/admin/protokoll/RetentionSection.svelte",
  "src/lib/components/admin/protokoll/RetentionSection.svelte",
);

/** Brace/paren-depth slicer of a function body, robust against parameter types that contain braces. */
function fnBody(source: string, marker: string): string {
  const start = source.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);

  let i = start;
  let parenDepth = 0;
  let bodyStart = -1;
  while (i < source.length) {
    const ch = source[i];
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
  for (; j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  expect(j, `unterminated function: ${marker}`).toBeLessThan(source.length);
  return source.slice(bodyStart, j + 1);
}

/** AK-02 census helper: the handler names on text/number inputs. */
function textOrNumberInputHandlers(source: string): string[] {
  const found: string[] = [];
  for (const tag of source.match(/<input\b[\s\S]*?>/g) ?? []) {
    const type = tag.match(/type="([a-z]+)"/)?.[1];
    if (type !== "number" && type !== "text") continue;
    for (const m of tag.matchAll(/on(?:blur|change|input)=\{(\w+)\}/g)) found.push(m[1]);
  }
  return found;
}

describe("anti-vacuity: both sources were read", () => {
  it("the page names the audit list and the section names its save", () => {
    expect(PAGE).toContain("/audit-logs");
    expect(SECTION).toContain("async function save");
  });
});

describe("D-01 - the retention setting saves only on its section button", () => {
  it("save is wired as the SettingsGroup onSave", () => {
    expect(SECTION).toContain("onSave={save}");
  });

  it("save is never wired via onchange= / oninput=", () => {
    expect(SECTION).not.toMatch(/on(?:change|input|blur)=\{save\}/);
  });

  it("the select carries no inline write handler", () => {
    const select = SECTION.match(/<select\b[\s\S]*?>/)?.[0] ?? "";
    expect(select).not.toBe("");
    expect(select).not.toMatch(/\bon(?:change|input|blur)\s*=/);
  });
});

describe("save payload census", () => {
  it("writes exactly the registry keys of protokoll-aufbewahrung and makes no other api call", () => {
    const body = fnBody(SECTION, "async function save");
    expect(body).toContain('api.put(\n        "/settings/work"');
    expect(body).toContain('settingsSection("protokoll-aufbewahrung").keys');
    const apiCalls = body.match(/api\.\w+\(/g) ?? [];
    expect(apiCalls).toHaveLength(1);
  });

  // exactly one persisted field - the registry section is pinned to `["dataRetentionYears"]` by settings-pages-854.
  it("the form value is the one retention field", () => {
    expect(SECTION).toContain("type RetentionValues = { dataRetentionYears: number }");
  });
});

describe("the log filters are not form state", () => {
  it("the page writes nothing: no put, post, patch or delete", () => {
    expect(PAGE).not.toMatch(/api\.(put|post|patch|delete)\(/);
  });

  it("the filters live in the URL and are written through listUrl.write", () => {
    expect(PAGE).toContain("listUrl.write(");
  });

  it("a filter reloads the list through the query, it does not persist anything", () => {
    expect(PAGE).toContain("auditQuery(");
    expect(fnBody(PAGE, "async function loadLogs")).toContain("api.get<AuditResponse>");
  });
});

describe("AK-02", () => {
  it("no text/number input in the page or the section carries an inline write handler", () => {
    expect(textOrNumberInputHandlers(PAGE)).toEqual([]);
    expect(textOrNumberInputHandlers(SECTION)).toEqual([]);
  });
});

describe("D-11/D-12 - unsaved marker and guard registration", () => {
  it("the section's change count is countChanges(snapshot, values, keys)", () => {
    expect(SECTION).toContain(
      "const changeCount = $derived(countChanges(snapshot, values, keys));",
    );
  });

  it("the page registers the sum, gated on a loaded baseline (WR-01)", () => {
    expect(PAGE).toContain('const snapshotsReady = $derived(retention.status === "ready");');
    expect(PAGE).toContain('markUnsaved("admin-audit", snapshotsReady && retentionChanges > 0)');
    expect(PAGE).not.toContain('markUnsaved("admin-audit", retentionChanges > 0)');
  });

  it("the log filters are not part of the unsaved state", () => {
    const start = PAGE.indexOf('markUnsaved("admin-audit"');
    const line = PAGE.slice(start, PAGE.indexOf(")", start + 30) + 1);
    expect(line).not.toMatch(/filters|urlFilters|entity|employeeId|from|to\b/);
  });

  it("the effect de-registers on unmount", () => {
    expect(PAGE).toContain('return () => markUnsaved("admin-audit", false);');
  });

  it("T-109-24 - the snapshot moves after the successful write, before the catch, never in finally", () => {
    const body = fnBody(SECTION, "async function save");
    const snapPoint = body.indexOf("snapshot = $state.snapshot(values)");
    const catchPoint = body.indexOf("} catch");
    expect(snapPoint).toBeGreaterThan(-1);
    expect(snapPoint).toBeLessThan(catchPoint);
    expect(SECTION).not.toMatch(/finally\s*\{[^}]*snapshot =/s);
  });
});
