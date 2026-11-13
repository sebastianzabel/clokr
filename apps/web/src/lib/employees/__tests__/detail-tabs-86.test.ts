// Issue #86 (D-04, AC-86-7) and Issue #854 - the employee detail tab strip follows the caller's
// permissions. Personas come from the shared system-role fixture; the expected tab ids are written
// out by hand. The former tab ids resolve through DETAIL_TAB_ALIASES onto the visible tabs only.
import { describe, expect, it } from "vitest";
import { employeeAdminRights } from "$lib/page-rights";
import { DETAIL_TAB_ALIASES, employeeDetailTabs } from "$lib/employees/detail-tabs";
import { tabFromHash } from "$lib/nav/tab-hash";
import personas from "$lib/nav/__tests__/fixtures/system-role-permissions.json";

const p = personas as Record<string, string[]>;

function ids(permissions: string[]): string[] {
  return employeeDetailTabs(employeeAdminRights({ permissions })).map((t) => t.id);
}

const BASE = ["person", "vertrag", "urlaub", "salons"];

describe("employeeDetailTabs (Issue #86, D-04; Issue #854)", () => {
  it("fixture is non-empty (anti-vacuity)", () => {
    expect(Object.keys(p).length).toBeGreaterThan(0);
    expect(p.ADMIN.length).toBeGreaterThan(0);
  });

  it("admin and owner get all five tabs in order", () => {
    for (const key of ["ADMIN", "OWNER"]) {
      expect(ids(p[key]), key).toEqual([...BASE, "zugang"]);
    }
  });

  it("HR gets Person, Vertrag, Urlaub and Salons only", () => {
    expect(ids(p.HR)).toEqual(BASE);
  });

  it("manager, salon manager, trainer and employee get the four base tabs", () => {
    for (const key of ["MANAGER", "SALON_MANAGER", "TRAINER", "EMPLOYEE"]) {
      expect(ids(p[key]), key).toEqual(BASE);
    }
  });

  it("Zugang follows employee:manage-access, role-assignment:manage OR employee:anonymize", () => {
    expect(ids(["employee:manage-access:ZUGEWIESEN"])).toContain("zugang");
    expect(ids(["role-assignment:manage:ZUGEWIESEN"])).toContain("zugang");
    expect(ids(["employee:anonymize:ZUGEWIESEN"])).toContain("zugang");
    expect(ids(["employee:update:ZUGEWIESEN"])).not.toContain("zugang");
  });

  it("zugang is absent without the three rights", () => {
    expect(ids([])).toEqual(BASE);
    expect(ids(["employee:update:ZUGEWIESEN", "employee:read:ZUGEWIESEN"])).not.toContain("zugang");
  });

  it("a caller without a permission list sees the base tabs only", () => {
    expect(employeeDetailTabs(employeeAdminRights(null)).map((t) => t.id)).toEqual(BASE);
  });

  it("labels are German and the two former tabs are one", () => {
    const tabs = employeeDetailTabs(employeeAdminRights({ permissions: p.ADMIN }));
    expect(tabs.map((t) => t.label)).toEqual(["Person", "Vertrag", "Urlaub", "Salons", "Zugang"]);
    expect(tabs.some((t) => /Berechtigungen|Gefahrenzone/.test(t.label))).toBe(false);
  });
});

describe("DETAIL_TAB_ALIASES (old deep links, T-854-50)", () => {
  const all = employeeDetailTabs(employeeAdminRights({ permissions: p.ADMIN })).map((t) => t.id);
  const hr = employeeDetailTabs(employeeAdminRights({ permissions: p.HR })).map((t) => t.id);

  it("states exactly the four aliases", () => {
    expect(DETAIL_TAB_ALIASES).toEqual({
      stammdaten: "person",
      arbeitszeit: "vertrag",
      berechtigungen: "zugang",
      danger: "zugang",
    });
  });

  it("the old ids open the new tabs", () => {
    expect(tabFromHash("#stammdaten", all, DETAIL_TAB_ALIASES)).toBe("person");
    expect(tabFromHash("#arbeitszeit", all, DETAIL_TAB_ALIASES)).toBe("vertrag");
    expect(tabFromHash("#berechtigungen", all, DETAIL_TAB_ALIASES)).toBe("zugang");
    expect(tabFromHash("#danger", all, DETAIL_TAB_ALIASES)).toBe("zugang");
  });

  it("the new ids open themselves", () => {
    for (const id of all) expect(tabFromHash(`#${id}`, all, DETAIL_TAB_ALIASES)).toBe(id);
  });

  it("a hidden Zugang tab is never opened through the hash or an alias", () => {
    expect(hr).not.toContain("zugang");
    for (const hash of ["#zugang", "#berechtigungen", "#danger"]) {
      expect(tabFromHash(hash, hr, DETAIL_TAB_ALIASES), hash).toBe("person");
    }
  });

  it("an unknown hash and a prototype key open the first tab", () => {
    expect(tabFromHash("#nope", all, DETAIL_TAB_ALIASES)).toBe("person");
    expect(tabFromHash("#constructor", all, DETAIL_TAB_ALIASES)).toBe("person");
  });
});
