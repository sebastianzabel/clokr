/**
 * Issue #87 (D-02, D-05, D-06, D-13) — the clock card's salon choice, as PRESENTATION of the
 * server's answer only. Whether a choice is offered, which salon is preselected and which salon a
 * booked day is fixed to are decided by `clockSalonChoice()` in the API
 * (GET /api/v1/time-entries/clock-salon); nothing here recomputes a rule.
 *
 * Since Issue #70 a FINISHED day also carries a second-salon offer: `fixedSalon` is the salon a plain
 * re-clock continues, `salons` the other active salons — choosing one starts a NEW entry (D-02/D-11).
 * Both come from the server; the web only renders them.
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
  /** Non-empty only when `offerChoice` is true. On a finished day: the salons OTHER than `fixedSalon`. */
  salons: ClockSalonOption[];
  /**
   * Set only when today already has an entry in a multi-salon tenant: the salon of the running entry,
   * or on a finished day the salon of the entry ending last (what „Erneut einstempeln“ continues).
   */
  fixedSalon: ClockSalonOption | null;
}

export type ClockSalonView =
  | { kind: "none" }
  | { kind: "select"; salons: ClockSalonOption[] }
  // `others` is present only on a finished day with a second-salon offer (Issue #70); absent otherwise.
  | { kind: "fixed"; salon: ClockSalonOption; others?: ClockSalonOption[] };

/** What a clock-in is for — decides whether a salon may travel with it. */
export type ClockInAction = "start" | "reopen" | "otherSalon";

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
  if (!choice.fixedSalon) return { kind: "none" };
  // A finished day may start a new entry in another salon (Issue #70); a running day offers nothing.
  if (dayKind === "finished" && choice.offerChoice && choice.salons.length > 0) {
    return { kind: "fixed", salon: choice.fixedSalon, others: choice.salons };
  }
  return { kind: "fixed", salon: choice.fixedSalon };
}

/** The salons a finished day offers for a new entry; empty for every other view. */
export function otherSalonOptions(view: ClockSalonView): ClockSalonOption[] {
  return view.kind === "fixed" ? (view.others ?? []) : [];
}

/** The lead-in of the fixed-salon note: the salon a running entry is in, or the last one recorded. */
export function fixedSalonNoteLabel(dayKind: DayStateKind, entryCount: number): string {
  if (dayKind === "running") return "Eingestempelt in";
  return entryCount >= 2 ? "Zuletzt erfasst in" : "Heute erfasst in";
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

function isOfferedElsewhere(view: ClockSalonView, salonId: string | null): salonId is string {
  return salonId !== null && otherSalonOptions(view).some((s) => s.id === salonId);
}

/**
 * The POST /time-entries/clock-in body. A salon is attached ONLY for the idle `select` view
 * (`start`) and for the finished-day other-salon action (`otherSalon`), and only when it is one of
 * the offered ids — never a null salon (the API answers 400 for it) and never for `reopen`, so a
 * re-clock-in (REOPEN) never carries one (D-13).
 */
export function clockInBody(
  view: ClockSalonView,
  selectedSalonId: string | null,
  action: ClockInAction = "start",
): { source: "MOBILE"; salonId?: string } {
  if (action === "start" && isOffered(view, selectedSalonId)) {
    return { source: "MOBILE", salonId: selectedSalonId };
  }
  if (action === "otherSalon" && isOfferedElsewhere(view, selectedSalonId)) {
    return { source: "MOBILE", salonId: selectedSalonId };
  }
  return { source: "MOBILE" };
}

/** The display name of an offered second salon, `undefined` for an id that is not offered. */
export function otherSalonName(view: ClockSalonView, salonId: string | null): string | undefined {
  return otherSalonOptions(view).find((s) => s.id === salonId)?.name;
}

/** True while the second-salon action has no valid selection (nothing is sent without one). */
export function otherSalonBlocked(view: ClockSalonView, selectedSalonId: string | null): boolean {
  return !isOfferedElsewhere(view, selectedSalonId);
}

/** True only while a choice is offered and none is made (D-05: no preselection, no clock-in). */
export function clockInBlocked(view: ClockSalonView, selectedSalonId: string | null): boolean {
  return view.kind === "select" && !isOffered(view, selectedSalonId);
}
