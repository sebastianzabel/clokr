// Issue #840 (D-840-01/02/03) — the URL state of /team/leave and /leave (tab, zoom, anchor day,
// status, request) and the redirect targets of the old URLs. The parsers never throw (T-840-05);
// a redirect target is always a fixed path with whitelisted, re-validated parameters (T-840-20).

import { describe, it, expect } from "vitest";
import {
  parseTeamLeaveState,
  parseMyLeaveState,
  teamLeaveSearch,
  myLeaveSearch,
  teamLeaveRedirect,
  teamcalRedirect,
  planungRedirect,
  REDIRECT_CARRIED_PARAMS,
  type TeamLeaveState,
  type MyLeaveState,
} from "../area-tabs";

const TODAY = "2026-11-08";
const ID = "0b6f3a52-9d1e-4c7a-8f21-5a3c9e7d1b44";
const ID2 = "7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5";

const q = (query: string) => new URLSearchParams(query);

describe("parseTeamLeaveState", () => {
  it("defaults to the Übersicht, the quarter and today", () => {
    expect(parseTeamLeaveState(q(""), TODAY)).toEqual({
      tab: "uebersicht",
      zoom: "quartal",
      datum: TODAY,
      explicitTab: false,
      status: null,
      requestId: null,
      salonId: null,
      year: null,
    });
  });

  it("takes valid values from the URL", () => {
    const state = parseTeamLeaveState(
      q(`tab=antraege&zoom=monat&datum=2026-02-15&status=PENDING&request=${ID}&salonId=${ID2}`),
      TODAY,
    );
    expect(state).toEqual({
      tab: "antraege",
      zoom: "monat",
      datum: "2026-02-15",
      explicitTab: true,
      status: "PENDING",
      requestId: ID,
      salonId: ID2,
      year: null,
    });
  });

  it("knows the three tabs and the three zooms", () => {
    for (const tab of ["uebersicht", "antraege", "planung"]) {
      expect(parseTeamLeaveState(q(`tab=${tab}`), TODAY).tab).toBe(tab);
    }
    for (const zoom of ["jahr", "quartal", "monat"]) {
      expect(parseTeamLeaveState(q(`zoom=${zoom}`), TODAY).zoom).toBe(zoom);
    }
  });

  it("defaults the zoom to the quarter on every team tab", () => {
    for (const tab of ["uebersicht", "antraege", "planung"]) {
      expect(parseTeamLeaveState(q(`tab=${tab}`), TODAY).zoom).toBe("quartal");
    }
  });

  it("an unknown tab or zoom falls back and is not an explicit tab; a tab of the other area too", () => {
    expect(parseTeamLeaveState(q("tab=bogus&zoom=woche"), TODAY)).toMatchObject({
      tab: "uebersicht",
      zoom: "quartal",
      explicitTab: false,
    });
    expect(parseTeamLeaveState(q("tab=kalender"), TODAY)).toMatchObject({
      tab: "uebersicht",
      explicitTab: false,
    });
  });

  it("an invalid datum falls back to today: not a day, not a real calendar day, wrong shape", () => {
    for (const datum of ["2026-02-30", "2026-13-01", "abc", "2026-1-1", "", "2026-11-08T00:00"]) {
      expect(parseTeamLeaveState(q(`datum=${datum}`), TODAY).datum, datum).toBe(TODAY);
    }
    // A leap day is a real day only in a leap year.
    expect(parseTeamLeaveState(q("datum=2028-02-29"), TODAY).datum).toBe("2028-02-29");
    expect(parseTeamLeaveState(q("datum=2026-02-29"), TODAY).datum).toBe(TODAY);
  });

  it("an unknown status and a non-uuid request or salonId are dropped", () => {
    const state = parseTeamLeaveState(
      q("status=ALL&request=https://evil.example&salonId=javascript:alert(1)"),
      TODAY,
    );
    expect(state.status).toBeNull();
    expect(state.requestId).toBeNull();
    expect(state.salonId).toBeNull();
    for (const status of [
      "PENDING",
      "APPROVED",
      "CANCELLATION_REQUESTED",
      "REJECTED",
      "CANCELLED",
    ]) {
      expect(parseTeamLeaveState(q(`status=${status}`), TODAY).status).toBe(status);
    }
  });

  it("lowercases a uuid", () => {
    expect(parseTeamLeaveState(q(`request=${ID.toUpperCase()}`), TODAY).requestId).toBe(ID);
  });

  it("year without datum anchors the first day of that year, or today for the current year", () => {
    expect(parseTeamLeaveState(q("year=2027"), TODAY)).toMatchObject({
      datum: "2027-01-01",
      year: 2027,
    });
    expect(parseTeamLeaveState(q("year=2026"), TODAY).datum).toBe(TODAY);
    expect(parseTeamLeaveState(q("year=2025"), TODAY).datum).toBe("2025-01-01");
  });

  it("a valid datum wins over year; an invalid year is dropped", () => {
    expect(parseTeamLeaveState(q("year=2027&datum=2026-03-04"), TODAY).datum).toBe("2026-03-04");
    for (const year of ["27", "20270", "abcd", "-2027", "0050", "2027.5", ""]) {
      const state = parseTeamLeaveState(q(`year=${year}`), TODAY);
      expect(state.year, year).toBeNull();
      expect(state.datum, year).toBe(TODAY);
    }
  });

  it("never throws, whatever the URL holds", () => {
    const hostile = [
      "tab=%E0%A4%A",
      "tab[]=x",
      "zoom=__proto__",
      "datum=%00",
      "tab=&zoom=&datum=",
      "status=__proto__&request=constructor&year=NaN",
    ];
    for (const query of hostile) {
      expect(() => parseTeamLeaveState(q(query), TODAY)).not.toThrow();
      expect(() => parseMyLeaveState(q(query), TODAY)).not.toThrow();
    }
  });
});

describe("parseMyLeaveState", () => {
  it("defaults to the calendar at month zoom", () => {
    expect(parseMyLeaveState(q(""), TODAY)).toMatchObject({
      tab: "kalender",
      zoom: "monat",
      datum: TODAY,
      explicitTab: false,
    });
  });

  it("knows the four tabs; the zoom default follows the tab", () => {
    const expected = { kalender: "monat", antraege: "monat", team: "monat", planung: "quartal" };
    for (const [tab, zoom] of Object.entries(expected)) {
      expect(parseMyLeaveState(q(`tab=${tab}`), TODAY)).toMatchObject({
        tab,
        zoom,
        explicitTab: true,
      });
    }
  });

  it("an explicit zoom beats the tab default; a team-area tab is unknown here", () => {
    expect(parseMyLeaveState(q("tab=planung&zoom=jahr"), TODAY).zoom).toBe("jahr");
    expect(parseMyLeaveState(q("tab=uebersicht"), TODAY)).toMatchObject({
      tab: "kalender",
      explicitTab: false,
    });
  });
});

describe("teamLeaveSearch / myLeaveSearch", () => {
  const base: TeamLeaveState = {
    tab: "planung",
    zoom: "jahr",
    datum: "2026-01-01",
    explicitTab: true,
    status: null,
    requestId: null,
    salonId: null,
    year: null,
  };

  it("writes the keys in the stable order tab, zoom, datum, status, request", () => {
    expect(teamLeaveSearch(base)).toBe("tab=planung&zoom=jahr&datum=2026-01-01");
    expect(teamLeaveSearch({ ...base, tab: "antraege", status: "PENDING", requestId: ID })).toBe(
      `tab=antraege&zoom=jahr&datum=2026-01-01&status=PENDING&request=${ID}`,
    );
  });

  it("never writes the salon deep link or the year", () => {
    expect(teamLeaveSearch({ ...base, salonId: ID2, year: 2027 })).toBe(
      "tab=planung&zoom=jahr&datum=2026-01-01",
    );
  });

  it("round-trips through the parser for every valid combination", () => {
    const tabs = ["uebersicht", "antraege", "planung"] as const;
    const zooms = ["jahr", "quartal", "monat"] as const;
    const statuses = [null, "PENDING", "REJECTED", "CANCELLATION_REQUESTED"] as const;
    const requests = [null, ID];
    let combinations = 0;
    for (const tab of tabs)
      for (const zoom of zooms)
        for (const status of statuses)
          for (const requestId of requests) {
            const state: TeamLeaveState = {
              tab,
              zoom,
              datum: "2026-03-31",
              explicitTab: true,
              status,
              requestId,
              salonId: null,
              year: null,
            };
            expect(parseTeamLeaveState(q(teamLeaveSearch(state)), TODAY)).toEqual(state);
            combinations++;
          }
    expect(combinations).toBe(72);
  });

  it("round-trips the four tabs of Mein Bereich", () => {
    for (const tab of ["kalender", "antraege", "team", "planung"] as const) {
      const state: MyLeaveState = {
        tab,
        zoom: "quartal",
        datum: "2026-12-31",
        explicitTab: true,
        status: "APPROVED",
        requestId: null,
        salonId: null,
        year: null,
      };
      expect(parseMyLeaveState(q(myLeaveSearch(state)), TODAY)).toEqual(state);
    }
  });
});

describe("teamLeaveRedirect", () => {
  it("maps the old view parameter to a tab", () => {
    expect(teamLeaveRedirect(q("view=approvals"))).toBe("/team/leave?tab=antraege&status=PENDING");
    expect(teamLeaveRedirect(q("view=calendar"))).toBe("/team/leave?tab=uebersicht");
    expect(teamLeaveRedirect(q("view=list"))).toBe("/team/leave?tab=antraege");
  });

  it("an unknown view is no legacy parameter", () => {
    for (const view of ["bogus", "__proto__", "constructor", "toString", ""]) {
      expect(teamLeaveRedirect(q(`view=${view}`)), view).toBeNull();
    }
  });

  it("an explicit valid tab wins over the view and keeps the PENDING filter out", () => {
    expect(teamLeaveRedirect(q("view=approvals&tab=planung"))).toBe("/team/leave?tab=planung");
    expect(teamLeaveRedirect(q("view=approvals&status=APPROVED"))).toBe(
      "/team/leave?tab=antraege&status=APPROVED",
    );
  });

  it("sends a § 9 case to the inbox, and only that parameter goes along", () => {
    expect(teamLeaveRedirect(q(`section9=${ID}`))).toBe(`/inbox?section9=${ID}`);
    expect(teamLeaveRedirect(q(`section9=${ID}&view=approvals&salonId=${ID2}`))).toBe(
      `/inbox?section9=${ID}`,
    );
  });

  it("opens the Anträge tab for a request link without a tab, and leaves one with a tab alone", () => {
    expect(teamLeaveRedirect(q(`request=${ID}`))).toBe(`/team/leave?tab=antraege&request=${ID}`);
    expect(teamLeaveRedirect(q(`request=${ID}&tab=antraege`))).toBeNull();
    expect(teamLeaveRedirect(q(`request=${ID}&tab=uebersicht`))).toBeNull();
    // A tab that is not one counts as no tab.
    expect(teamLeaveRedirect(q(`request=${ID}&tab=bogus`))).toBe(
      `/team/leave?tab=antraege&request=${ID}`,
    );
  });

  it("returns null without a legacy parameter, and its own target is final", () => {
    expect(teamLeaveRedirect(q(""))).toBeNull();
    expect(teamLeaveRedirect(q("tab=planung&zoom=monat&datum=2026-02-03"))).toBeNull();
    expect(teamLeaveRedirect(q(`create=1&employeeId=${ID}&date=2026-11-09`))).toBeNull();
    for (const query of [
      "view=approvals",
      "view=calendar",
      "view=list",
      `request=${ID}`,
      `view=list&salonId=${ID2}&year=2027&zoom=jahr`,
    ]) {
      const target = teamLeaveRedirect(q(query));
      expect(target, query).not.toBeNull();
      const next = new URL(target as string, "https://clokr.test");
      expect(teamLeaveRedirect(next.searchParams), `${query} loops`).toBeNull();
    }
  });

  it("carries the create link unchanged on every redirect", () => {
    const create = `create=1&employeeId=${ID}&date=2026-11-09`;
    expect(teamLeaveRedirect(q(`view=approvals&${create}`))).toBe(
      `/team/leave?tab=antraege&status=PENDING&${create}`,
    );
    expect(teamLeaveRedirect(q(`view=calendar&${create}`))).toBe(
      `/team/leave?tab=uebersicht&${create}`,
    );
    expect(teamLeaveRedirect(q(`request=${ID}&${create}`))).toBe(
      `/team/leave?tab=antraege&request=${ID}&${create}`,
    );
  });

  it("carries the whitelist, each value re-validated, in a stable order", () => {
    expect(
      teamLeaveRedirect(
        q(`view=list&date=2026-11-09&salonId=${ID2}&year=2027&zoom=jahr&datum=2027-03-04`),
      ),
    ).toBe(`/team/leave?tab=antraege&zoom=jahr&datum=2027-03-04&salonId=${ID2}&year=2027`);
    // employeeId and date mean something only with create=1.
    expect(teamLeaveRedirect(q(`view=list&employeeId=${ID}&date=2026-11-09`))).toBe(
      "/team/leave?tab=antraege",
    );
  });

  it("drops every carried value that fails its check", () => {
    expect(
      teamLeaveRedirect(
        q(
          "view=list&salonId=not-a-uuid&year=27&zoom=woche&datum=2026-02-30&status=ALL&request=x&create=1&employeeId=y&date=2026-13-01",
        ),
      ),
    ).toBe("/team/leave?tab=antraege&create=1");
  });
});

describe("teamcalRedirect", () => {
  it("is the Übersicht tab at month zoom", () => {
    expect(teamcalRedirect(q(""))).toBe("/team/leave?tab=uebersicht&zoom=monat");
  });

  it("carries a valid salon, anchor day and year, and nothing else", () => {
    expect(teamcalRedirect(q(`salonId=${ID2}`))).toBe(
      `/team/leave?tab=uebersicht&zoom=monat&salonId=${ID2}`,
    );
    expect(teamcalRedirect(q(`datum=2026-03-04&year=2026&status=PENDING&request=${ID}`))).toBe(
      "/team/leave?tab=uebersicht&zoom=monat&datum=2026-03-04&year=2026",
    );
    expect(teamcalRedirect(q("salonId=javascript:alert(1)&tab=planung&zoom=jahr"))).toBe(
      "/team/leave?tab=uebersicht&zoom=monat",
    );
  });
});

describe("planungRedirect", () => {
  it("goes to the team area for a manager and to Mein Bereich otherwise", () => {
    const params = q(`salonId=${ID2}&year=2027`);
    expect(planungRedirect(params, true)).toBe(`/team/leave?tab=planung&salonId=${ID2}&year=2027`);
    expect(planungRedirect(params, false)).toBe(`/leave?tab=planung&salonId=${ID2}&year=2027`);
  });

  it("works without parameters and drops invalid ones", () => {
    expect(planungRedirect(q(""), true)).toBe("/team/leave?tab=planung");
    expect(planungRedirect(q("salonId=../../admin&year=20x7"), false)).toBe("/leave?tab=planung");
  });

  it("never lets the query choose the tab", () => {
    expect(planungRedirect(q("tab=antraege"), true)).toBe("/team/leave?tab=planung");
  });
});

describe("open redirects (T-840-20)", () => {
  const ATTACKS = [
    "//evil.example",
    "https://evil.example",
    "http://evil.example/x",
    "javascript:alert(1)",
    "../../admin",
    "/\\evil.example",
    "%2F%2Fevil.example",
    "data:text/html,x",
  ];
  const FIXED_PREFIXES = ["/team/leave?", "/leave?", "/inbox?"];

  it("no attack value in any parameter changes the target path or reaches the target", () => {
    for (const attack of ATTACKS) {
      const enc = encodeURIComponent(attack);
      const params = [
        `section9=${enc}`,
        `request=${enc}`,
        `view=${enc}`,
        `tab=${enc}`,
        `salonId=${enc}`,
        `year=${enc}`,
        `zoom=${enc}`,
        `datum=${enc}`,
        `status=${enc}`,
        `employeeId=${enc}`,
        `date=${enc}`,
        `create=${enc}`,
      ].join("&");
      const targets = [
        teamLeaveRedirect(q(params)),
        teamLeaveRedirect(q(`view=list&${params}`)),
        teamcalRedirect(q(params)),
        planungRedirect(q(params), true),
        planungRedirect(q(params), false),
      ];
      for (const target of targets) {
        if (target === null) continue;
        expect(
          FIXED_PREFIXES.some((p) => target.startsWith(p)),
          `${attack} -> ${target}`,
        ).toBe(true);
        expect(target, attack).not.toContain("evil");
        expect(target, attack).not.toContain("javascript");
        expect(target, attack).not.toContain("admin");
      }
    }
  });

  it("the named attempts of the plan are dropped", () => {
    expect(teamLeaveRedirect(q("section9=//evil.example"))).toBeNull();
    expect(teamLeaveRedirect(q("request=https://evil.example"))).toBeNull();
    expect(teamLeaveRedirect(q("view=list&tab=../../admin"))).toBe("/team/leave?tab=antraege");
    expect(teamcalRedirect(q("salonId=javascript:alert(1)"))).toBe(
      "/team/leave?tab=uebersicht&zoom=monat",
    );
  });

  it("only whitelisted keys are ever written", () => {
    const allowed = new Set<string>(REDIRECT_CARRIED_PARAMS);
    const params = q(
      `view=list&tab=planung&zoom=jahr&datum=2026-02-03&status=PENDING&request=${ID}&salonId=${ID2}&year=2027&create=1&employeeId=${ID}&date=2026-11-09&redirect=/evil&next=/evil`,
    );
    const target = teamLeaveRedirect(params) as string;
    const keys = [...new URL(target, "https://clokr.test").searchParams.keys()];
    expect(keys.length).toBeGreaterThan(5);
    for (const key of keys) expect(allowed.has(key), key).toBe(true);
  });
});
