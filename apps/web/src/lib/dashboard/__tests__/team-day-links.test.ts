// Issue #587 (D-587-4) — the link builders of the team week and the attendance list.
import { describe, it, expect } from "vitest";

import { teamDayHref, teamLeaveCreateHref, teamCellAriaLabel } from "../team-day-links";

const ID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";

describe("teamDayHref", () => {
  it("builds the person-day link of Team-Zeiten in the documented parameter order", () => {
    expect(teamDayHref(ID, "2026-06-17")).toBe(
      `/team/time-entries?employeeId=${ID}&date=2026-06-17`,
    );
  });

  it("lowercases the id like the receiver does", () => {
    expect(teamDayHref(ID.toUpperCase(), "2026-06-17")).toBe(
      `/team/time-entries?employeeId=${ID}&date=2026-06-17`,
    );
  });

  it.each([
    ["not a uuid", "abc", "2026-06-17"],
    ["empty id", "", "2026-06-17"],
    ["id with a path segment", `${ID}/../x`, "2026-06-17"],
    ["unreal day", ID, "2026-02-30"],
    ["no day", ID, ""],
    ["garbage day", ID, "tomorrow"],
  ])("returns null for %s (the cell stays unlinked)", (_label, id, day) => {
    expect(teamDayHref(id, day)).toBeNull();
  });
});

describe("teamLeaveCreateHref", () => {
  it("builds the create deep link of Team-Abwesenheiten", () => {
    expect(teamLeaveCreateHref(ID, "2026-06-17")).toBe(
      `/team/leave?create=1&employeeId=${ID}&date=2026-06-17`,
    );
  });

  it.each([
    ["not a uuid", "abc", "2026-06-17"],
    ["unreal day", ID, "2026-13-01"],
    ["no day", ID, ""],
  ])("returns null for %s", (_label, id, day) => {
    expect(teamLeaveCreateHref(id, day)).toBeNull();
  });
});

describe("teamCellAriaLabel", () => {
  it("names person, weekday, day and status", () => {
    // 2026-06-17 is a Wednesday
    expect(teamCellAriaLabel("Anna Beispiel", "2026-06-17", "Fehlt")).toBe(
      "Anna Beispiel, Mi 17.06.: Fehlt",
    );
  });

  it("derives the weekday from the calendar day, not from a local getDay() of a UTC parse", () => {
    expect(teamCellAriaLabel("A", "2026-06-14", "Frei")).toBe("A, So 14.06.: Frei");
    expect(teamCellAriaLabel("A", "2026-06-15", "Frei")).toBe("A, Mo 15.06.: Frei");
    expect(teamCellAriaLabel("A", "2026-06-20", "Frei")).toBe("A, Sa 20.06.: Frei");
  });
});
