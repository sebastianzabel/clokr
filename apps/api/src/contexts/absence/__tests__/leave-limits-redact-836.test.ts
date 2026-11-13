/**
 * Issue #836 (AC-12, D-836-12) — who may be NAMED in a limit warning, a 409 body or the load view.
 * Pure, no database: the reach arithmetic of `redact.ts` and its use by `toLeaveLimitWarnings`.
 */
import { describe, expect, it } from "vitest";
import type { LeaveLimitExceedance } from "../leave-limits";
import { isPersonVisibleOn, readerVisibilityFrom, toLeaveLimitWarnings } from "../leave-limits";

const S1 = "salon-1";
const S2 = "salon-2";

function exceedance(salonId: string, personIds: string[], candidate: string) {
  const e: LeaveLimitExceedance = {
    rule: {
      id: "rule-1",
      name: null,
      groupKind: "ALL",
      classification: null,
      accessRoleId: null,
      accessRoleName: null,
      maxPersons: 1,
      validFrom: null,
      validUntil: null,
      salonId,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
    salonId,
    groupKey: "ALL",
    candidateEmployeeId: candidate,
    days: [{ day: "2026-08-05", count: personIds.length, max: 1, personIds }],
  };
  return e;
}

const names = new Map([
  ["cand", { firstName: "Cand", lastName: "Idate" }],
  ["p1", { firstName: "Pia", lastName: "Eins" }],
  ["p2", { firstName: "Paul", lastName: "Zwei" }],
  ["p3", { firstName: "Pina", lastName: "Drei" }],
]);

describe("readerVisibilityFrom / isPersonVisibleOn", () => {
  it("a whole-tenant reader sees every person", () => {
    const vis = readerVisibilityFrom({ kind: "wholeTenant" }, null);
    expect(isPersonVisibleOn(vis, "anyone", S1)).toBe(true);
    expect(isPersonVisibleOn(vis, "anyone", S2)).toBe(true);
  });

  it("a reader scoped to salon S1 sees persons homed in S1 that day, not those of S2", () => {
    const vis = readerVisibilityFrom({ kind: "scoped", salonIds: [S1], employeeIds: [] }, "me");
    expect(isPersonVisibleOn(vis, "p1", S1)).toBe(true);
    expect(isPersonVisibleOn(vis, "p1", S2)).toBe(false);
  });

  it("a reader scoped to one employee sees that employee only", () => {
    const vis = readerVisibilityFrom({ kind: "scoped", salonIds: [], employeeIds: ["p1"] }, null);
    expect(isPersonVisibleOn(vis, "p1", S2)).toBe(true);
    expect(isPersonVisibleOn(vis, "p2", S2)).toBe(false);
  });

  it("an own-data-only reader (scoped, empty sets) sees only themself", () => {
    const vis = readerVisibilityFrom({ kind: "scoped", salonIds: [], employeeIds: [] }, "me");
    expect(isPersonVisibleOn(vis, "me", S1)).toBe(true);
    expect(isPersonVisibleOn(vis, "p1", S1)).toBe(false);
  });

  it("a reader without an employee record sees nobody when scoped empty", () => {
    const vis = readerVisibilityFrom({ kind: "scoped", salonIds: [], employeeIds: [] }, null);
    expect(isPersonVisibleOn(vis, "p1", S1)).toBe(false);
  });
});

describe("toLeaveLimitWarnings with redaction", () => {
  const e = exceedance(S1, ["cand", "p1", "p2", "p3"], "cand");

  it("without redaction the day items stay counts only", () => {
    const [warning] = toLeaveLimitWarnings([e]);
    expect(warning!.days).toEqual([{ day: "2026-08-05", count: 4, max: 1 }]);
  });

  it("names the visible others, never the candidate, and counts the hidden ones", () => {
    const vis = readerVisibilityFrom({ kind: "scoped", salonIds: [], employeeIds: ["p2"] }, null);
    const [warning] = toLeaveLimitWarnings([e], { visibility: vis, personNames: names });
    expect(warning!.days).toEqual([
      {
        day: "2026-08-05",
        count: 4,
        max: 1,
        persons: [{ employeeId: "p2", firstName: "Paul", lastName: "Zwei" }],
        hiddenCount: 2,
      },
    ]);
  });

  it("hiddenCount + persons.length equals count - 1 for every reader", () => {
    const readers = [
      readerVisibilityFrom({ kind: "wholeTenant" }, null),
      readerVisibilityFrom({ kind: "scoped", salonIds: [S1], employeeIds: [] }, null),
      readerVisibilityFrom({ kind: "scoped", salonIds: [S2], employeeIds: [] }, null),
      readerVisibilityFrom({ kind: "scoped", salonIds: [], employeeIds: [] }, "p3"),
    ];
    for (const visibility of readers) {
      const [warning] = toLeaveLimitWarnings([e], { visibility, personNames: names });
      const day = warning!.days[0] as unknown as { persons: unknown[]; hiddenCount: number };
      expect(day.hiddenCount + day.persons.length).toBe(3);
    }
  });

  it("an own-data-only reader sees counts only: no names, a number for the rest", () => {
    const vis = readerVisibilityFrom({ kind: "scoped", salonIds: [], employeeIds: [] }, "cand");
    const [warning] = toLeaveLimitWarnings([e], { visibility: vis, personNames: names });
    const day = warning!.days[0] as unknown as { persons: unknown[]; hiddenCount: number };
    expect(day.persons).toEqual([]);
    expect(day.hiddenCount).toBe(3);
    expect(JSON.stringify(warning)).not.toMatch(/p1|p2|p3|Pia|Paul|Pina/);
  });

  it("orders the named persons by last name, first name, id", () => {
    const vis = readerVisibilityFrom({ kind: "wholeTenant" }, null);
    const [warning] = toLeaveLimitWarnings([e], { visibility: vis, personNames: names });
    const persons = (warning!.days[0] as unknown as { persons: Array<{ lastName: string }> })
      .persons;
    expect(persons.map((p) => p.lastName)).toEqual(["Drei", "Eins", "Zwei"]);
  });

  it("a hidden person's id never serialises, whoever the reader is", () => {
    const vis = readerVisibilityFrom({ kind: "scoped", salonIds: [S2], employeeIds: [] }, null);
    const [warning] = toLeaveLimitWarnings([e], { visibility: vis, personNames: names });
    expect(Object.keys(warning!.days[0]!).sort()).toEqual(
      ["count", "day", "hiddenCount", "max", "persons"].sort(),
    );
    expect(JSON.stringify(warning)).not.toContain("p1");
  });
});
