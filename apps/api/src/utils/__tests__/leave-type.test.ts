import { describe, it, expect } from "vitest";
import {
  LEAVE_TYPE_CODES,
  LEAVE_TYPE_DEFS,
  LEAVE_TYPE_LEGACY_ALIASES,
  leaveTypeFields,
  leaveTypeCodeForName,
  SICK_LEAVE_TYPE_CODES,
  isSickLeaveTypeCode,
} from "../leave-type";

/**
 * This is the AC-3 evidence for plan 02. The German strings users see are produced
 * by LEAVE_TYPE_DEFS alone (D-04), so a test that fails on one changed character is
 * what makes "there is exactly one mapping" a check rather than a promise. Pure
 * unit test — no Prisma, no buildApp(), no database, does not require test:setup.
 */
describe("LEAVE_TYPE_CODES", () => {
  it("has exactly the nine codes, in the stable dropdown order", () => {
    expect(LEAVE_TYPE_CODES).toEqual([
      "VACATION",
      "OVERTIME_COMP",
      "SPECIAL",
      "UNPAID",
      "SICK",
      "SICK_CHILD",
      "EDUCATION",
      "MATERNITY",
      "PARENTAL",
    ]);
  });

  it("covers every key of LEAVE_TYPE_DEFS and nothing else", () => {
    expect([...LEAVE_TYPE_CODES].sort()).toEqual(Object.keys(LEAVE_TYPE_DEFS).sort());
  });
});

describe("LEAVE_TYPE_DEFS", () => {
  it("pins the exact German display name for every one of the nine codes", () => {
    expect(LEAVE_TYPE_DEFS.VACATION.name).toBe("Urlaub");
    expect(LEAVE_TYPE_DEFS.OVERTIME_COMP.name).toBe("Überstundenausgleich");
    expect(LEAVE_TYPE_DEFS.SPECIAL.name).toBe("Sonderurlaub");
    expect(LEAVE_TYPE_DEFS.UNPAID.name).toBe("Unbezahlter Urlaub");
    expect(LEAVE_TYPE_DEFS.SICK.name).toBe("Krankmeldung");
    expect(LEAVE_TYPE_DEFS.SICK_CHILD.name).toBe("Kinderkrank");
    expect(LEAVE_TYPE_DEFS.EDUCATION.name).toBe("Bildungsurlaub");
    expect(LEAVE_TYPE_DEFS.MATERNITY.name).toBe("Mutterschutz");
    expect(LEAVE_TYPE_DEFS.PARENTAL.name).toBe("Elternzeit");
  });

  it("marks VACATION as paid and approval-requiring", () => {
    expect(LEAVE_TYPE_DEFS.VACATION.isPaid).toBe(true);
    expect(LEAVE_TYPE_DEFS.VACATION.requiresApproval).toBe(true);
  });

  it("marks exactly UNPAID and PARENTAL as unpaid; the other seven as paid", () => {
    for (const code of LEAVE_TYPE_CODES) {
      const expected = code === "UNPAID" || code === "PARENTAL" ? false : true;
      expect(LEAVE_TYPE_DEFS[code].isPaid).toBe(expected);
    }
  });

  it("marks exactly SICK, SICK_CHILD and MATERNITY as not requiring approval; the other six do", () => {
    for (const code of LEAVE_TYPE_CODES) {
      const expected =
        code === "SICK" || code === "SICK_CHILD" || code === "MATERNITY" ? false : true;
      expect(LEAVE_TYPE_DEFS[code].requiresApproval).toBe(expected);
    }
  });
});

describe("LEAVE_TYPE_LEGACY_ALIASES", () => {
  it("pins the two legacy vacation names exactly, backfill-only", () => {
    expect(LEAVE_TYPE_LEGACY_ALIASES.VACATION).toEqual(["Jahresurlaub", "Urlaub (Jahresurlaub)"]);
  });
});

describe("leaveTypeFields", () => {
  it("returns the code paired with its matching name and both policy flags", () => {
    expect(leaveTypeFields("SICK")).toEqual({
      code: "SICK",
      name: "Krankmeldung",
      isPaid: true,
      requiresApproval: false,
    });
  });

  it("returns VACATION's fields", () => {
    expect(leaveTypeFields("VACATION")).toEqual({
      code: "VACATION",
      name: "Urlaub",
      isPaid: true,
      requiresApproval: true,
    });
  });
});

describe("leaveTypeCodeForName", () => {
  it("resolves the canonical name to its code", () => {
    expect(leaveTypeCodeForName("Urlaub")).toBe("VACATION");
  });

  it("resolves both legacy alias names to VACATION", () => {
    expect(leaveTypeCodeForName("Jahresurlaub")).toBe("VACATION");
    expect(leaveTypeCodeForName("Urlaub (Jahresurlaub)")).toBe("VACATION");
  });

  it("returns null for an unmappable name instead of falling back to VACATION (D-09)", () => {
    expect(leaveTypeCodeForName("Erholungsurlaub")).toBeNull();
  });

  it("compares exactly — not case-insensitive and not a substring match", () => {
    expect(leaveTypeCodeForName("urlaub")).toBeNull();
  });
});

describe("SICK_LEAVE_TYPE_CODES", () => {
  it("has exactly the two sickness codes", () => {
    expect(SICK_LEAVE_TYPE_CODES).toEqual(["SICK", "SICK_CHILD"]);
  });
});

describe("isSickLeaveTypeCode", () => {
  it("is true for SICK and SICK_CHILD", () => {
    expect(isSickLeaveTypeCode("SICK")).toBe(true);
    expect(isSickLeaveTypeCode("SICK_CHILD")).toBe(true);
  });

  it("is false for VACATION, null and undefined", () => {
    expect(isSickLeaveTypeCode("VACATION")).toBe(false);
    expect(isSickLeaveTypeCode(null)).toBe(false);
    expect(isSickLeaveTypeCode(undefined)).toBe(false);
  });
});
