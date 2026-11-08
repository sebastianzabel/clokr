// Issue #840 (E-01, E-02, E-06) - the pure decisions of the Team → Abwesenheiten host page.

import { describe, it, expect } from "vitest";
import {
  locateDeepLinkedRequest,
  overviewPersons,
  pageOfRequest,
  requestsForStatus,
} from "../team-leave-model";
import type { TimelinePerson } from "../timeline-model";

const bar = { key: "b", start: "2026-11-02", end: "2026-11-03", style: "gesetzt" as const };

function person(id: string, name: string, own = false): TimelinePerson {
  return {
    employeeId: id,
    name,
    isOwn: own,
    bars: [{ ...bar, key: `bar-${id}`, typeCode: "VACATION", label: "Urlaub", editable: false }],
  };
}

describe("overviewPersons", () => {
  const roster = [
    { id: "e1", firstName: "Ada", lastName: "Zorn" },
    { id: "e2", firstName: "Ben", lastName: "Adler" },
    { id: "e3", firstName: "Cem", lastName: "Mohr" },
  ];

  it("adds a barless row for every roster person without an answer row, sorted by last name", () => {
    const rows = overviewPersons([person("e1", "Ada Zorn")], roster);
    expect(rows.map((r) => r.employeeId)).toEqual(["e2", "e3", "e1"]);
    expect(rows.find((r) => r.employeeId === "e2")!.bars).toEqual([]);
    expect(rows.find((r) => r.employeeId === "e1")!.bars).toHaveLength(1);
  });

  it("keeps a person of the answer that is not in the roster", () => {
    const rows = overviewPersons([person("x9", "Dora Kern")], roster);
    expect(rows.map((r) => r.employeeId)).toEqual(["e2", "x9", "e3", "e1"]);
  });

  it("marks the caller's own barless row", () => {
    const rows = overviewPersons([], roster, { ownEmployeeId: "e3" });
    expect(rows.filter((r) => r.isOwn).map((r) => r.employeeId)).toEqual(["e3"]);
  });

  it("narrows to one person without inventing rows", () => {
    expect(overviewPersons([person("e1", "Ada Zorn")], roster, { employeeId: "e2" })).toHaveLength(
      1,
    );
    expect(overviewPersons([], roster, { employeeId: "nobody" })).toEqual([]);
  });

  it("does not mutate its inputs", () => {
    const answer = [person("e1", "Ada Zorn")];
    overviewPersons(answer, roster);
    expect(answer).toHaveLength(1);
  });
});

describe("requestsForStatus", () => {
  const mk = (id: string, createdAt: string) => ({ id, createdAt });
  const year = [mk("a", "2026-03-01"), mk("b", "2026-05-01")];
  const open = [mk("c", "2026-06-01"), mk("b", "2026-05-01")];

  it("merges the open list of every year into the list for the open filters, newest first, no duplicates", () => {
    expect(requestsForStatus("PENDING", year, open).map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(requestsForStatus("CANCELLATION_REQUESTED", year, open).map((r) => r.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });

  it("reads the year list for every other filter and for Alle", () => {
    for (const status of [null, "APPROVED", "REJECTED", "CANCELLED"] as const) {
      expect(requestsForStatus(status, year, open).map((r) => r.id)).toEqual(["a", "b"]);
    }
  });
});

describe("pageOfRequest", () => {
  const ids = Array.from({ length: 25 }, (_, i) => `r${i}`);

  it("names the 1-based page", () => {
    expect(pageOfRequest(ids, "r0", 10)).toBe(1);
    expect(pageOfRequest(ids, "r9", 10)).toBe(1);
    expect(pageOfRequest(ids, "r10", 10)).toBe(2);
    expect(pageOfRequest(ids, "r24", 10)).toBe(3);
  });

  it("is null for an unknown id or a bad page size", () => {
    expect(pageOfRequest(ids, "nope", 10)).toBeNull();
    expect(pageOfRequest(ids, "r0", 0)).toBeNull();
  });
});

describe("locateDeepLinkedRequest (WR-05)", () => {
  const year = [{ id: "a", startDate: "2026-11-03" }];
  const open = [
    { id: "a", startDate: "2026-11-03" },
    { id: "jan", startDate: "2027-01-12T00:00:00.000Z" },
  ];

  it("a request of the loaded year list is found there", () => {
    expect(locateDeepLinkedRequest("a", year, open)).toEqual({ kind: "year" });
  });

  it("an open request of another year is found in the open list, with its own start day", () => {
    expect(locateDeepLinkedRequest("jan", year, open)).toEqual({
      kind: "open",
      startDate: "2027-01-12",
    });
  });

  it("an unknown request, or one outside both lists, is missing", () => {
    expect(locateDeepLinkedRequest("zzz", year, open)).toEqual({ kind: "missing" });
    expect(locateDeepLinkedRequest("a", [], [])).toEqual({ kind: "missing" });
  });
});
