import { describe, it, expect } from "vitest";
import type { LeaveTypeCode } from "@clokr/db";
import { REQUESTABLE_CODES, IMPOSED_ONLY_CODES } from "../utils/leave-type";
import { classifyLeaveTypeCode } from "../contexts/schichtplanung/shift-availability";

/**
 * Phase 98b (Option A) — pins the availability bucket for all eleven `LeaveTypeCode` values
 * (plus `null`), the vocabulary that `Absence.type` and `LeaveType.code` now share as a single
 * enum. Before this phase there were eight `AbsenceType` values and nine `LeaveTypeCode` values,
 * each pinned in their own `describe` block; no coverage was dropped by collapsing them — the six
 * former `AbsenceType` spellings are covered by their `LeaveTypeCode` counterparts (with
 * `SPECIAL_LEAVE`/`UNPAID_LEAVE` now spelled `SPECIAL`/`UNPAID`, which is exactly what the
 * migration's `CASE` did to the data), and `classifyAbsenceType` itself is deleted along with
 * `AbsenceType` — there is nothing left to delegate to or from.
 */

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
  it("VOCATIONAL_SCHOOL -> vocational_school (Phase 98b — the trap this plan defuses)", () => {
    expect(classifyLeaveTypeCode("VOCATIONAL_SCHOOL")).toBe("vocational_school");
  });
  it("OTHER -> other (via the default branch, deliberately — NOT removable, 15 production bridge rows)", () => {
    expect(classifyLeaveTypeCode("OTHER")).toBe("other");
  });
});

describe("an out-of-enum value degrades, it does not 500 the caller", () => {
  it("classifyLeaveTypeCode falls to 'other' for a value the compiled table has never seen — the pre-Phase-98 `default:` behaviour, kept on purpose", () => {
    // Stands in for the three runtime paths that bypass the compile-time exhaustiveness: a
    // $queryRaw row, a payload cast to LeaveTypeCode, and a rolling deploy where a migration added
    // an enum member before the new image rolled out. Both call sites of this function sit inside
    // the roster week build (routes/shifts.ts), so a throw here is a 500 on the whole shift
    // planner, not one wrong cell.
    const unknown = "CODE_ADDED_BY_A_LATER_MIGRATION" as LeaveTypeCode;
    expect(() => classifyLeaveTypeCode(unknown)).not.toThrow();
    expect(classifyLeaveTypeCode(unknown)).toBe("other");
  });
});

describe("exhaustiveness — a new enum value cannot be added without extending this test", () => {
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
    VOCATIONAL_SCHOOL: "vocational_school",
    OTHER: "other",
  };

  it("every member of the eleven-code vocabulary has an entry in this test's own expectation table", () => {
    for (const code of [...REQUESTABLE_CODES, ...IMPOSED_ONLY_CODES]) {
      expect(EXPECTED_LEAVE_BUCKET).toHaveProperty(code);
      expect(classifyLeaveTypeCode(code)).toBe(EXPECTED_LEAVE_BUCKET[code]);
    }
  });
});
