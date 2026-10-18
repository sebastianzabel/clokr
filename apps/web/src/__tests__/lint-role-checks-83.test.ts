// Issue #83 (D-10/D-13) — the files Phase 83 converted from role checks to permissions are in the
// web role-check gate's scope, exist, carry no role check, and the gate still finds a real one.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWLIST,
  SCOPE_FILES,
  findRoleChecks,
  staleAllowlistEntries,
} from "../../scripts/lint-role-checks.mjs";

const REPO = resolve(process.cwd(), "..", "..");
const PHASE_83 = [
  "apps/web/src/routes/(app)/admin/+layout.svelte",
  "apps/web/src/routes/(app)/admin/+page.svelte",
  "apps/web/src/routes/(app)/admin/shifts/+page.svelte",
  "apps/web/src/routes/(app)/admin/availability/+page.svelte",
  "apps/web/src/routes/(app)/admin/availability/[employeeId]/+page.svelte",
  "apps/web/src/routes/(app)/admin/roles/+page.svelte",
  "apps/web/src/lib/nav/admin-route-permissions.ts",
  "apps/web/src/lib/api/roles.ts",
  "apps/web/src/lib/components/ui/CommandPalette.svelte",
  "apps/web/src/lib/components/layout/BottomTabBar.svelte",
];

// Issue #538: the remaining pages and shell parts. Sidebar was already in scope (its two label
// lines were the allowlisted exceptions); the persona store was deleted, nothing imported it.
const ISSUE_538 = [
  "apps/web/src/routes/(app)/admin/employees/+page.svelte",
  "apps/web/src/routes/(app)/admin/employees/[id]/+page.svelte",
  "apps/web/src/routes/(app)/reports/+page.svelte",
  // Issue #612: the period components of the reports page decide nothing by role either.
  "apps/web/src/lib/components/reports/PeriodBar.svelte",
  "apps/web/src/lib/components/reports/PeriodKpis.svelte",
  "apps/web/src/lib/components/reports/PeriodRangeDialog.svelte",
  "apps/web/src/lib/components/reports/PersonDrilldown.svelte",
  "apps/web/src/lib/components/reports/TimesAccountsTable.svelte",
  "apps/web/src/lib/components/reports/VacationAbsenceTab.svelte",
  "apps/web/src/lib/components/reports/TodayAttendance.svelte",
  "apps/web/src/lib/components/reports/ExportDialog.svelte",
  "apps/web/src/lib/reports/period-table.ts",
  "apps/web/src/routes/(app)/time-entries/+page.svelte",
  "apps/web/src/routes/(app)/settings/+page.svelte",
  "apps/web/src/lib/components/layout/Topbar.svelte",
  "apps/web/src/lib/components/layout/Sidebar.svelte",
  "apps/web/src/lib/leave/team-calendar-visibility.ts",
  "apps/web/src/lib/page-rights.ts",
];

describe("web role-check gate covers Issue #538 without an exception", () => {
  it("lists every file, each exists and carries no role check", () => {
    for (const file of ISSUE_538) {
      expect(SCOPE_FILES).toContain(file);
      expect(existsSync(resolve(REPO, file)), file).toBe(true);
      expect(findRoleChecks(readFileSync(resolve(REPO, file), "utf8")), file).toEqual([]);
    }
  });

  it("the persona store is gone", () => {
    expect(existsSync(resolve(REPO, "apps/web/src/lib/stores/persona.ts"))).toBe(false);
  });

  it("flags a compat-role read through a store snapshot", () => {
    expect(findRoleChecks("const role = get(authStore).user?.role;").length).toBeGreaterThan(0);
    expect(findRoleChecks("currentRole = auth.user?.role ?? null;").length).toBeGreaterThan(0);
  });

  it("the shell shows the assigned role names, not the compat role", () => {
    for (const file of [
      "apps/web/src/lib/components/layout/Topbar.svelte",
      "apps/web/src/lib/components/layout/Sidebar.svelte",
      "apps/web/src/routes/(app)/settings/+page.svelte",
    ]) {
      const src = readFileSync(resolve(REPO, file), "utf8");
      expect(src, file).toContain("roleNamesLabel(");
      expect(src, file).not.toContain("Administrator");
    }
  });
});

describe("web role-check gate covers Phase 83 (Issue #83)", () => {
  it("lists every converted file, and each exists", () => {
    for (const file of PHASE_83) {
      expect(SCOPE_FILES).toContain(file);
      expect(existsSync(resolve(REPO, file)), file).toBe(true);
    }
  });

  it("finds no role check in the converted files", () => {
    for (const file of PHASE_83) {
      expect(findRoleChecks(readFileSync(resolve(REPO, file), "utf8")), file).toEqual([]);
    }
  });

  it("still flags a role comparison and a compat-role read", () => {
    expect(findRoleChecks('if (role === "ADMIN") {}').length).toBeGreaterThan(0);
    expect(findRoleChecks("const r = $authStore.user?.role;").length).toBeGreaterThan(0);
  });

  it("keeps no exception (Issue #538) and still flags stale ones", () => {
    expect([...ALLOWLIST]).toHaveLength(0);
    const read = (file: string) => readFileSync(resolve(REPO, file), "utf8");
    expect(staleAllowlistEntries(ALLOWLIST, SCOPE_FILES, read)).toEqual([]);
    const outOfScope = "apps/web/src/no-such-file.svelte::x";
    const noMatch = "apps/web/src/lib/components/layout/Sidebar.svelte::no such line";
    expect(staleAllowlistEntries([outOfScope, noMatch], SCOPE_FILES, read)).toEqual([
      outOfScope,
      noMatch,
    ]);
  });
});

describe("web role-check gate covers the role-less session (Issue #539)", () => {
  const ISSUE_539 = [
    "apps/web/src/lib/stores/auth.ts",
    "apps/web/src/routes/(auth)/login/+page.svelte",
    "apps/web/src/routes/(auth)/otp/+page.svelte",
  ];

  it("lists the session store and both sign-in pages, each exists and carries no role check", () => {
    for (const file of ISSUE_539) {
      expect(SCOPE_FILES).toContain(file);
      expect(existsSync(resolve(REPO, file)), file).toBe(true);
      expect(findRoleChecks(readFileSync(resolve(REPO, file), "utf8")), file).toEqual([]);
    }
  });
});
