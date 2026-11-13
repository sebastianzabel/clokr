/**
 * Issue #836 (D-836-09/10/19) — the exception building blocks: reason schema, the 409 body, the audit
 * snapshot and the delta ranges a correction has to check. Pure, no database.
 */
import { describe, expect, it } from "vitest";
import type { LeaveLimitExceedance } from "../leave-limits";
import {
  LEAVE_LIMIT_EXCEPTION_REQUIRED,
  buildLeaveLimitExceptionAudit,
  correctionCandidateRanges,
  leaveLimitExceptionRequiredBody,
  limitExceptionSchema,
} from "../leave-limits";

const MSG = "Die Begründung der Ausnahme muss 10 bis 500 Zeichen lang sein.";

function exceedance(
  ruleId: string,
  salonId: string,
  days: Array<{ day: string; count: number; max: number }>,
): LeaveLimitExceedance {
  return {
    rule: {
      id: ruleId,
      name: `Regel ${ruleId}`,
      groupKind: "ALL",
      classification: null,
      accessRoleId: null,
      accessRoleName: null,
      maxPersons: 1,
      validFrom: null,
      validUntil: null,
      salonId: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
    salonId,
    groupKey: "ALL",
    candidateEmployeeId: "cand-emp-id",
    days: days.map((d) => ({ ...d, personIds: ["other-person-id-1", "other-person-id-2"] })),
  };
}

describe("limitExceptionSchema", () => {
  it("accepts 10 and 500 characters after trimming", () => {
    expect(limitExceptionSchema.parse({ reason: "a".repeat(10) }).reason).toHaveLength(10);
    expect(limitExceptionSchema.parse({ reason: "b".repeat(500) }).reason).toHaveLength(500);
    expect(limitExceptionSchema.parse({ reason: `  ${"c".repeat(10)}  ` }).reason).toBe(
      "c".repeat(10),
    );
  });

  it("refuses 9 characters, a padded 9 and 501 characters with the German message", () => {
    for (const reason of ["a".repeat(9), `   ${"d".repeat(9)}   `, "e".repeat(501)]) {
      const result = limitExceptionSchema.safeParse({ reason });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.message).toBe(MSG);
    }
  });
});

describe("leaveLimitExceptionRequiredBody", () => {
  it("has exactly error, code and exceedances and serialises no person id", () => {
    const body = leaveLimitExceptionRequiredBody([
      exceedance("r1", "s1", [{ day: "2026-12-01", count: 2, max: 1 }]),
    ]);
    expect(Object.keys(body).sort()).toEqual(["code", "error", "exceedances"]);
    expect(body.code).toBe("LEAVE_LIMIT_EXCEPTION_REQUIRED");
    expect(body.code).toBe(LEAVE_LIMIT_EXCEPTION_REQUIRED);
    expect(body.exceedances[0]?.days).toEqual([{ day: "2026-12-01", count: 2, max: 1 }]);
    const text = JSON.stringify(body);
    expect(text).not.toContain("other-person-id");
    expect(text).not.toContain("personIds");
    expect(text).not.toContain("cand-emp-id");
  });
});

describe("buildLeaveLimitExceptionAudit", () => {
  const audit = buildLeaveLimitExceptionAudit("Hochzeit der Tochter", [
    exceedance("r1", "s2", [{ day: "2026-12-02", count: 2, max: 1 }]),
    exceedance("r1", "s1", [
      { day: "2026-12-03", count: 3, max: 1 },
      { day: "2026-12-01", count: 2, max: 1 },
    ]),
  ]);

  it("lists a rule once and every day with its salon, sorted", () => {
    expect(audit.reason).toBe("Hochzeit der Tochter");
    expect(audit.rules).toHaveLength(1);
    expect(audit.rules[0]).toMatchObject({ ruleId: "r1", name: "Regel r1", maxPersons: 1 });
    expect(audit.days).toEqual([
      { day: "2026-12-01", salonId: "s1", ruleId: "r1", count: 2 },
      { day: "2026-12-02", salonId: "s2", ruleId: "r1", count: 2 },
      { day: "2026-12-03", salonId: "s1", ruleId: "r1", count: 3 },
    ]);
  });

  it("carries no person id of the input", () => {
    const text = JSON.stringify(audit);
    expect(text).not.toContain("other-person-id");
    expect(text).not.toContain("cand-emp-id");
    expect(text).not.toContain("personIds");
  });
});

describe("correctionCandidateRanges", () => {
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  const base = {
    oldStart: d("2026-12-07"),
    oldEnd: d("2026-12-09"),
    oldTypeCode: "VACATION",
    newTypeCode: "VACATION",
  };

  it("extending Mon-Wed to Mon-Fri checks Thu-Fri only", () => {
    expect(
      correctionCandidateRanges({ ...base, newStart: d("2026-12-07"), newEnd: d("2026-12-11") }),
    ).toEqual([{ startDay: "2026-12-10", endDay: "2026-12-11" }]);
  });

  it("a shortening yields no range", () => {
    expect(
      correctionCandidateRanges({ ...base, newStart: d("2026-12-07"), newEnd: d("2026-12-08") }),
    ).toEqual([]);
  });

  it("moving Mon-Wed to Wed-Fri checks Thu-Fri", () => {
    expect(
      correctionCandidateRanges({ ...base, newStart: d("2026-12-09"), newEnd: d("2026-12-11") }),
    ).toEqual([{ startDay: "2026-12-10", endDay: "2026-12-11" }]);
  });

  it("an uncounted type becoming counted checks the whole new range", () => {
    expect(
      correctionCandidateRanges({
        ...base,
        oldTypeCode: "SICK",
        newStart: d("2026-12-07"),
        newEnd: d("2026-12-09"),
      }),
    ).toEqual([{ startDay: "2026-12-07", endDay: "2026-12-09" }]);
  });

  it("a counted type becoming uncounted checks nothing", () => {
    expect(
      correctionCandidateRanges({
        ...base,
        newTypeCode: "SICK",
        newStart: d("2026-12-07"),
        newEnd: d("2026-12-11"),
      }),
    ).toEqual([]);
  });

  it("VACATION to OVERTIME_COMP over the same dates checks nothing", () => {
    expect(
      correctionCandidateRanges({
        ...base,
        newTypeCode: "OVERTIME_COMP",
        newStart: d("2026-12-07"),
        newEnd: d("2026-12-09"),
      }),
    ).toEqual([]);
  });

  it("extending on both sides yields two ranges", () => {
    expect(
      correctionCandidateRanges({ ...base, newStart: d("2026-12-04"), newEnd: d("2026-12-11") }),
    ).toEqual([
      { startDay: "2026-12-04", endDay: "2026-12-06" },
      { startDay: "2026-12-10", endDay: "2026-12-11" },
    ]);
  });
});
