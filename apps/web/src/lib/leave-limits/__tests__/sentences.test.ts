// Issue #836 (plan 07) — the German warning and exception texts. Pure functions: every number
// and every name comes from the API payload; nothing is counted or looked up here.
import { describe, it, expect } from "vitest";
import { warningSentences, exceedanceDescription } from "../sentences";
import type { LeaveLimitWarning } from "../types";

function warning(overrides: Partial<LeaveLimitWarning> = {}): LeaveLimitWarning {
  return {
    ruleId: "r1",
    ruleName: null,
    groupKind: "CLASSIFICATION",
    classification: "AZUBI",
    accessRoleId: null,
    accessRoleName: null,
    salonId: "s1",
    maxPersons: 2,
    validFrom: null,
    validUntil: null,
    days: [
      { day: "2027-03-03", count: 3, max: 2 },
      { day: "2027-03-04", count: 3, max: 2 },
      { day: "2027-03-05", count: 3, max: 2 },
    ],
    ...overrides,
  };
}

describe("warningSentences", () => {
  it("words a group limit with the number of days and the others already on leave", () => {
    expect(warningSentences([warning()])).toEqual([
      "An 3 Tagen sind schon 2 Azubis im Urlaub (höchstens 2).",
    ]);
  });

  it("uses the singular for a single day", () => {
    const w = warning({ days: [{ day: "2027-03-03", count: 3, max: 2 }] });
    expect(warningSentences([w])).toEqual([
      "An 1 Tag sind schon 2 Azubis im Urlaub (höchstens 2).",
    ]);
  });

  it("takes the largest number of others over the days", () => {
    const w = warning({
      days: [
        { day: "2027-03-03", count: 3, max: 2 },
        { day: "2027-03-04", count: 4, max: 2 },
      ],
    });
    expect(warningSentences([w])[0]).toBe(
      "An 2 Tagen sind schon 3 Azubis im Urlaub (höchstens 2).",
    );
  });

  it("words a blackout with its name and window", () => {
    const w = warning({
      groupKind: "ALL",
      classification: null,
      maxPersons: 0,
      ruleName: "Inventur",
      validFrom: "2027-03-01",
      validUntil: "2027-03-07",
      days: [
        { day: "2027-03-03", count: 1, max: 0 },
        { day: "2027-03-04", count: 1, max: 0 },
      ],
    });
    expect(warningSentences([w])).toEqual([
      "Inventur vom 01.03.2027 bis 07.03.2027: an 2 Tagen betroffen.",
    ]);
  });

  it("falls back to 'Urlaubssperre' for an unnamed blackout", () => {
    const w = warning({
      groupKind: "ALL",
      classification: null,
      maxPersons: 0,
      validFrom: "2027-03-01",
      validUntil: "2027-03-07",
      days: [{ day: "2027-03-03", count: 1, max: 0 }],
    });
    expect(warningSentences([w])[0]).toBe(
      "Urlaubssperre vom 01.03.2027 bis 07.03.2027: an 1 Tag betroffen.",
    );
  });

  it("names a person only when the API sent it", () => {
    const w = warning({
      days: [
        {
          day: "2027-03-03",
          count: 3,
          max: 2,
          persons: [{ employeeId: "e1", firstName: "Anna", lastName: "Berg" }],
          hiddenCount: 1,
        },
      ],
    });
    const sentence = warningSentences([w])[0];
    expect(sentence).toContain("darunter Anna B.");
    expect(sentence).not.toContain("Berg");
  });

  it("never turns hiddenCount into a name", () => {
    const w = warning({
      days: [{ day: "2027-03-03", count: 3, max: 2, persons: [], hiddenCount: 2 }],
    });
    expect(warningSentences([w])).toEqual([
      "An 1 Tag sind schon 2 Azubis im Urlaub (höchstens 2).",
    ]);
  });

  it("returns one sentence per warning and none without warnings", () => {
    expect(warningSentences([])).toEqual([]);
    expect(warningSentences([warning(), warning({ ruleId: "r2" })])).toHaveLength(2);
  });
});

describe("exceedanceDescription", () => {
  it("lists per rule the group, the maximum and the days with their counts", () => {
    const text = exceedanceDescription([warning()]);
    expect(text).toContain("Azubis");
    expect(text).toContain("höchstens 2");
    expect(text).toContain("03.03. (3)");
    expect(text).toContain("05.03. (3)");
  });

  it("describes a blackout by its name and window", () => {
    const text = exceedanceDescription([
      warning({
        groupKind: "ALL",
        classification: null,
        maxPersons: 0,
        ruleName: "Inventur",
        validFrom: "2027-03-01",
        validUntil: "2027-03-07",
        days: [{ day: "2027-03-03", count: 1, max: 0 }],
      }),
    ]);
    expect(text).toContain("Inventur");
    expect(text).toContain("01.03.2027");
    expect(text).toContain("03.03.");
  });

  it("separates rules by a line break", () => {
    expect(exceedanceDescription([warning(), warning({ ruleId: "r2" })]).split("\n")).toHaveLength(
      2,
    );
  });
});
