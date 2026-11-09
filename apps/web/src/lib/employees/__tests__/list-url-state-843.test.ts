// Issue #843 (D-843-11, T-843-18) - the employee list reads only q, sort and dir from the URL and
// sorts client-side, stably, with German collation.
import { describe, expect, it } from "vitest";
import { parseUrlState, serialiseUrlState } from "$lib/table/url-state";
import { listUrlSchema, sortEmployees } from "../list-url-state";

const person = (lastName: string, firstName: string, hireDate: string) => ({
  lastName,
  firstName,
  hireDate,
});

describe("listUrlSchema", () => {
  it("accepts q, sort and dir and nothing else", () => {
    const state = parseUrlState(
      listUrlSchema,
      new URLSearchParams("q=M%C3%BCller&sort=hire&dir=desc&salonId=abc&evil=1"),
    );
    expect(state).toEqual({ q: "Müller", sort: "hire", dir: "desc" });
    expect(Object.keys(state)).toEqual(["q", "sort", "dir"]);
  });

  it("serialising the state keeps the salon key and never emits an unknown key", () => {
    const state = parseUrlState(
      listUrlSchema,
      new URLSearchParams("q=M%C3%BCller&sort=hire&dir=desc&evil=1"),
    );
    const query = new URLSearchParams(serialiseUrlState(listUrlSchema, state, "salonId=abc"));
    expect(query.get("salonId")).toBe("abc");
    expect(query.get("q")).toBe("Müller");
    expect(query.get("sort")).toBe("hire");
    expect(query.get("dir")).toBe("desc");
    expect(query.has("evil")).toBe(false);
  });

  it("falls back to the defaults for an invalid sort, a bad direction and an overlong text", () => {
    const state = parseUrlState(
      listUrlSchema,
      new URLSearchParams(`sort=lastLogin&dir=up&q=${"x".repeat(200)}`),
    );
    expect(state.sort).toBe("name");
    expect(state.dir).toBe("asc");
    expect(state.q).toHaveLength(80);
  });

  it("writes nothing for the default state", () => {
    const state = parseUrlState(listUrlSchema, new URLSearchParams(""));
    expect(serialiseUrlState(listUrlSchema, state, "")).toBe("");
  });
});

describe("sortEmployees", () => {
  const rows = [
    person("Zeller", "Anna", "2024-03-01T00:00:00.000Z"),
    person("Ärztin", "Berta", "2022-01-01T00:00:00.000Z"),
    person("Meyer", "Carl", "2023-06-01T00:00:00.000Z"),
  ];

  it("[floor] has rows to sort", () => {
    expect(rows.length).toBeGreaterThan(2);
  });

  it("sorts by display name with German collation (Ä next to A, not after Z)", () => {
    expect(sortEmployees(rows, "name", "asc").map((r) => r.lastName)).toEqual([
      "Ärztin",
      "Meyer",
      "Zeller",
    ]);
    expect(sortEmployees(rows, "name", "desc").map((r) => r.lastName)).toEqual([
      "Zeller",
      "Meyer",
      "Ärztin",
    ]);
  });

  it("sorts by hire date in both directions", () => {
    expect(sortEmployees(rows, "hire", "asc").map((r) => r.lastName)).toEqual([
      "Ärztin",
      "Meyer",
      "Zeller",
    ]);
    expect(sortEmployees(rows, "hire", "desc").map((r) => r.lastName)).toEqual([
      "Zeller",
      "Meyer",
      "Ärztin",
    ]);
  });

  it("is stable: equal keys keep their incoming order in both directions", () => {
    const same = [
      { ...person("Meyer", "Anna", "2023-01-01T00:00:00.000Z"), id: 1 },
      { ...person("Meyer", "Anna", "2023-01-01T00:00:00.000Z"), id: 2 },
      { ...person("Meyer", "Anna", "2023-01-01T00:00:00.000Z"), id: 3 },
    ];
    for (const sort of ["name", "hire"] as const) {
      for (const dir of ["asc", "desc"] as const) {
        expect(sortEmployees(same, sort, dir).map((r) => r.id)).toEqual([1, 2, 3]);
      }
    }
  });

  it("does not mutate its input and sorts an unparsable date last (ascending)", () => {
    const input = [person("A", "A", "not-a-date"), person("B", "B", "2020-01-01T00:00:00.000Z")];
    const copy = [...input];
    const out = sortEmployees(input, "hire", "asc");
    expect(input).toEqual(copy);
    expect(out.map((r) => r.lastName)).toEqual(["B", "A"]);
  });
});
