// Issue #83 (D-10, D-12, D-13, D-14, D-16) — the admin route map: guard decisions, every admin
// route mapped, every key real, all-of alternatives, the persona matrix, and the layout wiring.
// Expected persona visibility is HAND-WRITTEN here (D-14), never derived from the module.
// Issue #844: the pages keep their files under routes/(app)/admin but are opened under their new URL
// (`n("/admin/roles")` = "/verwalten/system/rollen"); the guard decides on the new URL.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ADMIN_ROUTE_PERMISSIONS,
  adminGuardDecision,
  canAccessAdminPath,
  firstAccessibleAdminHref,
  holdsAlternatives,
} from "../admin-route-permissions";
import { legacyRedirectTarget, routeFor } from "../routes";
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
/** The new URL of an old admin URL (#844); an alias keeps its own URL. */
const n = (old: string) => legacyRedirectTarget(old) ?? old;

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

/** The pre-#844 admin pages (by their route file) the keys open, sorted — the matrix below is hand-written. */
function visibleFor(keys: readonly string[]): string[] {
  return ADMIN_ROUTE_PERMISSIONS.filter(
    (e) => e.file?.startsWith("/admin/") === true && holdsAlternatives(user([...keys]), e.requires),
  )
    .map((e) => e.file!)
    .sort();
}

describe("admin route permissions (Issue #83)", () => {
  it("guard decisions: deny, allow per alternative, wait for a cached session, deny without user", () => {
    const roles = n("/admin/roles");
    expect(roles).toBe("/verwalten/system/rollen");
    expect(adminGuardDecision(user(["employee:read:ZUGEWIESEN"]), roles)).toBe("deny");
    expect(adminGuardDecision(user(["role:read:ZUGEWIESEN"]), roles)).toBe("allow");
    expect(adminGuardDecision(user(["role-assignment:manage:ZUGEWIESEN"]), roles)).toBe("allow");
    expect(adminGuardDecision(user(undefined), roles)).toBe("wait");
    expect(adminGuardDecision(null, n("/admin/employees"))).toBe("deny");
  });

  it("sub-routes follow their parent; an unmapped path is closed even with every key", () => {
    const all = ADMIN_ROUTE_PERMISSIONS.flatMap((e) => e.requires.flat());
    expect(canAccessAdminPath(user(["employee:read:ZUGEWIESEN"]), n("/admin/employees/abc"))).toBe(
      true,
    );
    expect(canAccessAdminPath(user(all), "/verwalten/unbekannt/x")).toBe(false);
    expect(canAccessAdminPath(user(all), "/admin/unbekannt")).toBe(false);
  });

  it("the old index redirects to Verwalten › Übersicht, which opens only through a visible entry", () => {
    expect(legacyRedirectTarget("/admin")).toBe("/verwalten");
    expect(firstAccessibleAdminHref(user(["employee:read:ZUGEWIESEN"]))).toBe(
      "/verwalten/personen",
    );
    expect(firstAccessibleAdminHref(user(["role:read:ZUGEWIESEN"]))).toBe("/verwalten/system");
    expect(firstAccessibleAdminHref(user([]))).toBeNull();
    expect(canAccessAdminPath(user([]), "/verwalten")).toBe(false);
  });

  it("every admin route directory is mapped (a new page without a mapping turns this red)", () => {
    const paths = adminRoutePaths();
    expect(paths.length).toBeGreaterThanOrEqual(20);
    expect(paths).toContain("/admin/roles");
    // every old admin URL either redirects to a table entry or is a kept alias with its own guard
    const unmapped = paths.filter(
      (p) =>
        p !== "/admin" &&
        routeFor(n(p)) === null &&
        !ADMIN_ROUTE_PERMISSIONS.some(
          (e) => e.file === undefined && (p === e.href || p.startsWith(`${e.href}/`)),
        ),
    );
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
    expect(canAccessAdminPath(user(["shift-config:manage:ZUGEWIESEN"]), n("/admin/shifts"))).toBe(
      false,
    );
    expect(
      canAccessAdminPath(
        user([
          "shift-config:manage:ZUGEWIESEN",
          "shift:read:ZUGEWIESEN",
          "shift-pattern:read:ZUGEWIESEN",
        ]),
        n("/admin/shifts"),
      ),
    ).toBe(true);
    expect(
      canAccessAdminPath(
        user(["employee:read:ZUGEWIESEN", "availability:update:ZUGEWIESEN"]),
        n("/admin/availability"),
      ),
    ).toBe(true);
    expect(
      canAccessAdminPath(user(["availability:read:ZUGEWIESEN"]), n("/admin/availability")),
    ).toBe(false);
  });

  it("persona matrix of the system roles (D-14)", () => {
    const ALL = ADMIN_ROUTE_PERMISSIONS.filter((e) => e.file?.startsWith("/admin/") === true)
      .map((e) => e.file!)
      .sort();
    expect(ALL.length).toBe(17);
    const p = personas as Record<string, string[]>;
    expect(visibleFor(p.ADMIN)).toEqual(ALL);
    expect(visibleFor(p.OWNER)).toEqual(ALL);
    // Issue #836: the leave-limits page opens for leave-request:approve, which MANAGER and
    // SALON_MANAGER hold (fixture read by hand); HR and TRAINER hold neither key.
    expect(visibleFor(p.MANAGER)).toEqual(
      [
        "/admin/employees",
        "/admin/leave-limits",
        "/admin/availability",
        "/admin/salons",
        "/admin/month-close",
        "/admin/export",
      ].sort(),
    );
    expect(visibleFor(p.SALON_MANAGER)).toEqual(
      ["/admin/employees", "/admin/leave-limits", "/admin/availability"].sort(),
    );
    // Issue #86 (owner decision 16.10.2026): the HR template holds salon:read, so "Salons" joins.
    expect(visibleFor(p.HR)).toEqual(
      ["/admin/employees", "/admin/salons", "/admin/month-close"].sort(),
    );
    expect(visibleFor(p.TRAINER)).toEqual(["/admin/employees"]);
    expect(visibleFor(p.EMPLOYEE)).toEqual([]);
    for (const slot of Object.keys(p)) {
      expect(canAccessAdminPath(user(p[slot]), n("/admin/roles")), slot).toBe(
        slot === "ADMIN" || slot === "OWNER",
      );
    }
  });

  it("layout wiring: children only on allow, a wait state, the refresh, a redirect, no role", () => {
    // #844: the guard is the shared RouteGuard of the admin, Verwalten and Team layouts
    for (const rel of ["admin", "verwalten", "team"]) {
      const host = readFileSync(join(SRC, "routes", "(app)", rel, "+layout.svelte"), "utf8");
      expect(host, rel).toContain("<RouteGuard");
    }
    const layout = readFileSync(
      join(SRC, "lib", "components", "layout", "RouteGuard.svelte"),
      "utf8",
    );
    expect(layout).toContain("adminGuardDecision($authStore.user, $page.url.pathname)");
    const allow = layout.indexOf('{#if decision === "allow"}');
    const wait = layout.indexOf('{:else if decision === "wait"}');
    const render = layout.indexOf("{@render children");
    expect(allow).toBeGreaterThan(-1);
    expect(render).toBeGreaterThan(allow);
    expect(render).toBeLessThan(wait);
    expect(layout.slice(wait)).toContain('role="status"');
    expect(layout).toContain("loadPermissionsIfMissing");
    expect(layout).toContain("goto(homeHref($authStore.user)");
    expect(layout).not.toMatch(/\.role\b|"ADMIN"|"MANAGER"/);
  });
});
