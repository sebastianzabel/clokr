// Issue #836 — the pure form model of the rule modal on /admin/leave-limits.
import { describe, it, expect } from "vitest";
import {
  blackoutPreset,
  emptyRuleForm,
  ruleFormFromDto,
  ruleFormPayload,
  validateRuleForm,
  type RuleForm,
} from "../rule-form";
import type { LeaveLimitRuleDto } from "../types";

function form(over: Partial<RuleForm> = {}): RuleForm {
  return { ...emptyRuleForm("s1"), maxPersons: "2", ...over };
}

describe("presets", () => {
  it("blackoutPreset is group ALL, maximum 0, the given salon, no window yet", () => {
    const preset = blackoutPreset("s1");
    expect(preset.groupKind).toBe("ALL");
    expect(preset.maxPersons).toBe("0");
    expect(preset.salonId).toBe("s1");
    expect(preset.validFrom).toBe("");
    expect(preset.validUntil).toBe("");
  });

  it("blackoutPreset(null) is the all-salons blackout", () => {
    expect(blackoutPreset(null).salonId).toBeNull();
  });

  it("emptyRuleForm starts as an all-persons rule without a window", () => {
    const empty = emptyRuleForm("s1");
    expect(empty.groupKind).toBe("ALL");
    expect(empty.classification).toBeNull();
    expect(empty.accessRoleId).toBeNull();
    expect(empty.validFrom).toBe("");
  });
});

describe("validateRuleForm", () => {
  it.each(["-1", "1.5", "1000", "", "abc"])("refuses the maximum %j", (maxPersons) => {
    expect(validateRuleForm(form({ maxPersons }), { blackout: false })).toEqual(expect.any(String));
  });

  it("accepts the bounds 0 and 999", () => {
    expect(validateRuleForm(form({ maxPersons: "0" }), { blackout: false })).toBeNull();
    expect(validateRuleForm(form({ maxPersons: "999" }), { blackout: false })).toBeNull();
  });

  it("refuses a window whose start lies after its end", () => {
    const message = validateRuleForm(form({ validFrom: "2027-12-24", validUntil: "2027-12-01" }), {
      blackout: false,
    });
    expect(message).toMatch(/Ende|Beginn/);
  });

  it("refuses CLASSIFICATION without a classification and ACCESS_ROLE without a role", () => {
    expect(validateRuleForm(form({ groupKind: "CLASSIFICATION" }), { blackout: false })).toEqual(
      expect.any(String),
    );
    expect(validateRuleForm(form({ groupKind: "ACCESS_ROLE" }), { blackout: false })).toEqual(
      expect.any(String),
    );
  });

  it("refuses a blackout without both dates and accepts it with both", () => {
    const base = blackoutPreset("s1");
    expect(validateRuleForm(base, { blackout: true })).toEqual(expect.any(String));
    expect(validateRuleForm({ ...base, validFrom: "2027-12-01" }, { blackout: true })).toEqual(
      expect.any(String),
    );
    expect(
      validateRuleForm(
        { ...base, validFrom: "2027-12-01", validUntil: "2027-12-24" },
        { blackout: true },
      ),
    ).toBeNull();
  });

  it("accepts a valid ALL rule without a window", () => {
    expect(validateRuleForm(form(), { blackout: false })).toBeNull();
  });

  it("refuses a name longer than 80 characters", () => {
    expect(validateRuleForm(form({ name: "x".repeat(81) }), { blackout: false })).toEqual(
      expect.any(String),
    );
  });
});

describe("ruleFormPayload", () => {
  it("sends explicit nulls for the unused fields of an ALL rule", () => {
    expect(ruleFormPayload(form())).toEqual({
      salonId: "s1",
      groupKind: "ALL",
      classification: null,
      accessRoleId: null,
      maxPersons: 2,
      validFrom: null,
      validUntil: null,
      name: null,
    });
  });

  it("drops the foreign group field and trims the name", () => {
    const payload = ruleFormPayload(
      form({
        groupKind: "CLASSIFICATION",
        classification: "AZUBI",
        accessRoleId: "stale-role",
        name: "  Weihnachtsgeschäft ",
        validFrom: "2027-12-01",
        validUntil: "2027-12-24",
      }),
    );
    expect(payload.accessRoleId).toBeNull();
    expect(payload.classification).toBe("AZUBI");
    expect(payload.name).toBe("Weihnachtsgeschäft");
    expect(payload.validFrom).toBe("2027-12-01");
  });

  it("keeps salonId null for the all-salons rule", () => {
    expect(ruleFormPayload(form({ salonId: null })).salonId).toBeNull();
  });
});

describe("ruleFormFromDto", () => {
  it("round-trips a stored rule's fields through the payload", () => {
    const dto: LeaveLimitRuleDto = {
      id: "r1",
      salonId: "s1",
      salonName: "Salon Nord",
      salonActive: true,
      groupKind: "ACCESS_ROLE",
      classification: null,
      accessRoleId: "role-1",
      accessRoleName: "Ausbilder",
      maxPersons: 3,
      validFrom: "2027-07-01",
      validUntil: "2027-08-31",
      name: "Sommer",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      canManage: true,
    };
    expect(ruleFormPayload(ruleFormFromDto(dto))).toEqual({
      salonId: "s1",
      groupKind: "ACCESS_ROLE",
      classification: null,
      accessRoleId: "role-1",
      maxPersons: 3,
      validFrom: "2027-07-01",
      validUntil: "2027-08-31",
      name: "Sommer",
    });
  });

  it("maps null window and name to empty form strings", () => {
    const restored = ruleFormFromDto({
      id: "r2",
      salonId: null,
      salonName: null,
      salonActive: null,
      groupKind: "ALL",
      classification: null,
      accessRoleId: null,
      accessRoleName: null,
      maxPersons: 0,
      validFrom: null,
      validUntil: null,
      name: null,
      createdAt: "",
      updatedAt: "",
      canManage: true,
    });
    expect(restored.validFrom).toBe("");
    expect(restored.name).toBe("");
    expect(restored.maxPersons).toBe("0");
    expect(restored.salonId).toBeNull();
  });
});
