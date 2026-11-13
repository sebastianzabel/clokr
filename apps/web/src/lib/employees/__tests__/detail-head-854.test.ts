// Issue #854 (owner review of the Personen detail) - the head's sub line „<Personalnummer> ·
// <Stammsalon> · seit <Eintritt>“ from the stored record and the stored salon assignments.
import { describe, expect, it } from "vitest";
import { detailHeadSub, homeSalonIdOn, salonNameOf } from "$lib/employees/detail-head";

const HOME_OLD = {
  kind: "HOME" as const,
  salonId: "s-old",
  validFrom: "2025-01-01",
  validUntil: "2026-09-30",
};
const HOME_NEW = {
  kind: "HOME" as const,
  salonId: "s-new",
  validFrom: "2026-10-01",
  validUntil: null,
};
const DEPLOYMENT = {
  kind: "DEPLOYMENT" as const,
  salonId: "s-dep",
  validFrom: "2026-01-01",
  validUntil: null,
};

describe("homeSalonIdOn", () => {
  it("is the HOME row covering the day; a deployment never counts", () => {
    const rows = [DEPLOYMENT, HOME_OLD, HOME_NEW];
    expect(homeSalonIdOn(rows, "2026-11-12")).toBe("s-new");
    expect(homeSalonIdOn(rows, "2026-09-30")).toBe("s-old");
    expect(homeSalonIdOn([DEPLOYMENT], "2026-11-12")).toBeNull();
  });

  it("is null before the first and after the last HOME row", () => {
    expect(homeSalonIdOn([HOME_OLD], "2024-12-31")).toBeNull();
    expect(homeSalonIdOn([HOME_OLD], "2026-10-01")).toBeNull();
  });
});

describe("salonNameOf", () => {
  it("names a known salon and is null for an unknown or missing id", () => {
    const salons = [{ id: "s-new", name: "Clokr Demo Nord", isActive: true }];
    expect(salonNameOf(salons, "s-new")).toBe("Clokr Demo Nord");
    expect(salonNameOf(salons, "s-x")).toBeNull();
    expect(salonNameOf(salons, null)).toBeNull();
  });
});

describe("detailHeadSub", () => {
  it("reads like the prototype: number · Stammsalon · seit hire day", () => {
    expect(
      detailHeadSub({
        employeeNumber: "P-004",
        homeSalonName: "Clokr Demo Nord",
        hireDate: "2026-10-19T00:00:00.000Z",
        today: "2026-11-12",
      }),
    ).toBe("P-004 · Clokr Demo Nord · seit 19.10.2026");
  });

  it("leaves out what is unknown instead of guessing", () => {
    expect(detailHeadSub({ employeeNumber: "P-004", today: "2026-11-12" })).toBe("P-004");
    expect(detailHeadSub({ hireDate: "kaputt", today: "2026-11-12" })).toBe("");
  });

  it("names a planned and a past exit", () => {
    const base = { employeeNumber: "P-004", today: "2026-11-12" };
    expect(detailHeadSub({ ...base, exitDate: "2026-12-31" })).toBe(
      "P-004 · Austritt am 31.12.2026",
    );
    expect(detailHeadSub({ ...base, exitDate: "2026-10-31" })).toBe(
      "P-004 · Ausgeschieden am 31.10.2026",
    );
  });
});
