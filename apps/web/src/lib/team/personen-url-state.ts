// Issue #853 (D-853-14, T-853-21) - the URL schema of Team › Personen. The search text, the two filters
// and the sort live in the URL through `urlState()`; every value is parsed against an allow-list, an
// unknown value falls back to its default, and foreign query keys (e.g. `salonId`) stay untouched.
import { oneOf, text } from "$lib/table/url-state";

/** The schedule type codes the Vertrag filter offers (the label comes from `scheduleModelLabel`). */
export const PERSONEN_VERTRAG_CODES = [
  "FIXED_SCHEDULE",
  "FLEXTIME",
  "MONTHLY_HOURS",
  "SHIFT_BASED",
] as const;

// Issue #853 (owner review): Stammsalon replaces the saldo column (the saldo stays in the person view
// and the reports), so it replaces its sort key too.
export const PERSONEN_SORT_KEYS = ["name", "salon", "vertrag", "stunden", "status"] as const;

export const personenUrlSchema = {
  q: text({ max: 80 }),
  status: oneOf(["aktiv", "alle"] as const, "aktiv"),
  vertrag: oneOf([...PERSONEN_VERTRAG_CODES, ""] as const, ""),
  // The Stammsalon filter of the table (a salon id, "" = all); the header's `salonId` stays its own.
  salon: text({ max: 64 }),
  sort: oneOf(PERSONEN_SORT_KEYS, "name"),
  dir: oneOf(["asc", "desc"] as const, "asc"),
};

/**
 * Verwalten › Personen (#854): the same keys, but the list starts on „alle“ - an ended employee stays
 * in the admin list by default (Issue #86, AC-86-6); Team › Personen starts on „aktiv“.
 */
export const verwaltenPersonenUrlSchema = {
  ...personenUrlSchema,
  status: oneOf(["aktiv", "alle"] as const, "alle"),
};
