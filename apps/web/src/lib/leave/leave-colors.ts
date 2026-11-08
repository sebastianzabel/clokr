/**
 * Issue #840 (D-840-12) — the ONE mapping from an absence type to the colour pair a timeline bar
 * is drawn with. Seed of the plan 840-02 tracer; 840-06 completes it and turns it into the only
 * reader of the `--leave-type-*` tokens.
 *
 * Values are CSS custom-property NAMES (the caller wraps them in `var(...)`), copied from
 * `LEAVE_TYPES[].colorVar` in `team-calendar-visibility.ts`; `timeline-model.test.ts` pins the two
 * tables equal. The code union is imported as a TYPE only — the vocabulary is never redeclared
 * here (`absence-vocabulary-guard` G6/G7).
 */
import type { CalendarTypeCode } from "./team-calendar-visibility";

export interface LeaveColor {
  /** Custom-property name of the fill, e.g. `--leave-type-vacation`. */
  fill: string;
  /** Custom-property name of the text colour that sits on the fill (the fill name + `-text`). */
  text: string;
}

const pair = (fill: string): LeaveColor => ({ fill, text: `${fill}-text` });

const BY_CODE: Record<CalendarTypeCode, LeaveColor> = {
  VACATION: pair("--leave-type-vacation"),
  OVERTIME_COMP: pair("--leave-type-overtime"),
  SPECIAL: pair("--leave-type-special"),
  UNPAID: pair("--leave-type-unpaid"),
  SICK: pair("--leave-type-sick"),
  SICK_CHILD: pair("--leave-type-sick-child"),
  EDUCATION: pair("--leave-type-education"),
  HOLIDAY: pair("--leave-type-holiday"),
  MATERNITY: pair("--leave-type-maternity"),
  PARENTAL: pair("--leave-type-parental"),
};

/** A bar whose type the reader may not learn (and an imposed absence without a requestable type). */
export const ABSENT: LeaveColor = pair("--leave-type-absent");

/** A wish of the planner (not yet a request); seed, the planner switches to it in 840-06. */
export const WISH: LeaveColor = pair("--leave-type-default");

const FALLBACK: LeaveColor = pair("--leave-type-default");

/** The colour pair of a type code; `null` (no type) is the absent pair, an unknown code the default. */
export function leaveTypeColor(code: string | null): LeaveColor {
  if (code === null) return ABSENT;
  return (BY_CODE as Record<string, LeaveColor | undefined>)[code] ?? FALLBACK;
}
