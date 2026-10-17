/**
 * Issue #617 (AC-617-2) - the seven vacation columns of the Urlaubsuebersicht on `/reports`, in the
 * order and wording of section "Urlaubsjahr" of the Monatsexport. Display mirror of
 * `VACATION_YEAR_COLUMN_LABELS` in `apps/api/src/composition/pdf.ts`: the page and the export are
 * labelled alike, and `__tests__/vacation-columns-617.test.ts` fails when the two drift apart. The
 * labels are text only - no figure and no rule lives here.
 */
export const VACATION_YEAR_COLUMNS = [
  "Anspruch",
  "Übertrag (wirksam)",
  "Verfügbar",
  "Genommen",
  "Genehmigt",
  "Beantragt",
  "Resturlaub",
] as const;
