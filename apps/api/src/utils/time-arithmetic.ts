/**
 * Phase 85.1 — Phorest Vor-/Nachbereitungszeit (D-01/D-02/D-05).
 *
 * Pure function — no I/O, no timezone-aware objects, no date-arithmetic library. Operates entirely
 * in "HH:mm" string / minutes-since-midnight space, mirroring the existing sync-shifts.ts
 * convention: never construct a timezone-aware object from a LocalTime — that would apply a TZ
 * offset and corrupt both the Shift time and the composite externalId
 * (apps/api/src/services/phorest/sync-shifts.ts:188-189).
 *
 * Clamps padded start/end to the SAME calendar day ([00:00, 23:59]) — never rolls onto the
 * previous/next date, which would corrupt the date-scoped externalId + reconcile logic (D-05).
 */

/** Parse "HH:mm" into total minutes since 00:00. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Format total minutes (clamped [0, 1439]) back to "HH:mm". */
function toHHMM(totalMinutes: number): string {
  const clamped = Math.max(0, Math.min(1439, totalMinutes));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Apply Vor-/Nachbereitungszeit padding to a raw "HH:mm" shift window, clamped to the same
 * calendar day (D-05) — start never goes before 00:00, end never goes past 23:59. Never mutates
 * its inputs; always returns a fresh object.
 */
export function applyPrepWrapup(
  rawStart: string,
  rawEnd: string,
  prepMinutes: number,
  wrapupMinutes: number,
): { startTime: string; endTime: string } {
  const startTime = toHHMM(toMinutes(rawStart) - prepMinutes);
  const endTime = toHHMM(toMinutes(rawEnd) + wrapupMinutes);
  return { startTime, endTime };
}
