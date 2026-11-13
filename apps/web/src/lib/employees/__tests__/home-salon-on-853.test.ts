// Issue #853 (D-853-08) - homeSalonIdOn() picks the Stammsalon valid on a calendar day. The
// expectations are written out by hand; the helper only compares calendar-day strings.
import { describe, expect, it } from "vitest";
import { homeSalonIdOn, type SalonAssignment } from "$lib/employees/salon-assignments";

function a(over: Partial<SalonAssignment> & Pick<SalonAssignment, "id">): SalonAssignment {
  return {
    employeeId: "e1",
    salonId: "s-nord",
    kind: "HOME",
    validFrom: "2026-03-01",
    validUntil: null,
    weekdays: [],
    ...over,
  };
}

describe("homeSalonIdOn", () => {
  it("is null for an empty list (anti-vacuity: the positive cases below return an id)", () => {
    expect(homeSalonIdOn([], "2026-09-01")).toBeNull();
    expect(homeSalonIdOn([a({ id: "h1" })], "2026-09-01")).toBe("s-nord");
  });

  it("is null before the first assignment starts", () => {
    expect(homeSalonIdOn([a({ id: "h1" })], "2026-02-28")).toBeNull();
  });

  it("includes both bounds of a closed assignment", () => {
    const rows = [a({ id: "h1", validFrom: "2026-03-01", validUntil: "2026-06-30" })];
    expect(homeSalonIdOn(rows, "2026-03-01")).toBe("s-nord");
    expect(homeSalonIdOn(rows, "2026-06-30")).toBe("s-nord");
    expect(homeSalonIdOn(rows, "2026-07-01")).toBeNull();
  });

  it("is still valid long after the start when the assignment is open-ended", () => {
    expect(homeSalonIdOn([a({ id: "h1" })], "2031-12-31")).toBe("s-nord");
  });

  it("ignores a DEPLOYMENT row even when it covers the day", () => {
    const rows = [a({ id: "d1", kind: "DEPLOYMENT", salonId: "s-ost" })];
    expect(homeSalonIdOn(rows, "2026-09-01")).toBeNull();
  });

  it("picks the assignment that is valid on the day when the Stammsalon changed", () => {
    const rows = [
      a({ id: "h1", salonId: "s-nord", validFrom: "2026-01-01", validUntil: "2026-05-31" }),
      a({ id: "h2", salonId: "s-ost", validFrom: "2026-06-01" }),
    ];
    expect(homeSalonIdOn(rows, "2026-05-31")).toBe("s-nord");
    expect(homeSalonIdOn(rows, "2026-06-01")).toBe("s-ost");
  });

  it("lets the latest validFrom win when two HOME rows overlap", () => {
    const rows = [
      a({ id: "h1", salonId: "s-nord", validFrom: "2026-01-01" }),
      a({ id: "h2", salonId: "s-ost", validFrom: "2026-04-01" }),
    ];
    expect(homeSalonIdOn(rows, "2026-09-01")).toBe("s-ost");
    expect(homeSalonIdOn([...rows].reverse(), "2026-09-01")).toBe("s-ost");
  });

  it("reads only the date part of a longer day string and does not mutate the input", () => {
    const rows = [a({ id: "h1" })];
    const copy = JSON.stringify(rows);
    expect(homeSalonIdOn(rows, "2026-09-01T00:00:00.000Z")).toBe("s-nord");
    expect(JSON.stringify(rows)).toBe(copy);
  });
});
