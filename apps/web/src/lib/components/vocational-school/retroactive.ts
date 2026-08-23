// Phase 103 — Rückwirkende Berufsschul-Musteränderungen: shared frontend types + pure
// helpers for the retroactive confirm flow. Pure, dependency-free module so the logic
// is unit-testable without mounting a component (see __tests__/retroactive.test.ts).
//
// Types live in a sibling .ts file rather than inside the .svelte module block, for
// the same reason as bs-pattern/types.ts: Svelte 5's ambient *.svelte module
// declaration only exposes the default export to tsc — named module-block exports
// work at runtime via Vite but aren't visible to tsc / IDE Go-To-Definition.
//
// Plan 04 (RetroactiveBSWizard) widens this module in place: every German sentence and
// every conflict/override rule the wizard needs lives here so the copy is verifiable
// without mounting anything — the .svelte component renders, it does not compute.

/** The reasons a day can be reported as skipped (create side) or unremoved (removal
 * side) by the backend generator. Mirrors GeneratorResult's `details[].reason` values
 * in `apps/api/src/utils/vocational-school-generator.ts` verbatim. */
export type RetroactiveReason =
  | "locked"
  | "existing"
  | "schoolHoliday"
  | "preHire"
  | "postExit"
  | "outOfWindow"
  | "removalLocked"
  | "timeEntryConflict";

/** One row of the preview/apply response's `details[]` array. */
export interface RetroactiveDetail {
  employeeId: string;
  date: string;
  action: "created" | "skipped" | "removed";
  reason?: RetroactiveReason;
}

/** Mirrors the API's GeneratorResult shape plus the resolved window as ISO strings. */
export interface RetroactivePreview {
  created: number;
  removed: number;
  skipped: {
    schoolHoliday: number;
    existing: number;
    locked: number;
    removalLocked: number;
    timeEntryConflict: number;
    preHire: number;
    postExit: number;
    outOfWindow: number;
  };
  details: RetroactiveDetail[];
  windowStart: string | null;
  windowEnd: string | null;
}

/** One conflict day as surfaced by step 2 of the wizard. Every day starts on `"skip"`
 * (D-07) — only an explicit user action ever flips a day to `"apply"`. */
export interface ConflictDay {
  date: string;
  weekdayLabel: string;
  disposition: "skip" | "apply";
}

/**
 * D-01 is about the backward range only — a purely-forward pattern change must not
 * open any dialog. True only when there is something worth showing the admin: at
 * least one day would be created or removed, or at least one day is stuck behind a
 * closed month or an existing TimeEntry. False when the preview is entirely inert.
 */
export function shouldOfferRetroactiveRun(preview: RetroactivePreview): boolean {
  return (
    preview.created > 0 ||
    preview.removed > 0 ||
    preview.skipped.locked > 0 ||
    preview.skipped.removalLocked > 0 ||
    preview.skipped.timeEntryConflict > 0
  );
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

const MONTH_NAMES_DE = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
];

// Index = `Date.UTC(...).getUTCDay()` (0 = Sunday .. 6 = Saturday).
const WEEKDAY_LABELS_DE = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

/**
 * D-02 step 1's headline: what changes, in one sentence, no day list. Singular/plural
 * handled independently for each half; a half whose count is 0 is dropped entirely.
 * When both halves are 0 (e.g. everything in the window is locked) the sentence still
 * names the date but carries no "0 Tage …" clause.
 */
export function buildRetroactiveSummary(p: RetroactivePreview): string {
  const datePart = `Ab ${formatIsoDateDe(p.windowStart ?? "")}:`;
  const clauses: string[] = [];
  if (p.removed > 0) {
    clauses.push(p.removed === 1 ? "1 Tag entfällt" : `${p.removed} Tage entfallen`);
  }
  if (p.created > 0) {
    clauses.push(p.created === 1 ? "1 Tag kommt hinzu" : `${p.created} Tage kommen hinzu`);
  }
  if (clauses.length === 0) {
    return `${datePart} keine Berufsschultage betroffen.`;
  }
  return `${datePart} ${clauses.join(", ")}.`;
}

/**
 * D-04's separate line naming closed months. Groups every `details[]` entry whose
 * `reason` is `"locked"` or `"removalLocked"` by calendar month (create-side and
 * removal-side locks counted together — the admin cares that the month is closed, not
 * which side of the diff hit the guard), renders German month names in chronological
 * order, and returns `null` when there are none so the component can omit the line.
 */
export function monthLabelsFromDetails(details: RetroactiveDetail[]): string | null {
  const relevant = details.filter((d) => d.reason === "locked" || d.reason === "removalLocked");
  if (relevant.length === 0) return null;

  const monthLabelByKey = new Map<string, string>();
  for (const d of relevant) {
    const [year, month] = d.date.split("-");
    const key = `${year}-${month}`;
    if (!monthLabelByKey.has(key)) {
      monthLabelByKey.set(key, MONTH_NAMES_DE[Number(month) - 1]);
    }
  }
  const monthLabels = Array.from(monthLabelByKey.keys())
    .sort()
    .map((key) => monthLabelByKey.get(key)!);

  const monthsText = monthLabels.join(", ");
  const verb = monthLabels.length === 1 ? "ist" : "sind";
  const dayCount = relevant.length;
  const dayClause = dayCount === 1 ? "1 Tag bleibt" : `${dayCount} Tage bleiben`;
  return `${monthsText} ${verb} abgeschlossen — ${dayClause} unverändert.`;
}

/**
 * D-05's list of conflict days for step 2, every entry starting at
 * `disposition: "skip"` (D-07) — only an explicit bulk or per-day action ever flips a
 * day to `"apply"`.
 */
export function conflictDaysFromPreview(p: RetroactivePreview): ConflictDay[] {
  return p.details
    .filter((d) => d.reason === "timeEntryConflict")
    .map((d) => ({
      date: d.date,
      weekdayLabel: WEEKDAY_LABELS_DE[new Date(`${d.date}T00:00:00.000Z`).getUTCDay()],
      disposition: "skip" as const,
    }));
}

/** True iff there is at least one conflict day — this is what makes step 2 appear or
 * vanish (D-02: two clicks in the clean case). */
export function hasConflicts(p: RetroactivePreview): boolean {
  return conflictDaysFromPreview(p).length > 0;
}

/**
 * The single place a per-day disposition becomes a wire value: only dates explicitly
 * flipped to `"apply"` are returned, in list order. Posted verbatim as
 * `retroactive-apply`'s `overrideDates` body field (D-06/D-07/T-103-OVERRIDE).
 */
export function effectiveOverrideDates(days: ConflictDay[]): string[] {
  return days.filter((d) => d.disposition === "apply").map((d) => d.date);
}

/**
 * The post-apply line (D-01: show the SERVER's real result, never a synthesised
 * success message). Names created, removed, unchanged-because-closed (locked +
 * removalLocked combined — the admin cares that the month closed, not which side of
 * the diff hit the guard) and skipped-because-recorded-time, omitting any clause whose
 * count is 0.
 */
export function buildApplyResultText(r: RetroactivePreview): string {
  const clauses: string[] = [];
  if (r.created > 0) {
    clauses.push(r.created === 1 ? "1 Tag angelegt" : `${r.created} Tage angelegt`);
  }
  if (r.removed > 0) {
    clauses.push(r.removed === 1 ? "1 Tag entfernt" : `${r.removed} Tage entfernt`);
  }
  const lockedTotal = r.skipped.locked + r.skipped.removalLocked;
  if (lockedTotal > 0) {
    clauses.push(
      lockedTotal === 1
        ? "1 Tag unverändert (abgeschlossen)"
        : `${lockedTotal} Tage unverändert (abgeschlossen)`,
    );
  }
  if (r.skipped.timeEntryConflict > 0) {
    clauses.push(
      r.skipped.timeEntryConflict === 1
        ? "1 Tag übersprungen (bereits erfasste Zeit)"
        : `${r.skipped.timeEntryConflict} Tage übersprungen (bereits erfasste Zeit)`,
    );
  }
  if (clauses.length === 0) {
    return "Keine Änderungen — nichts zu tun.";
  }
  return `${clauses.join(", ")}.`;
}
