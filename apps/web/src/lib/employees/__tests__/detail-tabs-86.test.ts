// Issue #86 (D-04, AC-86-7) - the employee detail tab strip follows the caller's permissions.
// Personas come from the shared system-role fixture; the expected tab ids are written out by hand.
import { describe, expect, it } from "vitest";
import { employeeAdminRights } from "$lib/page-rights";
import { employeeDetailTabs } from "$lib/employees/detail-tabs";
import personas from "$lib/nav/__tests__/fixtures/system-role-permissions.json";

const p = personas as Record<string, string[]>;

function ids(permissions: string[]): string[] {
  return employeeDetailTabs(employeeAdminRights({ permissions })).map((t) => t.id);
}

describe("employeeDetailTabs (Issue #86, D-04)", () => {
  it("fixture is non-empty (anti-vacuity)", () => {
    expect(Object.keys(p).length).toBeGreaterThan(0);
    expect(p.ADMIN.length).toBeGreaterThan(0);
  });

  it("admin and owner get all five tabs in order", () => {
    for (const key of ["ADMIN", "OWNER"]) {
      expect(ids(p[key]), key).toEqual([
        "stammdaten",
        "arbeitszeit",
        "urlaub",
        "salons",
        "berechtigungen",
        "danger",
      ]);
    }
  });

  it("HR gets Stammdaten, Arbeitszeit, Urlaub and Salons only", () => {
    expect(ids(p.HR)).toEqual(["stammdaten", "arbeitszeit", "urlaub", "salons"]);
  });

  it("manager, salon manager, trainer and employee get the four base tabs", () => {
    for (const key of ["MANAGER", "SALON_MANAGER", "TRAINER", "EMPLOYEE"]) {
      expect(ids(p[key]), key).toEqual(["stammdaten", "arbeitszeit", "urlaub", "salons"]);
    }
  });

  it("Berechtigungen follows employee:manage-access OR role-assignment:manage", () => {
    expect(ids(["employee:manage-access:ZUGEWIESEN"])).toContain("berechtigungen");
    expect(ids(["role-assignment:manage:ZUGEWIESEN"])).toContain("berechtigungen");
    expect(ids(["employee:update:ZUGEWIESEN"])).not.toContain("berechtigungen");
  });

  it("Gefahrenzone follows employee:anonymize alone", () => {
    expect(ids(["employee:anonymize:ZUGEWIESEN"])).toContain("danger");
    expect(
      ids(["employee:manage-access:ZUGEWIESEN", "role-assignment:manage:ZUGEWIESEN"]),
    ).not.toContain("danger");
  });

  it("a caller without a permission list sees the base tabs only", () => {
    expect(employeeDetailTabs(employeeAdminRights(null)).map((t) => t.id)).toEqual([
      "stammdaten",
      "arbeitszeit",
      "urlaub",
      "salons",
    ]);
  });

  it("labels are German; the danger tab is called Gefahrenzone", () => {
    const tabs = employeeDetailTabs(employeeAdminRights({ permissions: p.ADMIN }));
    expect(tabs.map((t) => t.label)).toEqual([
      "Stammdaten",
      "Arbeitszeit",
      "Urlaub",
      "Salons",
      "Berechtigungen",
      "Gefahrenzone",
    ]);
    expect(tabs.some((t) => t.label === ["Danger", "Zone"].join(" "))).toBe(false);
  });
});
