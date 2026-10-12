/**
 * Issue #87 (D-02, D-05, D-06, D-13) — the clock card's salon choice, as PRESENTATION of the
 * server's answer only. Whether a choice is offered, which salon is preselected and which salon a
 * booked day is fixed to are decided by `clockSalonChoice()` in the API
 * (GET /api/v1/time-entries/clock-salon); nothing here recomputes a rule.
 *
 * The #82 salon context is a view filter and is NEVER the clock salon (D-06): this module and the
 * selector component deliberately do not import it, so a salon picked in the Topbar cannot leak into
 * a booking. A wiring test pins that.
 */
import { api, ApiError } from "$api/client";
import { clientLogger } from "$lib/utils/logger";
import type { DayStateKind } from "./day-state";

export interface ClockSalonOption {
  id: string;
  name: string;
}

/** The body of GET /api/v1/time-entries/clock-salon. */
export interface ClockSalonChoice {
  offerChoice: boolean;
  preselectedSalonId: string | null;
  /** Non-empty only when `offerChoice` is true. */
  salons: ClockSalonOption[];
  /** Set only when today already has an entry in a multi-salon tenant. */
  fixedSalon: ClockSalonOption | null;
}

export type ClockSalonView =
  | { kind: "none" }
  | { kind: "select"; salons: ClockSalonOption[] }
  | { kind: "fixed"; salon: ClockSalonOption };

/**
 * Fetches the server's answer. ANY failure resolves to `null`: the card then behaves exactly as it
 * did before #87 (no select, plain clock-in, the server derives the salon) — a failed lookup must
 * never block clocking in. A 401/403 is expected for some callers and is not logged; nothing is
 * ever toasted.
 */
export async function loadClockSalonChoice(): Promise<ClockSalonChoice | null> {
  try {
    return await api.get<ClockSalonChoice>("/time-entries/clock-salon");
  } catch (err) {
    const status = err instanceof ApiError ? err.status : null;
    if (status !== 401 && status !== 403) {
      clientLogger.warn("Clock salon choice could not be loaded", { status });
    }
    return null;
  }
}

/** Which of the three renderings the clock card shows for the current day state. */
export function clockSalonView(
  choice: ClockSalonChoice | null,
  dayKind: DayStateKind,
): ClockSalonView {
  if (!choice) return { kind: "none" };
  if (dayKind === "idle") {
    return choice.offerChoice ? { kind: "select", salons: choice.salons } : { kind: "none" };
  }
  return choice.fixedSalon ? { kind: "fixed", salon: choice.fixedSalon } : { kind: "none" };
}

/** The server's pattern salon, but only when it is one of the offered salons. */
export function initialClockSalonSelection(choice: ClockSalonChoice | null): string | null {
  if (!choice?.preselectedSalonId) return null;
  return choice.salons.some((s) => s.id === choice.preselectedSalonId)
    ? choice.preselectedSalonId
    : null;
}

function isOffered(view: ClockSalonView, salonId: string | null): salonId is string {
  return view.kind === "select" && salonId !== null && view.salons.some((s) => s.id === salonId);
}

/**
 * The POST /time-entries/clock-in body. A salon is attached ONLY for the idle `select` view and
 * only when it is one of the offered ids — never a null salon (the API answers 400 for it) and
 * never on a running or finished day, so a re-clock-in (REOPEN) never carries one (D-13).
 */
export function clockInBody(
  view: ClockSalonView,
  selectedSalonId: string | null,
): { source: "MOBILE"; salonId?: string } {
  return isOffered(view, selectedSalonId)
    ? { source: "MOBILE", salonId: selectedSalonId }
    : { source: "MOBILE" };
}

/** True only while a choice is offered and none is made (D-05: no preselection, no clock-in). */
export function clockInBlocked(view: ClockSalonView, selectedSalonId: string | null): boolean {
  return view.kind === "select" && !isOffered(view, selectedSalonId);
}
