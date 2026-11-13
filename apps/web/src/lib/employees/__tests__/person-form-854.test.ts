// Issue #854 (plan 854-20) - the pure model of the Person tab: a section owns exactly its keys, the
// PATCH body of a section carries those keys and nothing else, and the checks refuse what the
// server would refuse.
import { describe, expect, it } from "vitest";
import {
  EMPLOYMENT_KEYS,
  IDENTITY_KEYS,
  STRUCTURE_KEYS,
  dayOf,
  employmentErrors,
  employmentPatch,
  identityErrors,
  identityPatch,
  personValuesOf,
  structureErrors,
  structurePatch,
  type PersonEmployee,
} from "$lib/employees/person-form";

const EMPLOYEE: PersonEmployee = {
  id: "e1",
  firstName: "Lena",
  lastName: "Muster",
  employeeNumber: "042",
  nfcCardId: null,
  exitDate: "2027-03-31T00:00:00.000Z",
  birthDate: "1999-05-17T00:00:00.000Z",
  classification: "MINIJOB",
  coverageWeight: "0.5",
  requiresSupervision: false,
  annualVacationDays: "26.5",
};

describe("personValuesOf", () => {
  it("reads a stored record into form values (days as ISO days, numbers as numbers)", () => {
    expect(personValuesOf(EMPLOYEE)).toEqual({
      firstName: "Lena",
      lastName: "Muster",
      employeeNumber: "042",
      birthDate: "1999-05-17",
      nfcCardId: "",
      classification: "MINIJOB",
      coverageWeight: 0.5,
      requiresSupervision: false,
      exitDate: "2027-03-31",
      annualVacationDays: 26.5,
    });
  });

  it("falls back to the classification defaults and keeps an empty vacation base null", () => {
    const values = personValuesOf({
      id: "e2",
      firstName: "A",
      lastName: "B",
      classification: "AZUBI",
    });
    expect(values.coverageWeight).toBe(0);
    expect(values.requiresSupervision).toBe(true);
    expect(values.annualVacationDays).toBeNull();
    expect(values.exitDate).toBeNull();
    expect(values.birthDate).toBeNull();
  });

  it("dayOf cuts the time part and maps blank to null", () => {
    expect(dayOf("2026-03-01T00:00:00.000Z")).toBe("2026-03-01");
    expect(dayOf("")).toBeNull();
    expect(dayOf(null)).toBeNull();
  });
});

describe("the sections own disjoint keys", () => {
  it("no key is in two sections, and together they cover every form value", () => {
    const all = [...IDENTITY_KEYS, ...STRUCTURE_KEYS, ...EMPLOYMENT_KEYS];
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual(Object.keys(personValuesOf(EMPLOYEE)).sort());
  });

  it("each patch carries exactly its section's keys", () => {
    const values = personValuesOf(EMPLOYEE);
    expect(Object.keys(identityPatch(values)).sort()).toEqual([...IDENTITY_KEYS].sort());
    expect(Object.keys(structurePatch(values)).sort()).toEqual([...STRUCTURE_KEYS].sort());
    expect(Object.keys(employmentPatch(values)).sort()).toEqual([...EMPLOYMENT_KEYS].sort());
  });
});

describe("patch bodies", () => {
  it("identity: trimmed texts, a blank NFC id is null, the birth day is a UTC-midnight timestamp", () => {
    const values = {
      ...personValuesOf(EMPLOYEE),
      firstName: " Lena ",
      nfcCardId: "  ",
      birthDate: "1999-05-17",
    };
    expect(identityPatch(values)).toEqual({
      firstName: "Lena",
      lastName: "Muster",
      employeeNumber: "042",
      birthDate: "1999-05-17T00:00:00.000Z",
      nfcCardId: null,
    });
    expect(identityPatch({ ...values, birthDate: null }).birthDate).toBeNull();
  });

  it("employment: the exit day is a timestamp, an empty vacation base is an explicit null (#482)", () => {
    const values = { ...personValuesOf(EMPLOYEE), annualVacationDays: null, exitDate: null };
    expect(employmentPatch(values)).toEqual({ exitDate: null, annualVacationDays: null });
    expect(employmentPatch(personValuesOf(EMPLOYEE))).toEqual({
      exitDate: "2027-03-31T00:00:00.000Z",
      annualVacationDays: 26.5,
    });
  });
});

describe("validation", () => {
  it("identity needs both names and the employee number", () => {
    const errors = identityErrors({
      ...personValuesOf(EMPLOYEE),
      firstName: " ",
      lastName: "",
      employeeNumber: "",
    });
    expect(Object.keys(errors).sort()).toEqual(["employeeNumber", "firstName", "lastName"]);
    expect(identityErrors(personValuesOf(EMPLOYEE))).toEqual({});
  });

  it("structure needs a weight between 0 and 9.99", () => {
    const values = personValuesOf(EMPLOYEE);
    expect(structureErrors(values)).toEqual({});
    expect(structureErrors({ ...values, coverageWeight: null }).coverageWeight).toBeDefined();
    expect(structureErrors({ ...values, coverageWeight: 10 }).coverageWeight).toBeDefined();
    expect(structureErrors({ ...values, coverageWeight: -1 }).coverageWeight).toBeDefined();
  });

  it("employment accepts an empty vacation base and bounds a typed one", () => {
    const values = personValuesOf(EMPLOYEE);
    expect(employmentErrors({ ...values, annualVacationDays: null })).toEqual({});
    expect(
      employmentErrors({ ...values, annualVacationDays: 0.4 }).annualVacationDays,
    ).toBeDefined();
    expect(
      employmentErrors({ ...values, annualVacationDays: 366 }).annualVacationDays,
    ).toBeDefined();
  });
});
