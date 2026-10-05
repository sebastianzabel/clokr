/**
 * Phase 436 (D-02) — the ONE write-path validation rule for
 * `WorkSchedule.usualWorkDays`. Platform-internal only: not exported from
 * `contexts/platform/index.ts` (no Unterbau facade change needed — the write paths that call this
 * live inside the same context).
 *
 * Rules, in this order:
 *   1. every value must be an integer 0..6 (0=Sun..6=Sat, same convention as `workDays`);
 *   2. no value may repeat;
 *   3. an empty list is valid only for non-SHIFT_BASED types (they carry no Angabe at all);
 *   4. a non-empty list is only accepted for `scheduleType === "SHIFT_BASED"`;
 *   5. for SHIFT_BASED, the list must have at least `contractWorkDaysPerWeek` entries.
 *
 * Issue #481 R5 (owner decision 2026-10-04): the Angabe is REQUIRED for SHIFT_BASED — an empty
 * list no longer means "keine Angabe" there, because leave pricing counts every requested Mo–Sa
 * date of a fragment week without it. This is an Unterbau-Semantikänderung (ADR 0002,
 * Entscheidung 7); the Nachtrag lives in docs/adr/0001-abweichungen.md. The rule applies to
 * writes only: existing rows with an empty Angabe are never backfilled or guessed from
 * `workDays`.
 */
export function validateUsualWorkDays(
  scheduleType: string,
  usualWorkDays: readonly number[],
  contractWorkDaysPerWeek: number,
): { ok: true; value: number[] } | { ok: false; error: string } {
  for (const v of usualWorkDays) {
    if (!Number.isInteger(v) || v < 0 || v > 6) {
      return { ok: false, error: "Ungültiger Wochentag bei den üblichen Arbeitstagen." };
    }
  }

  if (new Set(usualWorkDays).size !== usualWorkDays.length) {
    return {
      ok: false,
      error: "Jeder Wochentag darf bei den üblichen Arbeitstagen nur einmal vorkommen.",
    };
  }

  if (usualWorkDays.length === 0) {
    if (scheduleType !== "SHIFT_BASED") return { ok: true, value: [] };
    return {
      ok: false,
      error: `Bei Schichtbetrieb sind die üblichen Arbeitstage Pflicht – bitte mindestens ${contractWorkDaysPerWeek} Wochentage ankreuzen, so viele Arbeitstage hat der Vertrag pro Woche.`,
    };
  }

  if (scheduleType !== "SHIFT_BASED") {
    return { ok: false, error: "Übliche Arbeitstage gibt es nur bei Schichtbetrieb." };
  }

  if (usualWorkDays.length < contractWorkDaysPerWeek) {
    return {
      ok: false,
      error: `Es müssen mindestens ${contractWorkDaysPerWeek} übliche Arbeitstage angekreuzt sein – so viele Arbeitstage hat der Vertrag pro Woche.`,
    };
  }

  return { ok: true, value: [...usualWorkDays].sort((a, b) => a - b) };
}
