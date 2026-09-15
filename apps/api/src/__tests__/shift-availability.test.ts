import { describe, it, expect } from "vitest";
import type { AbsenceType, LeaveTypeCode } from "@clokr/db";
import { ABSENCE_TYPES, leaveTypeCodeForAbsenceType } from "../utils/absence-type";
import { LEAVE_TYPE_CODES } from "../utils/leave-type";
import { classifyAbsenceType, classifyLeaveTypeCode } from "../utils/shift-availability";

/**
 * Phase 98 (T3, plan 03) — pins the availability bucket for all eight `AbsenceType` and all nine
 * `LeaveTypeCode` values (plus `null`) exactly as measured on `main` in `<measured_baseline>`,
 * before `classifyAbsenceType` was rewritten to delegate through `absence-type.ts` instead of
 * restating the correspondence in its own `switch`. This is the behaviour-preservation proof the
 * plan requires — every one of the seventeen enum values, asserted individually.
 */

describe("classifyAbsenceType — one expectation per AbsenceType value, pinned to <measured_baseline>", () => {
  it("SICK -> sick", () => {
    expect(classifyAbsenceType("SICK")).toBe("sick");
  });
  it("SICK_CHILD -> sick", () => {
    expect(classifyAbsenceType("SICK_CHILD")).toBe("sick");
  });
  it("SPECIAL_LEAVE -> special", () => {
    expect(classifyAbsenceType("SPECIAL_LEAVE")).toBe("special");
  });
  it("UNPAID_LEAVE -> other", () => {
    expect(classifyAbsenceType("UNPAID_LEAVE")).toBe("other");
  });
  it("MATERNITY -> other", () => {
    expect(classifyAbsenceType("MATERNITY")).toBe("other");
  });
  it("PARENTAL -> other", () => {
    expect(classifyAbsenceType("PARENTAL")).toBe("other");
  });
  it("OTHER -> other (NOT removable — 15 production bridge rows, plan 01's <the_trap>)", () => {
    expect(classifyAbsenceType("OTHER")).toBe("other");
  });
  it("VOCATIONAL_SCHOOL -> vocational_school (Phase 63 D-20 — no leave-side counterpart at all)", () => {
    expect(classifyAbsenceType("VOCATIONAL_SCHOOL")).toBe("vocational_school");
  });
});

describe("classifyLeaveTypeCode — one expectation per LeaveTypeCode value, pinned to <measured_baseline>", () => {
  it("VACATION -> vacation", () => {
    expect(classifyLeaveTypeCode("VACATION")).toBe("vacation");
  });
  it("OVERTIME_COMP -> other", () => {
    expect(classifyLeaveTypeCode("OVERTIME_COMP")).toBe("other");
  });
  it("SPECIAL -> special", () => {
    expect(classifyLeaveTypeCode("SPECIAL")).toBe("special");
  });
  it("UNPAID -> other", () => {
    expect(classifyLeaveTypeCode("UNPAID")).toBe("other");
  });
  it("SICK -> sick", () => {
    expect(classifyLeaveTypeCode("SICK")).toBe("sick");
  });
  it("SICK_CHILD -> sick", () => {
    expect(classifyLeaveTypeCode("SICK_CHILD")).toBe("sick");
  });
  it("EDUCATION -> other", () => {
    expect(classifyLeaveTypeCode("EDUCATION")).toBe("other");
  });
  it("MATERNITY -> other", () => {
    expect(classifyLeaveTypeCode("MATERNITY")).toBe("other");
  });
  it("PARENTAL -> other", () => {
    expect(classifyLeaveTypeCode("PARENTAL")).toBe("other");
  });
  it("null -> other", () => {
    expect(classifyLeaveTypeCode(null)).toBe("other");
  });
});

describe("the delegation is real, not coincidental", () => {
  it("for every AbsenceType whose correspondence is 'corresponds', classifyAbsenceType(t) equals classifyLeaveTypeCode(leaveTypeCodeForAbsenceType(t)!) — this is the assertion a drift between the two functions would break", () => {
    // Deliberately NOT looping over ABSENCE_TYPE_CORRESPONDENCE (the table under test elsewhere) —
    // the six values known to correspond, named individually, so this test does not silently pass
    // an entry with zero coverage if a future edit adds an eighth "corresponds" value here without
    // updating this list. Cross-checked against ABSENCE_TYPES below for exhaustiveness.
    const correspondingTypes: AbsenceType[] = [
      "SICK",
      "SICK_CHILD",
      "SPECIAL_LEAVE",
      "UNPAID_LEAVE",
      "MATERNITY",
      "PARENTAL",
    ];
    for (const t of correspondingTypes) {
      const code = leaveTypeCodeForAbsenceType(t);
      expect(code).not.toBeNull();
      expect(classifyAbsenceType(t)).toBe(classifyLeaveTypeCode(code!));
    }
  });
});

describe("the two values with no counterpart keep their own answers", () => {
  it("VOCATIONAL_SCHOOL has no leave-side bucket at all (Phase 63 D-20)", () => {
    expect(classifyAbsenceType("VOCATIONAL_SCHOOL")).toBe("vocational_school");
  });
  it("OTHER falls to 'other' explicitly, not by accident", () => {
    expect(classifyAbsenceType("OTHER")).toBe("other");
  });
});

describe("an out-of-enum value degrades, it does not 500 the caller", () => {
  it("classifyAbsenceType falls to 'other' for a value the compiled correspondence has never seen — the pre-Phase-98 `default:` behaviour, kept on purpose", () => {
    // Stands in for the three runtime paths that bypass the compile-time exhaustiveness: a
    // $queryRaw row, a payload cast to AbsenceType, and a rolling deploy where a migration added
    // an enum member before the new image rolled out. Both call sites of this function sit inside
    // the roster week build (routes/shifts.ts), so a throw here is a 500 on the whole shift
    // planner, not one wrong cell.
    const unknown = "MEMBER_ADDED_BY_A_LATER_MIGRATION" as AbsenceType;
    expect(() => classifyAbsenceType(unknown)).not.toThrow();
    expect(classifyAbsenceType(unknown)).toBe("other");
  });

  it("classifyLeaveTypeCode does the same for an unknown code (it always has — its switch ends in default)", () => {
    const unknown = "CODE_ADDED_BY_A_LATER_MIGRATION" as LeaveTypeCode;
    expect(classifyLeaveTypeCode(unknown)).toBe("other");
  });
});

describe("exhaustiveness — a new enum value cannot be added without extending this test", () => {
  const EXPECTED_ABSENCE_BUCKET: Record<AbsenceType, string> = {
    SICK: "sick",
    SICK_CHILD: "sick",
    SPECIAL_LEAVE: "special",
    UNPAID_LEAVE: "other",
    MATERNITY: "other",
    PARENTAL: "other",
    OTHER: "other",
    VOCATIONAL_SCHOOL: "vocational_school",
  };

  it("every member of ABSENCE_TYPES has an entry in this test's own expectation table", () => {
    for (const t of ABSENCE_TYPES) {
      expect(EXPECTED_ABSENCE_BUCKET).toHaveProperty(t);
      expect(classifyAbsenceType(t)).toBe(EXPECTED_ABSENCE_BUCKET[t]);
    }
  });

  const EXPECTED_LEAVE_BUCKET: Record<LeaveTypeCode, string> = {
    VACATION: "vacation",
    OVERTIME_COMP: "other",
    SPECIAL: "special",
    UNPAID: "other",
    SICK: "sick",
    SICK_CHILD: "sick",
    EDUCATION: "other",
    MATERNITY: "other",
    PARENTAL: "other",
  };

  it("every member of LEAVE_TYPE_CODES has an entry in this test's own expectation table", () => {
    for (const code of LEAVE_TYPE_CODES) {
      expect(EXPECTED_LEAVE_BUCKET).toHaveProperty(code);
      expect(classifyLeaveTypeCode(code)).toBe(EXPECTED_LEAVE_BUCKET[code]);
    }
  });
});
