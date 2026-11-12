// Phase 109 (Issue #35) / Issue #854 (plan 854-11) - source pins for the page `admin/vacation/+page.svelte`,
// which is Verwalten › Regeln › Abwesenheiten since plan 854-11, and its panels.
//
// Source-read pins, not behaviour tests: `apps/web/vitest.config.ts` has no `$app` alias, so a route page
// cannot be mounted (see `nav-guard.test.ts` for the established precedent of reading route source with
// `readFileSync`). Until plan 854-11 the page saved 43 fields (later 20) with ONE `saveGlobal`; it now has no
// page-wide save. Each section of the panels saves only its own registry keys - the section census itself is
// proven for every file by `settings-pages-854.test.ts` (one place per key, own fields only, gates); what stays
// here is what is specific to this page: the 20 keys are all still saved somewhere, the unsaved registration,
// and the click-only saves.

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { sectionsOfPage, settingsSection } from "$lib/settings/settings-pages";

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
  "../routes/(app)/admin/vacation/+page.svelte",
  "src/routes/(app)/admin/vacation/+page.svelte",
);
const PANEL_FILES = ["UrlaubPanel", "UebertragPanel"] as const;
const SONDERURLAUB = readSource(
  "../lib/components/admin/abwesenheiten/SonderurlaubPanel.svelte",
  "src/lib/components/admin/abwesenheiten/SonderurlaubPanel.svelte",
);
const PANELS = Object.fromEntries(
  PANEL_FILES.map((name) => [
    name,
    readSource(
      `../lib/components/admin/abwesenheiten/${name}.svelte`,
      `src/lib/components/admin/abwesenheiten/${name}.svelte`,
    ),
  ]),
) as Record<(typeof PANEL_FILES)[number], string>;

// The 20 keys the former page-wide `saveGlobal` carried after the working-time defaults (plan 854-07), the
// reminders (plans 854-08 and 854-10) had left it. Issue #435 D-03 added defaultApprenticeVacationDays,
// Issue #835 leavePlanDeadlineLocksWishes.
const FORMER_SAVE_GLOBAL_KEYS = [
  "autoCalcPartTimeVacation",
  "carryOverDeadlineDay",
  "carryOverDeadlineMonth",
  "carryOverRequiresReason",
  "carryoverWarningEnabled",
  "carryoverWarningThresholds",
  "christmasEveRule",
  "defaultApprenticeVacationDays",
  "defaultVacationDays",
  "enforceMinVacation",
  "fullTimeWorkDaysPerWeek",
  "halfDayAllowed",
  "holidayRulesValidFromYear",
  "leavePlanDeadlineLocksWishes",
  "newYearsEveRule",
  "sickNoteRequiredAfterDays",
  "sickSelfReport",
  "vacationLeadTimeDays",
  "vacationMaxAdvanceMonths",
  "vacationReminderStartMonth",
] as const;

const SETTINGS_SECTIONS = sectionsOfPage("/verwalten/regeln/abwesenheiten").filter(
  (section) => section.endpoint !== null,
);

describe("D-854-04 - the page-wide save is gone", () => {
  it("the page and its panels have no saveGlobal, no sticky global save bar and no page-wide snapshot", () => {
    for (const [name, source] of Object.entries({ page: PAGE, ...PANELS })) {
      expect(source, name).not.toContain("saveGlobal");
      expect(source, name).not.toContain("vac-save-bar");
      expect(source, name).not.toContain("globalSnapshot");
      expect(source, name).not.toContain("globalDirty");
    }
  });

  it("the sections with settings are the six of the registry, each saving through pickSection of its own id", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual([
      "abwesenheiten-anspruch",
      "abwesenheiten-antraege",
      "abwesenheiten-krankheit",
      "abwesenheiten-feiertage",
      "abwesenheiten-uebertrag",
      "abwesenheiten-verfallswarnung",
    ]);
    for (const section of SETTINGS_SECTIONS) {
      const source = section.renderedBy.endsWith("UrlaubPanel.svelte")
        ? PANELS.UrlaubPanel
        : PANELS.UebertragPanel;
      expect(source, section.id).toContain(`settingsSection("${section.id}").keys`);
    }
    // One request per section: the six pickSection saves are the only settings writes.
    const puts = Object.values(PANELS).flatMap(
      (s) => s.match(/api\.put\(\s*"\/settings\/work"/g) ?? [],
    );
    expect(puts).toHaveLength(6);
  });

  it("no setting was lost: the sections together carry exactly the 20 keys of the former page-wide save", () => {
    const keys = SETTINGS_SECTIONS.flatMap((s) => [...s.keys]).sort();
    expect(keys).toEqual([...FORMER_SAVE_GLOBAL_KEYS].sort());
  });
});

describe("D-01 - a section saves only on its SaveBar button", () => {
  it.each([
    ["UrlaubPanel", ["saveAnspruch", "saveAntraege", "saveKrankheit", "saveFeiertage"]],
    ["UebertragPanel", ["saveUebertrag", "saveVerfall"]],
  ] as const)("%s: %j are onSave handlers, never onchange", (file, names) => {
    for (const name of names) {
      expect(PANELS[file]).toContain(`onSave={${name}}`);
      expect(PANELS[file]).not.toContain(`onchange={${name}}`);
    }
  });
});

describe("Sonderurlaub - the rules are a management section with their own endpoints", () => {
  it("the panel writes rules only through a Dialog form (POST create, PUT edit) and loads them lazily", () => {
    expect(SONDERURLAUB).toContain('api.post("/special-leave/rules"');
    expect(SONDERURLAUB).toContain("api.put(`/special-leave/rules/${editing.id}`");
    expect(SONDERURLAUB).toContain('api.get<SpecialLeaveRule[]>("/special-leave/rules")');
    expect(SONDERURLAUB).toContain("onsubmit={(event) => {");
    expect(SONDERURLAUB).toContain("if (active && !loaded)");
    // No tenant setting is written from the panel: the registry section has no keys.
    expect(SONDERURLAUB).not.toMatch(/api\.put\(\s*"\/settings\//);
    expect(SONDERURLAUB).not.toMatch(/onchange=\{save/);
  });

  it("the page holds no Sonderurlaub code of its own any more", () => {
    for (const forbidden of [
      "slRules",
      "saveSLCreate",
      "saveSLEdit",
      "<Modal",
      "<Section",
      "SectionStack",
    ])
      expect(PAGE, forbidden).not.toContain(forbidden);
    expect(PAGE).toContain("<SonderurlaubPanel");
    expect(settingsSection("abwesenheiten-sonderurlaub")).toMatchObject({
      endpoint: null,
      keys: [],
      source: "/admin/special-leave",
    });
  });
});

describe("D-11/D-12 - unsaved marker and guard registration on admin/vacation", () => {
  it("one registration sums the counts of both panels", () => {
    const registrations = PAGE.match(/markUnsaved\("admin-vacation"/g) ?? [];
    // one in the effect, one in its cleanup
    expect(registrations).toHaveLength(2);
    expect(PAGE).toContain(
      'markUnsaved("admin-vacation", snapshotsReady && urlaubChanges + uebertragChanges > 0)',
    );
    for (const name of PANEL_FILES) expect(PAGE, name).toContain(`bind:changes=`);
  });

  it("the registration is gated on snapshotsReady, which is set only after a successful load (WR-01)", () => {
    expect(PAGE).not.toMatch(/markUnsaved\("admin-vacation", (?!snapshotsReady|false)/);
    const load = PAGE.slice(PAGE.indexOf("async function loadConfig"));
    const tryAt = load.indexOf("try {");
    const catchAt = load.indexOf("} catch");
    expect(load.slice(tryAt, catchAt)).toContain("snapshotsReady = true");
    expect(load.slice(catchAt)).not.toMatch(/snapshotsReady\s*=\s*true/);
  });

  it("the effect de-registers on unmount", () => {
    expect(PAGE).toContain('return () => markUnsaved("admin-vacation", false)');
  });

  it("each panel reports the sum of its sections' counts through a bindable `changes`", () => {
    expect(PANELS.UrlaubPanel).toContain(
      "changes = anspruchChanges + antraegeChanges + krankheitChanges + feiertageChanges",
    );
    expect(PANELS.UebertragPanel).toContain("changes = uebertragChanges + verfallChanges");
  });

  it("the registry id is unique across admin routes", () => {
    function adminPageFiles(): string[] {
      const candidates = [
        () => fileURLToPath(new URL("../routes/(app)/admin", import.meta.url)),
        () => resolve(process.cwd(), "src/routes/(app)/admin"),
      ];
      for (const getDir of candidates) {
        try {
          const dir = getDir();
          return (readdirSync(dir, { recursive: true }) as string[])
            .filter((f) => f.endsWith("+page.svelte"))
            .map((f) => resolve(dir, f));
        } catch {
          continue;
        }
      }
      throw new Error("could not locate src/routes/(app)/admin from either candidate path");
    }

    const files = adminPageFiles();
    // Phase 235 (Group D, D-02/D-05) - non-emptiness on the walked set itself, distinct from the
    // "exactly one hit" assertion below on the FILTERED (output) set.
    expect(
      files.length,
      "no admin page scanned - src/routes/(app)/admin moved or emptied",
    ).toBeGreaterThan(0);
    const hits = files.filter((f) =>
      readFileSync(f, "utf8").includes('markUnsaved("admin-vacation"'),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("vacation");
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

  it("no text/number input of the page or its panels carries an inline write handler", () => {
    for (const [name, source] of Object.entries({ page: PAGE, ...PANELS })) {
      expect(textOrNumberInputHandlers(source), name).toEqual([]);
    }
  });

  it("is not vacuous: the panels hold number and text inputs", () => {
    const inputs = Object.values(PANELS).flatMap((s) => s.match(/type="(number|text)"/g) ?? []);
    expect(inputs.length).toBeGreaterThanOrEqual(8);
  });
});

// Issue #854 (plan 854-10): the shift reminders (Issue #609, D-01/D-15) left this page together with the
// Erinnerungen tab; the clamp rule, the three-tuple rule of the snapshot and the D-15 hint are pinned where
// they live now (`dienstplan-settings-854.test.ts`, section dienstplan-erinnerungen).
describe("Issue #854 - the shift reminders no longer live on admin/vacation", () => {
  it("names none of the five reminder keys and has no Erinnerungen tab", () => {
    for (const name of [
      "reminderShiftStartEnabled",
      "reminderShiftEndEnabled",
      "reminderDayCloseEnabled",
      "reminderOffsetMinutes",
      "reminderDayCloseTime",
      "clampReminderOffsetInput",
    ])
      for (const [file, source] of Object.entries({ page: PAGE, ...PANELS }))
        expect(source, `${file}: ${name}`).not.toContain(name);
    expect(PAGE).not.toContain('id: "erinnerungen"');
    expect(PAGE).not.toContain('title="Schicht-Erinnerungen"');
  });
});
