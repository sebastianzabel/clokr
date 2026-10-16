// Issue #83 (D-10, D-12, D-13, D-14, D-16) — the admin route map: guard decisions, every admin
// route mapped, every key real, all-of alternatives, the persona matrix, and the layout wiring.
// Expected persona visibility is HAND-WRITTEN here (D-14), never derived from the module.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ADMIN_ROUTE_PERMISSIONS,
  adminGuardDecision,
  adminRouteFor,
  canAccessAdminPath,
  firstAccessibleAdminHref,
  holdsAlternatives,
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
const ADMIN_DIR = join(SRC, "routes", "(app)", "admin");
const user = (permissions: string[] | undefined) => ({ permissions });

/** Every directory under routes/(app)/admin that renders or redirects, as a URL path. */
function adminRoutePaths(dir = ADMIN_DIR): string[] {
  const here = readdirSync(dir);
  const own = here.some((n) => n === "+page.svelte" || n === "+page.server.ts")
    ? [
        "/admin" +
          (relative(ADMIN_DIR, dir) === ""
            ? ""
            : "/" +
              relative(ADMIN_DIR, dir)
                .split(sep)
                .join("/")
                .replace(/\[[^\]]+\]/g, "x")),
      ]
    : [];
  const nested = here
    .map((n) => join(dir, n))
    .filter((p) => statSync(p).isDirectory())
    .flatMap((p) => adminRoutePaths(p));
  return [...own, ...nested];
}

function visibleFor(keys: readonly string[]): string[] {
  return ADMIN_ROUTE_PERMISSIONS.filter(
    (e) => e.inNav && holdsAlternatives(user([...keys]), e.requires),
  ).map((e) => e.href);
}

describe("admin route permissions (Issue #83)", () => {
  it("guard decisions: deny, allow per alternative, wait for a cached session, deny without user", () => {
    expect(adminGuardDecision(user(["employee:read:ZUGEWIESEN"]), "/admin/roles")).toBe("deny");
    expect(adminGuardDecision(user(["role:read:ZUGEWIESEN"]), "/admin/roles")).toBe("allow");
    expect(adminGuardDecision(user(["role-assignment:manage:ZUGEWIESEN"]), "/admin/roles")).toBe(
      "allow",
    );
    expect(adminGuardDecision(user(undefined), "/admin/roles")).toBe("wait");
    expect(adminGuardDecision(null, "/admin/employees")).toBe("deny");
  });

  it("sub-routes follow their parent; an unmapped path is closed even with every key", () => {
    const all = ADMIN_ROUTE_PERMISSIONS.flatMap((e) => e.requires.flat());
    expect(canAccessAdminPath(user(["employee:read:ZUGEWIESEN"]), "/admin/employees/abc")).toBe(
      true,
    );
    expect(canAccessAdminPath(user(all), "/admin/unbekannt")).toBe(false);
  });

  it("the index goes to the first allowed page, or nowhere", () => {
    expect(firstAccessibleAdminHref(user(["employee:read:ZUGEWIESEN"]))).toBe("/admin/employees");
    expect(firstAccessibleAdminHref(user(["role:read:ZUGEWIESEN"]))).toBe("/admin/roles");
    expect(firstAccessibleAdminHref(user([]))).toBeNull();
    expect(canAccessAdminPath(user([]), "/admin")).toBe(false);
  });

  it("every admin route directory is mapped (a new page without a mapping turns this red)", () => {
    const paths = adminRoutePaths();
    expect(paths.length).toBeGreaterThanOrEqual(20);
    expect(paths).toContain("/admin/roles");
    const unmapped = paths.filter((p) => p !== "/admin" && adminRouteFor(p) === null);
    expect(unmapped).toEqual([]);
  });

  it("every key exists in docs/permissions.md and no alternative is empty", () => {
    const doc = readFileSync(resolve(SRC, "..", "..", "..", "docs", "permissions.md"), "utf8");
    const documented = new Set(
      [...doc.matchAll(/^\| `([a-z0-9-]+:[a-z-]+:(?:EIGENE|ZUGEWIESEN))`/gm)].map((m) => m[1]),
    );
    expect(documented.size).toBeGreaterThanOrEqual(80);
    for (const entry of ADMIN_ROUTE_PERMISSIONS) {
      expect(entry.requires.length).toBeGreaterThan(0);
      for (const alternative of entry.requires) {
        expect(alternative.length).toBeGreaterThan(0);
        for (const key of alternative) expect(documented.has(key), key).toBe(true);
      }
    }
    expect(holdsAlternatives(user(["x"]), [[]])).toBe(false);
  });

  it("all-of alternatives (D-12): shifts and availability need every key of one set", () => {
    expect(canAccessAdminPath(user(["shift-config:manage:ZUGEWIESEN"]), "/admin/shifts")).toBe(
      false,
    );
    expect(
      canAccessAdminPath(
        user([
          "shift-config:manage:ZUGEWIESEN",
          "shift:read:ZUGEWIESEN",
          "shift-pattern:read:ZUGEWIESEN",
        ]),
        "/admin/shifts",
      ),
    ).toBe(true);
    expect(
      canAccessAdminPath(
        user(["employee:read:ZUGEWIESEN", "availability:update:ZUGEWIESEN"]),
        "/admin/availability",
      ),
    ).toBe(true);
    expect(canAccessAdminPath(user(["availability:read:ZUGEWIESEN"]), "/admin/availability")).toBe(
      false,
    );
  });

  it("persona matrix of the system roles (D-14)", () => {
    const ALL = ADMIN_ROUTE_PERMISSIONS.filter((e) => e.inNav).map((e) => e.href);
    const p = personas as Record<string, string[]>;
    expect(visibleFor(p.ADMIN)).toEqual(ALL);
    expect(visibleFor(p.OWNER)).toEqual(ALL);
    expect(visibleFor(p.MANAGER)).toEqual([
      "/admin/employees",
      "/admin/availability",
      "/admin/salons",
      "/admin/month-close",
      "/admin/export",
    ]);
    expect(visibleFor(p.SALON_MANAGER)).toEqual(["/admin/employees", "/admin/availability"]);
    // Issue #86 (owner decision 16.10.2026): the HR template holds salon:read, so "Salons" joins.
    expect(visibleFor(p.HR)).toEqual(["/admin/employees", "/admin/salons", "/admin/month-close"]);
    expect(visibleFor(p.TRAINER)).toEqual(["/admin/employees"]);
    expect(visibleFor(p.EMPLOYEE)).toEqual([]);
    for (const slot of Object.keys(p)) {
      expect(canAccessAdminPath(user(p[slot]), "/admin/roles"), slot).toBe(
        slot === "ADMIN" || slot === "OWNER",
      );
    }
  });

  it("layout wiring: children only on allow, a wait state, the refresh, a redirect, no role", () => {
    const layout = readFileSync(join(ADMIN_DIR, "+layout.svelte"), "utf8");
    expect(layout).toContain("adminGuardDecision($authStore.user, $page.url.pathname)");
    const allow = layout.indexOf('{#if decision === "allow"}');
    const wait = layout.indexOf('{:else if decision === "wait"}');
    const render = layout.indexOf("{@render children");
    expect(allow).toBeGreaterThan(-1);
    expect(render).toBeGreaterThan(allow);
    expect(render).toBeLessThan(wait);
    expect(layout.slice(wait)).toContain('role="status"');
    expect(layout).toContain("loadPermissionsIfMissing");
    expect(layout).toContain('goto("/dashboard"');
    expect(layout).not.toMatch(/\.role\b|"ADMIN"|"MANAGER"/);
    const index = readFileSync(join(ADMIN_DIR, "+page.svelte"), "utf8");
    expect(index).toContain("firstAccessibleAdminHref($authStore.user)");
  });
});
