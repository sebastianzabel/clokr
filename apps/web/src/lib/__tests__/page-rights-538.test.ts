// Issue #538 - the page-level decisions that used to read the compat role now follow the caller's
// permissions. Persona matrix: the system-role permission sets from the shared fixture, a custom
// role and a user without a permission list. Visible AND hidden cases per control.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { employeeAdminRights, mayFileRetroRequest, reportRights } from "$lib/page-rights";
import personas from "$lib/nav/__tests__/fixtures/system-role-permissions.json";

const p = personas as Record<string, string[]>;
// A custom role with only report:export - the compat role of its holder would be EMPLOYEE.
const customExporter = { permissions: ["report:export:ZUGEWIESEN"] };
// Compat role says ADMIN but the permission list is empty: nothing may show (fail-closed).
const adminRoleNoPermissions = { role: "ADMIN", permissions: [] as string[] };
const noList = { role: "ADMIN" } as { role: string; permissions?: string[] };

describe("reportRights (/reports)", () => {
  it("admin and owner see every block", () => {
    for (const key of ["ADMIN", "OWNER"]) {
      expect(reportRights({ permissions: p[key] }), key).toEqual({
        canTeamAttendance: true,
        canTeamOvertime: true,
        canReportRead: true,
        canReportExport: true,
        canReportNotify: true,
        showTeamArea: true,
      });
    }
  });

  it("manager sees every block too", () => {
    expect(reportRights({ permissions: p.MANAGER }).showTeamArea).toBe(true);
    expect(reportRights({ permissions: p.MANAGER }).canReportNotify).toBe(true);
  });

  it("salon manager (compat role EMPLOYEE) gets the attendance block only, no reports or exports", () => {
    const r = reportRights({ permissions: p.SALON_MANAGER });
    expect(r.canTeamAttendance).toBe(true);
    expect(r.showTeamArea).toBe(true);
    expect(r.canTeamOvertime).toBe(false);
    expect(r.canReportRead).toBe(false);
    expect(r.canReportExport).toBe(false);
    expect(r.canReportNotify).toBe(false);
  });

  it("a custom role with report:export shows the export cards and nothing else", () => {
    expect(reportRights(customExporter)).toEqual({
      canTeamAttendance: false,
      canTeamOvertime: false,
      canReportRead: false,
      canReportExport: true,
      canReportNotify: false,
      showTeamArea: true,
    });
  });

  it("employee and trainer see the personal monthly closes, no team area", () => {
    for (const key of ["EMPLOYEE", "TRAINER"]) {
      expect(reportRights({ permissions: p[key] }).showTeamArea, key).toBe(false);
    }
  });

  it("overtime overview needs overtime:read as well as team-overview:read", () => {
    const onlyTeam = reportRights({ permissions: ["team-overview:read:ZUGEWIESEN"] });
    const onlyOvertime = reportRights({ permissions: ["overtime:read:ZUGEWIESEN"] });
    expect(onlyTeam.canTeamOvertime).toBe(false);
    expect(onlyOvertime.canTeamOvertime).toBe(false);
    expect(onlyOvertime.showTeamArea).toBe(false);
  });

  it("a compat role without permissions, or no permission list at all, shows nothing", () => {
    expect(reportRights(adminRoleNoPermissions).showTeamArea).toBe(false);
    expect(reportRights(noList).showTeamArea).toBe(false);
    expect(reportRights(null).showTeamArea).toBe(false);
    expect(reportRights(undefined).showTeamArea).toBe(false);
  });
});

describe("employeeAdminRights (/admin/employees)", () => {
  it("admin may create, manage access, update and assign roles", () => {
    expect(employeeAdminRights({ permissions: p.ADMIN })).toEqual({
      canCreate: true,
      canManageAccess: true,
      canUpdate: true,
      canAssignRoles: true,
      showActions: true,
    });
  });

  it("HR creates and updates but cannot manage access or pick a role", () => {
    expect(employeeAdminRights({ permissions: p.HR })).toEqual({
      canCreate: true,
      canManageAccess: false,
      canUpdate: true,
      canAssignRoles: false,
      showActions: true,
    });
  });

  it("manager, salon manager, trainer and employee get no create button, action column or role select", () => {
    for (const key of ["MANAGER", "SALON_MANAGER", "TRAINER", "EMPLOYEE"]) {
      expect(employeeAdminRights({ permissions: p[key] }), key).toEqual({
        canCreate: false,
        canManageAccess: false,
        canUpdate: false,
        canAssignRoles: false,
        showActions: false,
      });
    }
  });

  it("role selection follows role-assignment:manage alone, whatever the compat role says", () => {
    const onlyRoles = employeeAdminRights({ permissions: ["role-assignment:manage:ZUGEWIESEN"] });
    expect(onlyRoles.canAssignRoles).toBe(true);
    expect(onlyRoles.canUpdate).toBe(false);
    expect(employeeAdminRights(adminRoleNoPermissions).canAssignRoles).toBe(false);
    expect(employeeAdminRights(noList).canCreate).toBe(false);
  });
});

describe("mayFileRetroRequest (/time-entries)", () => {
  it("employee, manager and admin hold retro-request:create:EIGENE", () => {
    for (const key of ["EMPLOYEE", "MANAGER", "ADMIN"]) {
      expect(mayFileRetroRequest({ permissions: p[key] }), key).toBe(true);
    }
  });

  it("a user without the permission gets no retro form, whatever the compat role says", () => {
    expect(mayFileRetroRequest({ permissions: p.TRAINER })).toBe(false);
    expect(mayFileRetroRequest({ permissions: ["retro-request:create:ZUGEWIESEN"] })).toBe(false);
    expect(mayFileRetroRequest(adminRoleNoPermissions)).toBe(false);
    expect(mayFileRetroRequest(null)).toBe(false);
  });
});

describe("the pages read the rights module and no role", () => {
  function read(relativeFromHere: string, relativeFromCwd: string): string {
    try {
      return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
    } catch {
      return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
    }
  }
  const pages: [string, string, string][] = [
    [
      "../../routes/(app)/reports/+page.svelte",
      "src/routes/(app)/reports/+page.svelte",
      "reportRights(",
    ],
    [
      "../../routes/(app)/admin/employees/+page.svelte",
      "src/routes/(app)/admin/employees/+page.svelte",
      "employeeAdminRights(",
    ],
    [
      "../../routes/(app)/admin/employees/[id]/+page.svelte",
      "src/routes/(app)/admin/employees/[id]/+page.svelte",
      "employeeAdminRights(",
    ],
    [
      "../../routes/(app)/time-entries/+page.svelte",
      "src/routes/(app)/time-entries/+page.svelte",
      "mayFileRetroRequest(",
    ],
  ];
  for (const [here, cwd, call] of pages) {
    it(`${cwd} calls ${call}`, () => {
      const src = read(here, cwd);
      expect(src.length).toBeGreaterThan(10_000);
      expect(src).toContain(call);
      expect(src).not.toMatch(/\$authStore\.user\??\.role\b/);
    });
  }
});

describe("the employee list shows roles only from roleNames (Issue #538)", () => {
  const src = readFileSync(
    resolve(process.cwd(), "src/routes/(app)/admin/employees/+page.svelte"),
    "utf8",
  );
  it("never reads the compat role of a listed person, and offers chip, filter and count only when names arrive", () => {
    expect(src.length).toBeGreaterThan(10_000);
    expect(src).not.toMatch(/\buser\??\.role\b/);
    expect(src).toContain("roleNames: string[] | null");
    expect(src).toContain("employees.some((e) => e.roleNames !== null)");
    expect(src).toContain("{#if showRoles}");
  });

  it("the team calendar no longer renders a role under a name", () => {
    const cal = readFileSync(
      resolve(process.cwd(), "src/routes/(app)/teamcal/+page.svelte"),
      "utf8",
    );
    expect(cal.length).toBeGreaterThan(5_000);
    expect(cal).not.toContain("u.role");
  });
});
