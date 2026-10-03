import { describe, it, expect } from "vitest";
import { planSection9CreditsForCorrection } from "../section9-detect";

/**
 * Issue #468, finding 2 (G18), D-04/A-3 — pure, DB-free classification of § 9 credits against
 * a `/correct` call's new range. See section9-detect.ts's own docblock for the rules.
 */
describe("planSection9CreditsForCorrection (pure, DB-free) — Issue #468 D-04/A-3", () => {
  it("CONFIRMED credited range fully outside the new range → supersede, ledgerUndo true, no clip", () => {
    const plan = planSection9CreditsForCorrection({
      credits: [
        {
          id: "c1",
          status: "CONFIRMED",
          creditedStart: new Date("2027-03-10"),
          creditedEnd: new Date("2027-03-12"),
          overlapStart: new Date("2027-03-10"),
          overlapEnd: new Date("2027-03-12"),
        },
      ],
      newStart: new Date("2027-03-01"),
      newEnd: new Date("2027-03-09"),
      typeChanged: false,
    });
    expect(plan.keep).toEqual([]);
    expect(plan.supersede).toEqual([{ id: "c1", ledgerUndo: true }]);
    expect(plan.clip).toEqual([]);
  });

  it("CONFIRMED credited range fully inside the new range → keep, untouched", () => {
    const plan = planSection9CreditsForCorrection({
      credits: [
        {
          id: "c2",
          status: "CONFIRMED",
          creditedStart: new Date("2027-03-03"),
          creditedEnd: new Date("2027-03-05"),
          overlapStart: new Date("2027-03-03"),
          overlapEnd: new Date("2027-03-05"),
        },
      ],
      newStart: new Date("2027-03-01"),
      newEnd: new Date("2027-03-09"),
      typeChanged: false,
    });
    expect(plan.keep).toEqual(["c2"]);
    expect(plan.supersede).toEqual([]);
    expect(plan.clip).toEqual([]);
  });

  it("CONFIRMED credited range partially overlapping the new range → supersede + clip to the overlap", () => {
    const plan = planSection9CreditsForCorrection({
      credits: [
        {
          id: "c3",
          status: "CONFIRMED",
          creditedStart: new Date("2027-03-08"),
          creditedEnd: new Date("2027-03-10"),
          overlapStart: new Date("2027-03-08"),
          overlapEnd: new Date("2027-03-10"),
        },
      ],
      newStart: new Date("2027-03-01"),
      newEnd: new Date("2027-03-09"),
      typeChanged: false,
    });
    expect(plan.keep).toEqual([]);
    expect(plan.supersede).toEqual([{ id: "c3", ledgerUndo: true }]);
    expect(plan.clip).toEqual([
      { id: "c3", start: new Date("2027-03-08"), end: new Date("2027-03-09") },
    ]);
  });

  it("typeChanged supersedes every non-SUPERSEDED credit — ledgerUndo only for the CONFIRMED one, never a clip", () => {
    const plan = planSection9CreditsForCorrection({
      credits: [
        {
          id: "confirmed",
          status: "CONFIRMED",
          creditedStart: new Date("2027-03-03"),
          creditedEnd: new Date("2027-03-05"),
          overlapStart: new Date("2027-03-03"),
          overlapEnd: new Date("2027-03-05"),
        },
        {
          id: "pending",
          status: "AU_PENDING",
          creditedStart: null,
          creditedEnd: null,
          overlapStart: new Date("2027-03-03"),
          overlapEnd: new Date("2027-03-05"),
        },
        {
          id: "already-superseded",
          status: "SUPERSEDED",
          creditedStart: new Date("2027-03-03"),
          creditedEnd: new Date("2027-03-05"),
          overlapStart: new Date("2027-03-03"),
          overlapEnd: new Date("2027-03-05"),
        },
      ],
      newStart: new Date("2027-03-01"),
      newEnd: new Date("2027-03-09"),
      typeChanged: true,
    });
    expect(plan.keep).toEqual([]);
    expect(plan.supersede).toEqual(
      expect.arrayContaining([
        { id: "confirmed", ledgerUndo: true },
        { id: "pending", ledgerUndo: false },
      ]),
    );
    expect(plan.supersede).toHaveLength(2); // the already-SUPERSEDED row is ignored entirely
    expect(plan.clip).toEqual([]);
  });

  it("AU_PENDING overlap fully outside the new range → supersede, ledgerUndo false (nothing was ever booked)", () => {
    const plan = planSection9CreditsForCorrection({
      credits: [
        {
          id: "p1",
          status: "AU_PENDING",
          creditedStart: null,
          creditedEnd: null,
          overlapStart: new Date("2027-03-10"),
          overlapEnd: new Date("2027-03-12"),
        },
      ],
      newStart: new Date("2027-03-01"),
      newEnd: new Date("2027-03-09"),
      typeChanged: false,
    });
    expect(plan.keep).toEqual([]);
    expect(plan.supersede).toEqual([{ id: "p1", ledgerUndo: false }]);
    expect(plan.clip).toEqual([]);
  });

  it("AU_PENDING overlap partially inside the new range → keep (no clip — confirm clips later to the current range)", () => {
    const plan = planSection9CreditsForCorrection({
      credits: [
        {
          id: "p2",
          status: "AU_PENDING",
          creditedStart: null,
          creditedEnd: null,
          overlapStart: new Date("2027-03-10"),
          overlapEnd: new Date("2027-03-12"),
        },
      ],
      newStart: new Date("2027-03-01"),
      newEnd: new Date("2027-03-11"),
      typeChanged: false,
    });
    expect(plan.keep).toEqual(["p2"]);
    expect(plan.supersede).toEqual([]);
    expect(plan.clip).toEqual([]);
  });

  it("a SUPERSEDED input row is ignored entirely, even alone", () => {
    const plan = planSection9CreditsForCorrection({
      credits: [
        {
          id: "s1",
          status: "SUPERSEDED",
          creditedStart: new Date("2027-03-03"),
          creditedEnd: new Date("2027-03-05"),
          overlapStart: new Date("2027-03-03"),
          overlapEnd: new Date("2027-03-05"),
        },
      ],
      newStart: new Date("2027-03-01"),
      newEnd: new Date("2027-03-09"),
      typeChanged: false,
    });
    expect(plan.keep).toEqual([]);
    expect(plan.supersede).toEqual([]);
    expect(plan.clip).toEqual([]);
  });
});
