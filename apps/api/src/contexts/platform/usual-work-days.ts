/**
 * Phase 436 (D-02) — the ONE write-path validation rule for
 * `WorkSchedule.usualWorkDays`. Platform-internal only: not exported from
 * `contexts/platform/index.ts` (no Unterbau facade change needed — the write paths that call this
 * live inside the same context).
 *
 * Rules, in this order:
 *   1. every value must be an integer 0..6 (0=Sun..6=Sat, same convention as `workDays`);
 *   2. no value may repeat;
 *   3. a non-empty list is only accepted for `scheduleType === "SHIFT_BASED"`;
 *   4. for SHIFT_BASED, a non-empty list must have at least `contractWorkDaysPerWeek` entries.
 * An empty list is always valid — it means "keine Angabe" (D-01).
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
    return { ok: true, value: [] };
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
