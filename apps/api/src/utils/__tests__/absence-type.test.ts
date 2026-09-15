import { describe, it, expect } from "vitest";
import {
  ABSENCE_TYPES,
  ABSENCE_TYPE_CORRESPONDENCE,
  LEAVE_TYPE_CODE_CORRESPONDENCE,
  leaveTypeCodeForAbsenceType,
  absenceTypeForLeaveTypeCode,
  ADR_REQUESTED_ONLY_ABSENCE_TYPES,
} from "../absence-type";

/**
 * Phase 98 (T3, Option D) — the AC5 evidence for plan 01. This is the controlling assertion
 * set for the one written correspondence between AbsenceType and LeaveTypeCode. Pure unit test
 * — no Prisma, no buildApp(), no database, does not require test:setup.
 */
describe("ABSENCE_TYPES", () => {
  it("contains exactly the eight values, in schema order", () => {
    expect(ABSENCE_TYPES).toEqual([
      "SICK",
      "SICK_CHILD",
      "SPECIAL_LEAVE",
      "UNPAID_LEAVE",
      "MATERNITY",
      "PARENTAL",
      "OTHER",
      "VOCATIONAL_SCHOOL",
    ]);
  });
});

describe("leaveTypeCodeForAbsenceType — the six correspondences, asserted individually", () => {
  it("SICK -> SICK", () => {
    expect(leaveTypeCodeForAbsenceType("SICK")).toBe("SICK");
  });

  it("SICK_CHILD -> SICK_CHILD", () => {
    expect(leaveTypeCodeForAbsenceType("SICK_CHILD")).toBe("SICK_CHILD");
  });

  it("SPECIAL_LEAVE -> SPECIAL (same thing, different spelling)", () => {
    expect(leaveTypeCodeForAbsenceType("SPECIAL_LEAVE")).toBe("SPECIAL");
  });

  it("UNPAID_LEAVE -> UNPAID (same thing, different spelling)", () => {
    expect(leaveTypeCodeForAbsenceType("UNPAID_LEAVE")).toBe("UNPAID");
  });

  it("MATERNITY -> MATERNITY", () => {
    expect(leaveTypeCodeForAbsenceType("MATERNITY")).toBe("MATERNITY");
  });

  it("PARENTAL -> PARENTAL", () => {
    expect(leaveTypeCodeForAbsenceType("PARENTAL")).toBe("PARENTAL");
  });
});

describe("the absence-only non-correspondences — first-class facts, not missing entries", () => {
  it("VOCATIONAL_SCHOOL resolves to null and is declared absence_only with a written reason", () => {
    expect(leaveTypeCodeForAbsenceType("VOCATIONAL_SCHOOL")).toBeNull();
    expect(ABSENCE_TYPE_CORRESPONDENCE.VOCATIONAL_SCHOOL.kind).toBe("absence_only");
    expect(
      ABSENCE_TYPE_CORRESPONDENCE.VOCATIONAL_SCHOOL.kind === "absence_only" &&
        ABSENCE_TYPE_CORRESPONDENCE.VOCATIONAL_SCHOOL.why.length,
    ).toBeGreaterThan(0);
  });

  it("OTHER resolves to null and is declared absence_only with a written reason", () => {
    expect(leaveTypeCodeForAbsenceType("OTHER")).toBeNull();
    expect(ABSENCE_TYPE_CORRESPONDENCE.OTHER.kind).toBe("absence_only");
    expect(
      ABSENCE_TYPE_CORRESPONDENCE.OTHER.kind === "absence_only" &&
        ABSENCE_TYPE_CORRESPONDENCE.OTHER.why.length,
    ).toBeGreaterThan(0);
  });
});

describe("the leave-only non-correspondences — first-class facts, not missing entries", () => {
  it("VACATION, OVERTIME_COMP and EDUCATION resolve to null and are declared leave_only with a written reason", () => {
    for (const code of ["VACATION", "OVERTIME_COMP", "EDUCATION"] as const) {
      expect(absenceTypeForLeaveTypeCode(code)).toBeNull();
      expect(LEAVE_TYPE_CODE_CORRESPONDENCE[code].kind).toBe("leave_only");
      const entry = LEAVE_TYPE_CODE_CORRESPONDENCE[code];
      expect(entry.kind === "leave_only" && entry.why.length).toBeGreaterThan(0);
    }
  });
});

describe("round-trip — every corresponds pair resolves back to itself in both directions", () => {
  it("every AbsenceType with a corresponds entry round-trips through LeaveTypeCode", () => {
    for (const t of ABSENCE_TYPES) {
      const entry = ABSENCE_TYPE_CORRESPONDENCE[t];
      if (entry.kind !== "corresponds") continue;
      expect(absenceTypeForLeaveTypeCode(leaveTypeCodeForAbsenceType(t)!)).toBe(t);
    }
  });

  it("every LeaveTypeCode with a corresponds entry round-trips through AbsenceType", () => {
    for (const code of Object.keys(LEAVE_TYPE_CODE_CORRESPONDENCE) as Array<
      keyof typeof LEAVE_TYPE_CODE_CORRESPONDENCE
    >) {
      const entry = LEAVE_TYPE_CODE_CORRESPONDENCE[code];
      if (entry.kind !== "corresponds") continue;
      expect(leaveTypeCodeForAbsenceType(absenceTypeForLeaveTypeCode(code)!)).toBe(code);
    }
  });
});

describe("ADR_REQUESTED_ONLY_ABSENCE_TYPES", () => {
  it("is exactly the four AbsenceType values ADR 0001 assigns to LeaveRequest", () => {
    expect(ADR_REQUESTED_ONLY_ABSENCE_TYPES).toEqual([
      "SICK",
      "SICK_CHILD",
      "SPECIAL_LEAVE",
      "UNPAID_LEAVE",
    ]);
  });
});

describe("OTHER's anti-removal pin — the readable half", () => {
  it("names the production situation in its why", () => {
    const entry = ABSENCE_TYPE_CORRESPONDENCE.OTHER;
    expect(entry.kind).toBe("absence_only");
    const why = entry.kind === "absence_only" ? entry.why : "";
    expect(why).toContain("pre-tracking");
    expect(why).toContain("15");
  });
});
