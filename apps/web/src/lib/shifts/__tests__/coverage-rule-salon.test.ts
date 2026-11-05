// Issue #647 (D-09, D-10) — the salon of a coverage rule on /admin/shifts, as pure rules.
//
// Mutation proof (Phase 647, recorded at execution, each restored from a backup copy):
//   M1  coverageRuleSalonPayload always returns { salonId } (also while the select is hidden)
//       -> red: "not shown -> no key at all (an omitted key leaves the stored salon unchanged)".
//   M2  coverageRuleSalonChoices never appends the editing rule's salon that is missing from the
//       active list -> red: "a deactivated salon of the rule being edited stays a choice, marked".
import { describe, it, expect } from "vitest";
import {
  COVERAGE_RULE_ALL_SALONS_CELL,
  COVERAGE_RULE_ALL_SALONS_OPTION,
  COVERAGE_RULE_SALON_INACTIVE_BADGE,
  coverageRuleSalonCell,
  coverageRuleSalonChoices,
  coverageRuleSalonPayload,
  showCoverageSalonColumn,
  type CoverageRuleSalonFields,
} from "../coverage-rule-salon";

const tenantWide: CoverageRuleSalonFields = { salonId: null, salonName: null, salonActive: null };
const ruleA: CoverageRuleSalonFields = {
  salonId: "salon-1",
  salonName: "Salon Nord",
  salonActive: true,
};
const ruleGone: CoverageRuleSalonFields = {
  salonId: "salon-9",
  salonName: "Salon Alt",
  salonActive: false,
};

describe("coverageRuleSalonCell", () => {
  it("a tenant-wide rule reads 'Alle Salons'", () => {
    expect(coverageRuleSalonCell(tenantWide)).toEqual({
      label: COVERAGE_RULE_ALL_SALONS_CELL,
      inactive: false,
    });
    expect(COVERAGE_RULE_ALL_SALONS_CELL).toBe("Alle Salons");
  });

  it("a salon rule shows the name, active", () => {
    expect(coverageRuleSalonCell(ruleA)).toEqual({ label: "Salon Nord", inactive: false });
  });

  it("a rule of a deactivated salon is marked inactive", () => {
    expect(coverageRuleSalonCell(ruleGone)).toEqual({ label: "Salon Alt", inactive: true });
    expect(COVERAGE_RULE_SALON_INACTIVE_BADGE).toBe("Salon deaktiviert");
  });

  it("a salon rule without a name falls back to 'Salon' and is not inactive unless stated", () => {
    expect(
      coverageRuleSalonCell({ salonId: "salon-2", salonName: null, salonActive: null }),
    ).toEqual({ label: "Salon", inactive: false });
  });
});

describe("showCoverageSalonColumn", () => {
  it("is shown while salon options are shown, even for an empty list", () => {
    expect(showCoverageSalonColumn(true, [])).toBe(true);
    expect(showCoverageSalonColumn(true, [tenantWide])).toBe(true);
  });

  it("without options it is shown only when some rule names a salon", () => {
    expect(showCoverageSalonColumn(false, [tenantWide, ruleA])).toBe(true);
    expect(showCoverageSalonColumn(false, [ruleGone])).toBe(true);
  });

  it("without options and without a salon rule it is hidden (empty list included)", () => {
    expect(showCoverageSalonColumn(false, [tenantWide, tenantWide])).toBe(false);
    expect(showCoverageSalonColumn(false, [])).toBe(false);
  });
});

describe("coverageRuleSalonChoices", () => {
  const salons = [
    { id: "salon-1", name: "Salon Nord" },
    { id: "salon-2", name: "Salon Süd" },
  ];

  it("starts with the tenant-wide choice (empty value), then the salons in the given order", () => {
    expect(coverageRuleSalonChoices(salons, null)).toEqual([
      { value: "", label: COVERAGE_RULE_ALL_SALONS_OPTION },
      { value: "salon-1", label: "Salon Nord" },
      { value: "salon-2", label: "Salon Süd" },
    ]);
    expect(COVERAGE_RULE_ALL_SALONS_OPTION).toBe("Alle Salons (mandantenweit)");
  });

  it("a tenant-wide or listed editing rule adds nothing", () => {
    expect(coverageRuleSalonChoices(salons, tenantWide)).toHaveLength(3);
    expect(coverageRuleSalonChoices(salons, ruleA)).toHaveLength(3);
  });

  it("a deactivated salon of the rule being edited stays a choice, marked", () => {
    const choices = coverageRuleSalonChoices(salons, ruleGone);
    expect(choices).toHaveLength(4);
    expect(choices[3]).toEqual({ value: "salon-9", label: "Salon Alt (deaktiviert)" });
  });

  it("an editing salon missing from the list but not stated inactive keeps its plain name", () => {
    const choices = coverageRuleSalonChoices(salons, {
      salonId: "salon-7",
      salonName: "Salon Fern",
      salonActive: true,
    });
    expect(choices[3]).toEqual({ value: "salon-7", label: "Salon Fern" });
  });
});

describe("coverageRuleSalonPayload", () => {
  it("not shown -> no key at all (an omitted key leaves the stored salon unchanged)", () => {
    expect(coverageRuleSalonPayload(false, "salon-1")).toEqual({});
    expect(coverageRuleSalonPayload(false, "")).toEqual({});
    expect(Object.keys(coverageRuleSalonPayload(false, ""))).toHaveLength(0);
  });

  it("shown and empty -> tenant-wide (null)", () => {
    expect(coverageRuleSalonPayload(true, "")).toEqual({ salonId: null });
  });

  it("shown and chosen -> the salon id", () => {
    expect(coverageRuleSalonPayload(true, "salon-1")).toEqual({ salonId: "salon-1" });
  });
});
