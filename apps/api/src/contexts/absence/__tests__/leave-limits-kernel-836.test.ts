/**
 * Issue #836 (AC-4, AC-8, AC-9) — the pure kernel of the leave limits: the allow-list pinned against
 * the Prisma enum, rule windows, the strictest rule, group membership, the workday definition and the
 * counted days of one leave row. No database.
 *
 * Mutation proof (Phase 836, 2026-11-06) — recorded here, not re-run by CI; each change was reverted
 * with cp afterwards:
 * M1 constants.ts: "EDUCATION" removed from LEAVE_LIMIT_COUNTED_CODES -> red: the AC-8 case for
 *    EDUCATION.
 * M2 rules.ts: `day > rule.validUntil` -> `day >= rule.validUntil` -> red: the AC-9 window case.
 * M3 workdays.ts: the `rosterDays.has(day)` branch removed -> red: the SHIFT_BASED Saturday case.
 *
 * Weekday anchors (checked with getUTCDay): 2027-12-06 Mon, 12-07 Tue, 12-08 Wed, 12-09 Thu,
 * 12-10 Fri, 12-11 Sat, 12-12 Sun; 2027-12-01 Wed, 2027-12-31 Fri, 2028-01-01 Sat.
 */
import { describe, it, expect } from "vitest";
import { LeaveTypeCode } from "@clokr/db";
import { isLeaveLimitCountedCode, LEAVE_LIMIT_COUNTED_CODES } from "../leave-limits/constants";
import { countedDaysOfLeave, eachDay, type PersonDayFacts } from "../leave-limits/counted-days";
import { groupMembershipOn } from "../leave-limits/group-membership";
import { parallelLeaveLoad } from "../leave-limits/parallel-leave-load";
import { ruleAppliesOn, strictestRulesOn, type LeaveLimitRuleRow } from "../leave-limits/rules";
import { workdaysOf } from "../leave-limits/workdays";
import type { LoadedContractSegment } from "../leave-days";

function rule(over: Partial<LeaveLimitRuleRow> & { id: string }): LeaveLimitRuleRow {
  return {
    salonId: null,
    groupKind: "ALL",
    classification: null,
    accessRoleId: null,
    maxPersons: 1,
    validFrom: null,
    validUntil: null,
    name: null,
    createdAt: new Date("2027-01-01T00:00:00Z"),
    ...over,
  };
}

function segment(over: Partial<LoadedContractSegment> = {}): LoadedContractSegment {
  return {
    from: new Date("2024-01-01T00:00:00Z"),
    workDaysPerWeek: 5,
    workScheduleId: "ws",
    validFrom: new Date("2024-01-01T00:00:00Z"),
    type: "FIXED_SCHEDULE",
    usualWorkDays: [],
    resolvedWorkDays: [1, 2, 3, 4, 5],
    ...over,
  };
}

describe("AC-8: the counted codes are an allow-list pinned against the Prisma enum", () => {
  // The test's own decision for EVERY enum value. A new LeaveTypeCode is undecided here, so this
  // suite fails until someone decides (and adds it to the constant on purpose, if it counts).
  const DECIDED: Record<string, boolean> = {
    VACATION: true,
    OVERTIME_COMP: true,
    SPECIAL: true,
    UNPAID: true,
    EDUCATION: true,
    SICK: false,
    SICK_CHILD: false,
    MATERNITY: false,
    PARENTAL: false,
    VOCATIONAL_SCHOOL: false,
    OTHER: false,
  };

  it("decides every value of the enum, and nothing else", () => {
    expect(Object.keys(DECIDED).sort()).toEqual(Object.values(LeaveTypeCode).sort());
  });

  for (const code of Object.values(LeaveTypeCode)) {
    it(`${code} counts: ${DECIDED[code]}`, () => {
      expect(DECIDED[code], `undecided enum value ${code}`).toBeDefined();
      expect(isLeaveLimitCountedCode(code)).toBe(DECIDED[code]);
    });
  }

  it("SICK and SICK_CHILD never count, by name", () => {
    expect(isLeaveLimitCountedCode("SICK")).toBe(false);
    expect(isLeaveLimitCountedCode("SICK_CHILD")).toBe(false);
  });

  it("the constant equals the literal list of the issue", () => {
    expect([...LEAVE_LIMIT_COUNTED_CODES].sort()).toEqual(
      ["VACATION", "OVERTIME_COMP", "SPECIAL", "UNPAID", "EDUCATION"].sort(),
    );
  });
});

describe("AC-9: rule windows and the strictest rule", () => {
  const windowed = rule({ id: "w", validFrom: "2027-12-01", validUntil: "2027-12-31" });

  it("a windowed rule applies on both inclusive bounds, not outside", () => {
    expect(ruleAppliesOn(windowed, "S", "2027-12-01")).toBe(true);
    expect(ruleAppliesOn(windowed, "S", "2027-12-31")).toBe(true);
    expect(ruleAppliesOn(windowed, "S", "2027-11-30")).toBe(false);
    expect(ruleAppliesOn(windowed, "S", "2028-01-01")).toBe(false);
  });

  it("an unwindowed rule applies every day", () => {
    expect(ruleAppliesOn(rule({ id: "u" }), "S", "2031-02-03")).toBe(true);
  });

  it("a salon rule applies to its salon only, a null-salon rule to every salon", () => {
    expect(ruleAppliesOn(rule({ id: "a", salonId: "S" }), "T", "2027-12-08")).toBe(false);
    expect(ruleAppliesOn(rule({ id: "b", salonId: null }), "T", "2027-12-08")).toBe(true);
  });

  it("the lowest maximum wins, a tie goes to the smaller id", () => {
    const rules = [
      rule({ id: "r1", maxPersons: 3 }),
      rule({ id: "r3", maxPersons: 1, salonId: "S" }),
      rule({ id: "r2", maxPersons: 1, salonId: "S" }),
    ];
    const winners = strictestRulesOn(rules, "S", "2027-12-08");
    expect(winners.get("ALL")?.id).toBe("r2");
  });

  it("each group chooses its own strictest rule", () => {
    const rules = [
      rule({ id: "all", maxPersons: 3 }),
      rule({ id: "az", maxPersons: 2, groupKind: "CLASSIFICATION", classification: "AZUBI" }),
      rule({ id: "az2", maxPersons: 4, groupKind: "CLASSIFICATION", classification: "AZUBI" }),
    ];
    const winners = strictestRulesOn(rules, "S", "2027-12-08");
    expect(winners.get("ALL")?.id).toBe("all");
    expect(winners.get("CLASSIFICATION:AZUBI")?.id).toBe("az");
  });

  it("a rule outside its window does not take part in the choice", () => {
    const rules = [
      rule({ id: "wide", maxPersons: 5 }),
      rule({ id: "tight", maxPersons: 1, validFrom: "2027-12-20" }),
    ];
    expect(strictestRulesOn(rules, "S", "2027-12-08").get("ALL")?.id).toBe("wide");
    expect(strictestRulesOn(rules, "S", "2027-12-20").get("ALL")?.id).toBe("tight");
  });
});

describe("parallelLeaveLoad and groupMembershipOn", () => {
  it("two rows of the same person, salon and day count once; a person in two groups is in both", () => {
    const row = (requestId: string, groups: string[]) => ({
      personId: "p",
      requestId,
      day: "2027-12-08",
      salonId: "S",
      groups,
    });
    const load = parallelLeaveLoad([
      row("r1", ["ALL", "CLASSIFICATION:AZUBI"]),
      row("r2", ["ALL", "CLASSIFICATION:AZUBI"]),
    ]);
    expect(load.get("S")?.get("ALL")?.get("2027-12-08")?.size).toBe(1);
    expect(load.get("S")?.get("CLASSIFICATION:AZUBI")?.get("2027-12-08")?.size).toBe(1);
  });

  it("membership: ALL, the classification, one key per role - independent of the day", () => {
    const person = { classification: "AZUBI" as const, accessRoleIds: new Set(["r1", "r2"]) };
    const keys = groupMembershipOn(person, "2027-12-08");
    expect(keys).toEqual(["ALL", "CLASSIFICATION:AZUBI", "ACCESS_ROLE:r1", "ACCESS_ROLE:r2"]);
    expect(groupMembershipOn(person, "2031-01-01")).toEqual(keys);
    expect(
      groupMembershipOn({ classification: "VOLLZEIT", accessRoleIds: new Set() }, "x"),
    ).toEqual(["ALL", "CLASSIFICATION:VOLLZEIT"]);
  });
});

describe("workdaysOf: the one workday definition", () => {
  const week = eachDay("2027-12-06", "2027-12-12"); // Mon .. Sun
  const none = new Set<string>();

  it("a FIXED Mo-Fr person works Mo-Fr, never Saturday or Sunday", () => {
    const set = workdaysOf({ days: week, segments: [segment()], holidays: none, rosterDays: none });
    expect([...set]).toEqual(week.slice(0, 5));
  });

  it("a holiday on a Wednesday removes it", () => {
    const set = workdaysOf({
      days: week,
      segments: [segment()],
      holidays: new Set(["2027-12-08"]),
      rosterDays: none,
    });
    expect(set.has("2027-12-08")).toBe(false);
    expect(set.has("2027-12-07")).toBe(true);
  });

  it("a roster shift does not make a non-SHIFT_BASED person work on a Saturday", () => {
    const set = workdaysOf({
      days: week,
      segments: [segment()],
      holidays: none,
      rosterDays: new Set(["2027-12-11"]),
    });
    expect(set.has("2027-12-11")).toBe(false);
  });

  const shift = (over: Partial<LoadedContractSegment> = {}) =>
    segment({ type: "SHIFT_BASED", usualWorkDays: [2, 3, 4], ...over });

  it("SHIFT_BASED: usual days plus a roster Saturday count, Monday does not", () => {
    const set = workdaysOf({
      days: week,
      segments: [shift()],
      holidays: none,
      rosterDays: new Set(["2027-12-11"]),
    });
    expect([...set].sort()).toEqual(["2027-12-07", "2027-12-08", "2027-12-09", "2027-12-11"]);
    expect(set.has("2027-12-06")).toBe(false);
  });

  it("SHIFT_BASED: a holiday removes a usual day without a shift, a shift keeps it", () => {
    const holidays = new Set(["2027-12-08"]);
    const without = workdaysOf({ days: week, segments: [shift()], holidays, rosterDays: none });
    expect(without.has("2027-12-08")).toBe(false);
    const withShift = workdaysOf({
      days: week,
      segments: [shift()],
      holidays,
      rosterDays: new Set(["2027-12-08"]),
    });
    expect(withShift.has("2027-12-08")).toBe(true);
  });

  it("SHIFT_BASED with an empty Angabe falls back to the resolved workday set", () => {
    const set = workdaysOf({
      days: week,
      segments: [shift({ usualWorkDays: [], resolvedWorkDays: [1, 5] })],
      holidays: none,
      rosterDays: none,
    });
    expect([...set].sort()).toEqual(["2027-12-06", "2027-12-10"]);
  });

  it("a contract change on the 1st of a month switches the set from that day", () => {
    const segments = [
      segment({ from: new Date("2024-01-01T00:00:00Z"), resolvedWorkDays: [1, 2, 3, 4, 5] }),
      segment({ from: new Date("2026-04-01T00:00:00Z"), resolvedWorkDays: [2, 6] }),
    ];
    const set = workdaysOf({
      days: ["2026-03-31", "2026-04-01"], // Tue, Wed
      segments,
      holidays: none,
      rosterDays: none,
    });
    expect(set.has("2026-03-31")).toBe(true); // Tue, old contract Mo-Fr
    expect(set.has("2026-04-01")).toBe(false); // Wed, new contract Tue+Sat only
  });
});

describe("countedDaysOfLeave", () => {
  const days = eachDay("2027-12-06", "2027-12-10"); // Mon .. Fri
  const person = (over: Partial<PersonDayFacts> = {}): PersonDayFacts => ({
    personId: "p",
    homeSalonByDay: new Map(days.map((d) => [d, "S"] as const)),
    employedDays: new Set(days),
    anonymized: false,
    workdays: new Set(days),
    vocationalSchoolDays: new Set(),
    ...over,
  });
  const window = { fromDay: "2027-12-06", toDay: "2027-12-10" };
  const vacation = { typeCode: "VACATION", startDay: "2027-12-06", endDay: "2027-12-10" };

  it("counts every workday with a Stammsalon, clipped to the window", () => {
    const counted = countedDaysOfLeave(person(), vacation, {
      fromDay: "2027-12-08",
      toDay: "2027-12-09",
    });
    expect(counted.map((c) => c.day)).toEqual(["2027-12-08", "2027-12-09"]);
    expect(counted.every((c) => c.salonId === "S")).toBe(true);
  });

  it("a VACATION day on a Berufsschultag does not count, an OVERTIME_COMP day does", () => {
    const p = person({ vocationalSchoolDays: new Set(["2027-12-07"]) });
    expect(countedDaysOfLeave(p, vacation, window).map((c) => c.day)).not.toContain("2027-12-07");
    const comp = countedDaysOfLeave(p, { ...vacation, typeCode: "OVERTIME_COMP" }, window);
    expect(comp.map((c) => c.day)).toContain("2027-12-07");
  });

  it("a day without a Stammsalon does not count", () => {
    const home = new Map(days.map((d) => [d, d === "2027-12-08" ? null : "S"] as const));
    const counted = countedDaysOfLeave(person({ homeSalonByDay: home }), vacation, window);
    expect(counted.map((c) => c.day)).not.toContain("2027-12-08");
    expect(counted).toHaveLength(4);
  });

  it("a day outside the employment does not count", () => {
    const employed = new Set(days.slice(1));
    const counted = countedDaysOfLeave(person({ employedDays: employed }), vacation, window);
    expect(counted.map((c) => c.day)).not.toContain("2027-12-06");
  });

  it("an anonymised person never counts", () => {
    expect(countedDaysOfLeave(person({ anonymized: true }), vacation, window)).toEqual([]);
  });

  it("a half day (a single date) is one person-day", () => {
    const half = { typeCode: "VACATION", startDay: "2027-12-08", endDay: "2027-12-08" };
    expect(countedDaysOfLeave(person(), half, window)).toEqual([
      { day: "2027-12-08", salonId: "S" },
    ]);
  });

  it("the Stammsalon of each single day decides, a change applies from its own day", () => {
    const home = new Map(days.map((d) => [d, d < "2027-12-08" ? "S1" : "S2"] as const));
    const counted = countedDaysOfLeave(person({ homeSalonByDay: home }), vacation, window);
    expect(counted.filter((c) => c.salonId === "S1").map((c) => c.day)).toEqual([
      "2027-12-06",
      "2027-12-07",
    ]);
    expect(counted.filter((c) => c.salonId === "S2")).toHaveLength(3);
  });
});
