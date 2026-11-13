// Issue #853 (D-853-13, S-22) - the availability person list: rows, search by name or number, order.
import { describe, expect, it } from "vitest";
import {
  availabilityRows,
  filterAvailability,
  sortAvailability,
  type AvailabilityEmployee,
} from "../availability-list";

const PEOPLE: AvailabilityEmployee[] = [
  { id: "3", firstName: "Zora", lastName: "Äbel", employeeNumber: "P-10" },
  { id: "1", firstName: "Anna", lastName: "Meier", employeeNumber: "P-2" },
  { id: "2", firstName: "Bernd", lastName: "Meier", employeeNumber: undefined },
  { id: "4", firstName: "Gelöscht", lastName: "GELÖSCHT-1234", employeeNumber: "1234" },
];

describe("availabilityRows", () => {
  it("excludes an anonymised person and keeps everyone else", () => {
    const rows = availabilityRows(PEOPLE);
    expect(rows.map((r) => r.id).sort()).toEqual(["1", "2", "3"]);
  });

  it("shows „Vorname Nachname“, sorts by „Nachname, Vorname“ and searches name plus number", () => {
    const [anna] = availabilityRows([PEOPLE[1]]);
    expect(anna.name).toBe("Anna Meier");
    expect(anna.sortName).toBe("Meier, Anna");
    expect(anna.number).toBe("P-2");
    expect(anna.searchText).toBe("Meier, Anna · P-2");
  });

  it("a person without a number has an empty number and no dangling separator", () => {
    const [bernd] = availabilityRows([PEOPLE[2]]);
    expect(bernd.number).toBe("");
    expect(bernd.searchText).toBe("Meier, Bernd");
  });
});

describe("filterAvailability", () => {
  const rows = availabilityRows(PEOPLE);

  it("a blank search matches everyone", () => {
    expect(filterAvailability(rows, "  ")).toHaveLength(3);
  });

  it("finds a person by the Personalnummer", () => {
    expect(filterAvailability(rows, "p-10").map((r) => r.id)).toEqual(["3"]);
  });

  it("finds a person by a part of the name, ignoring case", () => {
    expect(filterAvailability(rows, "äbel").map((r) => r.id)).toEqual(["3"]);
    expect(
      filterAvailability(rows, "MEIER")
        .map((r) => r.id)
        .sort(),
    ).toEqual(["1", "2"]);
  });

  it("no hit gives an empty list", () => {
    expect(filterAvailability(rows, "zzz")).toEqual([]);
  });
});

describe("sortAvailability", () => {
  const rows = availabilityRows(PEOPLE);

  it("orders by last name, then first name (German collation: Ä before M)", () => {
    expect(sortAvailability(rows, { key: "name", dir: "asc" }).map((r) => r.id)).toEqual([
      "3",
      "1",
      "2",
    ]);
    expect(sortAvailability(rows, { key: "name", dir: "desc" }).map((r) => r.id)).toEqual([
      "2",
      "1",
      "3",
    ]);
  });

  it("ties on the name fall back to the id, so the order is stable", () => {
    const twins = availabilityRows([
      { id: "b", firstName: "Anna", lastName: "Meier", employeeNumber: "2" },
      { id: "a", firstName: "Anna", lastName: "Meier", employeeNumber: "1" },
    ]);
    expect(sortAvailability(twins, { key: "name", dir: "asc" }).map((r) => r.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("returns a new array and leaves the input alone", () => {
    const before = rows.map((r) => r.id);
    const sorted = sortAvailability(rows, { key: "name", dir: "asc" });
    expect(sorted).not.toBe(rows);
    expect(rows.map((r) => r.id)).toEqual(before);
  });
});
