// Issue #574 (D-574-09..11) — every page has ONE name, from $lib/nav/page-labels. The Sidebar and
// the "Mehr" sheet (visibleNavSections), the Topbar crumb (labelForPath) and the quick search
// (CommandPalette) must show it; CommandPalette imports `$app/*` and is read as source.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { visibleNavSections } from "$lib/nav/app-nav";
import { PAGE_LABELS, labelForPath, pageLabel, type PageHref } from "$lib/nav/page-labels";
import { APP_ROUTES } from "$lib/nav/routes";
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
const labels = PAGE_LABELS as Record<string, string>;
const allPersonas = Object.entries(personas as Record<string, string[]>);

describe("page-labels: the table", () => {
  it("pageLabel fails closed for an href outside the table", () => {
    expect(() => pageLabel("/nowhere" as PageHref)).toThrow(/no page name/);
  });
  it("labelForPath resolves nested paths to their page and unknown paths to empty", () => {
    // #844: the crumb reads the new URL; a page names itself by its new URL or its route file
    expect(labelForPath("/verwalten/personen/123")).toBe(labels["/verwalten/personen"]);
    expect(labels["/admin/employees"]).toBe(labels["/verwalten/personen"]);
    expect(labelForPath("/verwalten/unknown-page")).toBe(labels["/verwalten"]);
    expect(labelForPath("/nowhere")).toBe("");
  });
});

describe("page-labels: nav labels (Sidebar, Mehr sheet, crumb)", () => {
  // #844: three areas instead of seven groups; the hub children are no rail entries any more
  it("covers at least the 18 rail entries of the admin persona (non-vacuity)", () => {
    const admin = (personas as Record<string, string[]>).ADMIN;
    const items = visibleNavSections({ permissions: admin }, { availabilityEnabled: true }).flatMap(
      (s) => s.items,
    );
    expect(items.length).toBeGreaterThanOrEqual(18);
  });

  for (const [persona, permissions] of allPersonas) {
    it(`${persona}: every nav item shows the table's name, and the crumb shows the same`, () => {
      const sections = visibleNavSections({ permissions }, { availabilityEnabled: true });
      for (const section of sections) {
        for (const item of section.items) {
          expect(item.label, item.href).toBe(labels[item.href]);
          expect(labelForPath(item.href), item.href).toBe(item.label);
        }
        const names = section.items.map((i) => i.label);
        expect(new Set(names).size, `duplicate name in ${section.label}`).toBe(names.length);
      }
    });
  }
});

describe("page-labels: Schnellsuche (CommandPalette)", () => {
  const source = read("lib/components/ui/CommandPalette.svelte");
  const actions = [
    ...source.matchAll(/\{\s*id: "([^"]+)",\s*label: ([^,\n]+),[\s\S]*?href: "([^"]+)"/g),
  ].map(([, id, label, href]) => ({ id, label: label.trim(), href }));
  const pageActions = actions.filter((a) => !a.href.includes("?"));

  it("finds the palette's page actions (non-vacuity)", () => {
    expect(pageActions.length).toBeGreaterThanOrEqual(6);
  });
  for (const action of pageActions) {
    it(`${action.id} takes its label from pageLabel("${action.href}")`, () => {
      expect(action.label).toBe(`pageLabel("${action.href}")`);
      expect(labels[action.href], action.href).toBeDefined();
    });
  }
});

// ── H1 and browser tab title (D-574-10/11) ────────────────────────────────────────────────
// The route pages are not mountable here (no `$app` alias), so the wiring is pinned by source:
// the page's heading component and its <title> read pageLabel() of the page's own key — since #844 the route
// file (the pre-#844 URL) for an existing page, the new href for a page created by #844.
const NO_HEADING: Record<string, string> = {
  "/ich/tag":
    "renders from the dashboard file with a view prop; pinned by the dashboard test below",
  "/team/heute": "renders the dashboard file with view=team; pinned by the dashboard test below",
};
const HEADING_TAG = /<(PageHead|PageHeader|SectionStack|ListDetail|ToolPage|HubPage)\b[\s\S]*?\/?>/;

function routeSource(fileOrHref: string): string {
  return read(`routes/(app)${fileOrHref}/+page.svelte`);
}

const grouped = new Map<string, { href: string; key: string }[]>();
for (const route of APP_ROUTES) {
  if (route.href in NO_HEADING) continue;
  const group = grouped.get(route.area) ?? [];
  group.push({ href: route.href, key: route.file ?? route.href });
  grouped.set(route.area, group);
}

describe("page-labels: H1 and tab title of every page", () => {
  it("checks at least 30 page files (non-vacuity)", () => {
    expect([...grouped.values()].flat().length).toBeGreaterThanOrEqual(30);
  });
  for (const [section, entries] of grouped) {
    describe(section, () => {
      for (const { href, key } of entries) {
        it(`${href} takes its H1 and <title> from pageLabel("${key}")`, () => {
          const source = routeSource(key);
          const body = source.slice(source.lastIndexOf("</script>"));
          const heading = HEADING_TAG.exec(body)?.[0] ?? "";
          expect(heading, `${href}: no heading component`).not.toBe("");
          expect(heading).toContain(`title={pageLabel("${key}")}`);
          const tabTitle = /<title>([^<]*)<\/title>/.exec(source)?.[1];
          if (tabTitle !== undefined)
            expect(tabTitle.startsWith(`{pageLabel("${key}")}`)).toBe(true);
        });
      }
    });
  }
});

describe("page-labels: Mein Tag and Heute im Salon (#844, one file, two views)", () => {
  it("the dashboard names itself by the view's key and Heute im Salon renders it in the team view", () => {
    const dashboard = read("routes/(app)/dashboard/+page.svelte");
    expect(dashboard).toContain(
      'const pageKey = $derived(view === "team" ? "/team/heute" : "/dashboard");',
    );
    // Owner acceptance #845 (09.11.2026, prototype v5): Mein Tag greets in its H1; the page name
    // stays the crumb, the menu entry and the document title. Heute im Salon keeps the page name.
    expect(dashboard).toMatch(
      /title=\{view === "me" \? `\$\{greeting\(\)\}, \$\{capitalizedName\}` : pageLabel\(pageKey\)\}/,
    );
    expect(dashboard).toContain("<title>{pageLabel(pageKey)} – Clokr</title>");
    expect(read("routes/(app)/team/heute/+page.svelte")).toContain("<Dashboard />");
    expect(pageLabel("/dashboard")).toBe("Mein Tag");
    expect(pageLabel("/team/heute")).toBe("Heute im Salon");
  });
});

describe("page-labels: breadcrumbs of detail pages (review WR-04)", () => {
  const DETAIL_PAGES = [
    "routes/(app)/admin/support-access/[id]/+page.svelte",
    "routes/(app)/admin/shutdowns/[id]/+page.svelte",
    "routes/(app)/admin/audit/[id]/+page.svelte",
    "routes/(app)/admin/salons/[id]/+page.svelte",
    "routes/(app)/admin/employees/[id]/+page.svelte",
    "routes/(app)/admin/availability/[employeeId]/+page.svelte",
  ];
  for (const rel of DETAIL_PAGES) {
    it(`${rel}: a crumb to a named page carries that page's name`, () => {
      const source = read(rel);
      const crumbs = [...source.matchAll(/\{\s*label:\s*([^,]+),\s*href:\s*"([^"]+)"\s*\}/g)];
      const named = crumbs.filter(([, , href]) => href in labels);
      expect(named.length, `${rel}: no crumb to a named page`).toBeGreaterThan(0);
      for (const [, label, href] of named) expect(label.trim()).toBe(`pageLabel("${href}")`);
    });
  }
});
