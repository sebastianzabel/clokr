// Issue #836 (plan 07) — mapping of the daily load view to calendar badges.
import { describe, it, expect } from "vitest";
import {
  APPROVED_BEFORE_RULE_HINT,
  exceededDaysFromLoad,
  limitBadgeTitle,
  loadRangeForMonth,
} from "../calendar-load";
import type { LeaveLimitLoadResponse } from "../types";

type LoadDay = LeaveLimitLoadResponse["salons"][number]["groups"][number]["days"][number];

function day(overrides: Partial<LoadDay> = {}): LoadDay {
  return {
    day: "2027-03-03",
    count: 3,
    max: 2,
    ruleId: "r1",
    ruleName: null,
    exceeded: true,
    persons: [],
    hiddenCount: 0,
    approvedBeforeRuleCount: 0,
    ...overrides,
  };
}

type LoadGroup = LeaveLimitLoadResponse["salons"][number]["groups"][number];

const EMPTY_GROUP: LoadGroup = {
  groupKey: "CLASSIFICATION:AZUBI",
  groupKind: "CLASSIFICATION",
  classification: "AZUBI",
  accessRoleId: null,
  accessRoleName: null,
  days: [],
};

function group(days: LoadDay[], overrides: Partial<LoadGroup> = {}): LoadGroup {
  return { ...EMPTY_GROUP, days, ...overrides };
}

function view(salons: LeaveLimitLoadResponse["salons"]): LeaveLimitLoadResponse {
  return { from: "2027-03-01", to: "2027-03-31", salons };
}

describe("loadRangeForMonth", () => {
  it("returns the first and last day, leap years included", () => {
    expect(loadRangeForMonth(2027, 2)).toEqual({ from: "2027-02-01", to: "2027-02-28" });
    expect(loadRangeForMonth(2028, 2)).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(loadRangeForMonth(2027, 12)).toEqual({ from: "2027-12-01", to: "2027-12-31" });
  });
});

describe("exceededDaysFromLoad", () => {
  it("lists only exceeded days", () => {
    const map = exceededDaysFromLoad(
      view([
        {
          salonId: "s1",
          salonName: "Salon A",
          groups: [group([day(), day({ day: "2027-03-04", count: 2, exceeded: false })])],
        },
      ]),
    );
    expect([...map.keys()]).toEqual(["2027-03-03"]);
    expect(map.get("2027-03-03")?.lines).toEqual(["Azubis: 3 von höchstens 2"]);
  });

  it("gives two lines for two groups on one day", () => {
    const map = exceededDaysFromLoad(
      view([
        {
          salonId: "s1",
          salonName: "Salon A",
          groups: [
            group([day()]),
            group([day({ count: 5, max: 4 })], {
              groupKey: "ALL",
              groupKind: "ALL",
              classification: null,
            }),
          ],
        },
      ]),
    );
    expect(map.get("2027-03-03")?.lines).toEqual([
      "Azubis: 3 von höchstens 2",
      "Personen: 5 von höchstens 4",
    ]);
  });

  it("prefixes the salon name when the view has more than one salon", () => {
    const map = exceededDaysFromLoad(
      view([
        { salonId: "s1", salonName: "Salon A", groups: [group([day()])] },
        { salonId: "s2", salonName: "Salon B", groups: [group([day({ count: 4 })])] },
      ]),
    );
    expect(map.get("2027-03-03")?.lines).toEqual([
      "Salon A · Azubis: 3 von höchstens 2",
      "Salon B · Azubis: 4 von höchstens 2",
    ]);
  });

  it("flags approvedBeforeRule iff an exceeded group has approvedBeforeRuleCount > 0", () => {
    const flagged = exceededDaysFromLoad(
      view([
        {
          salonId: "s1",
          salonName: "Salon A",
          groups: [group([day({ approvedBeforeRuleCount: 1 })])],
        },
      ]),
    );
    expect(flagged.get("2027-03-03")?.approvedBeforeRule).toBe(true);

    const plain = exceededDaysFromLoad(
      view([{ salonId: "s1", salonName: "Salon A", groups: [group([day()])] }]),
    );
    expect(plain.get("2027-03-03")?.approvedBeforeRule).toBe(false);

    // A non-exceeded group with a pre-rule approval does not flag the day.
    const otherGroup = exceededDaysFromLoad(
      view([
        {
          salonId: "s1",
          salonName: "Salon A",
          groups: [
            group([day()]),
            group([day({ exceeded: false, approvedBeforeRuleCount: 2 })], { groupKey: "X" }),
          ],
        },
      ]),
    );
    expect(otherGroup.get("2027-03-03")?.approvedBeforeRule).toBe(false);
  });

  it("words a blackout by its name", () => {
    const map = exceededDaysFromLoad(
      view([
        {
          salonId: "s1",
          salonName: "Salon A",
          groups: [
            group([day({ count: 1, max: 0, ruleName: "Inventur" })], {
              groupKey: "ALL",
              groupKind: "ALL",
              classification: null,
            }),
          ],
        },
      ]),
    );
    expect(map.get("2027-03-03")?.lines).toEqual(["Inventur: 1 im Urlaub"]);
  });
});

describe("limitBadgeTitle", () => {
  it("joins the lines and appends the neutral hint only when flagged", () => {
    expect(limitBadgeTitle({ lines: ["a", "b"], approvedBeforeRule: false })).toBe("a\nb");
    expect(limitBadgeTitle({ lines: ["a"], approvedBeforeRule: true })).toBe(
      `a\n${APPROVED_BEFORE_RULE_HINT}`,
    );
    expect(APPROVED_BEFORE_RULE_HINT).toBe("Vor Anlage der Regel genehmigt");
  });
});
