/**
 * Issue #835 (D-835-06/07/08) — the control codes, German texts and the audit marker of the leave
 * planner (Urlaubsplaner). Pure: no runtime import, so the cycle gate sees a leaf.
 *
 * A code is the control value of a refusal, the German text is display only (CLAUDE.md "Never use
 * a new display string as a control value"). The web branches on `code`, never on the message.
 *
 * Deliberately NOT re-exported from `contexts/absence/index.ts` (import-cycle cap 22); importer:
 * `contexts/absence/api/leave-plans.ts` and the sibling files of this directory.
 */

/** Value of `newValue.trigger` on the CREATE audit of a request created by the takeover. */
export const LEAVE_PLAN_TRIGGER = "LEAVE_PLAN";

/** The plan is TAKEN_OVER: every write is refused (409). */
export const LEAVE_PLAN_CLOSED = "LEAVE_PLAN_CLOSED";
/** An OPEN plan of the salon and year exists already (409). */
export const LEAVE_PLAN_ALREADY_OPEN = "LEAVE_PLAN_ALREADY_OPEN";
/** The wish overlaps a blocking request or another wish of the person (409). */
export const LEAVE_PLAN_WISH_OVERLAP = "LEAVE_PLAN_WISH_OVERLAP";
/** The wish does not lie completely inside the plan year (400). */
export const LEAVE_PLAN_WISH_OUTSIDE_YEAR = "LEAVE_PLAN_WISH_OUTSIDE_YEAR";
/** A half day is only valid for a single day (400). */
export const LEAVE_PLAN_WISH_HALF_DAY_RANGE = "LEAVE_PLAN_WISH_HALF_DAY_RANGE";
/** The person is homed in the plan's salon on no day of the wish (400). */
export const LEAVE_PLAN_WISH_NOT_HOMED = "LEAVE_PLAN_WISH_NOT_HOMED";
/** The wish does not lie completely inside the person's employment (400). */
export const LEAVE_PLAN_WISH_NOT_EMPLOYED = "LEAVE_PLAN_WISH_NOT_EMPLOYED";
/** A takeover refusal stored on the wish: no day of the wish is in the plan's salon any more. */
export const LEAVE_PLAN_WISH_NOT_IN_SALON = "LEAVE_PLAN_WISH_NOT_IN_SALON";
/** The wish is taken over already (409). */
export const LEAVE_PLAN_WISH_TAKEN_OVER = "LEAVE_PLAN_WISH_TAKEN_OVER";
/** The tenant locks own changes after the deadline and the deadline has passed (409). */
export const LEAVE_PLAN_DEADLINE_PASSED = "LEAVE_PLAN_DEADLINE_PASSED";

/** A stored approval-step refusal of a wish is `APPROVAL_<DecisionRefusalReason>`. */
export const APPROVAL_REFUSAL_PREFIX = "APPROVAL_";

/** German display texts (du-form) per code. An overlap with a request uses `LEAVE_OVERLAP_ERROR`. */
export const LEAVE_PLAN_MESSAGES: Record<string, string> = {
  [LEAVE_PLAN_CLOSED]: "Die Urlaubsplanung ist abgeschlossen und kann nicht mehr geändert werden.",
  [LEAVE_PLAN_ALREADY_OPEN]:
    "Für diesen Salon und dieses Jahr ist bereits eine Urlaubsplanung offen.",
  [LEAVE_PLAN_WISH_OUTSIDE_YEAR]: "Der Wunsch muss vollständig im Planungsjahr liegen.",
  [LEAVE_PLAN_WISH_HALF_DAY_RANGE]: "Ein halber Tag geht nur bei einem einzelnen Tag.",
  [LEAVE_PLAN_WISH_NOT_HOMED]: "Die Person gehört an keinem Tag des Wunsches zu diesem Salon.",
  [LEAVE_PLAN_WISH_NOT_EMPLOYED]: "Der Wunsch liegt nicht vollständig in der Beschäftigungszeit.",
  [LEAVE_PLAN_WISH_NOT_IN_SALON]:
    "Die Person gehört an keinem Tag des Wunsches mehr zu diesem Salon.",
  [LEAVE_PLAN_WISH_TAKEN_OVER]: "Dieser Wunsch ist bereits übernommen.",
  [LEAVE_PLAN_DEADLINE_PASSED]: "Die Frist für eigene Änderungen ist abgelaufen.",
};

/** Text of an overlap with another wish of the same person (an overlap with a request: `LEAVE_OVERLAP_ERROR`). */
export const LEAVE_PLAN_WISH_OVERLAP_WISH_MESSAGE =
  "Überschneidung mit einem anderen Urlaubswunsch";

/** The one 404 text of an unknown, foreign, removed or unreadable plan (the route freezes the body). */
export const PLAN_NOT_FOUND_ERROR = "Urlaubsplanung nicht gefunden";
