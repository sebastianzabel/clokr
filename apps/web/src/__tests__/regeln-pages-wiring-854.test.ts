// Issue #854 (plan 854-08) - source pins of Regeln › Monatsabschluss and Regeln › Benachrichtigungen & E-Mail,
// the sibling of arbeitszeit-save-wiring-854.test.ts. The pages cannot be mounted here (no `$app` alias), so
// this reads the sources:
//  - each page registers ONE unsaved id, gated on a loaded baseline, and cleans it up;
//  - every section is shown only under `mayOpenSection` of its registry section (D-854-05) and rendered by an
//    imported component;
//  - every section component sends its PUT only as `pickSection(…, settingsSection("<its id>").keys)` (#878);
//  - no text/number input writes inline (D-02, docs/ADMIN_STRUCTURE.md §3.2.1);
//  - the SMTP password is write-only (T-854-22) and no environment variable name appears in a text.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { APP_ROUTES } from "$lib/nav/routes";
import { SETTINGS_SECTIONS, pageAlternatives, sectionsOfPage } from "$lib/settings/settings-pages";

import { SRC_ROOT } from "./design-source-files";

const read = (rel: string) => readFileSync(join(SRC_ROOT, rel), "utf8");

const PAGES = [
  {
    href: "/verwalten/regeln/monatsabschluss",
    rel: "routes/(app)/verwalten/regeln/monatsabschluss/+page.svelte",
    unsavedId: "regeln-monatsabschluss",
    sectionIds: ["monatsabschluss-luecken", "monatsabschluss-pausen"],
  },
  {
    href: "/verwalten/regeln/benachrichtigungen",
    rel: "routes/(app)/verwalten/regeln/benachrichtigungen/+page.svelte",
    unsavedId: "regeln-benachrichtigungen",
    sectionIds: [
      "benachrichtigungen-smtp",
      "benachrichtigungen-email",
      "benachrichtigungen-erinnerungen",
    ],
  },
] as const;

describe.each(PAGES)("$href", ({ href, rel, unsavedId, sectionIds }) => {
  const page = read(rel);
  const sections = sectionsOfPage(href);

  it("has exactly the planned sections registered (not vacuous)", () => {
    expect(sections.map((s) => s.id)).toEqual([...sectionIds]);
  });

  it("opens under the union of its sections' permission alternatives (D-854-05)", () => {
    const route = APP_ROUTES.find((entry) => entry.href === href);
    expect(route?.requires).toEqual(pageAlternatives(href));
  });

  it("registers one unsaved id, gated on a loaded baseline, and cleans it up", () => {
    expect(page.match(/markUnsaved\("/g)?.length).toBe(2);
    expect(page).toContain(`markUnsaved("${unsavedId}", snapshotsReady && totalChanges > 0)`);
    expect(page).toContain(`return () => markUnsaved("${unsavedId}", false)`);
  });

  it.each(sections.map((s) => [s.id, s] as const))(
    "%s: shown only under mayOpenSection, rendered by an imported component",
    (id, section) => {
      expect(page).toContain(`mayOpenSection(user, settingsSection("${id}"))`);
      const component = section.renderedBy.split("/").at(-1)!.replace(".svelte", "");
      expect(page).toContain(`import ${component} from`);
      expect(page).toMatch(new RegExp(`<${component}\\s`));
    },
  );

  it("sums the section counts into one registration", () => {
    expect(page).toContain("const totalChanges = $derived(");
    expect(page.match(/bind:changes=\{changes\./g)?.length).toBe(sections.length);
  });

  const files = [...new Set(sections.map((s) => s.renderedBy))];

  it.each(files)("%s sends its PUT only as its own section", (file) => {
    const source = read(file);
    const puts = [...source.matchAll(/api\.put(?:<[^()]*>)?\(\s*"([^"]+)",/g)];
    expect(puts.length).toBeGreaterThanOrEqual(1);
    const mine = SETTINGS_SECTIONS.filter((s) => s.renderedBy === file).map((s) => s.id);
    for (const match of puts) {
      const rest = source.slice(match.index!, match.index! + 400);
      const picked = /settingsSection\(\s*"([^"]+)"\s*\)\.keys/.exec(rest)?.[1];
      expect(
        picked,
        `${file}: a PUT that is not pickSection(…, settingsSection(id).keys)`,
      ).toBeDefined();
      expect(mine).toContain(picked);
    }
    expect(source).not.toMatch(/api\.put\([^)]*\.\.\./);
  });

  it.each(files)("%s: no text/number input writes inline (D-02)", (file) => {
    for (const tag of read(file).match(/<input\b[\s\S]*?>/g) ?? []) {
      const type = tag.match(/type="([a-z]+)"/)?.[1];
      if (type !== "number" && type !== "text") continue;
      expect(tag).not.toMatch(/\bon(?:blur|change|input)=/);
    }
  });
});

describe("Regeln › Benachrichtigungen & E-Mail", () => {
  const smtp = read("lib/components/admin/benachrichtigungen/SmtpSection.svelte");
  const page = read("routes/(app)/verwalten/regeln/benachrichtigungen/+page.svelte");

  it("T-854-22: the SMTP password is never read back into the form or logged", () => {
    // The form value comes from smtpFrom(), which sets it to "" - the loaded config has no password.
    expect(read("lib/settings/benachrichtigungen.ts")).toContain('smtpPassword: "",');
    expect(smtp).toContain('type="password"');
    expect(smtp).not.toMatch(/console\./);
    expect(smtp).not.toMatch(/config\.smtpPassword\b/);
  });

  it("the test mail posts to the dedicated endpoint", () => {
    expect(smtp).toContain('api.post("/settings/smtp/test"');
  });

  it("each endpoint is loaded only for a section the person may open", () => {
    expect(page).toContain("show.smtp &&");
    expect(page).toContain("show.email &&");
    expect(page).toContain("show.erinnerungen &&");
  });

  it("no environment variable name (SMTP_*) appears in the files", () => {
    for (const file of [
      "lib/components/admin/benachrichtigungen/SmtpSection.svelte",
      "lib/components/admin/benachrichtigungen/EmailSection.svelte",
      "lib/components/admin/benachrichtigungen/RemindersSection.svelte",
      "routes/(app)/verwalten/regeln/benachrichtigungen/+page.svelte",
    ]) {
      expect(read(file), file).not.toMatch(/\bSMTP_[A-Z_]+\b/);
    }
  });
});
