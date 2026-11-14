// Issue #83 (D-10, D-14, D-16), since #844 the Verwalten area — one item list for Sidebar and the mobile Mehr
// sheet, filtered per item by the route table, plus source-level wiring of the three navigation consumers
// (Sidebar and CommandPalette import `$app/*` and are not mountable here). Expected lists are HAND-WRITTEN.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { visibleAdminNavItems } from "../admin-route-permissions";
import { APP_ROUTES, visibleChildren } from "../routes";
import personas from "./fixtures/system-role-permissions.json";

function webSrc(): string {
  try {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    if (existsSync(join(root, "app.html"))) return root;
  } catch {
    // fall through to the cwd-based root
  }
  return resolve(process.cwd(), "src");
}

const SRC = webSrc();
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const p = personas as Record<string, string[]>;
const on = { availabilityEnabled: true };
/** The page H1: the page-labels lookup of the page's own route file (Issue #574, #844). */
const titleOf = (file: string) => new RegExp(`title=\\{pageLabel\\("${file}"\\)\\}`);
const labelsOf = (hub: string) =>
  visibleChildren({ permissions: p.ADMIN }, hub, on).map((r) => r.label);

describe("Verwalten navigation (Issue #83, #844)", () => {
  it("the rail lists the seven Verwalten entries of D-04 in order, Salons directly after Personen (#563; Berichte moved to Team, #936)", () => {
    expect(visibleAdminNavItems({ permissions: p.ADMIN }, on).map((i) => i.label)).toEqual([
      "Übersicht",
      "Personen",
      "Salons",
      "Regeln",
      "Monatsabschluss",
      "Daten",
      "System",
    ]);
  });

  it("Daten lists Import, Export, Protokoll, then Support-Zugriffe directly after Protokoll (#93, #574)", () => {
    expect(labelsOf("/verwalten/daten")).toEqual([
      "CSV-Import",
      "Export",
      "Protokoll",
      "Support-Zugriffe",
    ]);
    const support = APP_ROUTES.find((r) => r.file === "/admin/support-access");
    expect(support).toMatchObject({
      href: "/verwalten/daten/support-zugriffe",
      label: "Support-Zugriffe",
      icon: "shield",
    });
  });

  // Issue #854 regrouped the pages one plan at a time; Regeln now lists the five themes of D-854-03 (plan 854-13).
  it("Regeln lists the five themes of D-854-03 and System today's pages", () => {
    expect(labelsOf("/verwalten/regeln")).toEqual([
      "Arbeitszeit & Verträge",
      "Abwesenheiten",
      "Dienstplan",
      "Monatsabschluss",
      "Benachrichtigungen & E-Mail",
    ]);
    expect(labelsOf("/verwalten/system")).toEqual([
      "Allgemein",
      "Branding & Themes",
      "Integrationen",
      "Phorest",
      "Rollen & Rechte",
    ]);
  });

  it("the nav label equals the list page's PageHead title character for character (#93, #563)", () => {
    expect(read("routes/(app)/admin/support-access/+page.svelte")).toMatch(
      titleOf("/admin/support-access"),
    );
    expect(read("routes/(app)/admin/salons/+page.svelte")).toMatch(titleOf("/admin/salons"));
    expect(APP_ROUTES.find((r) => r.file === "/admin/salons")?.label).toBe("Salons");
  });

  it("filters per item and drops a hub without a visible child", () => {
    // Issue #86 (owner decision 16.10.2026): HR holds salon:read, report:read and month-close:read.
    expect(visibleAdminNavItems({ permissions: p.HR }, on).map((i) => i.href)).toEqual([
      "/verwalten",
      "/verwalten/personen",
      "/verwalten/salons",
      "/verwalten/monatsabschluss",
    ]);
    // Issue #836: SALON_MANAGER holds leave-request:approve, so Regeln (Abwesenheiten › Urlaubsgrenzen & Sperren) joins;
    // the team availability moved to the Team area (D-05). #853 (D-853-15): she creates and edits no
    // persons, so her „Personen“ is Team › Personen and the Verwalten rail does not list it.
    expect(visibleAdminNavItems({ permissions: p.SALON_MANAGER }, on).map((i) => i.href)).toEqual([
      "/verwalten",
      "/verwalten/regeln",
    ]);
    expect(
      visibleChildren({ permissions: p.SALON_MANAGER }, "/verwalten/regeln", on).map(
        (r) => r.label,
      ),
    ).toEqual(["Abwesenheiten"]);
    expect(visibleAdminNavItems({ permissions: p.EMPLOYEE }, on)).toEqual([]);
  });

  it("Sidebar, BottomTabBar and CommandPalette read the route table, not the compat role", () => {
    const sidebar = read("lib/components/layout/Sidebar.svelte");
    // Since #516 both variants render `visibleNavSections()` (app-nav.ts), which reads the route table.
    expect(sidebar).toContain("visibleNavSections($authStore.user");
    expect(read("lib/nav/app-nav.ts")).toContain("visibleRoute(user, route, options)");
    expect(sidebar).not.toContain("const adminNav");
    expect(sidebar).not.toMatch(/\$authStore\.user\.role\b/);
    const bar = read("lib/components/layout/BottomTabBar.svelte");
    expect(bar).toContain("visibleNavSections($authStore.user");
    expect(bar).not.toMatch(/\brole\b\s*===|adminMore/);
    const palette = read("lib/components/ui/CommandPalette.svelte");
    expect(palette).toContain("canAccessAdminPath($authStore.user, a.href)");
    expect(palette).not.toMatch(/adminOnly|isManager|\.role\b/);
    expect(palette).toContain('href: "/verwalten/system/rollen"');
  });
});
