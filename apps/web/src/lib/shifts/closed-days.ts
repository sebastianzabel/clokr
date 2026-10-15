/**
 * Which closed weekdays the shift planner's week view dims (Issue #563, D-03, D-15, AC-563-2).
 *
 * Opening hours live on the salon, never on the tenant. `GET /shifts/week` hands the planner the
 * hours of the active salons inside its `shift:read` reach (`salonOpeningHours`); this module is the
 * ONE place that decides whose hours the grid shows:
 * - exactly one salon in the field → that salon's closed days;
 * - several salons → the salon chosen in the header (#82 salon context) when it is in the field;
 * - several and no usable choice → nothing is dimmed, and a hint asks for a choice when the header
 *   offers one. Hours of different salons are NEVER merged into one set.
 *
 * Presentation only, never a filter: the salon context decides which hours are shown, not which
 * shifts or employees the planner sees (#82), and the authoritative opening-hours check stays on the
 * server for every shift write. Weekday indices follow the API: 0 = Montag … 6 = Sonntag.
 */
import { selectedSalonId, showSalonOptions } from "$stores/salon-context";

/** Shown above the grid when several salons are in the field and none is chosen. */
export const SALON_HOURS_CHOOSE_HINT =
  "Öffnungszeiten je Salon – Salon wählen, um geschlossene Tage zu sehen.";

/** One element of `GET /shifts/week` → `salonOpeningHours`; the hours stay untrusted until read. */
export interface SalonOpeningHoursEntry {
  salonId: string;
  name: string;
  openingHours: unknown;
}

export interface ClosedDaysView {
  /** Weekday indices (0 = Montag) the grid dims. */
  days: Set<number>;
  /** The salon whose hours `days` shows; null while nothing is dimmed. */
  salonName: string | null;
  /** The German hint to render above the grid, or null. */
  hint: string | null;
}

const NOTHING: Pick<ClosedDaysView, "salonName" | "hint"> = { salonName: null, hint: null };

/** The weekdays marked `closed === true`; anything malformed is no closed day and never throws. */
function closedWeekdays(openingHours: unknown): Set<number> {
  const days = new Set<number>();
  if (!Array.isArray(openingHours)) return days;
  for (const entry of openingHours) {
    if (typeof entry !== "object" || entry === null) continue;
    const { day, closed } = entry as { day?: unknown; closed?: unknown };
    if (
      closed === true &&
      typeof day === "number" &&
      Number.isInteger(day) &&
      day >= 0 &&
      day <= 6
    ) {
      days.add(day);
    }
  }
  return days;
}

function viewOf(salon: SalonOpeningHoursEntry): ClosedDaysView {
  return { days: closedWeekdays(salon.openingHours), salonName: salon.name, hint: null };
}

export function closedDaysFor(
  salons: SalonOpeningHoursEntry[] | undefined,
  state: Parameters<typeof showSalonOptions>[0] & Parameters<typeof selectedSalonId>[0],
): ClosedDaysView {
  if (!Array.isArray(salons) || salons.length === 0) {
    return { days: new Set(), ...NOTHING };
  }
  if (salons.length === 1) return viewOf(salons[0]);

  const chosen = selectedSalonId(state);
  const chosenSalon = chosen === null ? undefined : salons.find((s) => s.salonId === chosen);
  if (chosenSalon) return viewOf(chosenSalon);

  return {
    days: new Set(),
    salonName: null,
    hint: showSalonOptions(state) ? SALON_HOURS_CHOOSE_HINT : null,
  };
}
