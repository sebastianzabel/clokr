// Issue #853 (D-853-10) - the options of the person picker on Team › Zeiten. Pure: no store, no
// request. The Personalnummer sits in the label because the Combobox filters through the one
// search normaliser over the label, so a leader finds a person by name or by number.

export interface PersonOptionSource {
  id: string;
  firstName: string;
  lastName: string;
  /** Optional: the list endpoint serves it; a row without one gets no suffix. */
  employeeNumber?: string | null;
}

export interface PersonOption {
  value: string;
  label: string;
}

const COLLATOR = new Intl.Collator("de");

/** „Nachname, Vorname · Nr. 123“ (no number: „Nachname, Vorname“). */
export function personOptionLabel(person: PersonOptionSource): string {
  const base = `${person.lastName}, ${person.firstName}`;
  const number = person.employeeNumber?.trim();
  return number ? `${base} · Nr. ${number}` : base;
}

/** The picker items, sorted by last name, first name and id (German collation). */
export function personOptions(employees: readonly PersonOptionSource[]): PersonOption[] {
  return [...employees]
    .sort(
      (a, b) =>
        COLLATOR.compare(a.lastName, b.lastName) ||
        COLLATOR.compare(a.firstName, b.firstName) ||
        COLLATOR.compare(a.id, b.id),
    )
    .map((person) => ({ value: person.id, label: personOptionLabel(person) }));
}
