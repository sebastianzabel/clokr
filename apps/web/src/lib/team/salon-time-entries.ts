/**
 * Issue #85 D-09 / D-15 — grouping and request path of the Salonansicht on `/team/time-entries`.
 * Pure, no `$app/*` import, so it is directly testable.
 *
 * Presentation only: the server decides which entries a caller may see (85b-03). This module
 * orders and labels what arrived and sums NOTHING — a per-person or per-day figure over a list
 * that may be cut at the row cap or narrowed by the caller's reach would be a wrong number, so
 * the structures below deliberately carry per-entry details and no total field.
 */
import { format } from "date-fns";
import { de } from "date-fns/locale";
import { withSalonId } from "$lib/dashboard/team-view";
import type { TravelRowFields } from "$lib/time-entries/travel-entry-form";

/**
 * One entry of `GET /time-entries?salonId` (the fields the Salonansicht reads). A trip between two
 * salons (Issue #92) is listed under its departure salon and names its route through the served
 * display names of `TravelRowFields`.
 */
export interface SalonViewEntry extends TravelRowFields {
  id: string;
  employeeId: string;
  /** ISO timestamp at UTC midnight of the work day (`@db.Date`). */
  date: string;
  startTime: string;
  /** null: the entry is still open. */
  endTime: string | null;
  breakMinutes: number;
  isInvalid: boolean;
  salonId?: string;
  employee: { firstName: string; lastName: string };
  /** null for an open entry (the server derives it, never the browser). */
  workingMinutes: number | null;
}

export interface SalonViewPerson {
  employeeId: string;
  /** "Last, First" */
  name: string;
  entries: SalonViewEntry[];
}

export interface SalonViewDay {
  /** "YYYY-MM-DD" */
  dateKey: string;
  /** e.g. "Mo, 15.06.2026" */
  label: string;
  persons: SalonViewPerson[];
}

/** What the Salonansicht currently shows (the page decides, the component renders). */
export type SalonViewStatus = "prompt" | "loading" | "rejected" | "empty" | "rows";

/** The server returns at most this many rows per request (85b-03, D-15). */
export const SALON_VIEW_ROW_CAP = 1000;

/** D-15: exactly the cap means the list may be cut off. */
export function salonViewCapReached(entries: ReadonlyArray<unknown>): boolean {
  return entries.length >= SALON_VIEW_ROW_CAP;
}

/** `GET /time-entries` for one salon over a date range (a month is at most 31 days). */
export function salonViewRequestPath(from: string, to: string, salonId: string): string {
  return withSalonId(`/time-entries?from=${from}&to=${to}`, salonId);
}

function dayLabel(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return format(new Date(year, month - 1, day), "EEEEEE, dd.MM.yyyy", { locale: de });
}

function byText(a: string, b: string): number {
  return a.localeCompare(b, "de");
}

/** Groups entries by calendar day (ascending) and person (last name, first name). */
export function groupSalonEntries(entries: ReadonlyArray<SalonViewEntry>): SalonViewDay[] {
  const byDay = new Map<string, Map<string, SalonViewPerson>>();
  for (const entry of entries) {
    const dateKey = entry.date.slice(0, 10);
    let persons = byDay.get(dateKey);
    if (!persons) {
      persons = new Map();
      byDay.set(dateKey, persons);
    }
    let person = persons.get(entry.employeeId);
    if (!person) {
      person = {
        employeeId: entry.employeeId,
        name: `${entry.employee.lastName}, ${entry.employee.firstName}`,
        entries: [],
      };
      persons.set(entry.employeeId, person);
    }
    person.entries.push(entry);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([dateKey, persons]) => ({
      dateKey,
      label: dayLabel(dateKey),
      persons: [...persons.values()]
        .map((person) => ({
          ...person,
          entries: [...person.entries].sort(
            (a, b) => Date.parse(a.startTime) - Date.parse(b.startTime),
          ),
        }))
        .sort((a, b) => byText(a.name, b.name)),
    }));
}
