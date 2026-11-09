// Issue #853 (D-853-08, D-853-09, S-27, S-29) - the pure text rules of the leave decision dialog
// (LeaveReviewDialog.svelte): the result toast, the Resturlaub line and the shift lines. Pure and
// dependency-free (no `$api`, store or component import) so every sentence is unit-testable
// without mounting the dialog.
//
// None of these functions computes a balance: the Resturlaub figure comes in already derived
// (`deriveVacationSummary(...).remaining`, #451), this module only subtracts the request's own
// days for the "before -> after" display and words the result.

export type ReviewDecision = "APPROVED" | "REJECTED";

/**
 * The toast after a decision was answered by the server. It names the person and the decision,
 * never the leave type: a sick-leave decision on a lock screen or a shared screen would be health
 * data (Art. 9 DSGVO, T-853-12).
 */
export function reviewResultToast(
  decision: ReviewDecision,
  personName: string,
  isCancellation = false,
): string {
  const subject = isCancellation ? "Stornierung" : "Antrag";
  const verb = decision === "APPROVED" ? "genehmigt" : "abgelehnt";
  return `${subject} von ${personName} ${verb}.`;
}

/** German decimal comma, at most two decimals, no trailing zeros (`7.5` -> `7,5`). */
export function formatDays(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(rounded).replace(".", ",");
}

function yearOf(day: string): number {
  return Number(day.slice(0, 4));
}

export interface VacationFactInput {
  /** `deriveVacationSummary(balance, 0).remaining`; `null` when there is no balance row. */
  remaining: number | null;
  /** The request's priced days. */
  days: number;
  /** The request status; only a PENDING request has not been deducted yet. */
  status: string;
  startDate: string;
  endDate: string;
}

export interface VacationFact {
  year: number;
  before: number;
  /** `before - days`; `null` when the "after" figure must not be derived. */
  after: number | null;
  text: string;
}

/**
 * The Resturlaub line of the decision dialog. "Before -> after" is derived ONLY for a PENDING
 * request whose start and end lie in the same calendar year (Pitfall 6): a request that spans the
 * turn of the year is split across two entitlements and one subtraction would be wrong, and a
 * request that is no longer pending is already deducted. In every other case the line shows the
 * current Resturlaub only, with no derived number.
 */
export function vacationBeforeAfter(input: VacationFactInput): VacationFact | null {
  if (input.remaining === null) return null;
  const year = yearOf(input.startDate);
  const before = input.remaining;
  const sameYear = yearOf(input.endDate) === year;
  const derive = input.status === "PENDING" && sameYear;
  if (!derive) {
    return { year, before, after: null, text: `Resturlaub ${year}: ${formatDays(before)} Tage` };
  }
  const after = before - input.days;
  return {
    year,
    before,
    after,
    text: `Resturlaub ${year}: ${formatDays(before)} → ${formatDays(after)} Tage`,
  };
}

const WEEKDAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

/** Shown when no shift is returned. An out-of-scope person also yields an empty list, so the text
 *  is neutral: it never says that the person has no shifts. */
export const NO_SHIFTS_TEXT = "Keine geplanten Schichten sichtbar";

export interface RangeShift {
  date: string;
  startTime: string;
  endTime: string;
}

/** `Di 10.11. · 10:00–18:30` per shift, in date and start order. Inputs are not mutated. */
export function shiftLines(shifts: readonly RangeShift[]): string[] {
  return [...shifts]
    .sort((a, b) =>
      a.date !== b.date
        ? a.date < b.date
          ? -1
          : 1
        : a.startTime < b.startTime
          ? -1
          : a.startTime > b.startTime
            ? 1
            : 0,
    )
    .map((s) => {
      const [y, m, d] = s.date.slice(0, 10).split("-").map(Number);
      const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
      const dd = String(d).padStart(2, "0");
      const mm = String(m).padStart(2, "0");
      return `${weekday} ${dd}.${mm}. · ${s.startTime}–${s.endTime}`;
    });
}
