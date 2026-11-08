// Issue #840 (D-840-01/02) — the URL state of /team/leave: tab, zoom and anchor day.
// The parser never throws: an unknown or invalid value falls back to its default (T-840-05).

import { describe, it, expect } from "vitest";
import { parseTeamLeaveState, teamLeaveSearch } from "../area-tabs";

const TODAY = "2026-11-08";

describe("parseTeamLeaveState", () => {
  it("defaults to the Übersicht, the quarter and today", () => {
    expect(parseTeamLeaveState(new URLSearchParams(""), TODAY)).toEqual({
      tab: "uebersicht",
      zoom: "quartal",
      datum: TODAY,
      explicitTab: false,
    });
  });

  it("takes valid values from the URL", () => {
    const state = parseTeamLeaveState(
      new URLSearchParams("tab=antraege&zoom=monat&datum=2026-02-15"),
      TODAY,
    );
    expect(state).toEqual({
      tab: "antraege",
      zoom: "monat",
      datum: "2026-02-15",
      explicitTab: true,
    });
  });

  it("knows the three tabs and the three zooms", () => {
    for (const tab of ["uebersicht", "antraege", "planung"]) {
      expect(parseTeamLeaveState(new URLSearchParams({ tab }), TODAY).tab).toBe(tab);
    }
    for (const zoom of ["jahr", "quartal", "monat"]) {
      expect(parseTeamLeaveState(new URLSearchParams({ zoom }), TODAY).zoom).toBe(zoom);
    }
  });

  it("an unknown tab or zoom falls back and is not an explicit tab", () => {
    const state = parseTeamLeaveState(new URLSearchParams("tab=bogus&zoom=woche"), TODAY);
    expect(state).toEqual({ tab: "uebersicht", zoom: "quartal", datum: TODAY, explicitTab: false });
  });

  it("an invalid datum falls back to today: not a day, not a real calendar day, wrong shape", () => {
    for (const datum of ["2026-02-30", "2026-13-01", "abc", "2026-1-1", "", "2026-11-08T00:00"]) {
      expect(parseTeamLeaveState(new URLSearchParams({ datum }), TODAY).datum, datum).toBe(TODAY);
    }
    // A leap day is a real day only in a leap year.
    expect(parseTeamLeaveState(new URLSearchParams({ datum: "2028-02-29" }), TODAY).datum).toBe(
      "2028-02-29",
    );
    expect(parseTeamLeaveState(new URLSearchParams({ datum: "2026-02-29" }), TODAY).datum).toBe(
      TODAY,
    );
  });

  it("never throws, whatever the URL holds", () => {
    const hostile = ["tab=%E0%A4%A", "tab[]=x", "zoom=__proto__", "datum=%00", "tab=&zoom=&datum="];
    for (const query of hostile) {
      expect(() => parseTeamLeaveState(new URLSearchParams(query), TODAY)).not.toThrow();
    }
  });
});

describe("teamLeaveSearch", () => {
  it("writes the keys in the stable order tab, zoom, datum", () => {
    expect(
      teamLeaveSearch({ tab: "planung", zoom: "jahr", datum: "2026-01-01", explicitTab: true }),
    ).toBe("tab=planung&zoom=jahr&datum=2026-01-01");
  });

  it("round-trips through the parser", () => {
    const state = {
      tab: "antraege",
      zoom: "monat",
      datum: "2026-03-31",
      explicitTab: true,
    } as const;
    expect(parseTeamLeaveState(new URLSearchParams(teamLeaveSearch(state)), TODAY)).toEqual(state);
  });
});
