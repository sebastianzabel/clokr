// Phase 378 (GitHub issue #378) — the Team-Bereich nav mapping is the mechanism the issue's
// Akzeptanzkriterien (AK-378-1, AK-378-2, AK-378-3) actually hinge on: which nav entries a
// Salonmanager, an Ausbilder, a plain Mitarbeiter, and legacy ADMIN/MANAGER see. Permission sets
// below are copied verbatim from the SHIPPED Systemrollen-Templates (docs/permissions.md:444/446)
// — not hand-picked — so a template change that silently narrows/widens a role is caught here
// too, not only in the API's own template tests.

import { describe, it, expect } from "vitest";
import { mayOpenTeamPage, visibleTeamNavItems } from "../team-nav";

// docs/permissions.md:444 — Salonmanager (intended scope: Salons).
const SALONMANAGER_PERMISSIONS = [
  "employee:read:ZUGEWIESEN",
  "time-entry:read:ZUGEWIESEN",
  "time-entry:create:ZUGEWIESEN",
  "time-entry:update:ZUGEWIESEN",
  "time-entry:delete:ZUGEWIESEN",
  "time-entry:revalidate:ZUGEWIESEN",
  "retro-request:read:ZUGEWIESEN",
  "retro-request:create:ZUGEWIESEN",
  "retro-request:approve:ZUGEWIESEN",
  "leave-request:read:ZUGEWIESEN",
  "leave-request:create:ZUGEWIESEN",
  "leave-request:approve:ZUGEWIESEN",
  "leave-request:attest:ZUGEWIESEN",
  "leave-request:cancel:ZUGEWIESEN",
  "section9:read:ZUGEWIESEN",
  "section9:upload:ZUGEWIESEN",
  "section9:decide:ZUGEWIESEN",
  "leave-entitlement:read:ZUGEWIESEN",
  "vocational-school:read:ZUGEWIESEN",
  "shift:read:ZUGEWIESEN",
  "shift:plan:ZUGEWIESEN",
  "shift-pattern:read:ZUGEWIESEN",
  "availability:read:ZUGEWIESEN",
  "team-overview:read:ZUGEWIESEN",
];

// docs/permissions.md:446 — Ausbilder (intended scope: Personen).
const AUSBILDER_PERMISSIONS = [
  "employee:read:ZUGEWIESEN",
  "time-entry:read:ZUGEWIESEN",
  "leave-request:read:ZUGEWIESEN",
  "vocational-school:read:ZUGEWIESEN",
  "shift:read:ZUGEWIESEN",
];

// docs/permissions.md § Systemrollen-Templates — Personalabteilung (intended scope: Mandant). Since
// Issue #86 (owner decision 16.10.2026) the template holds report:read and salon:read.
const PERSONALABTEILUNG_PERMISSIONS = [
  "employee:read:ZUGEWIESEN",
  "employee:create:ZUGEWIESEN",
  "employee:update:ZUGEWIESEN",
  "employee:update-avatar:ZUGEWIESEN",
  "contract:read:ZUGEWIESEN",
  "contract:update:ZUGEWIESEN",
  "salon:read:ZUGEWIESEN",
  "leave-request:read:ZUGEWIESEN",
  "section9:read:ZUGEWIESEN",
  "leave-entitlement:read:ZUGEWIESEN",
  "leave-entitlement:update:ZUGEWIESEN",
  "vocational-school:read:ZUGEWIESEN",
  "overtime:read:ZUGEWIESEN",
  "month-close:read:ZUGEWIESEN",
  "report:read:ZUGEWIESEN",
];

describe("visibleTeamNavItems", () => {
  it("AK-378-1: Salonmanager sees Aufgaben, Team-Zeiten, Abwesenheiten, Schichtplanung — not Berichte", () => {
    const items = visibleTeamNavItems({ permissions: SALONMANAGER_PERMISSIONS });
    const hrefs = items.map((i) => i.href);
    expect(hrefs).toEqual(["/inbox", "/team/time-entries", "/team/leave", "/shifts"]);
    expect(hrefs).not.toContain("/reports");
  });

  it("AK-378-2: Ausbilder sees only Team-Zeiten, Abwesenheiten — no Aufgaben, no Schichtplanung, no Berichte", () => {
    const items = visibleTeamNavItems({ permissions: AUSBILDER_PERMISSIONS });
    const hrefs = items.map((i) => i.href);
    expect(hrefs).toEqual(["/team/time-entries", "/team/leave"]);
    expect(hrefs).not.toContain("/inbox"); // no approve permission
    expect(hrefs).not.toContain("/shifts"); // shift:read only, not shift:plan
    expect(hrefs).not.toContain("/reports"); // no report:read:ZUGEWIESEN
  });

  it("AK-378-3: a plain Mitarbeiter (no ZUGEWIESEN permissions at all) sees no Team-Bereich items", () => {
    expect(visibleTeamNavItems({ permissions: ["time-entry:read:EIGENE"] })).toEqual([]);
  });

  it("Issue #86: the Personalabteilung persona sees Berichte (report:read, owner decision 16.10.2026) and no Team-Zeiten", () => {
    const hrefs = visibleTeamNavItems({ permissions: PERSONALABTEILUNG_PERMISSIONS }).map(
      (i) => i.href,
    );
    expect(hrefs).toEqual(["/team/leave", "/reports"]);
    expect(hrefs).not.toContain("/team/time-entries"); // no time-entry:read — no daily times
    expect(hrefs).not.toContain("/shifts");
    expect(hrefs).not.toContain("/inbox"); // no approve permission
  });

  it("a user object with no permissions list at all sees no Team-Bereich items (fail-closed)", () => {
    expect(visibleTeamNavItems({})).toEqual([]);
    expect(visibleTeamNavItems(null)).toEqual([]);
    expect(visibleTeamNavItems(undefined)).toEqual([]);
  });

  it("every entry with report:read:ZUGEWIESEN unlocks exactly Berichte in addition", () => {
    const items = visibleTeamNavItems({ permissions: ["report:read:ZUGEWIESEN"] });
    expect(items.map((i) => i.href)).toEqual(["/reports"]);
  });

  it("holding only retro-request:approve:ZUGEWIESEN (not leave-request:approve) still unlocks Anträge", () => {
    const items = visibleTeamNavItems({ permissions: ["retro-request:approve:ZUGEWIESEN"] });
    expect(items.map((i) => i.href)).toEqual(["/inbox"]);
  });

  it("Issue #840 (D-840-29): holding only section9:decide:ZUGEWIESEN unlocks Anträge and the page", () => {
    const only = { permissions: ["section9:decide:ZUGEWIESEN"] };
    expect(visibleTeamNavItems(only).map((i) => i.href)).toEqual(["/inbox"]);
    expect(mayOpenTeamPage("/inbox", only)).toBe(true);
  });

  it("Issue #840 (D-840-29): none of the three inbox keys, no inbox (section9:read alone is not enough)", () => {
    const none = { permissions: ["section9:read:ZUGEWIESEN", "leave-request:read:ZUGEWIESEN"] };
    expect(visibleTeamNavItems(none).map((i) => i.href)).not.toContain("/inbox");
    expect(mayOpenTeamPage("/inbox", none)).toBe(false);
  });

  it("display order is fixed regardless of the permission array's own order", () => {
    const items = visibleTeamNavItems({
      permissions: [...SALONMANAGER_PERMISSIONS].reverse(),
    });
    expect(items.map((i) => i.href)).toEqual([
      "/inbox",
      "/team/time-entries",
      "/team/leave",
      "/shifts",
    ]);
  });
});

describe("Issue #840 (D-840-06, E-01): one leave entry per area", () => {
  it("labels the leave entry „Abwesenheiten“ and the inbox „Aufgaben“ (Issue #574); the team calendar entry is gone", () => {
    const items = visibleTeamNavItems({ permissions: SALONMANAGER_PERMISSIONS });
    const byHref = Object.fromEntries(items.map((i) => [i.href, i.label]));
    expect(byHref["/team/leave"]).toBe("Abwesenheiten");
    expect(byHref["/inbox"]).toBe("Aufgaben");
    expect(Object.keys(byHref)).not.toContain("/teamcal");
    expect(mayOpenTeamPage("/teamcal", { permissions: SALONMANAGER_PERMISSIONS })).toBe(false);
  });
});

describe("mayOpenTeamPage (Issue #86, AC-86-3)", () => {
  it("the Personalabteilung may open Team-Abwesenheiten but not Team-Zeiten", () => {
    const hr = { permissions: PERSONALABTEILUNG_PERMISSIONS };
    expect(mayOpenTeamPage("/team/time-entries", hr)).toBe(false);
    expect(mayOpenTeamPage("/team/leave", hr)).toBe(true);
  });

  it("the Salonmanager may open both", () => {
    const sm = { permissions: SALONMANAGER_PERMISSIONS };
    expect(mayOpenTeamPage("/team/time-entries", sm)).toBe(true);
    expect(mayOpenTeamPage("/team/leave", sm)).toBe(true);
  });

  it("agrees with the nav for every entry (one source)", () => {
    for (const permissions of [
      SALONMANAGER_PERMISSIONS,
      AUSBILDER_PERMISSIONS,
      PERSONALABTEILUNG_PERMISSIONS,
    ]) {
      const user = { permissions };
      const hrefs = visibleTeamNavItems(user).map((i) => i.href);
      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs) expect(mayOpenTeamPage(href, user), href).toBe(true);
    }
  });

  it("refuses an unknown page, a plain Mitarbeiter and a caller without a permission list", () => {
    expect(mayOpenTeamPage("/team/unknown", { permissions: SALONMANAGER_PERMISSIONS })).toBe(false);
    expect(mayOpenTeamPage("/team/time-entries", { permissions: ["time-entry:read:EIGENE"] })).toBe(
      false,
    );
    expect(mayOpenTeamPage("/team/time-entries", {})).toBe(false);
    expect(mayOpenTeamPage("/team/time-entries", null)).toBe(false);
  });
});
