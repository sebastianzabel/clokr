// Issue #83 (D-10, D-14, D-16) — the admin navigation: one item list for Sidebar and the mobile
// Mehr sheet, filtered per item by the admin route map, plus source-level wiring of the three
// navigation consumers (Sidebar and CommandPalette import `$app/*` and are not mountable here).
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ADMIN_NAV_GROUPS,
  ADMIN_ROUTE_PERMISSIONS,
  visibleAdminNavGroups,
  visibleAdminNavItems,
} from "../admin-route-permissions";
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

describe("admin navigation (Issue #83)", () => {
  it("the nav groups list exactly the navigable route-map entries, in the same order", () => {
    expect(ADMIN_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href))).toEqual(
      ADMIN_ROUTE_PERMISSIONS.filter((e) => e.inNav).map((e) => e.href),
    );
    const system = ADMIN_NAV_GROUPS.find((g) => g.label === "SYSTEM");
    expect(system?.items[4]).toEqual({
      href: "/admin/roles",
      label: "Rollen & Rechte",
      icon: "key",
    });
    for (const group of ADMIN_NAV_GROUPS) expect(group.items.length).toBeLessThanOrEqual(5);
  });

  it("COMPLIANCE is one group of three, Support-Zugriffe directly after Audit & Log (Issue #93)", () => {
    const compliance = ADMIN_NAV_GROUPS.filter((g) => g.label === "COMPLIANCE");
    expect(compliance).toHaveLength(1);
    expect(compliance[0].items.map((i) => i.label)).toEqual([
      "Monatsabschluss",
      "Audit & Log",
      "Support-Zugriffe",
    ]);
    expect(compliance[0].items[2]).toEqual({
      href: "/admin/support-access",
      label: "Support-Zugriffe",
      icon: "shield",
    });
  });

  it("the nav label equals the list page's PageHead title character for character (Issue #93)", () => {
    const page = read("routes/(app)/admin/support-access/+page.svelte");
    expect(page).toContain('title="Support-Zugriffe"');
    expect(read("routes/(app)/+layout.svelte")).toContain(
      '"/admin/support-access": "Support-Zugriffe"',
    );
  });

  it("filters per item, drops empty groups and the availability item when the feature is off", () => {
    expect(visibleAdminNavGroups({ permissions: p.HR }, on).map((g) => g.label)).toEqual([
      "PERSONAL",
      "COMPLIANCE",
    ]);
    expect(visibleAdminNavItems({ permissions: p.SALON_MANAGER }, on).map((i) => i.href)).toEqual([
      "/admin/employees",
      "/admin/availability",
    ]);
    expect(
      visibleAdminNavItems({ permissions: p.SALON_MANAGER }, { availabilityEnabled: false }).map(
        (i) => i.href,
      ),
    ).toEqual(["/admin/employees"]);
    expect(visibleAdminNavGroups({ permissions: p.EMPLOYEE }, on)).toEqual([]);
    expect(visibleAdminNavItems({ permissions: p.ADMIN }, on).map((i) => i.label)).toContain(
      "Rollen & Rechte",
    );
  });

  it("Sidebar, BottomTabBar and CommandPalette read the route map, not the compat role", () => {
    const sidebar = read("lib/components/layout/Sidebar.svelte");
    // Since #516 both variants render `visibleNavSections()` (app-nav.ts), which reads the groups.
    expect(sidebar).toContain("visibleNavSections($authStore.user");
    expect(read("lib/nav/app-nav.ts")).toContain("visibleAdminNavGroups(user");
    expect(sidebar).not.toContain("const adminNav");
    expect(sidebar.match(/\.role\b/g) ?? []).toHaveLength(
      (sidebar.match(/\$authStore\.user\.role === "(ADMIN|MANAGER)"/g) ?? []).length + 1,
    );
    const bar = read("lib/components/layout/BottomTabBar.svelte");
    expect(bar).toContain("visibleNavSections($authStore.user");
    expect(bar).not.toMatch(/\brole\b\s*===|adminMore/);
    const palette = read("lib/components/ui/CommandPalette.svelte");
    expect(palette).toContain("canAccessAdminPath($authStore.user, a.href)");
    expect(palette).not.toMatch(/adminOnly|isManager|\.role\b/);
    expect(palette).toContain('href: "/admin/roles"');
  });
});
