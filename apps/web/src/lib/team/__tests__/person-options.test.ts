// Issue #853 (D-853-10) - personOptions: order, label with and without the Personalnummer, empty input.
import { describe, expect, it } from "vitest";
import { matchesSearch } from "$lib/table/search";
import { personOptionLabel, personOptions } from "../person-options";

const person = (
  id: string,
  lastName: string,
  firstName: string,
  employeeNumber?: string | null,
) => ({
  id,
  lastName,
  firstName,
  employeeNumber,
});

describe("personOptions", () => {
  it("labels a person „Nachname, Vorname · Nr. 123“ and leaves the suffix out without a number", () => {
    expect(personOptionLabel(person("a", "Meier", "Anna", "123"))).toBe("Meier, Anna · Nr. 123");
    expect(personOptionLabel(person("a", "Meier", "Anna"))).toBe("Meier, Anna");
    expect(personOptionLabel(person("a", "Meier", "Anna", null))).toBe("Meier, Anna");
    expect(personOptionLabel(person("a", "Meier", "Anna", "  "))).toBe("Meier, Anna");
  });

  it("sorts by last name, first name and id with the German collator (Ä next to A)", () => {
    const options = personOptions([
      person("3", "Zimmer", "Zoe", "9"),
      person("2", "Meier", "Berta", "2"),
      person("5", "Ärmel", "Ida", "5"),
      person("1", "Meier", "Anna", "1"),
      person("4", "Meier", "Anna", "4"),
    ]);
    expect(options.map((o) => o.value)).toEqual(["5", "1", "4", "2", "3"]);
    expect(options[0]).toEqual({ value: "5", label: "Ärmel, Ida · Nr. 5" });
  });

  it("does not reorder or mutate the input", () => {
    const input = [person("2", "B", "b"), person("1", "A", "a")];
    personOptions(input);
    expect(input.map((p) => p.id)).toEqual(["2", "1"]);
  });

  it("returns an empty list for no employees", () => {
    expect(personOptions([])).toEqual([]);
  });

  it("puts the Personalnummer into the label, so the Combobox search finds it", () => {
    const [option] = personOptions([person("1", "Meier", "Anna", "4711")]);
    expect(matchesSearch(option.label, "4711")).toBe(true);
    expect(matchesSearch(option.label, "meier")).toBe(true);
    expect(matchesSearch(option.label, "999")).toBe(false);
  });
});
