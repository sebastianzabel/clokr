/**
 * The one wording for a finding that is withheld from a reader (Issue #85 D-07 / D-12).
 *
 * A reader whose reach does not cover every entry a day-level finding rests on gets this neutral
 * hint instead of the finding: it names no category, no minute, no hour and no threshold on
 * purpose - any of those would reveal time worked outside the reader's reach (DSGVO Art. 5 Abs. 1
 * lit. c). A pure leaf module: it imports nothing, so the notification texts can share the wording
 * without pulling in the finding builders.
 */

/** `ArbZGWarning.code` of the neutral hint; a hint is never a violation, marker or notice. */
export const WITHHELD_FINDING_CODE = "FINDING_WITHHELD" as const;

/** The neutral hint text shown instead of a withheld finding. */
export const WITHHELD_FINDING_TEXT =
  "Für diesen Tag liegt ein Prüfhinweis vor; die Klärung erfolgt über den Stammsalon.";

/** The title of a notification that carries the neutral hint. */
export const WITHHELD_NOTICE_TITLE = "Prüfhinweis zu einem Arbeitstag";
