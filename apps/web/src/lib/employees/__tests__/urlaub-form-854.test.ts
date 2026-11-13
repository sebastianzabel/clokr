// Issue #854 (plan 854-20) - the pure model of the Urlaub tab: the values of a stored entitlement,
// the checks, and the PUT body with the change-only carry-over reason (#445 D-16, T-451-26).
import { describe, expect, it } from "vitest";
import {
  VACATION_KEYS,
  reasonHint,
  vacationBody,
  vacationErrors,
  vacationValuesOf,
  type VacationEntitlement,
} from "$lib/employees/urlaub-form";

const ENTITLEMENT: VacationEntitlement = {
  year: 2026,
  totalDays: 28,
  usedDays: 6,
  carriedOverDays: 3,
  carryOverDeadline: "2027-03-31T00:00:00.000Z",
  carryOverReason: "ILLNESS",
  carryOverNote: "Langzeitkrank",
  regularDays: 30,
  statutoryMinimumDays: 20,
};

describe("vacationValuesOf", () => {
  it("reads a stored entitlement (the deadline as an ISO day)", () => {
    expect(vacationValuesOf(ENTITLEMENT)).toEqual({
      totalDays: 28,
      carriedOverDays: 3,
      carryOverDeadline: "2027-03-31",
      carryOverReason: "ILLNESS",
      carryOverNote: "Langzeitkrank",
    });
  });

  it("an absent entitlement gives the empty form", () => {
    expect(vacationValuesOf(null)).toEqual({
      totalDays: null,
      carriedOverDays: 0,
      carryOverDeadline: null,
      carryOverReason: null,
      carryOverNote: "",
    });
    expect(Object.keys(vacationValuesOf(null)).sort()).toEqual([...VACATION_KEYS].sort());
  });
});

describe("vacationErrors", () => {
  it("accepts the stored values and an empty total", () => {
    expect(vacationErrors(vacationValuesOf(ENTITLEMENT))).toEqual({});
    expect(vacationErrors({ ...vacationValuesOf(ENTITLEMENT), totalDays: null })).toEqual({});
  });

  it("bounds the total and requires the carried days", () => {
    const base = vacationValuesOf(ENTITLEMENT);
    expect(vacationErrors({ ...base, totalDays: 366 }).totalDays).toBeDefined();
    expect(vacationErrors({ ...base, totalDays: -1 }).totalDays).toBeDefined();
    expect(vacationErrors({ ...base, carriedOverDays: null }).carriedOverDays).toBeDefined();
  });

  it("mirrors the server's note and deadline requirements as an error, the illness default as a hint", () => {
    const base = vacationValuesOf(ENTITLEMENT);
    expect(
      vacationErrors({ ...base, carryOverReason: "OTHER", carryOverNote: " " }).note,
    ).toContain("Notiz");
    expect(
      vacationErrors({ ...base, carryOverReason: "MATERNITY", carryOverDeadline: null }).note,
    ).toContain("Verfallsdatum");
    const illnessNoDeadline = { ...base, carryOverDeadline: null };
    expect(vacationErrors(illnessNoDeadline).note).toBeUndefined();
    expect(reasonHint(illnessNoDeadline)).toContain("31.03.");
  });
});

describe("vacationBody", () => {
  const loaded = { reason: "ILLNESS", note: "Langzeitkrank" };

  it("carries year, total, carried days and the deadline; an unchanged reason and note are omitted", () => {
    expect(vacationBody(2026, 30, vacationValuesOf(ENTITLEMENT), loaded)).toEqual({
      year: 2026,
      totalDays: 28,
      carriedOverDays: 3,
      carryOverDeadline: "2027-03-31",
    });
  });

  it("an empty total takes the server's suggestion, an empty deadline is null", () => {
    const body = vacationBody(
      2026,
      30,
      { ...vacationValuesOf(ENTITLEMENT), totalDays: null, carryOverDeadline: null },
      loaded,
    );
    expect(body.totalDays).toBe(30);
    expect(body.carryOverDeadline).toBeNull();
  });

  it("sends a changed reason and a cleared note explicitly, and only those", () => {
    const body = vacationBody(
      2026,
      30,
      { ...vacationValuesOf(ENTITLEMENT), carryOverReason: null, carryOverNote: "" },
      loaded,
    );
    expect(body.carryOverReason).toBeNull();
    expect(body.carryOverNote).toBeNull();
    const unrelated = vacationBody(
      2026,
      30,
      { ...vacationValuesOf(ENTITLEMENT), totalDays: 27 },
      loaded,
    );
    expect("carryOverReason" in unrelated).toBe(false);
    expect("carryOverNote" in unrelated).toBe(false);
  });
});
