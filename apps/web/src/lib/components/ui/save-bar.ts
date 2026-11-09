// Issue #843 (D-843-01 block 7) - pure helpers of the SaveBar: the one place the German phrase of
// the bar and the "may the save button be pressed" rule live (docs/ADMIN_STRUCTURE.md §3.2.1).

/** Leading words of the summary; the bar says it is not saved yet. */
export const SAVE_BAR_PREFIX = "Nicht gespeichert";

/** "1 Änderung" / "2 Änderungen". */
export function changesPhrase(changes: number): string {
  return `${changes} ${changes === 1 ? "Änderung" : "Änderungen"}`;
}

/** "1 Fehler" / "3 Fehler" (the plural of Fehler is Fehler). */
export function errorsPhrase(errors: number): string {
  return `${errors} Fehler`;
}

/**
 * The summary line: "Nicht gespeichert · 2 Änderungen · 1 Fehler". The error part is left out
 * while there is no error.
 */
export function saveBarSummary(changes: number, errors: number): string {
  const parts = [SAVE_BAR_PREFIX, changesPhrase(changes)];
  if (errors > 0) parts.push(errorsPhrase(errors));
  return parts.join(" · ");
}

/** Saving is possible only with changes, without errors and while no save is running. */
export function canSave(state: { changes: number; errors: number; saving?: boolean }): boolean {
  return state.changes > 0 && state.errors === 0 && !state.saving;
}
