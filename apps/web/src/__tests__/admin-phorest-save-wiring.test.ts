// Phase 109 (Issue #35), Plan 09 - the regression net for the Phorest page; re-pointed by Issue #854 (plan 16),
// when the page was rebuilt on blocks: its body now lives in `lib/components/admin/phorest/` and the pure rules in
// `lib/settings/phorest.ts`. The behaviour is proven by the mounted suites next to the panels
// (`phorest-connection-854`, `phorest-sync-854`); this file keeps the SOURCE pins that no mounted test can
// state: which handler saves, what the request is built from, what the page registers, what the sources must
// not contain.
//
// A route page cannot be mounted (`apps/web/vitest.config.ts` has no `$app` alias, see `nav-guard.test.ts`), so the
// page is read with `readFileSync` like every route pin.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { settingsSection } from "$lib/settings/settings-pages";

// fileURLToPath decodes the %28/%29 that the "(app)" route group produces in import.meta.url.
function read(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    // Fallback: `pnpm --filter @clokr/web test` runs with cwd `apps/web`.
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const PAGE = read(
  "../routes/(app)/admin/phorest/+page.svelte",
  "src/routes/(app)/admin/phorest/+page.svelte",
);
const CONNECTION = read(
  "../lib/components/admin/phorest/PhorestConnectionPanel.svelte",
  "src/lib/components/admin/phorest/PhorestConnectionPanel.svelte",
);
const RULES = read("../lib/settings/phorest.ts", "src/lib/settings/phorest.ts");

/** Script and markup without comments, so prose in a comment can never trip or hide a pin. */
function code(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const PANEL_CODE = code(CONNECTION);
const PAGE_CODE = code(PAGE);

describe("D-07 - Phorest credentials stay button-gated", () => {
  // Phorest credentials are security configuration and stay behind a button whatever the control looks
  // like (109-CONTEXT.md D-07) - the same rule that keeps SMTP and the password policy button-gated.
  it("save is wired to the SaveBar only, never to a change handler", () => {
    expect(PANEL_CODE).toContain("onSave={save}");
    expect(PANEL_CODE).not.toMatch(/on(?:change|blur|input)=\{save\}/);
  });

  it("the automatic-sync switch saves nothing by itself", () => {
    const toggle = PANEL_CODE.slice(PANEL_CODE.indexOf("<ToggleField"));
    expect(toggle.slice(0, toggle.indexOf("/>"))).not.toContain("onchange");
  });
});

describe("the config PUT census - the nine keys of one registry section", () => {
  const KEYS = [
    "phorestBusinessId",
    "phorestUsername",
    "phorestPassword",
    "phorestAutoSync",
    "phorestSyncCron",
    "phorestSyncWindowDays",
    "phorestPrepMinutes",
    "phorestWrapupMinutes",
    "branchId",
  ];

  it("the registry holds the nine keys once, in the section this panel renders", () => {
    const section = settingsSection("phorest-verbindung");
    expect([...section.keys].sort()).toEqual([...KEYS].sort());
    expect(section.endpoint).toBe("/integrations/phorest/config");
    expect(section.renderedBy).toBe("lib/components/admin/phorest/PhorestConnectionPanel.svelte");
  });

  it("the PUT body is the section's own fields, picked by the registry, never a spread", () => {
    expect(PANEL_CODE).toMatch(
      /api\.put\(\s*"\/integrations\/phorest\/config",\s*pickSection\([\s\S]*?settingsSection\("phorest-verbindung"\)\.keys/,
    );
  });

  it("the ninth field, branchId, is sent only while the Branch-ID is editable (Issue #65, D-20)", () => {
    expect(RULES).toContain("...(branchEditable ? { branchId: values.branchId.trim() } : {})");
    expect(PANEL_CODE).toContain("phorestWire(values, { branchEditable: phBranchIdEditable })");
  });

  it("the password goes along only when one was typed", () => {
    expect(RULES).toContain('...(values.phorestPassword !== "" ? { phorestPassword');
  });
});

describe("D-20 - Branch-ID input locks for multi-salon tenants (Phase 65b, issue #65)", () => {
  it("the Branch-ID input is disabled when phBranchIdEditable is false", () => {
    expect(PANEL_CODE).toContain("disabled={!phBranchIdEditable || saving}");
  });

  it("the multi-salon hint renders under the Branch-ID input", () => {
    expect(PANEL_CODE).toContain(
      "Mehrere aktive Salons — die Phorest-Filiale wird je Salon gekoppelt.",
    );
  });

  it("the sources contain no reference to the deprecated TenantConfig branch key", () => {
    expect(PANEL_CODE).not.toContain("phorestBranchId");
    expect(RULES).not.toContain("phorestBranchId");
  });
});

describe("the mapping table is pre-filled with server suggestions (not user edits)", () => {
  it("a row seeds the selection from saved-or-suggested", () => {
    expect(RULES).toContain("item.savedEmployeeId ?? item.suggestedEmployeeId");
  });

  it("a suggested-but-unsaved row is classified as 'suggested'", () => {
    expect(RULES.slice(RULES.indexOf("export function mappingStatus"))).toContain('"suggested"');
  });

  it("saving a row promotes the selection to saved on success", () => {
    const body = PANEL_CODE.slice(PANEL_CODE.indexOf("async function saveRow"));
    expect(body).toContain("row.savedEmployeeId = row.selectedEmployeeId");
  });

  // A naive `selected !== saved` dirty count would report the page as unsaved right after load for every
  // suggested row: the baseline is the selection AS LOADED. The password may only ever count as a change by
  // being typed; its value never enters the snapshot.
  it("the unsaved count compares with the loaded selection, not with the saved mapping", () => {
    const body = RULES.slice(RULES.indexOf("export function unsavedMappingCount"));
    expect(body).toContain("row.baselineEmployeeId");
    expect(body.slice(0, body.indexOf("\n}"))).not.toContain("savedEmployeeId");
  });

  it("the password is never hydrated from the server", () => {
    const load = PANEL_CODE.slice(
      PANEL_CODE.indexOf("async function loadConfig"),
      PANEL_CODE.indexOf("async function save()"),
    );
    expect(load).not.toContain("phorestPassword");
    expect(RULES).toContain('phorestPassword: "",');
  });
});

describe("AK-02 - no text/number input writes inline on this page", () => {
  function textOrNumberInputHandlers(source: string): string[] {
    const found: string[] = [];
    for (const tag of source.match(/<input\b[\s\S]*?>/g) ?? []) {
      const type = tag.match(/type="([a-z]+)"/)?.[1];
      if (type !== "number" && type !== "text") continue;
      for (const m of tag.matchAll(/on(?:blur|change|input)=\{(\w+)\}/g)) found.push(m[1]);
    }
    return found;
  }

  it("no text/number input of the page or the panel carries an inline write handler", () => {
    expect(textOrNumberInputHandlers(PAGE_CODE)).toEqual([]);
    expect(textOrNumberInputHandlers(PANEL_CODE)).toEqual([]);
  });
});

describe("D-11/D-12 - unsaved markers and guard registration on admin/phorest", () => {
  it("the page registers ONE marker from the panel's change count and de-registers on unmount", () => {
    expect((PAGE_CODE.match(/markUnsaved\("admin-phorest"/g) ?? []).length).toBe(2);
    expect(PAGE_CODE).toContain('markUnsaved("admin-phorest", connectionChanges > 0)');
    expect(PAGE_CODE).toContain('return () => markUnsaved("admin-phorest", false)');
    expect(PANEL_CODE).not.toContain("markUnsaved");
  });

  it("the change counts are derived, never hand-set", () => {
    expect(PANEL_CODE).toContain(
      "const configChanges = $derived(countChanges(snapshot, values, keys))",
    );
    expect(PANEL_CODE).toContain("const mappingChanges = $derived(unsavedMappingCount(mapRows))");
    expect(PANEL_CODE).not.toMatch(/^\s*(?:configChanges|mappingChanges)\s*=[^=]/m);
  });

  it("the snapshot is taken on load and on a successful save only, never in a finally block", () => {
    const lines = PANEL_CODE.split("\n");
    const takes = lines.flatMap((line, i) => (/^\s*snapshot = /.test(line) ? [i] : []));
    expect(takes.length).toBe(2);
    for (const i of takes) {
      const before = lines.slice(Math.max(0, i - 3), i).join("\n");
      expect(
        before,
        `line ${i + 1}: a "finally" appears within 3 lines above a snapshot reset`,
      ).not.toContain("finally");
    }
    const save = PANEL_CODE.slice(PANEL_CODE.indexOf("async function save()"));
    expect(save.indexOf("snapshot = saved")).toBeGreaterThan(-1);
    expect(save.indexOf("snapshot = saved")).toBeLessThan(save.indexOf("} catch"));
  });

  it("removing a mapping moves the row's baseline", () => {
    const body = PANEL_CODE.slice(PANEL_CODE.indexOf("async function confirmRemove"));
    expect(body).toContain("row.baselineEmployeeId = row.selectedEmployeeId");
  });
});
