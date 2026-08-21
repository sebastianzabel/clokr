// Phase 103 — Rückwirkende Berufsschul-Musteränderungen: shared frontend types + pure
// helpers for the post-save confirm dialog. Pure, dependency-free module so the logic
// is unit-testable without mounting a component (see __tests__/retroactive.test.ts).
//
// Types live in a sibling .ts file rather than inside the .svelte module block, for
// the same reason as bs-pattern/types.ts: Svelte 5's ambient *.svelte module
// declaration only exposes the default export to tsc — named module-block exports
// work at runtime via Vite but aren't visible to tsc / IDE Go-To-Definition.

/**
 * One row of the preview/apply response's `details[]` array.
 *
 * Plan 04 widens `action` with `"removed"` and adds the corresponding new skip
 * reasons (`removalLocked`, `timeEntryConflict`) once the 3-step wizard needs them.
 * This type intentionally stays narrow for the tracer slice (creates + skips only).
 */
export interface RetroactiveDetail {
  employeeId: string;
  date: string;
  action: "created" | "skipped";
  reason?: string;
}

/** Mirrors the API's GeneratorResult shape plus the resolved window as ISO strings. */
export interface RetroactivePreview {
  created: number;
  skipped: {
    schoolHoliday: number;
    existing: number;
    locked: number;
    preHire: number;
    postExit: number;
    outOfWindow: number;
  };
  details: RetroactiveDetail[];
  windowStart: string | null;
  windowEnd: string | null;
}

/**
 * D-01 is about the backward range only — a purely-forward pattern change must not
 * open any dialog. True only when there is something worth showing the admin: at
 * least one day would be created, or at least one day is stuck behind a closed month
 * (D-04's "übersprungen und in der Vorschau getrennt ausgewiesen"). Plan 04 widens
 * this predicate to also cover removals and conflicts once those exist.
 */
export function shouldOfferRetroactiveRun(preview: RetroactivePreview): boolean {
  return preview.created > 0 || preview.skipped.locked > 0;
}

/**
 * "2026-08-12" → "12.08.2026". Plain string reformat of an already-resolved
 * YYYY-MM-DD date — deliberately NOT a `new Date(iso)` parse, which would introduce
 * the classic UTC-vs-local-timezone off-by-one for a date-only string.
 */
export function formatIsoDateDe(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${day}.${month}.${year}`;
}
