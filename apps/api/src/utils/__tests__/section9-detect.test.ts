import { describe, it, expect } from "vitest";
import {
  intersectRanges,
  isSickTypeName,
  findSection9Overlaps,
  SICK_TYPE_NAMES,
  type LeaveRangeRow,
} from "../section9-detect";

describe("section9-detect (pure, DB-free)", () => {
  describe("intersectRanges", () => {
    it("Test 7a: edge overlap — ranges touch at exactly one day", () => {
      const result = intersectRanges(
        new Date("2028-06-01"),
        new Date("2028-06-05"),
        new Date("2028-06-05"),
        new Date("2028-06-10"),
      );
      expect(result).toEqual({ start: new Date("2028-06-05"), end: new Date("2028-06-05") });
    });

    it("Test 7b: mid overlap — partial intersection", () => {
      const result = intersectRanges(
        new Date("2028-06-01"),
        new Date("2028-06-10"),
        new Date("2028-06-05"),
        new Date("2028-06-15"),
      );
      expect(result).toEqual({ start: new Date("2028-06-05"), end: new Date("2028-06-10") });
    });

    it("Test 7c: full containment — one range entirely inside the other", () => {
      const result = intersectRanges(
        new Date("2028-06-01"),
        new Date("2028-06-30"),
        new Date("2028-06-10"),
        new Date("2028-06-15"),
      );
      expect(result).toEqual({ start: new Date("2028-06-10"), end: new Date("2028-06-15") });
    });

    it("Test 7d: disjoint ranges return null", () => {
      const result = intersectRanges(
        new Date("2028-06-01"),
        new Date("2028-06-05"),
        new Date("2028-06-10"),
        new Date("2028-06-15"),
      );
      expect(result).toBeNull();
    });
  });

  describe("isSickTypeName", () => {
    it("matches both German sick type names", () => {
      expect(isSickTypeName("Krankmeldung")).toBe(true);
      expect(isSickTypeName("Kinderkrank")).toBe(true);
    });

    it("does not match a non-sick type name", () => {
      expect(isSickTypeName("Urlaub")).toBe(false);
      expect(isSickTypeName("Elternzeit")).toBe(false);
    });

    it("SICK_TYPE_NAMES contains exactly the two sick names", () => {
      expect([...SICK_TYPE_NAMES].sort()).toEqual(["Kinderkrank", "Krankmeldung"]);
    });
  });

  describe("findSection9Overlaps", () => {
    function row(partial: Partial<LeaveRangeRow>): LeaveRangeRow {
      return {
        id: "row-id",
        startDate: new Date("2028-01-01"),
        endDate: new Date("2028-01-01"),
        status: "APPROVED",
        leaveType: { name: "Urlaub" },
        ...partial,
      };
    }

    it("finds an overlap against an APPROVED non-SICK candidate", () => {
      const result = findSection9Overlaps(new Date("2028-06-07"), new Date("2028-06-08"), [
        row({
          id: "vac-1",
          startDate: new Date("2028-06-05"),
          endDate: new Date("2028-06-09"),
          status: "APPROVED",
          leaveType: { name: "Urlaub" },
        }),
      ]);
      expect(result).toEqual([
        {
          vacationRequestId: "vac-1",
          overlapStart: new Date("2028-06-07"),
          overlapEnd: new Date("2028-06-08"),
        },
      ]);
    });

    it("excludes a PENDING candidate (D-13: unapproved vacation is not yet § 9)", () => {
      const result = findSection9Overlaps(new Date("2028-06-07"), new Date("2028-06-08"), [
        row({
          status: "PENDING",
          startDate: new Date("2028-06-05"),
          endDate: new Date("2028-06-09"),
        }),
      ]);
      expect(result).toEqual([]);
    });

    it("excludes a SICK/SICK_CHILD candidate (homogeneous overlap stays blocked upstream)", () => {
      const result = findSection9Overlaps(new Date("2028-06-07"), new Date("2028-06-08"), [
        row({
          status: "APPROVED",
          leaveType: { name: "Krankmeldung" },
          startDate: new Date("2028-06-05"),
          endDate: new Date("2028-06-09"),
        }),
      ]);
      expect(result).toEqual([]);
    });

    it("excludes a disjoint candidate", () => {
      const result = findSection9Overlaps(new Date("2028-06-07"), new Date("2028-06-08"), [
        row({ startDate: new Date("2028-01-01"), endDate: new Date("2028-01-05") }),
      ]);
      expect(result).toEqual([]);
    });

    it("returns one overlap per candidate for multiple simultaneous overlaps, sorted", () => {
      const result = findSection9Overlaps(new Date("2028-06-01"), new Date("2028-06-30"), [
        row({
          id: "vac-b",
          startDate: new Date("2028-06-20"),
          endDate: new Date("2028-06-25"),
        }),
        row({
          id: "vac-a",
          startDate: new Date("2028-06-05"),
          endDate: new Date("2028-06-10"),
        }),
      ]);
      expect(result.map((r) => r.vacationRequestId)).toEqual(["vac-a", "vac-b"]);
    });
  });
});
