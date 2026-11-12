// Issue #563 - source pins for the tenant salon admin pages and the reduced admin/system section.
//
// Routes cannot be mounted (`apps/web/vitest.config.ts` has no `$app` alias, see
// `admin-system-save-wiring.test.ts` and `layout-boundaries.test.ts`), so the page contract is read
// from source: the exact PATCH body, the context reload after a successful write, the unsaved
// registration, the rights call, the operator isolation and the shape of admin/system.
//
// Issue #854: the Stammdaten section and the create form moved out of the page into
// `SalonMasterDataForm.svelte` (FORM below); the page keeps the shell, the hours section, the
// lifecycle actions and the one unsaved registration. Each pin names the file that now owns it.

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
const FORM = readRouteFile(
  "../lib/components/admin/salons/SalonMasterDataForm.svelte",
  "src/lib/components/admin/salons/SalonMasterDataForm.svelte",
);
const LIST = readRouteFile(
  "../routes/(app)/admin/salons/+page.svelte",
  "src/routes/(app)/admin/salons/+page.svelte",
);
const SYSTEM = readRouteFile(
  "../routes/(app)/admin/system/+page.svelte",
  "src/routes/(app)/admin/system/+page.svelte",
);
// Issue #854 (plan 854-10): the shift check mode moved from admin/system to Regeln › Dienstplan › Einstellungen.
const DIENSTPLAN_SETTINGS = readRouteFile(
  "../lib/components/admin/dienstplan/DienstplanSettingsPanel.svelte",
  "src/lib/components/admin/dienstplan/DienstplanSettingsPanel.svelte",
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
    expect(body).toContain('salonPatch(salon, formWithHours(salon), ["openingHours"])');
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
  const CREATE = () => fnBody(FORM, "async function createSalon");
  const AFTER_CREATE = () => fnBody(DETAIL, "async function afterCreate");

  it("posts createSalonBody(form) to /salons, once; the only other posts are the two lifecycle actions", () => {
    const body = CREATE();
    expect(body).toContain('api.post("/salons", createSalonBody(form))');
    expect((body.match(/api\.post\(/g) ?? []).length).toBe(1);
    const targets = [
      ...FORM.matchAll(/api\.post\(\s*([^,)]+)/g),
      ...DETAIL.matchAll(/api\.post\(\s*([^,)]+)/g),
    ].map((m) => m[1].trim());
    expect(targets).toEqual([
      '"/salons"',
      "`/salons/${salon.id}/deactivate`",
      "`/salons/${salon.id}/activate`",
    ]);
  });

  it("validates in create mode before it posts", () => {
    const body = CREATE();
    expect(body.indexOf('validateSalonForm(form, "create")')).toBeGreaterThanOrEqual(0);
    expect(body.indexOf('validateSalonForm(form, "create")')).toBeLessThan(
      body.indexOf("api.post("),
    );
  });

  it("reloads the salon context after the POST and before it hands the created salon to the page", () => {
    const body = CREATE();
    const postAt = body.indexOf("api.post(");
    const reloadAt = body.indexOf("await refreshSalonContext()");
    const handOffAt = body.indexOf("onCreated?.(");
    expect(postAt).toBeGreaterThanOrEqual(0);
    expect(reloadAt).toBeGreaterThan(postAt);
    expect(handOffAt).toBeGreaterThan(reloadAt);
    const helper = fnBody(FORM, "async function refreshSalonContext");
    expect(helper).toMatch(/salonContext\.load\([^)]*\{\s*force:\s*true\s*\}\s*\)/);
  });

  it("the page navigates to the new salon only after the context reload, and clears the unsaved registration first", () => {
    const body = AFTER_CREATE();
    const clearAt = body.indexOf('markUnsaved("admin-salon-detail", false)');
    expect(clearAt).toBeGreaterThanOrEqual(0);
    expect(clearAt).toBeLessThan(body.indexOf("goto("));
    expect(DETAIL).toContain("onCreated={afterCreate}");
  });

  it("has exactly one create submit: the SaveBar of the form, labelled 'Salon anlegen'", () => {
    expect((FORM.match(/onSave=\{isCreate \? createSalon : saveMasterData\}/g) ?? []).length).toBe(
      1,
    );
    expect(FORM).toContain('saveLabel={isCreate ? "Salon anlegen" : "Salon speichern"}');
  });

  it("shows the create form only to a caller who may manage salons", () => {
    expect(DETAIL).toMatch(/isCreate && !rights\.canManage/);
    expect(DETAIL).toContain("Für das Anlegen von Salons fehlt dir die Berechtigung.");
  });
});

describe("salon detail page - master data (Stammdaten)", () => {
  const SAVE = () => fnBody(FORM, "async function saveMasterData");

  it("PATCHes exactly the master-data keys of the section (pickSection), never the hours", () => {
    const body = SAVE();
    const patchCall = /api\.patch\(\s*`\/salons\/\$\{[^`]*\}`\s*,\s*([\s\S]*?)\);/.exec(body);
    expect(patchCall, "api.patch(`/salons/${...}`, <patch>) not found").not.toBeNull();
    expect(patchCall?.[1].replace(/\s+/g, " ").trim()).toBe(
      "pickSection(normalised(values), SALON_MASTER_KEYS),",
    );
    const keys = /const SALON_MASTER_KEYS\s*=\s*\[([^\]]*)\]/.exec(FORM);
    expect(keys, "SALON_MASTER_KEYS not found").not.toBeNull();
    expect(keys?.[1]).not.toContain("openingHours");
    expect(keys?.[1]).toContain('"federalState"');
  });

  it("never sends an empty body: the SaveBar exists only while there is a change, and an invalid form stops before the PATCH", () => {
    const body = SAVE();
    expect(FORM).toContain("changes={changeCount}");
    expect(body.indexOf("hasMessages(liveErrors)")).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("hasMessages(liveErrors)")).toBeLessThan(body.indexOf("api.patch("));
    const bar = readFileSync(
      resolve(process.cwd(), "src/lib/components/ui/SaveBar.svelte"),
      "utf8",
    );
    expect(bar).toContain("{#if changes > 0}");
  });

  it("reloads the salon context after the PATCH succeeded", () => {
    const body = SAVE();
    expect(body.indexOf("await refreshSalonContext()")).toBeGreaterThan(body.indexOf("api.patch("));
  });

  it("decides the Bundesland lock by status and err.data code, resets the select and locks it", () => {
    const body = SAVE();
    expect(body).toMatch(/err\.status === 409 && data\?\.code === "FEDERAL_STATE_IN_USE"/);
    expect(body).toContain("err.data");
    expect(body).toContain("values.federalState = snapshot.federalState");
    expect(body).toContain("federalStateLocked = true");
    expect(FORM).toMatch(/disabled=\{!canEdit \|\| federalStateLocked\}/);
  });

  it("has its own SaveBar and section state, next to the hours section", () => {
    expect(FORM).toContain("<SaveBar");
    expect(FORM).toContain("countChanges(snapshot, values, SALON_MASTER_KEYS)");
    expect(DETAIL).toContain("onSave={saveHours}");
    expect(DETAIL).toContain("changes={hoursChanges}");
    expect(DETAIL).toContain("bind:changes={masterChanges}");
    expect(DETAIL).toContain("const totalChanges = $derived(masterChanges + hoursChanges)");
  });
});

describe("salon detail page - deactivate and activate (D-06)", () => {
  const DEACTIVATE = () => fnBody(DETAIL, "async function deactivateSalon");
  const ACTIVATE = () => fnBody(DETAIL, "async function activateSalon");

  it("deactivates through POST /salons/:id/deactivate and reloads the salon and the salon context after success", () => {
    const body = DEACTIVATE();
    const postAt = body.indexOf("api.post(");
    expect(postAt).toBeGreaterThanOrEqual(0);
    expect(body).toMatch(/api\.post\(\s*`\/salons\/\$\{[^`]*\}\/deactivate`/);
    expect(body.indexOf("await reloadAfterLifecycleWrite()")).toBeGreaterThan(postAt);
    expect(body).toContain("Salon deaktiviert.");
  });

  it("activates through POST /salons/:id/activate and reloads the salon and the salon context after success", () => {
    const body = ACTIVATE();
    const postAt = body.indexOf("api.post(");
    expect(postAt).toBeGreaterThanOrEqual(0);
    expect(body).toMatch(/api\.post\(\s*`\/salons\/\$\{[^`]*\}\/activate`/);
    expect(body.indexOf("await reloadAfterLifecycleWrite()")).toBeGreaterThan(postAt);
    expect(body).toContain("Salon aktiviert.");
  });

  it("the shared reload re-reads the salon, adopts it without touching the form baselines and then reloads the salon context", () => {
    const body = fnBody(DETAIL, "async function reloadAfterLifecycleWrite");
    const getAt = body.indexOf("api.get<SalonDto>(`/salons/${");
    expect(getAt).toBeGreaterThanOrEqual(0);
    expect(body).toContain("adopt(");
    expect(body).toContain("{})");
    expect(body.indexOf("await refreshSalonContext()")).toBeGreaterThan(getAt);
    const helper = fnBody(DETAIL, "async function refreshSalonContext");
    expect(helper).toMatch(/salonContext\.load\([^)]*\{\s*force:\s*true\s*\}\s*\)/);
  });

  it("shows the server's refusal text and rethrows so the dialog stays open, on both actions", () => {
    for (const body of [DEACTIVATE(), ACTIVATE()]) {
      const catchAt = body.indexOf("catch (err");
      expect(catchAt).toBeGreaterThanOrEqual(0);
      const handler = body.slice(catchAt);
      expect(handler).toContain("toasts.error(");
      expect(handler).toContain("err.message");
      expect(handler).toMatch(/throw err/);
    }
  });

  it("has one ConfirmDialog per action, each bound to its handler", () => {
    expect((DETAIL.match(/<ConfirmDialog/g) ?? []).length).toBe(2);
    expect(DETAIL).toContain("onConfirm={deactivateSalon}");
    expect(DETAIL).toContain("onConfirm={activateSalon}");
    expect(DETAIL).toContain('title="Salon deaktivieren?"');
    expect(DETAIL).toContain('title="Salon wieder aktivieren?"');
  });

  it("offers the lifecycle controls only to a caller who may manage salons, in edit mode", () => {
    const zone = DETAIL.indexOf('id="salon-deactivate-title"');
    const section = DETAIL.indexOf('id="salon-activate-title"');
    expect(zone).toBeGreaterThanOrEqual(0);
    expect(section).toBeGreaterThanOrEqual(0);
    for (const at of [zone, section]) {
      const gate = DETAIL.lastIndexOf("{#if", at);
      expect(DETAIL.slice(gate, at)).toMatch(/rights\.canManage/);
      expect(DETAIL.slice(gate, at)).toMatch(/!isCreate/);
    }
  });

  it("disables deactivation with a visible hint when the salon is the tenant's only active one", () => {
    expect(DETAIL).toContain("/salons?includeInactive=true");
    expect(DETAIL).toMatch(/disabled=\{[^}]*isLastActiveSalon[^}]*\}/);
    expect(DETAIL).toContain("Der letzte aktive Salon kann nicht deaktiviert werden.");
  });

  it("never deletes a salon", () => {
    for (const source of [DETAIL, LIST]) {
      expect(source).not.toMatch(/api\.delete\(/);
      expect(source).not.toMatch(/\.delete\(/);
    }
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
    // name, street, postal code, city, federal state: the form disables them without the right
    expect((FORM.match(/disabled=\{!canEdit/g) ?? []).length).toBeGreaterThanOrEqual(5);
    // ... and shows no SaveBar to a reader
    expect(FORM).toMatch(/\{#if canEdit\}\s*<SaveBar/);
    expect(DETAIL).toMatch(/canEdit=\{rights\.canManage\}/);
    // the hours editor: the same right, read-only without it, no SaveBar for a reader
    expect(DETAIL).toMatch(/disabled=\{!rights\.canManage\}/);
    expect(
      readFileSync(
        resolve(process.cwd(), "src/lib/components/admin/OpeningHoursEditor.svelte"),
        "utf8",
      ),
    ).toMatch(/\{#if onSave && !disabled\}\s*<SaveBar/);
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
    expect(LIST).toContain('title={pageLabel("/admin/salons")}'); // Issue #574: from page-labels.ts
    expect(LIST).not.toContain("markUnsaved(");
  });

  it("shows the Bundesland per salon through the one label function", () => {
    expect(LIST).toContain("federalStateLabel(");
    expect(LIST).toContain('{ key: "federalState", label: "Bundesland" }');
  });

  it("reads the CHAIN hint's inputs from the package state and renders the hint component", () => {
    expect(LIST).toMatch(/import ModuleHint from /);
    expect(LIST).toMatch(/import \{[^}]*\bmoduleBooked\b[^}]*\} from "\$stores\/salon-context"/);
    expect(LIST).toContain("moduleBooked(");
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

describe("the shift check mode lives on Regeln › Dienstplan › Einstellungen (D-12, #854)", () => {
  it("admin/system no longer holds the opening-hours editor, any tenant-level hours or the mode", () => {
    expect(SYSTEM).not.toContain("OpeningHoursEditor");
    expect(SYSTEM).not.toMatch(/\bstoreHours\b/);
    expect(SYSTEM).not.toContain("shiftStoreHoursMode");
  });

  it("renders the three shiftStoreHoursMode radios from the choice list", () => {
    expect((DIENSTPLAN_SETTINGS.match(/name="shiftStoreHoursMode"/g) ?? []).length).toBe(1);
    expect(DIENSTPLAN_SETTINGS).toContain("{#each STORE_HOURS_MODES as mode");
  });

  it("saves the mode with the minimal payload, never the full other-fields spread", () => {
    const body = fnBody(DIENSTPLAN_SETTINGS, "async function saveHours");
    expect(body).toContain('api.put(\n        "/settings/work"');
    expect(body).toContain('settingsSection("dienstplan-oeffnungszeiten").keys');
    expect(body).not.toContain("_gOtherFields");
  });
});

describe("salon detail page - section Feiertage (Issue #579)", () => {
  it("mounts the holiday section for an existing salon and decides canManage by salonHolidayRights()", () => {
    expect(importSpecifiers(DETAIL)).toContain("$lib/components/admin/SalonHolidays.svelte");
    expect(DETAIL).toContain("salonHolidayRights(");
    expect(DETAIL).toMatch(
      /<SalonHolidays salonId=\{stored\.id\} canManage=\{holidayRights\.canManage\} \/>/,
    );
    // an existing salon only: the tabs (and with them the calendar) are rendered in the edit branch
    expect(DETAIL).toMatch(/\{:else if salon\}\s*\{@const stored = salon\}\s*<PageTabs/);
  });

  it("keeps the holiday writes out of the page: only the lifecycle and create posts remain", () => {
    expect(DETAIL).not.toContain("/holidays");
  });
});
