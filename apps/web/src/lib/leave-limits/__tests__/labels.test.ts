// Issue #836 (D-06, AC-11) — the group labels and the fixed legal hint of /admin/leave-limits.
import { describe, it, expect } from "vitest";
import { CLASSIFICATION_LABELS, CLASSIFICATION_OPTIONS } from "$lib/employee-classification";
import {
  LEAVE_LIMIT_LEGAL_HINT,
  groupLabel,
  groupPluralLabel,
  isBlackout,
  limitText,
  windowLabel,
} from "../labels";

const all = { groupKind: "ALL", classification: null, accessRoleName: null } as const;

describe("groupLabel", () => {
  it("ALL is 'Alle'", () => {
    expect(groupLabel(all)).toBe("Alle");
  });

  it("CLASSIFICATION reads the shared classification label", () => {
    expect(
      groupLabel({ groupKind: "CLASSIFICATION", classification: "AZUBI", accessRoleName: null }),
    ).toBe(CLASSIFICATION_LABELS.AZUBI);
  });

  it("ACCESS_ROLE shows the role name, with a fallback for an unnamed role", () => {
    expect(
      groupLabel({ groupKind: "ACCESS_ROLE", classification: null, accessRoleName: "Ausbilder" }),
    ).toBe("Ausbilder");
    expect(
      groupLabel({ groupKind: "ACCESS_ROLE", classification: null, accessRoleName: null }),
    ).toBe("Rolle");
  });
});

describe("groupPluralLabel", () => {
  it("ALL is 'Personen' and AZUBI is 'Azubis'", () => {
    expect(groupPluralLabel(all)).toBe("Personen");
    expect(
      groupPluralLabel({
        groupKind: "CLASSIFICATION",
        classification: "AZUBI",
        accessRoleName: null,
      }),
    ).toBe("Azubis");
  });

  it("every classification of the shared option list has its own plural", () => {
    expect(CLASSIFICATION_OPTIONS.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const classification of CLASSIFICATION_OPTIONS) {
      const plural = groupPluralLabel({
        groupKind: "CLASSIFICATION",
        classification,
        accessRoleName: null,
      });
      expect(plural.length).toBeGreaterThan(0);
      expect(plural).not.toBe("Personen");
      seen.add(plural);
    }
    expect(seen.size).toBe(CLASSIFICATION_OPTIONS.length);
  });

  it("ACCESS_ROLE names the role", () => {
    expect(
      groupPluralLabel({
        groupKind: "ACCESS_ROLE",
        classification: null,
        accessRoleName: "Ausbilder",
      }),
    ).toBe("Personen mit der Rolle „Ausbilder“");
  });
});

describe("LEAVE_LIMIT_LEGAL_HINT (D-06)", () => {
  it("names the statutory basis and says Clokr does not check it", () => {
    expect(LEAVE_LIMIT_LEGAL_HINT).toContain("§ 7 Abs. 1 und 2 BUrlG");
    expect(LEAVE_LIMIT_LEGAL_HINT).toContain("12 aufeinanderfolgende Werktage");
    expect(LEAVE_LIMIT_LEGAL_HINT).toContain("§ 87 Abs. 1 Nr. 5 BetrVG");
    expect(LEAVE_LIMIT_LEGAL_HINT).toContain("Clokr prüft das nicht automatisch");
  });
});

describe("windowLabel", () => {
  it("is 'ganzjährig' without a window and prints German dates otherwise", () => {
    expect(windowLabel({ validFrom: null, validUntil: null })).toBe("ganzjährig");
    expect(windowLabel({ validFrom: "2027-12-01", validUntil: "2027-12-24" })).toBe(
      "01.12.2027 – 24.12.2027",
    );
    expect(windowLabel({ validFrom: "2027-12-01", validUntil: null })).toBe("ab 01.12.2027");
    expect(windowLabel({ validFrom: null, validUntil: "2027-12-24" })).toBe("bis 24.12.2027");
  });
});

describe("limitText and isBlackout", () => {
  it("words a limit and a block", () => {
    expect(limitText({ maxPersons: 2 })).toBe("höchstens 2 gleichzeitig im Urlaub");
    expect(limitText({ maxPersons: 0 })).toBe("Urlaub gesperrt");
  });

  it("a blackout is group ALL with a maximum of 0", () => {
    expect(isBlackout({ groupKind: "ALL", maxPersons: 0 })).toBe(true);
    expect(isBlackout({ groupKind: "CLASSIFICATION", maxPersons: 0 })).toBe(false);
    expect(isBlackout({ groupKind: "ALL", maxPersons: 1 })).toBe(false);
  });
});
