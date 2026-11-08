// Issue #840 review WR-02 (E-03) — the personal planner narrows a colleague's data on the display
// side too; the caller's own person and wishes pass through untouched.
import { describe, expect, it } from "vitest";
import { neutralOwnPlanner } from "../neutral";
import type { PlannerPerson, PlannerReadDto, PlannerWish } from "../types";

const wish = (id: string): PlannerWish => ({
  id,
  planId: "p",
  startDate: "2027-02-08",
  endDate: "2027-02-10",
  halfDay: false,
  foreignPlan: false,
  conflict: true,
  leaveRequestId: "r1",
  leaveRequestStatus: "REJECTED",
  refusalCode: "X",
  refusalMessage: "Text",
  editable: true,
  createdAt: "2027-01-01T00:00:00.000Z",
});
const forecast = {
  entitlementBasis: "STORED" as const,
  remainingDays: 1,
  pendingDays: 0,
  wishDays: 1,
  forecastDays: 0,
  forecastNegative: false,
};
const person = (id: string): PlannerPerson => ({
  employeeId: id,
  firstName: id,
  lastName: "X",
  homeRanges: [],
  rows: [],
  wishes: [wish(`w-${id}`)],
  forecast,
});

const dto = {
  plan: {},
  salon: { id: "s", name: "S", openingHours: null },
  viewer: { employeeId: "me", canManage: true, canWishOwn: true, ownEditLocked: false },
  persons: [person("me"), person("other")],
  holidays: [],
  dayLoad: [{ day: "2027-02-08", count: 2, limits: [] }],
} as unknown as PlannerReadDto;

describe("neutralOwnPlanner", () => {
  const result = neutralOwnPlanner(dto);

  it("keeps the caller's person and wishes untouched", () => {
    expect(result.persons[0]).toEqual(dto.persons[0]);
  });

  it("reduces a colleague's wish to the period and drops the forecast", () => {
    const other = result.persons[1];
    expect(other.forecast).toBeNull();
    expect(other.wishes[0]).toMatchObject({
      startDate: "2027-02-08",
      endDate: "2027-02-10",
      editable: false,
      conflict: false,
      leaveRequestId: null,
      leaveRequestStatus: null,
      refusalCode: null,
      refusalMessage: null,
    });
  });

  it("drops the rule data of the day load but keeps the count", () => {
    expect(result.dayLoad).toEqual([{ day: "2027-02-08", count: 2, limits: null }]);
  });

  it("without an own employee every person is a colleague", () => {
    const anonymous = neutralOwnPlanner({ ...dto, viewer: { ...dto.viewer, employeeId: null } });
    expect(anonymous.persons.every((p) => p.forecast === null)).toBe(true);
  });
});
