// Issue #538 - the page-level decisions that used to read the compat role now follow the caller's
// permissions. Persona matrix: the system-role permission sets from the shared fixture, a custom
// role and a user without a permission list. Visible AND hidden cases per control.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  contractShiftRights,
  employeeAdminRights,
  mayReadTeamSaldo,
  mayFileRetroRequest,
  reportRights,
  salonAdminRights,
} from "$lib/page-rights";
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
        canAddTeamEntry: true,
        canRecordTeamAbsence: true,
        // Issue #612: the day list right and the tabs of the period area.
        canTimeEntryRead: true,
        periodTabs: ["zeiten", "urlaub", "heute"],
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
      canAddTeamEntry: false,
      canRecordTeamAbsence: false,
      canTimeEntryRead: false,
      // Issue #612: export is a dialog of the period bar, not a tab - no period tab at all.
      periodTabs: [],
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

// Issue #612 (AC-612-6, D-612-7): the tabs of the period area and the day-list right follow the
// permissions of the endpoints behind them, never the role.
describe("reportRights - period tabs and day list right (Issue #612)", () => {
  it("persona table of the tabs and canTimeEntryRead", () => {
    const table: Record<string, { tabs: string[]; timeEntryRead: boolean }> = {
      ADMIN: { tabs: ["zeiten", "urlaub", "heute"], timeEntryRead: true },
      OWNER: { tabs: ["zeiten", "urlaub", "heute"], timeEntryRead: true },
      MANAGER: { tabs: ["zeiten", "urlaub", "heute"], timeEntryRead: true },
      // The Salonleitung holds team-overview:read but neither report:read nor overtime:read.
      SALON_MANAGER: { tabs: ["heute"], timeEntryRead: true },
      // HR: report:read + overtime:read, no team overview, no time-entry read.
      HR: { tabs: ["zeiten", "urlaub"], timeEntryRead: false },
      // The Ausbilder reads time entries of the apprentices but holds no report right.
      TRAINER: { tabs: [], timeEntryRead: true },
      EMPLOYEE: { tabs: [], timeEntryRead: false },
    };
    for (const [key, expected] of Object.entries(table)) {
      const r = reportRights({ permissions: p[key] });
      expect([...r.periodTabs], `${key} periodTabs`).toEqual(expected.tabs);
      expect(r.canTimeEntryRead, `${key} canTimeEntryRead`).toBe(expected.timeEntryRead);
    }
  });

  it("HR keeps both period tabs and issues no time-data request: no day list, no export, no notify", () => {
    const r = reportRights({ permissions: p.HR });
    expect(r.canTimeEntryRead).toBe(false);
    expect(r.canReportExport).toBe(false);
    expect(r.canReportNotify).toBe(false);
    expect(r.canTeamAttendance).toBe(false);
  });

  it("the tab order is zeiten, urlaub, heute and each tab needs its own permission", () => {
    expect([...reportRights({ permissions: ["report:read:ZUGEWIESEN"] }).periodTabs]).toEqual([
      "zeiten",
      "urlaub",
    ]);
    expect([
      ...reportRights({ permissions: ["team-overview:read:ZUGEWIESEN"] }).periodTabs,
    ]).toEqual(["heute"]);
    expect([
      ...reportRights({
        permissions: ["team-overview:read:ZUGEWIESEN", "report:read:ZUGEWIESEN"],
      }).periodTabs,
    ]).toEqual(["zeiten", "urlaub", "heute"]);
  });

  it("a custom role with only report:export gets no period tab (export is a dialog of the bar)", () => {
    expect([...reportRights(customExporter).periodTabs]).toEqual([]);
  });

  it("a compat role without permissions, or no list at all, gets no tab and no day list", () => {
    for (const user of [adminRoleNoPermissions, noList, null, undefined]) {
      const r = reportRights(user);
      expect([...r.periodTabs]).toEqual([]);
      expect(r.canTimeEntryRead).toBe(false);
    }
  });
});

// Issue #587 (D-587-4): the two action links of a „Fehlt“ row of the attendance list. Each flag is
// the permission pair of the existing flow behind the link (Team-Zeiten „Eintrag nachtragen“ ->
// POST /time-entries for a person in scope; Team-Abwesenheiten „Abwesenheit erfassen“ ->
// POST /leave/requests on behalf). The target pages and the API enforce their own rules.
describe("reportRights - attendance row actions (Issue #587)", () => {
  it("persona table of the two flags", () => {
    const table: Record<string, [boolean, boolean]> = {
      ADMIN: [true, true],
      OWNER: [true, true],
      MANAGER: [true, true],
      SALON_MANAGER: [true, true],
      HR: [false, false],
      TRAINER: [false, false],
      EMPLOYEE: [false, false],
    };
    for (const [key, [addEntry, recordAbsence]] of Object.entries(table)) {
      const r = reportRights({ permissions: p[key] });
      expect(r.canAddTeamEntry, `${key} canAddTeamEntry`).toBe(addEntry);
      expect(r.canRecordTeamAbsence, `${key} canRecordTeamAbsence`).toBe(recordAbsence);
    }
  });

  it("a holder of only team-overview:read gets neither action", () => {
    const r = reportRights({ permissions: ["team-overview:read:ZUGEWIESEN"] });
    expect(r.canTeamAttendance).toBe(true);
    expect(r.canAddTeamEntry).toBe(false);
    expect(r.canRecordTeamAbsence).toBe(false);
  });

  it("each flag needs BOTH permissions of its flow", () => {
    expect(reportRights({ permissions: ["time-entry:read:ZUGEWIESEN"] }).canAddTeamEntry).toBe(
      false,
    );
    expect(reportRights({ permissions: ["time-entry:create:ZUGEWIESEN"] }).canAddTeamEntry).toBe(
      false,
    );
    expect(
      reportRights({
        permissions: ["time-entry:read:ZUGEWIESEN", "time-entry:create:ZUGEWIESEN"],
      }).canAddTeamEntry,
    ).toBe(true);
    expect(
      reportRights({ permissions: ["leave-request:read:ZUGEWIESEN"] }).canRecordTeamAbsence,
    ).toBe(false);
    expect(
      reportRights({ permissions: ["leave-request:create:ZUGEWIESEN"] }).canRecordTeamAbsence,
    ).toBe(false);
    expect(
      reportRights({
        permissions: ["leave-request:read:ZUGEWIESEN", "leave-request:create:ZUGEWIESEN"],
      }).canRecordTeamAbsence,
    ).toBe(true);
  });

  it("a compat role without permissions, or no permission list, gets neither action", () => {
    for (const user of [adminRoleNoPermissions, noList, null, undefined]) {
      const r = reportRights(user);
      expect(r.canAddTeamEntry).toBe(false);
      expect(r.canRecordTeamAbsence).toBe(false);
    }
  });
});

// Source pin of the reports page (it imports `$app/*` and cannot be mounted): only a „Fehlt“ row
// gets action links, each behind its own flag, built by the shared href builders.
describe("reports attendance list - action links (Issue #587, source pin)", () => {
  function readRoute(relativeFromHere: string, relativeFromCwd: string): string {
    try {
      return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
    } catch {
      return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
    }
  }
  // Issue #612 (pin ledger row 15): the attendance list lives in the tab „Heute“ component now.
  const REPORTS = readRoute(
    "../components/reports/TodayAttendance.svelte",
    "src/lib/components/reports/TodayAttendance.svelte",
  );
  const PAGE = readRoute(
    "../../routes/(app)/reports/+page.svelte",
    "src/routes/(app)/reports/+page.svelte",
  );
  const tableStart = REPORTS.indexOf('<table class="attendance-table">');
  const table = REPORTS.slice(tableStart, REPORTS.indexOf("</table>", tableStart));

  it("anchors are present (non-vacuous)", () => {
    expect(tableStart).toBeGreaterThan(-1);
    expect(table).toContain("pagedTodayRows");
  });

  it("offers the two links only on a missing row, each behind its flag", () => {
    expect(table).toContain('row.status === "missing"');
    expect(table).toContain("Eintrag nachtragen");
    expect(table).toContain("Abwesenheit erfassen");
    expect(table).toContain("teamDayHref(row.id, attendance.date)");
    expect(table).toContain("teamLeaveCreateHref(row.id, attendance.date)");
    const missingAt = table.indexOf('row.status === "missing"');
    expect(table.indexOf("Eintrag nachtragen")).toBeGreaterThan(missingAt);
    expect(table.indexOf("Abwesenheit erfassen")).toBeGreaterThan(missingAt);
    expect(table).toMatch(/canAddTeamEntry[\s\S]*Eintrag nachtragen/);
    expect(table).toMatch(/canRecordTeamAbsence[\s\S]*Abwesenheit erfassen/);
  });

  it("the page hands the component exactly the two rights, from reportRights", () => {
    expect(PAGE).toContain("let canAddTeamEntry = $derived(rights.canAddTeamEntry);");
    expect(PAGE).toContain("let canRecordTeamAbsence = $derived(rights.canRecordTeamAbsence);");
    expect(PAGE).toMatch(/<TodayAttendance[^>]*\{canAddTeamEntry\}[^>]*\{canRecordTeamAbsence\}/s);
    expect(REPORTS).not.toContain("reportRights");
  });

  it("no other status wording sits in the action cell", () => {
    expect(table.match(/Eintrag nachtragen/g)).toHaveLength(1);
    expect(table.match(/Abwesenheit erfassen/g)).toHaveLength(1);
  });
});

describe("employeeAdminRights (/admin/employees)", () => {
  it("admin may create, manage access, update and assign roles", () => {
    expect(employeeAdminRights({ permissions: p.ADMIN })).toEqual({
      canCreate: true,
      canManageAccess: true,
      canUpdate: true,
      canAssignRoles: true,
      canAnonymize: true,
      showActions: true,
    });
  });

  it("HR creates and updates but cannot manage access or pick a role", () => {
    expect(employeeAdminRights({ permissions: p.HR })).toEqual({
      canCreate: true,
      canManageAccess: false,
      canUpdate: true,
      canAssignRoles: false,
      canAnonymize: false,
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
        canAnonymize: false,
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

describe("salonAdminRights (/admin/salons, Issue #563)", () => {
  // Hand-written expectations, re-checked against the fixture: ADMIN and OWNER hold salon:read and
  // salon:manage, MANAGER and HR hold salon:read only (HR since Issue #86, owner decision
  // 16.10.2026), every other system role holds neither.
  it("admin and owner read and manage", () => {
    for (const key of ["ADMIN", "OWNER"]) {
      expect(salonAdminRights({ permissions: p[key] }), key).toEqual({
        canRead: true,
        canManage: true,
      });
    }
  });

  it("manager reads but cannot create or edit", () => {
    expect(salonAdminRights({ permissions: p.MANAGER })).toEqual({
      canRead: true,
      canManage: false,
    });
  });

  it("HR reads but cannot create or edit (salon:read since Issue #86, owner decision 16.10.2026)", () => {
    expect(salonAdminRights({ permissions: p.HR })).toEqual({
      canRead: true,
      canManage: false,
    });
  });

  it("salon manager, trainer and employee neither read nor manage", () => {
    for (const key of ["SALON_MANAGER", "TRAINER", "EMPLOYEE"]) {
      expect(salonAdminRights({ permissions: p[key] }), key).toEqual({
        canRead: false,
        canManage: false,
      });
    }
  });

  it("a custom role with salon:manage only manages without reading, whatever the compat role says", () => {
    expect(salonAdminRights({ permissions: ["salon:manage:ZUGEWIESEN"] })).toEqual({
      canRead: false,
      canManage: true,
    });
    expect(salonAdminRights(adminRoleNoPermissions)).toEqual({ canRead: false, canManage: false });
    expect(salonAdminRights(noList)).toEqual({ canRead: false, canManage: false });
    expect(salonAdminRights(null)).toEqual({ canRead: false, canManage: false });
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
    expect(src).toContain("/role-assignments/role-names");
    expect(src).toContain("let showRoles = $derived(roleNamesByUser !== null);");
    expect(src).toContain("if (!canAssignRoles)");
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

describe("contractShiftRights (/admin/employees/:id, #650)", () => {
  it("only shift:plan offers discarding shifts; the HR template does not", () => {
    expect(contractShiftRights({ permissions: p.HR }).canDiscardShifts).toBe(false);
    expect(contractShiftRights({ permissions: p.ADMIN }).canDiscardShifts).toBe(true);
    expect(contractShiftRights({ permissions: p.SALON_MANAGER }).canDiscardShifts).toBe(true);
    expect(
      contractShiftRights({ permissions: ["contract:update:ZUGEWIESEN"] }).canDiscardShifts,
    ).toBe(false);
  });

  it("is fail-closed for a missing caller or an admin compat role without permissions", () => {
    expect(contractShiftRights(null).canDiscardShifts).toBe(false);
    expect(contractShiftRights(adminRoleNoPermissions).canDiscardShifts).toBe(false);
    expect(contractShiftRights(noList).canDiscardShifts).toBe(false);
  });
});

// Issue #588 (P-10): the dashboard card "Salden" reads GET /dashboard/overtime-overview, whose two
// guards are team-overview:read AND overtime:read - the same rule /reports uses for its overview.
describe("mayReadTeamSaldo (Issue #588)", () => {
  const BOTH = ["team-overview:read:ZUGEWIESEN", "overtime:read:ZUGEWIESEN"];

  it("needs both permissions", () => {
    expect(mayReadTeamSaldo({ permissions: BOTH })).toBe(true);
    expect(mayReadTeamSaldo({ permissions: ["team-overview:read:ZUGEWIESEN"] })).toBe(false);
    expect(mayReadTeamSaldo({ permissions: ["overtime:read:ZUGEWIESEN"] })).toBe(false);
    expect(mayReadTeamSaldo({ permissions: [] })).toBe(false);
  });

  it("is false for no caller, no permission list and a compat role without permissions", () => {
    expect(mayReadTeamSaldo(null)).toBe(false);
    expect(mayReadTeamSaldo(undefined)).toBe(false);
    expect(mayReadTeamSaldo(noList)).toBe(false);
    expect(mayReadTeamSaldo(adminRoleNoPermissions)).toBe(false);
  });

  it("equals reportRights().canTeamOvertime for every persona and the custom sets", () => {
    const sets: Array<{ permissions?: string[] } | null | undefined> = [
      ...Object.values(p).map((permissions) => ({ permissions })),
      customExporter,
      adminRoleNoPermissions,
      noList,
      { permissions: BOTH },
      { permissions: [BOTH[0]] },
      { permissions: [BOTH[1]] },
      null,
      undefined,
    ];
    expect(sets.length).toBeGreaterThan(8);
    for (const set of sets) {
      expect(mayReadTeamSaldo(set)).toBe(reportRights(set).canTeamOvertime);
    }
  });

  it("admin, owner and manager see the card; salon manager and employee do not", () => {
    for (const key of ["ADMIN", "OWNER", "MANAGER"]) {
      expect(mayReadTeamSaldo({ permissions: p[key] }), key).toBe(true);
    }
    for (const key of ["SALON_MANAGER", "EMPLOYEE", "TRAINER"]) {
      expect(mayReadTeamSaldo({ permissions: p[key] }), key).toBe(false);
    }
  });
});
