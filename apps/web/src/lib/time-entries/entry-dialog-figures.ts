/**
 * Issue #943 — the figures of the entry dialog equal the list's for an unchanged entry.
 *
 * The list reads the stored `breakMinutes` of an entry (the sum of its Break rows, or a legacy flat
 * amount without rows). The dialog edits break SLOTS, so an entry that only carries the legacy
 * amount opens with no slot. The dialog must still count that amount until the person converts it
 * to slots or adds a slot of their own; otherwise the net working time, and the break sent to the
 * server's day check (`POST /day-breaks/preview`), would say 0 and contradict the list.
 *
 * This only decides which break amount the dialog DISPLAYS and sends to the PREVIEW. It evaluates
 * no ArbZG rule (findings come from the server only) and the save payload is built elsewhere.
 */

/** Minutes of one "HH:MM"–"HH:MM" slot; an incomplete or inverted slot counts 0. */
export function slotMinutes(start: string, end: string): number {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const diff = eh * 60 + em - (sh * 60 + sm);
  return diff > 0 ? diff : 0;
}

export interface DialogBreakInput {
  /** The slots currently in the form. */
  slots: { start: string; end: string }[];
  /** The edited entry's Break rows (empty or absent: none stored). */
  storedBreakRowCount: number;
  /** The edited entry's stored `breakMinutes` (legacy flat amount when there are no rows). */
  storedBreakMinutes: number;
}

/** True while the form shows a legacy flat break: stored minutes, no rows, no slot in the form. */
export function usesLegacyBreak(input: DialogBreakInput): boolean {
  return (
    input.storedBreakRowCount === 0 && input.storedBreakMinutes > 0 && input.slots.length === 0
  );
}

/** The break minutes the dialog counts: the slots' sum, or the legacy flat amount. */
export function dialogBreakMinutes(input: DialogBreakInput): number {
  if (usesLegacyBreak(input)) return input.storedBreakMinutes;
  return input.slots.reduce((sum, s) => sum + slotMinutes(s.start, s.end), 0);
}

/** Working time of the proposed entry in minutes, or null while it has no end. */
export function dialogNetMinutes(
  start: string,
  end: string,
  hasEnd: boolean,
  breakMinutes: number,
): number | null {
  if (!hasEnd || !start || !end) return null;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const gross = eh * 60 + em - (sh * 60 + sm);
  if (gross <= 0) return 0;
  return Math.max(0, gross - breakMinutes);
}

/**
 * The break fields of a save (POST/PUT /time-entries). A stored legacy flat break the person did not
 * touch (no Break rows, no slot added) is sent back unchanged, so a save never drops it (Issue #943);
 * once a slot exists the slots' sum is sent, as before.
 */
export function breakWriteFields<B>(
  input: DialogBreakInput,
  breaksPayload: B[],
): { breakMinutes: number; breaks: B[] } {
  return { breakMinutes: dialogBreakMinutes(input), breaks: breaksPayload };
}
