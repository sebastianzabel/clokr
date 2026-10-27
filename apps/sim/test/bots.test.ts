import { describe, expect, it } from "vitest";
import { realizeDay } from "../src/bots/employee";
import { blockedDay, plannedDay, rosterFor } from "../src/bots/schedule";
import { rngFor } from "../src/rng";
import { buildPopulation, SMALL_SIZE, type PersonSpec } from "../src/plan";

const people = buildPopulation("clokr-sim-1", "2026-11-02", SMALL_SIZE).tenants[0].persons;
const byKind = (kind: PersonSpec["kind"]) => people.find((p) => p.kind === kind)!;

describe("schedule", () => {
  it("plans a fixed contract on its work days only", () => {
    const person = byKind("FIXED");
    const rng = rngFor("s", "x");
    const worked = [
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
      "2026-11-08",
    ]
      .map((day) => plannedDay(person, day, undefined, rng))
      .map((p) => p !== null);
    // 2026-11-02 is a Monday; index 0 = Mon .. 6 = Sun
    const expected = [1, 2, 3, 4, 5, 6, 0].map((d) => person.workDays.includes(d));
    expect(worked).toEqual(expected);
  });

  it("plans a shift-based person only where a shift exists", () => {
    const person = byKind("SHIFT");
    const rng = rngFor("s", "y");
    expect(plannedDay(person, "2026-11-03", undefined, rng)).toBeNull();
    const planned = plannedDay(
      person,
      "2026-11-03",
      { start: "09:00", end: "17:00", salonIndex: 1 },
      rng,
    );
    expect(planned).toMatchObject({
      start: "09:00",
      end: "17:00",
      salonIndex: 1,
      breakMinutes: 30,
    });
  });

  it("builds a roster only on usual work days, with a salon of the person", () => {
    const person = byKind("SPRINGER");
    const roster = rosterFor(person, "2026-11-02", "2026-11-15", (day) =>
      rngFor("s", person.key, day),
    );
    expect(Object.keys(roster).length).toBeGreaterThan(0);
    const allowed = new Set([person.homeSalonIndex, ...person.extraSalonIndexes]);
    for (const shift of Object.values(roster)) expect(allowed.has(shift.salonIndex)).toBe(true);
  });

  it("blocks leave days and the school day", () => {
    const azubi = byKind("AZUBI");
    expect(
      blockedDay(azubi, "2026-11-10", [
        { id: "1", start: "2026-11-09", end: "2026-11-11", type: "VACATION", status: "APPROVED" },
      ]),
    ).toBe("LEAVE");
    expect(
      blockedDay(azubi, "2026-11-10", [
        { id: "1", start: "2026-11-09", end: "2026-11-11", type: "VACATION", status: "REJECTED" },
      ]),
    ).not.toBe("LEAVE");
    const school = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"].filter(
      (d) => blockedDay(azubi, d, []) === "SCHOOL",
    );
    expect(school).toHaveLength(1);
  });
});

describe("realizeDay", () => {
  const planned = { start: "09:00", end: "17:30", breakMinutes: 30, salonIndex: 0 };
  const traits = {
    lateness: 0,
    forgetsClockOut: 0,
    sickness: 0,
    vacationAppetite: 0,
    violationProne: 1,
  };

  it("introduces a deliberate violation for an adult who is violation-prone, and reports it", () => {
    const intents = new Set<string | null>();
    for (let i = 0; i < 40; i += 1)
      intents.add(realizeDay(planned, traits, false, rngFor("v", String(i))).intent);
    expect(intents.has("LONG_DAY")).toBe(true);
    expect(intents.has("NO_BREAK")).toBe(true);
  });

  it("never pushes a minor past the statutory day", () => {
    for (let i = 0; i < 40; i += 1) {
      expect(realizeDay(planned, traits, true, rngFor("v", String(i))).intent).toBeNull();
    }
  });

  it("reports no intent for an ordinary day and is deterministic", () => {
    const calm = { ...traits, violationProne: 0 };
    const a = realizeDay(planned, calm, false, rngFor("c", "1"));
    expect(a.intent).toBeNull();
    expect(realizeDay(planned, calm, false, rngFor("c", "1"))).toEqual(a);
  });
});
