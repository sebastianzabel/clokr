// Issue #844 — the route table: new URLs, old URLs, permissions unchanged, start page per role, page widths.
import { describe, expect, it } from "vitest";
import {
  APP_ROUTES,
  LEGACY_ROUTE_REDIRECTS,
  homeHref,
  legacyRedirectTarget,
  mayOpenPath,
  mayOpenRoute,
  mobileTabs,
  pageWidthForPath,
  redirectLocation,
  rerouteTarget,
  routeFor,
  visibleChildren,
} from "$lib/nav/routes";
import { visibleNavSections } from "$lib/nav/app-nav";
import { sectionsOfPage } from "$lib/settings/settings-pages";
import personas from "./fixtures/system-role-permissions.json";
import pre844 from "./fixtures/pre-844-route-permissions.json";

const ALL = { availabilityEnabled: true };
const P = personas as Record<string, string[]>;
const user = (persona: string) => ({ permissions: P[persona] });

describe("route table (D-844-01..08)", () => {
  it("has at least 35 entries in three areas (non-vacuity)", () => {
    expect(APP_ROUTES.length).toBeGreaterThanOrEqual(35);
    expect(new Set(APP_ROUTES.map((r) => r.area))).toEqual(new Set(["ich", "team", "verwalten"]));
  });

  it("every href and every route file is unique", () => {
    const hrefs = APP_ROUTES.map((r) => r.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    const files = APP_ROUTES.flatMap((r) => (r.file ? [r.file] : []));
    expect(new Set(files).size).toBe(files.length);
  });

  it("every new URL lives under its area prefix", () => {
    for (const route of APP_ROUTES)
      expect(route.href.startsWith(`/${route.area}`), route.href).toBe(true);
  });

  it("no new URL lies under a route file, so a new URL is never taken for an old one", () => {
    for (const route of APP_ROUTES) {
      expect(legacyRedirectTarget(route.href), route.href).toBeNull();
      expect(legacyRedirectTarget(`${route.href}/x`), route.href).toBeNull();
    }
  });

  it("a hub child names an existing hub, and a hub has children", () => {
    const hrefs = new Set(APP_ROUTES.map((r) => r.href));
    for (const route of APP_ROUTES.filter((r) => r.parent))
      expect(hrefs.has(route.parent!), route.href).toBe(true);
    for (const hub of APP_ROUTES.filter((r) => r.requires === "children")) {
      expect(
        APP_ROUTES.some((r) => r.parent === hub.href),
        hub.href,
      ).toBe(true);
    }
  });
});

describe("reroute and redirect are inverse (D-844-03/04)", () => {
  const filed = APP_ROUTES.filter((r) => r.file !== undefined);
  const folded = LEGACY_ROUTE_REDIRECTS.filter((a) => a.to !== undefined);
  // Both kinds are moved pages: a filed one is rerouted to its old file, a folded one to the page that now
  // holds its content (#854).
  it("covers at least 28 moved pages (non-vacuity)", () =>
    expect(filed.length + folded.length).toBeGreaterThanOrEqual(28));
  for (const route of filed) {
    it(`${route.href} ⇄ ${route.file}`, () => {
      expect(rerouteTarget(route.href)).toBe(route.file);
      expect(legacyRedirectTarget(route.file!)).toBe(route.href);
      // sub-paths survive both ways
      expect(rerouteTarget(`${route.href}/abc`)).toBe(`${route.file}/abc`);
      expect(legacyRedirectTarget(`${route.file}/abc`)).toBe(`${route.href}/abc`);
    });
  }

  it("pages created by #844 and unknown paths are not rerouted", () => {
    for (const href of [
      "/team/heute",
      "/verwalten",
      "/verwalten/regeln",
      "/verwalten/daten",
      "/verwalten/system",
    ]) {
      expect(rerouteTarget(href), href).toBeNull();
    }
    expect(rerouteTarget("/nowhere")).toBeNull();
    expect(legacyRedirectTarget("/nowhere")).toBeNull();
  });
});

describe("folded old pages (#854)", () => {
  const folded = LEGACY_ROUTE_REDIRECTS.filter((a) => a.to !== undefined);

  it("has at least one folded page (non-vacuity)", () =>
    expect(folded.length).toBeGreaterThanOrEqual(1));

  for (const alias of folded) {
    it(`${alias.href} → ${alias.to}`, () => {
      expect(legacyRedirectTarget(alias.href)).toBe(alias.to);
      expect(legacyRedirectTarget(`${alias.href}/x`)).toBe(alias.to);
      // Without a page file the URL must still resolve to a route so the layout load can redirect.
      expect(rerouteTarget(alias.href)).not.toBeNull();
      expect(rerouteTarget(`${alias.href}/x`)).not.toBeNull();
      // The target is a page of the table, and the alias keeps its old alternatives.
      expect(routeFor(alias.to!.split("#")[0])).not.toBeNull();
      const holder = { permissions: alias.requires[0].map((key) => key) };
      expect(mayOpenPath(holder, alias.href)).toBe(true);
      expect(mayOpenPath({ permissions: [] }, alias.href)).toBe(false);
    });
  }

  it("special-leave rerouting renders the page the redirect lands on", () => {
    expect(rerouteTarget("/admin/special-leave")).toBe("/admin/vacation");
    expect(rerouteTarget("/admin/special-leave/42")).toBe("/admin/vacation");
  });

  it("the renamed #844 vacation URL renders the Abwesenheiten page and keeps its gate", () => {
    expect(rerouteTarget("/verwalten/regeln/urlaub")).toBe("/admin/vacation");
    expect(legacyRedirectTarget("/verwalten/regeln/urlaub")).toBe(
      "/verwalten/regeln/abwesenheiten",
    );
    expect(
      mayOpenPath({ permissions: ["leave-config:manage:ZUGEWIESEN"] }, "/verwalten/regeln/urlaub"),
    ).toBe(true);
    expect(mayOpenPath({ permissions: [] }, "/verwalten/regeln/urlaub")).toBe(false);
  });

  it("redirectLocation puts the query before the fragment", () => {
    expect(redirectLocation("/a#t", "?x=1")).toBe("/a?x=1#t");
    expect(redirectLocation("/a", "?x=1")).toBe("/a?x=1");
    expect(redirectLocation("/a#t", "")).toBe("/a#t");
    expect(redirectLocation("/a", "")).toBe("/a");
  });
});

describe("old URLs of the acceptance criteria land on the new place", () => {
  const CASES: [string, string][] = [
    ["/dashboard", "/ich/tag"],
    ["/time-entries", "/ich/zeiten"],
    ["/leave", "/ich/abwesenheiten"],
    ["/leave/planung", "/ich/abwesenheiten/planung"], // its own redirect then continues to the team planner
    ["/availability", "/ich/dienstplan"],
    ["/settings", "/ich/profil"],
    ["/settings/geraet-koppeln", "/ich/profil/geraet-koppeln"],
    ["/inbox", "/team/aufgaben"],
    ["/team/time-entries", "/team/zeiten"],
    ["/team/leave", "/team/abwesenheiten"],
    ["/shifts", "/team/dienstplan"],
    ["/shifts/planning", "/team/dienstplan/planung"],
    ["/shifts/conflicts", "/team/dienstplan/konflikte"],
    ["/admin", "/verwalten"],
    ["/admin/employees/abc", "/verwalten/personen/abc"],
    ["/admin/vacation", "/verwalten/regeln/abwesenheiten"],
    ["/verwalten/regeln/urlaub", "/verwalten/regeln/abwesenheiten"], // the renamed #844 URL (alias)
    ["/admin/special-leave", "/verwalten/regeln/abwesenheiten#sonderurlaub"],
    ["/admin/system", "/verwalten/system/allgemein"],
    ["/admin/month-close", "/verwalten/monatsabschluss"],
    ["/admin/audit/42", "/verwalten/daten/protokoll/42"],
    ["/admin/availability", "/team/verfuegbarkeit"],
    ["/reports", "/verwalten/berichte"],
  ];
  for (const [from, to] of CASES)
    it(`${from} → ${to}`, () => expect(legacyRedirectTarget(from)).toBe(to));

  it("/teamcal keeps its own redirect (a route of its own, no table entry)", () => {
    expect(legacyRedirectTarget("/teamcal")).toBeNull();
  });

  it("every former nav href of the pre-#844 admin and team maps is redirected or a kept alias", () => {
    const old = [...Object.keys(pre844.admin), ...Object.keys(pre844.team)];
    expect(old.length).toBeGreaterThanOrEqual(24);
    const aliases = new Set(LEGACY_ROUTE_REDIRECTS.map((a) => a.href));
    for (const href of old) {
      expect(legacyRedirectTarget(href) !== null || aliases.has(href), href).toBe(true);
    }
  });
});

describe("no permission change (D-06, AC: keine Berechtigungsänderung)", () => {
  const pinned: Record<string, string[][]> = { ...pre844.admin, ...pre844.team };
  it("pins at least 24 pre-#844 pages (non-vacuity)", () => {
    expect(Object.keys(pinned).length).toBeGreaterThanOrEqual(24);
  });
  for (const [file, requires] of Object.entries(pinned)) {
    it(`${file} keeps its alternatives`, () => {
      const route = APP_ROUTES.find((r) => r.file === file);
      const alias = LEGACY_ROUTE_REDIRECTS.find((a) => a.href === file);
      // A page that RECEIVES settings sections from other old pages opens under the union of their gates
      // (D-854-05): nobody loses access, so every pinned alternative must still be there; the exact value is
      // pinned by settings-pages-854.test.ts. Every other page keeps the equality pin.
      if (
        route !== undefined &&
        sectionsOfPage(route.href).length > 0 &&
        Array.isArray(route.requires)
      ) {
        for (const alternative of requires)
          expect(route.requires, file).toContainEqual(alternative);
        return;
      }
      expect(route?.requires ?? alias?.requires, file).toEqual(requires);
    });
  }

  it("the personal pages stay open to every signed-in user, Heute im Salon needs team-overview:read", () => {
    for (const href of [
      "/ich/tag",
      "/ich/zeiten",
      "/ich/abwesenheiten",
      "/ich/dienstplan",
      "/ich/profil",
    ]) {
      expect(mayOpenPath({ permissions: [] }, href), href).toBe(true);
    }
    expect(mayOpenPath({ permissions: [] }, "/team/heute")).toBe(false);
    expect(mayOpenPath({ permissions: ["team-overview:read:ZUGEWIESEN"] }, "/team/heute")).toBe(
      true,
    );
  });

  it("fails closed for an unknown path and opens a hub only through a child", () => {
    expect(mayOpenPath(user("ADMIN"), "/nowhere")).toBe(false);
    expect(mayOpenPath({ permissions: [] }, "/verwalten")).toBe(false);
    expect(mayOpenPath({ permissions: ["report:export:ZUGEWIESEN"] }, "/verwalten/daten")).toBe(
      true,
    );
    expect(mayOpenPath({ permissions: ["report:export:ZUGEWIESEN"] }, "/verwalten/system")).toBe(
      false,
    );
  });
});

describe("start page per role (Z-02, D-844-10)", () => {
  // Personalabteilung (HR) is the pure administration role of Z-02; the Ausbilder (TRAINER) has Team entries but
  // no team-overview:read, so Heute im Salon is closed to them and they start on Mein Tag.
  const EXPECTED: Record<string, string> = {
    EMPLOYEE: "/ich/tag",
    TRAINER: "/ich/tag",
    SALON_MANAGER: "/team/heute",
    MANAGER: "/team/heute",
    OWNER: "/team/heute",
    ADMIN: "/team/heute",
    HR: "/verwalten",
  };
  for (const [persona, home] of Object.entries(EXPECTED)) {
    it(`${persona} starts on ${home}`, () => expect(homeHref(user(persona))).toBe(home));
  }

  it("every persona of the fixture has a start page it may open", () => {
    expect(Object.keys(P).length).toBeGreaterThanOrEqual(4);
    for (const persona of Object.keys(P)) {
      const home = homeHref(user(persona));
      expect(mayOpenPath(user(persona), home), `${persona} → ${home}`).toBe(true);
    }
  });

  it("an administration role (Verwalten entries, no Heute im Salon) starts on Verwalten › Übersicht", () => {
    const hr = {
      permissions: ["employee:read:ZUGEWIESEN", "report:read:ZUGEWIESEN", "salon:read:ZUGEWIESEN"],
    };
    expect(homeHref(hr)).toBe("/verwalten");
  });

  it("nobody and an empty permission list start on Mein Tag", () => {
    expect(homeHref(null)).toBe("/ich/tag");
    expect(homeHref({ permissions: [] })).toBe("/ich/tag");
  });
});

describe("navigation (Z-01, AC: kein Eintrag doppelt)", () => {
  for (const persona of Object.keys(P)) {
    it(`${persona}: three areas at most, no name and no target twice within an area`, () => {
      const sections = visibleNavSections(user(persona), ALL);
      expect(sections.length).toBeGreaterThanOrEqual(1);
      expect(sections.length).toBeLessThanOrEqual(3);
      for (const section of sections) {
        const names = section.items.map((i) => i.label);
        expect(new Set(names).size, `${persona}/${section.label}`).toBe(names.length);
      }
      const all = sections.flatMap((s) => s.items.map((i) => i.href));
      expect(new Set(all).size).toBe(all.length);
    });
  }

  it("a plain employee sees only the Ich area (Z-01: one role, one area)", () => {
    const sections = visibleNavSections(user("EMPLOYEE"), ALL);
    expect(sections.map((s) => s.label)).toEqual(["Ich"]);
  });

  it("an admin sees Ich, Team and Verwalten with the hubs in the rail and their children only on the hub", () => {
    const sections = visibleNavSections(user("ADMIN"), ALL);
    expect(sections.map((s) => s.label)).toEqual(["Ich", "Team", "Verwalten"]);
    const verwalten = sections[2].items.map((i) => i.href);
    expect(verwalten).toContain("/verwalten/regeln");
    expect(verwalten).not.toContain("/verwalten/regeln/abwesenheiten");
    expect(visibleChildren(user("ADMIN"), "/verwalten/regeln", ALL).map((r) => r.href)).toContain(
      "/verwalten/regeln/abwesenheiten",
    );
  });

  it("the availability feature off hides its two entries", () => {
    const hrefs = visibleNavSections(user("ADMIN"), { availabilityEnabled: false }).flatMap((s) =>
      s.items.map((i) => i.href),
    );
    expect(hrefs).not.toContain("/ich/dienstplan");
    expect(hrefs).not.toContain("/team/verfuegbarkeit");
  });

  it("hub entries follow their children", () => {
    const regeln = APP_ROUTES.find((r) => r.href === "/verwalten/regeln")!;
    expect(mayOpenRoute({ permissions: [] }, regeln)).toBe(false);
    expect(mayOpenRoute({ permissions: ["company-shutdown:manage:ZUGEWIESEN"] }, regeln)).toBe(
      true,
    );
  });
});

describe("phone tabs (D-844-13)", () => {
  it("team reach: Salon · Aufgaben · Mein Tag · Abwesend", () => {
    expect(mobileTabs(user("ADMIN"), ALL).map((t) => t.href)).toEqual([
      "/team/heute",
      "/team/aufgaben",
      "/ich/tag",
      "/team/abwesenheiten",
    ]);
  });
  it("employee: Mein Tag · Zeiten · Abwesend · Plan, Plan skipped without the feature", () => {
    expect(mobileTabs(user("EMPLOYEE"), ALL).map((t) => t.label)).toEqual([
      "Mein Tag",
      "Zeiten",
      "Abwesend",
      "Plan",
    ]);
    expect(
      mobileTabs(user("EMPLOYEE"), { availabilityEnabled: false }).map((t) => t.label),
    ).toEqual(["Mein Tag", "Zeiten", "Abwesend"]);
  });
  it("never offers a target the user may not open", () => {
    for (const persona of Object.keys(P)) {
      for (const tab of mobileTabs(user(persona), ALL)) {
        expect(mayOpenPath(user(persona), tab.href), `${persona} ${tab.href}`).toBe(true);
      }
    }
  });
});

describe("page widths (owner 09.11.2026)", () => {
  it("planners, calendars, tables, reports and start pages are full width", () => {
    for (const href of [
      "/ich/tag",
      "/team/heute",
      "/ich/zeiten",
      "/team/dienstplan",
      "/verwalten/personen",
      "/verwalten/berichte",
    ]) {
      expect(pageWidthForPath(href), href).toBe("full");
    }
  });
  it("forms, settings, profile, details and hubs are reading width", () => {
    for (const href of [
      "/ich/profil",
      "/verwalten/regeln",
      "/verwalten/regeln/abwesenheiten",
      "/verwalten/system/allgemein",
      "/verwalten/salons/1",
    ]) {
      expect(pageWidthForPath(href), href).toBe("read");
    }
  });
  it("a detail page below a full-width list (no entry of its own) gets the reading width", () => {
    expect(routeFor("/verwalten/personen/123")?.href).toBe("/verwalten/personen");
    expect(pageWidthForPath("/verwalten/personen/123")).toBe("read");
    expect(pageWidthForPath("/nowhere")).toBe("read");
  });
});
