// Issue #85 D-09 / D-15 — the grouping of the Salonansicht. Presentation only: the server decides
// which entries are visible, this module orders and labels them and sums nothing.

import { describe, it, expect, vi } from "vitest";

// The grouping module imports `withSalonId` from team-view, which pulls in the api client, the auth
// store and its localStorage bootstrap; a stand-in (as in team-view.test.ts) keeps this file free
// of that.
vi.mock("$api/client", () => ({
  api: { get: vi.fn() },
  ApiError: class ApiError extends Error {},
}));
vi.mock("$lib/utils/logger", () => ({ clientLogger: { warn: vi.fn(), error: vi.fn() } }));
import {
  groupSalonEntries,
  salonViewRequestPath,
  salonViewCapReached,
  SALON_VIEW_ROW_CAP,
  type SalonViewEntry,
} from "../salon-time-entries";

function entry(over: Partial<SalonViewEntry> & { id: string }): SalonViewEntry {
  return {
    employeeId: "e1",
    date: "2026-06-15T00:00:00.000Z",
    startTime: "2026-06-15T08:00:00.000Z",
    endTime: "2026-06-15T16:00:00.000Z",
    breakMinutes: 30,
    isInvalid: false,
    salonId: "s1",
    employee: { firstName: "Anna", lastName: "Berg" },
    workingMinutes: 450,
    ...over,
  };
}

describe("groupSalonEntries", () => {
  it("groups by calendar day ascending and labels the day in German", () => {
    const days = groupSalonEntries([
      entry({ id: "b", date: "2026-06-16T00:00:00.000Z" }),
      entry({ id: "a", date: "2026-06-15T00:00:00.000Z" }),
    ]);
    expect(days.map((d) => d.dateKey)).toEqual(["2026-06-15", "2026-06-16"]);
    expect(days[0].label).toBe("Mo, 15.06.2026");
    expect(days[1].label).toBe("Di, 16.06.2026");
  });

  it("sorts the persons of a day by last name then first name with German collation", () => {
    const days = groupSalonEntries([
      entry({ id: "1", employeeId: "z", employee: { firstName: "Zoe", lastName: "Müller" } }),
      entry({ id: "2", employeeId: "o", employee: { firstName: "Otto", lastName: "Ärmel" } }),
      entry({ id: "3", employeeId: "m", employee: { firstName: "Max", lastName: "Müller" } }),
    ]);
    expect(days).toHaveLength(1);
    expect(days[0].persons.map((p) => p.name)).toEqual([
      "Ärmel, Otto",
      "Müller, Max",
      "Müller, Zoe",
    ]);
  });

  it("keeps several entries of one person together, ordered by start time", () => {
    const days = groupSalonEntries([
      entry({
        id: "late",
        startTime: "2026-06-15T13:00:00.000Z",
        endTime: "2026-06-15T17:00:00.000Z",
      }),
      entry({
        id: "early",
        startTime: "2026-06-15T07:00:00.000Z",
        endTime: "2026-06-15T11:00:00.000Z",
      }),
    ]);
    expect(days[0].persons).toHaveLength(1);
    expect(days[0].persons[0].entries.map((e) => e.id)).toEqual(["early", "late"]);
  });

  it("keeps an open entry open and an invalid entry invalid", () => {
    const days = groupSalonEntries([
      entry({ id: "open", endTime: null, workingMinutes: null }),
      entry({
        id: "bad",
        employeeId: "e2",
        isInvalid: true,
        employee: { firstName: "B", lastName: "Zed" },
      }),
    ]);
    const all = days[0].persons.flatMap((p) => p.entries);
    expect(all.find((e) => e.id === "open")).toMatchObject({ endTime: null, workingMinutes: null });
    expect(all.find((e) => e.id === "bad")?.isInvalid).toBe(true);
  });

  it("sums nothing: no day or person carries a total", () => {
    const days = groupSalonEntries([entry({ id: "a" }), entry({ id: "b", employeeId: "e2" })]);
    const keys = new Set<string>();
    for (const day of days) {
      Object.keys(day).forEach((k) => keys.add(k));
      for (const person of day.persons) Object.keys(person).forEach((k) => keys.add(k));
    }
    expect([...keys].filter((k) => /sum|total|gesamt/i.test(k))).toEqual([]);
  });

  it("returns no days for no entries", () => {
    expect(groupSalonEntries([])).toEqual([]);
  });
});

describe("salonViewRequestPath", () => {
  it("builds the month request with the salon id", () => {
    expect(salonViewRequestPath("2026-06-01", "2026-06-30", "s1")).toBe(
      "/time-entries?from=2026-06-01&to=2026-06-30&salonId=s1",
    );
  });
});

describe("salonViewCapReached (D-15)", () => {
  it("is false below the server cap and true at exactly the cap", () => {
    expect(SALON_VIEW_ROW_CAP).toBe(1000);
    expect(salonViewCapReached(new Array(999).fill(null))).toBe(false);
    expect(salonViewCapReached(new Array(1000).fill(null))).toBe(true);
  });
});
