// Issue #563 - source pins for the tenant salon admin pages and the reduced admin/system section.
//
// Routes cannot be mounted (`apps/web/vitest.config.ts` has no `$app` alias, see
// `admin-system-save-wiring.test.ts` and `layout-boundaries.test.ts`), so the page contract is read
// from source: the exact PATCH body, the context reload after a successful write, the unsaved
// registration, the rights call, the operator isolation and the shape of admin/system.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  const fromHere = fileURLToPath(new URL(relativeFromHere, import.meta.url));
  const path = existsSync(fromHere) ? fromHere : resolve(process.cwd(), relativeFromCwd);
  // A missing page must fail the pin with a clear message instead of throwing before `expect`.
  expect(existsSync(path), `page source missing: ${relativeFromCwd}`).toBe(true);
  return readFileSync(path, "utf8");
}

const DETAIL = readRouteFile(
  "../routes/(app)/admin/salons/[id]/+page.svelte",
  "src/routes/(app)/admin/salons/[id]/+page.svelte",
);
const LIST = readRouteFile(
  "../routes/(app)/admin/salons/+page.svelte",
  "src/routes/(app)/admin/salons/+page.svelte",
);
const SYSTEM = readRouteFile(
  "../routes/(app)/admin/system/+page.svelte",
  "src/routes/(app)/admin/system/+page.svelte",
);

/** The text of `signature { ... }` up to its matching closing brace. */
function fnBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
}

describe("salon detail page - the hours write", () => {
  const SAVE = () => fnBody(DETAIL, "async function saveHours");

  it("builds its PATCH body with salonPatch limited to openingHours, so it can only carry that key", () => {
    const body = SAVE();
    expect(body).toContain('salonPatch(salon, form, ["openingHours"])');
    const patchCall = /api\.patch\(\s*`\/salons\/\$\{[^`]*\}`\s*,\s*([^)]*)\)/.exec(body);
    expect(patchCall, "api.patch(`/salons/${...}`, <patch>) not found").not.toBeNull();
    expect(patchCall?.[1].trim()).toBe("patch");
  });

  it("reloads the salon context with force: true after the PATCH succeeded", () => {
    const body = SAVE();
    const patchAt = body.indexOf("api.patch(");
    const reloadAt = body.indexOf("await refreshSalonContext()");
    expect(patchAt).toBeGreaterThanOrEqual(0);
    expect(reloadAt).toBeGreaterThan(patchAt);
    const helper = fnBody(DETAIL, "async function refreshSalonContext");
    expect(helper).toMatch(/salonContext\.load\([^)]*\{\s*force:\s*true\s*\}\s*\)/);
  });

  it("validates before it sends", () => {
    const body = SAVE();
    expect(body.indexOf("validateOpeningHours(")).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("validateOpeningHours(")).toBeLessThan(body.indexOf("api.patch("));
  });

  it("registers unsaved state gated on the baseline and de-registers on unmount", () => {
    expect(DETAIL).toContain('markUnsaved("admin-salon-detail", snapshotsReady && ');
    expect(DETAIL).toContain('markUnsaved("admin-salon-detail", false)');
  });

  it("decides what it shows by salonAdminRights() and uses the shared editor", () => {
    expect(DETAIL).toContain("salonAdminRights(");
    expect(importSpecifiers(DETAIL)).toContain("$lib/components/admin/OpeningHoursEditor.svelte");
  });
});

describe("salon detail page - create mode (D-06)", () => {
  const CREATE = () => fnBody(DETAIL, "async function createSalon");

  it("posts createSalonBody(form) to /salons, once, and nowhere else", () => {
    const body = CREATE();
    expect(body).toContain('api.post("/salons", createSalonBody(form))');
    expect((DETAIL.match(/api\.post\(/g) ?? []).length).toBe(1);
  });

  it("validates in create mode before it posts", () => {
    const body = CREATE();
    expect(body.indexOf('validateSalonForm(form, "create")')).toBeGreaterThanOrEqual(0);
    expect(body.indexOf('validateSalonForm(form, "create")')).toBeLessThan(
      body.indexOf("api.post("),
    );
  });

  it("reloads the salon context before it navigates to the new salon", () => {
    const body = CREATE();
    const postAt = body.indexOf("api.post(");
    const reloadAt = body.indexOf("await refreshSalonContext()");
    const gotoAt = body.indexOf("goto(");
    expect(postAt).toBeGreaterThanOrEqual(0);
    expect(reloadAt).toBeGreaterThan(postAt);
    expect(gotoAt).toBeGreaterThan(reloadAt);
  });

  it("clears the unsaved registration before the navigation", () => {
    const body = CREATE();
    const clearAt = body.indexOf('markUnsaved("admin-salon-detail", false)');
    expect(clearAt).toBeGreaterThanOrEqual(0);
    expect(clearAt).toBeLessThan(body.indexOf("goto("));
  });

  it("has exactly one create submit button", () => {
    expect((DETAIL.match(/onclick=\{createSalon\}/g) ?? []).length).toBe(1);
    expect(DETAIL).toContain("Salon anlegen");
  });

  it("shows the create form only to a caller who may manage salons", () => {
    expect(DETAIL).toMatch(/isCreate && !rights\.canManage/);
    expect(DETAIL).toContain("Für das Anlegen von Salons fehlt Ihnen die Berechtigung.");
  });
});

describe("salon detail page - master data (Stammdaten)", () => {
  const SAVE = () => fnBody(DETAIL, "async function saveMasterData");

  it("PATCHes the changed keys from salonPatch(), restricted to the master-data keys", () => {
    const body = SAVE();
    expect(body).toContain("salonPatch(salon, form, MASTER_KEYS)");
    const patchCall = /api\.patch\(\s*`\/salons\/\$\{[^`]*\}`\s*,\s*([^)]*)\)/.exec(body);
    expect(patchCall?.[1].trim()).toBe("patch");
    const keys = /const MASTER_KEYS[^=]*=\s*\[([^\]]*)\]/.exec(DETAIL);
    expect(keys, "MASTER_KEYS not found").not.toBeNull();
    expect(keys?.[1]).not.toContain("openingHours");
    expect(keys?.[1]).toContain('"federalState"');
  });

  it("never sends an empty body: a null patch stops with a hint", () => {
    const body = SAVE();
    expect(body.indexOf("if (!patch)")).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("if (!patch)")).toBeLessThan(body.indexOf("api.patch("));
  });

  it("reloads the salon context after the PATCH succeeded", () => {
    const body = SAVE();
    expect(body.indexOf("await refreshSalonContext()")).toBeGreaterThan(body.indexOf("api.patch("));
  });

  it("decides the Bundesland lock by status and err.data code, resets the select and locks it", () => {
    const body = SAVE();
    expect(body).toMatch(/err\.status === 409 && data\?\.code === "FEDERAL_STATE_IN_USE"/);
    expect(body).toContain("err.data");
    expect(body).toContain("form.federalState = salon.federalState");
    expect(body).toContain("federalStateLocked = true");
    expect(DETAIL).toMatch(/disabled=\{!rights\.canManage \|\| federalStateLocked\}/);
  });

  it("has its own save button and section state, next to the hours section", () => {
    expect(DETAIL).toContain("onclick={saveMasterData}");
    expect(DETAIL).toContain("onclick={saveHours}");
    expect(DETAIL).toContain("dirty={masterDirty}");
    expect(DETAIL).toContain("dirty={hoursDirty}");
  });
});

describe("salon pages - no control flow on display text", () => {
  it("neither page compares or searches a message", () => {
    for (const source of [DETAIL, LIST]) {
      expect(source).not.toMatch(/message\s*===/);
      expect(source).not.toContain(".message.includes(");
      expect(source).not.toContain("message.startsWith(");
      expect(source).not.toMatch(/err\.message\s*(===|!==|==)/);
    }
  });

  it("every write control of the detail page is gated by canManage", () => {
    const disabledInputs = (DETAIL.match(/disabled=\{!rights\.canManage/g) ?? []).length;
    // name, street, postal code, city, federal state (+ the editor)
    expect(disabledInputs).toBeGreaterThanOrEqual(6);
    expect(DETAIL).toMatch(/footer=\{rights\.canManage && !isCreate \? masterFooter : undefined\}/);
    expect(DETAIL).toMatch(/footer=\{rights\.canManage \? hoursFooter : undefined\}/);
  });
});

describe("salon pages - isolation and escaping", () => {
  it("no import specifier of either page names the operator console", () => {
    for (const source of [DETAIL, LIST]) {
      for (const specifier of importSpecifiers(source)) {
        expect(specifier.toLowerCase()).not.toContain("operator");
      }
    }
  });

  it("neither page renders raw HTML", () => {
    expect(DETAIL).not.toContain("{@html");
    expect(LIST).not.toContain("{@html");
  });
});

describe("salon list page", () => {
  it("fetches every salon, titles itself 'Salons' and holds no unsaved state", () => {
    expect(LIST).toContain("/salons?includeInactive=true");
    expect(LIST).toContain('title="Salons"');
    expect(LIST).not.toContain("markUnsaved(");
  });

  it("shows the Bundesland per salon through the one label function", () => {
    expect(LIST).toContain("federalStateLabel(");
    expect(LIST).toContain("<th>Bundesland</th>");
  });

  it("offers 'Salon anlegen' only inside a canManage condition, linking to the create route", () => {
    expect(LIST).toContain("salonAdminRights(");
    const link = LIST.indexOf('href="/admin/salons/neu"');
    expect(link).toBeGreaterThanOrEqual(0);
    const gate = LIST.lastIndexOf("{#if rights.canManage}", link);
    expect(gate).toBeGreaterThanOrEqual(0);
    // the gate closes after the link and nothing else closes in between
    const between = LIST.slice(gate, link);
    expect(between).not.toContain("{/if}");
    expect(LIST.slice(link)).toContain("Salon anlegen");
  });
});

describe("admin/system keeps only the shift check mode (D-12)", () => {
  it("no longer holds the opening-hours editor or any tenant-level hours", () => {
    expect(SYSTEM).not.toContain("OpeningHoursEditor");
    expect(SYSTEM).not.toMatch(/\bstoreHours\b/);
  });

  it("still renders the three shiftStoreHoursMode radios", () => {
    expect((SYSTEM.match(/name="shiftStoreHoursMode"/g) ?? []).length).toBe(3);
  });

  it("saves the mode with the minimal payload, never the full other-fields spread", () => {
    const body = fnBody(SYSTEM, "async function saveShiftHoursMode");
    expect(body).toContain('api.put("/settings/work"');
    expect(body).toContain("shiftStoreHoursMode");
    expect(body).not.toContain("_gOtherFields");
  });
});
