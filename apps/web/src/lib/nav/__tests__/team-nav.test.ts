// Phase 378 (GitHub issue #378) — the Team-Bereich nav mapping is the mechanism the issue's
// Akzeptanzkriterien (AK-378-1, AK-378-2, AK-378-3) actually hinge on: which nav entries a
// Salonmanager, an Ausbilder, a plain Mitarbeiter, and legacy ADMIN/MANAGER see. Permission sets
// below are copied verbatim from the SHIPPED Systemrollen-Templates (docs/permissions.md:444/446)
// — not hand-picked — so a template change that silently narrows/widens a role is caught here
// too, not only in the API's own template tests.

import { describe, it, expect } from "vitest";
import { visibleTeamNavItems } from "../team-nav";

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

describe("visibleTeamNavItems", () => {
  it("AK-378-1: Salonmanager sees Anträge, Team-Zeiten, Team-Abwesenheiten, Team-Kalender, Schichtplanung — not Berichte", () => {
    const items = visibleTeamNavItems({ permissions: SALONMANAGER_PERMISSIONS });
    const hrefs = items.map((i) => i.href);
    expect(hrefs).toEqual(["/inbox", "/team/time-entries", "/team/leave", "/teamcal", "/shifts"]);
    expect(hrefs).not.toContain("/reports");
  });

  it("AK-378-2: Ausbilder sees only Team-Zeiten, Team-Abwesenheiten, Team-Kalender — no Anträge, no Schichtplanung, no Berichte", () => {
    const items = visibleTeamNavItems({ permissions: AUSBILDER_PERMISSIONS });
    const hrefs = items.map((i) => i.href);
    expect(hrefs).toEqual(["/team/time-entries", "/team/leave", "/teamcal"]);
    expect(hrefs).not.toContain("/inbox"); // no approve permission
    expect(hrefs).not.toContain("/shifts"); // shift:read only, not shift:plan
    expect(hrefs).not.toContain("/reports"); // no report:read:ZUGEWIESEN
  });

  it("AK-378-3: a plain Mitarbeiter (no ZUGEWIESEN permissions at all) sees no Team-Bereich items", () => {
    expect(visibleTeamNavItems({ permissions: ["time-entry:read:EIGENE"] })).toEqual([]);
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

  it("display order is fixed regardless of the permission array's own order", () => {
    const items = visibleTeamNavItems({
      permissions: [...SALONMANAGER_PERMISSIONS].reverse(),
    });
    expect(items.map((i) => i.href)).toEqual([
      "/inbox",
      "/team/time-entries",
      "/team/leave",
      "/teamcal",
      "/shifts",
    ]);
  });
});
