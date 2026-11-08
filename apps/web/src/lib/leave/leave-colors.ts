/**
 * Issue #840 (D-840-12, AC-7) — the ONE mapping from an absence type to the colour pair it is drawn
 * with, and the only module of the web that names the `--leave-type-*` tokens (besides `tokens.css`
 * and the `.cal-abs-*` recipes of `app.css`, which cannot import a module).
 * `leave-colors-one-place-840.test.ts` fails on any other reader.
 *
 * Values are CSS custom-property NAMES (the caller wraps them in `var(...)`); the `-text` partner of
 * a fill is the colour that sits ON it and reaches WCAG AA (`leave-chip-contrast.test.ts`). A
 * `-text` token is a foreground only, never a background. The code union is imported as a TYPE only —
 * the vocabulary is never redeclared here (`absence-vocabulary-guard` G6/G7), and a type import adds
 * no runtime cycle with `team-calendar-visibility.ts`, which reads this module.
 */
import type { TimelinePerson, TimelineBar } from "./timeline-model";
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

/** The same neutral, for a colleague's request that is still pending (display of the absent chip). */
export const ABSENT_MUTED: LeaveColor = pair("--leave-type-absent-muted");

/**
 * A wish of the planner (not yet a request). It is drawn in the brand colour and never gets a
 * `--leave-type-*` token of its own: a wish is a plan, not a type.
 */
export const WISH: LeaveColor = { fill: "--brand", text: "--text-on-brand" };

/** The colour of a code the mapping does not know. */
export const FALLBACK: LeaveColor = pair("--leave-type-default");

/** The colour pair of a type code; `null` (no type) is the absent pair, an unknown code the default. */
export function leaveTypeColor(code: string | null): LeaveColor {
  if (code === null) return ABSENT;
  return (BY_CODE as Record<string, LeaveColor | undefined>)[code] ?? FALLBACK;
}

/** Every fill/text token name the mapping can return (the guard and the token test iterate it). */
export function allLeaveColorTokens(): string[] {
  const colors = [...Object.values(BY_CODE), ABSENT, ABSENT_MUTED, FALLBACK];
  return colors.flatMap((c) => [c.fill, c.text]);
}

const STYLE_ORDER: ReadonlyArray<TimelineBar["style"]> = [
  "gesetzt",
  "beantragt",
  "wunsch",
  "abwesend",
];

/**
 * What a legend has to name for the rows in view: the type codes of the set and requested bars (in
 * the order of the given code table, so the legend does not jump) and the bar styles that occur.
 * A masked bar has no type, a wish is a plan and not a type; neither adds a type entry.
 */
export function legendFrom(
  rows: readonly TimelinePerson[],
  codeOrder: readonly string[] = Object.keys(BY_CODE),
): {
  typeCodes: string[];
  styles: Array<TimelineBar["style"]>;
} {
  const codes = new Set<string>();
  const styles = new Set<TimelineBar["style"]>();
  for (const row of rows) {
    for (const bar of row.bars) {
      styles.add(bar.style);
      if ((bar.style === "gesetzt" || bar.style === "beantragt") && bar.typeCode !== null) {
        codes.add(bar.typeCode);
      }
    }
  }
  const ordered = codeOrder.filter((code) => codes.has(code));
  const unknown = [...codes].filter((code) => !codeOrder.includes(code)).sort();
  return {
    typeCodes: [...ordered, ...unknown],
    styles: STYLE_ORDER.filter((style) => styles.has(style)),
  };
}
