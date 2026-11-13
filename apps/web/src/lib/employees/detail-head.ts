/**
 * Issue #854 (owner review of the Personen detail) - the head of the employee detail as in the
 * prototype: avatar, name and ONE sub line „<Personalnummer> · <Stammsalon> · seit <Eintrittsdatum>“.
 * Display only: the Stammsalon comes from the person's stored salon assignments through
 * `homeSalonIdOn()` of `$lib/employees/salon-assignments` (#853, the one display rule) (the API decides
 * them, `GET /employees/:id/salon-assignments`), the employment state from `employmentState()`; a
 * part that is unknown or unreadable is left out, nothing is guessed.
 */
import { employmentState } from "$lib/employees/employment-state";
import type { SalonRef } from "$lib/employees/salon-assignments";

/** The name of a salon id, or null when the list does not hold it (unreadable or unknown). */
export function salonNameOf(salons: readonly SalonRef[], salonId: string | null): string | null {
  if (!salonId) return null;
  return salons.find((s) => s.id === salonId)?.name ?? null;
}

function germanDay(isoDay: string): string {
  const [y, m, d] = isoDay.split("-");
  return `${d}.${m}.${y}`;
}

export interface DetailHeadInput {
  employeeNumber?: string | null;
  homeSalonName?: string | null;
  /** The hire date as stored (a UTC-midnight instant or an ISO day); read by its calendar day. */
  hireDate?: string | null;
  exitDate?: string | null;
  /** The calendar day the employment state is judged on (`YYYY-MM-DD`). */
  today: string;
}

/**
 * „P-004 · Clokr Demo Nord · seit 19.10.2026“; a planned or past exit is appended with its own label
 * („Austritt am …“ / „Ausgeschieden am …“), so the head never hides that a person is leaving.
 */
export function detailHeadSub(input: DetailHeadInput): string {
  const parts: string[] = [];
  if (input.employeeNumber) parts.push(input.employeeNumber);
  if (input.homeSalonName) parts.push(input.homeSalonName);
  const hireDay = input.hireDate ? String(input.hireDate).slice(0, 10) : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(hireDay)) parts.push(`seit ${germanDay(hireDay)}`);
  const state = employmentState(input.exitDate, input.today);
  if (state.kind !== "EMPLOYED") parts.push(state.label);
  return parts.join(" · ");
}
