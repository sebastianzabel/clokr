// #843 — internal tool pages (the design-system example page /admin/bausteine): reachable by URL
// behind their guard so e2e, axe and visual run against them, but never offered in a navigation.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ADMIN_NAV_GROUPS,
  ADMIN_ROUTE_PERMISSIONS,
  canAccessAdminPath,
  firstAccessibleAdminHref,
  visibleAdminNavItems,
} from "../admin-route-permissions";
import personas from "./fixtures/system-role-permissions.json";

const src = (rel: string) => readFileSync(resolve(process.cwd(), "src", rel), "utf8");
const admin = { permissions: (personas as Record<string, string[]>).ADMIN };
const INTERNAL = ADMIN_ROUTE_PERMISSIONS.filter((e) => e.internal).map((e) => e.href);

describe("internal-routes-843 — intern, nicht in der Navigation", () => {
  it("marks exactly the example page as internal", () => {
    expect(INTERNAL).toEqual(["/admin/bausteine"]);
  });

  it("keeps the guard: an admin may open it, a person without the key may not", () => {
    expect(canAccessAdminPath(admin, "/admin/bausteine")).toBe(true);
    expect(canAccessAdminPath({ permissions: [] }, "/admin/bausteine")).toBe(false);
  });

  it("is in no navigation group, no visible nav item and never the admin start page", () => {
    const groupHrefs = ADMIN_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href));
    const visible = visibleAdminNavItems(admin, { availabilityEnabled: true }).map((i) => i.href);
    expect(groupHrefs.length).toBeGreaterThan(10);
    expect(visible.length).toBeGreaterThan(10);
    for (const href of INTERNAL) {
      expect(groupHrefs).not.toContain(href);
      expect(visible).not.toContain(href);
    }
    expect(INTERNAL).not.toContain(firstAccessibleAdminHref(admin));
  });

  it("is not an action of the command palette", () => {
    const palette = src("lib/components/ui/CommandPalette.svelte");
    expect(palette).toContain('href: "/admin/roles"'); // positive control: the palette lists admin hrefs this way
    for (const href of INTERNAL) expect(palette).not.toContain(href);
  });

  it("tells search engines not to index the page", () => {
    expect(src("routes/(app)/admin/bausteine/+page.svelte")).toContain(
      '<meta name="robots" content="noindex" />',
    );
  });
});
