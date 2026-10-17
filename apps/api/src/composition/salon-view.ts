/**
 * Issue #542 (P-01) — the one membership rule of a salon view over a window, and the one 404 body
 * of the composition's salon views.
 *
 * A salon view lists the persons that belong to a chosen salon over a window of calendar days. The
 * rule combines the two attributions Issue #84 fixed — working time follows the ENTRY's salon, an
 * absence follows the Stammsalon per day — and decides no salon rule of its own: a candidate is a
 * member when one of the given entries carries the salon OR the person's Stammsalon is the salon on
 * at least one of the given days.
 *
 * Pure and DB-free: the caller reads the entries and the `homeSalonsForDays` map and passes them
 * in. The module imports nothing (types are inline), so it can never join an import cycle.
 */

/** The minimal row shape the rule reads (a subset of a recorded work entry). */
export interface SalonViewEntry {
  employeeId: string;
  salonId: string;
}

export interface SalonViewMembershipInput {
  /** The chosen salon. */
  salonId: string;
  /** The persons already admitted by the caller's reach and population — the result is bounded by them. */
  candidateIds: readonly string[];
  /** Recorded entries of the window (any persons; only candidates can become members). */
  entries: readonly SalonViewEntry[];
  /** The Stammsalon per person and calendar day (`homeSalonsForDays`); a person without a map is not homed. */
  homeByPerson: ReadonlyMap<string, ReadonlyMap<string, string | null>>;
  /** The calendar days (`YYYY-MM-DD`) of the window. */
  days: readonly string[];
}

/** The candidates that recorded time in the salon or are homed there on at least one day. */
export function salonViewMemberIds(input: SalonViewMembershipInput): Set<string> {
  const { salonId, candidateIds, entries, homeByPerson, days } = input;
  const enteredInSalon = new Set<string>();
  for (const entry of entries) {
    if (entry.salonId === salonId) enteredInSalon.add(entry.employeeId);
  }
  const members = new Set<string>();
  for (const id of candidateIds) {
    if (enteredInSalon.has(id)) {
      members.add(id);
      continue;
    }
    const dayMap = homeByPerson.get(id);
    if (dayMap && days.some((day) => dayMap.get(day) === salonId)) members.add(id);
  }
  return members;
}

/**
 * The one 404 body of every composition salon view (#85 D-13 / T-100-09): a foreign tenant's salon,
 * an unknown id, an inactive salon and a salon outside the caller's reach are indistinguishable.
 * Byte-identical to the context routes' copies.
 */
export const SALON_VIEW_NOT_FOUND = Object.freeze({ error: "Salon nicht gefunden" } as const);
