/**
 * Issue #542 (P-01) — the membership rule of a salon view and its one 404 body. DB-free: the
 * module is pure, so the cases build the inputs by hand.
 */
import { describe, it, expect } from "vitest";
import { salonViewMemberIds, salonHelperIds, SALON_VIEW_NOT_FOUND } from "../salon-view";

const A = "salon-a";
const B = "salon-b";
const DAYS = ["2026-06-01", "2026-06-02", "2026-06-03"];

function homes(entries: Array<[string, Array<[string, string | null]>]>) {
  return new Map(entries.map(([id, days]) => [id, new Map(days)] as const));
}

describe("Issue #542 — salonViewMemberIds", () => {
  it("lists a candidate with an entry in the salon", () => {
    const result = salonViewMemberIds({
      salonId: A,
      candidateIds: ["p1"],
      entries: [{ employeeId: "p1", salonId: A }],
      homeByPerson: new Map(),
      days: DAYS,
    });
    expect([...result]).toEqual(["p1"]);
  });

  it("lists a candidate homed in the salon on one of several days", () => {
    const result = salonViewMemberIds({
      salonId: A,
      candidateIds: ["p1"],
      entries: [],
      homeByPerson: homes([
        [
          "p1",
          [
            ["2026-06-01", B],
            ["2026-06-02", B],
            ["2026-06-03", A],
          ],
        ],
      ]),
      days: DAYS,
    });
    expect(result.has("p1")).toBe(true);
  });

  it("does not list a candidate with entries only elsewhere and no home day in the salon", () => {
    const result = salonViewMemberIds({
      salonId: A,
      candidateIds: ["p1"],
      entries: [{ employeeId: "p1", salonId: B }],
      homeByPerson: homes([["p1", [["2026-06-01", B]]]]),
      days: DAYS,
    });
    expect(result.size).toBe(0);
  });

  it("is bounded by the candidates: a non-candidate with an entry in the salon never appears", () => {
    const result = salonViewMemberIds({
      salonId: A,
      candidateIds: ["p1"],
      entries: [{ employeeId: "p2", salonId: A }],
      homeByPerson: homes([["p2", [["2026-06-01", A]]]]),
      days: DAYS,
    });
    expect(result.size).toBe(0);
  });

  it("decides a candidate without a home map by its entries alone", () => {
    const result = salonViewMemberIds({
      salonId: A,
      candidateIds: ["p1", "p2"],
      entries: [{ employeeId: "p1", salonId: A }],
      homeByPerson: new Map(),
      days: DAYS,
    });
    expect([...result]).toEqual(["p1"]);
  });

  it("decides by entries alone when the day list is empty", () => {
    const result = salonViewMemberIds({
      salonId: A,
      candidateIds: ["p1", "p2"],
      entries: [{ employeeId: "p2", salonId: A }],
      homeByPerson: homes([["p1", [["2026-06-01", A]]]]),
      days: [],
    });
    expect([...result]).toEqual(["p2"]);
  });

  it("ignores a home day outside the given days", () => {
    const result = salonViewMemberIds({
      salonId: A,
      candidateIds: ["p1"],
      entries: [],
      homeByPerson: homes([["p1", [["2026-07-01", A]]]]),
      days: DAYS,
    });
    expect(result.size).toBe(0);
  });
});

describe("Issue #542 — SALON_VIEW_NOT_FOUND", () => {
  it("is the one body of every composition salon view, frozen", () => {
    expect(SALON_VIEW_NOT_FOUND).toEqual({ error: "Salon nicht gefunden" });
    expect(Object.isFrozen(SALON_VIEW_NOT_FOUND)).toBe(true);
    expect(JSON.stringify(SALON_VIEW_NOT_FOUND)).toBe('{"error":"Salon nicht gefunden"}');
  });
});

describe("Issue #714 — salonHelperIds", () => {
  it("lists a candidate outside the home set that recorded time in the salon", () => {
    const result = salonHelperIds({
      salonId: A,
      candidateIds: ["p1", "p2"],
      entries: [{ employeeId: "p1", salonId: A }],
      homeMemberIds: new Set(["p2"]),
    });
    expect([...result]).toEqual(["p1"]);
  });

  it("never lists a candidate of the home set, even with an entry in the salon", () => {
    const result = salonHelperIds({
      salonId: A,
      candidateIds: ["p1"],
      entries: [{ employeeId: "p1", salonId: A }],
      homeMemberIds: new Set(["p1"]),
    });
    expect(result.size).toBe(0);
  });

  it("does not list a candidate whose entries are only in another salon", () => {
    const result = salonHelperIds({
      salonId: A,
      candidateIds: ["p1"],
      entries: [{ employeeId: "p1", salonId: B }],
      homeMemberIds: new Set(),
    });
    expect(result.size).toBe(0);
  });

  it("never lists a non-candidate with an entry in the salon", () => {
    const result = salonHelperIds({
      salonId: A,
      candidateIds: ["p1"],
      entries: [{ employeeId: "p9", salonId: A }],
      homeMemberIds: new Set(),
    });
    expect(result.size).toBe(0);
  });

  it("answers an empty set without entries", () => {
    const result = salonHelperIds({
      salonId: A,
      candidateIds: ["p1", "p2"],
      entries: [],
      homeMemberIds: new Set(),
    });
    expect(result.size).toBe(0);
  });
});
