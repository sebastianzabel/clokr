// #843 — internal tool pages (the design-system example page, since #844 /verwalten/bausteine with the old URL
// /admin/bausteine redirecting): reachable by URL behind their guard so e2e, axe and visual run against them,
// but never offered in a navigation, a hub page, the command palette or as a start page.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ADMIN_ROUTE_PERMISSIONS,
  canAccessAdminPath,
  firstAccessibleAdminHref,
  visibleAdminNavItems,
} from "../admin-route-permissions";
import { visibleNavSections } from "../app-nav";
import { APP_ROUTES, homeHref, legacyRedirectTarget, visibleChildren } from "../routes";
import personas from "./fixtures/system-role-permissions.json";

const src = (rel: string) => readFileSync(resolve(process.cwd(), "src", rel), "utf8");
const P = personas as Record<string, string[]>;
const admin = { permissions: P.ADMIN };
const on = { availabilityEnabled: true };
const INTERNAL = ADMIN_ROUTE_PERMISSIONS.filter((e) => e.internal).map((e) => e.href);

describe("internal-routes-843 — intern, nicht in der Navigation", () => {
  it("marks exactly the example page as internal, under its #844 URL", () => {
    expect(INTERNAL).toEqual(["/verwalten/bausteine"]);
    expect(legacyRedirectTarget("/admin/bausteine")).toBe("/verwalten/bausteine");
  });

  it("keeps the guard: an admin may open it, a person without the key may not", () => {
    expect(canAccessAdminPath(admin, "/verwalten/bausteine")).toBe(true);
    expect(canAccessAdminPath({ permissions: [] }, "/verwalten/bausteine")).toBe(false);
  });

  it("is in no area, no visible nav item, no hub page and never a start page", () => {
    const navHrefs = visibleNavSections(admin, on).flatMap((s) => s.items.map((i) => i.href));
    const visible = visibleAdminNavItems(admin, on).map((i) => i.href);
    const hubs = APP_ROUTES.filter((r) => r.requires === "children").flatMap((hub) =>
      visibleChildren(admin, hub.href, on).map((r) => r.href),
    );
    expect(navHrefs.length).toBeGreaterThan(10);
    expect(visible.length).toBeGreaterThan(5);
    expect(hubs.length).toBeGreaterThan(10);
    for (const href of INTERNAL) {
      expect(navHrefs).not.toContain(href);
      expect(visible).not.toContain(href);
      expect(hubs).not.toContain(href);
    }
    expect(INTERNAL).not.toContain(firstAccessibleAdminHref(admin));
    for (const persona of Object.keys(P)) {
      expect(INTERNAL, persona).not.toContain(homeHref({ permissions: P[persona] }));
    }
  });

  it("is not an action of the command palette", () => {
    const palette = src("lib/components/ui/CommandPalette.svelte");
    // positive control: the palette lists Verwalten hrefs this way
    expect(palette).toContain('href: "/verwalten/system/rollen"');
    for (const href of [...INTERNAL, "/admin/bausteine"]) expect(palette).not.toContain(href);
  });

  it("tells search engines not to index the page", () => {
    expect(src("routes/(app)/admin/bausteine/+page.svelte")).toContain(
      '<meta name="robots" content="noindex" />',
    );
  });
});
