// Issue #574 (D-574-09..11) — every page has ONE name, from $lib/nav/page-labels. The Sidebar and
// the "Mehr" sheet (visibleNavSections), the Topbar crumb (labelForPath) and the quick search
// (CommandPalette) must show it; CommandPalette imports `$app/*` and is read as source.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { visibleNavSections } from "$lib/nav/app-nav";
import { PAGE_LABELS, labelForPath, pageLabel, type PageHref } from "$lib/nav/page-labels";
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
    expect(labelForPath("/admin/employees/123")).toBe(labels["/admin/employees"]);
    expect(labelForPath("/admin/unknown-page")).toBe(labels["/admin"]);
    expect(labelForPath("/nowhere")).toBe("");
  });
});

describe("page-labels: nav labels (Sidebar, Mehr sheet, crumb)", () => {
  it("covers at least the 26 nav pages of the admin persona (non-vacuity)", () => {
    const admin = (personas as Record<string, string[]>).ADMIN;
    const items = visibleNavSections({ permissions: admin }, { availabilityEnabled: true }).flatMap(
      (s) => s.items,
    );
    expect(items.length).toBeGreaterThanOrEqual(26);
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
