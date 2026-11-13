/**
 * Issue #840 review WR-02 (E-03) — the personal planner (`?view=own`) is neutral for everybody
 * but the caller. The API already answers a colleague's wish with the period only; this is the
 * display-side twin that makes sure the personal area can never offer a drag, an edit, a request
 * status, a refusal text, a forecast or limit-rule data for a colleague, even if an answer carried
 * them (an older server, a cached answer). It narrows, never widens: own persons and own wishes
 * pass through untouched, and nothing here is an access decision — the API decides every write.
 */
import type { PlannerPerson, PlannerReadDto, PlannerWish } from "./types";

function neutralWish(wish: PlannerWish): PlannerWish {
  return {
    ...wish,
    editable: false,
    conflict: false,
    leaveRequestId: null,
    leaveRequestStatus: null,
    refusalCode: null,
    refusalMessage: null,
  };
}

function neutralPerson(person: PlannerPerson): PlannerPerson {
  return { ...person, wishes: person.wishes.map(neutralWish), forecast: null };
}

export function neutralOwnPlanner(dto: PlannerReadDto): PlannerReadDto {
  const own = dto.viewer.employeeId;
  return {
    ...dto,
    persons: dto.persons.map((person) =>
      own !== null && person.employeeId === own ? person : neutralPerson(person),
    ),
    dayLoad: dto.dayLoad.map((day) => ({ ...day, limits: null })),
  };
}
