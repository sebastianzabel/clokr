/**
 * The ONE visibility decision behind an absence bar in the team calendar.
 *
 * Phase 257 (GitHub issue #257, D-10): routes/(app)/team/leave/+page.svelte held THREE
 * independent copies of the same `isOwn`-only check for a single visual element — the bar's
 * background (typeColor), its `title` attribute and its label span. Fixing only one of them
 * produces a coloured bar reading "abwesend", or a grey bar reading "Krankmeldung". This module
 * is the single decision all three now read from.
 *
 * It lives here rather than in the page because it is pure logic AND because it would otherwise
 * be untestable: apps/web/vitest.config.ts registers no `$app/*` alias, so a route file that
 * imports `$app/stores` cannot be mounted in a test.
 *
 * The rule (D-01/D-02): MANAGER and ADMIN see the absence type — they approve the requests and
 * the "Anträge" table on the same page already prints it in full. A colleague's type is withheld
 * from an EMPLOYEE, because "Krank" next to a name is health data (Art. 9 DSGVO). The API
 * already enforces the same rule server-side (GET /leave/calendar,
 * apps/api/src/contexts/absence/api/leave.ts:2250-2258, `showDetails = isOwn || isManager`);
 * this module is the display half of it, not its only line of defence.
 */

/** Every leave-type code the team calendar can paint. Mirrors the `TypeCode` union that used to
 *  be declared inline in the route file. */
export type LeaveTypeCode =
  | "VACATION"
  | "OVERTIME_COMP"
  | "SPECIAL"
  | "UNPAID"
  | "SICK"
  | "SICK_CHILD"
  | "EDUCATION"
  | "HOLIDAY"
  | "MATERNITY"
  | "PARENTAL";

export interface LeaveTypeEntry {
  code: LeaveTypeCode;
  /** German display label. Display only — never a control value (CLAUDE.md § Context Boundaries). */
  label: string;
  /** v1.5 fill token in apps/web/src/tokens.css. The matching foreground token is this name
   *  plus the `-text` suffix — see `typeTextColor()`. */
  colorVar: string;
  /** `false` for a code that exists as data but is never a request type. HOLIDAY comes from the
   *  holiday calendar, not from a form, so it must stay out of the request-type dropdowns and out
   *  of the leave legend (the legend shows Feiertag through its own `.legend-holiday-dot`). */
  requestable: boolean;
}

/** Order is load-bearing: `LEAVE_TYPE_OPTIONS` derives from this array and drives three
 *  request-type <select> dropdowns on the team leave page. */
export const LEAVE_TYPES: readonly LeaveTypeEntry[] = [
  { code: "VACATION", label: "Urlaub", colorVar: "--leave-type-vacation", requestable: true },
  {
    code: "OVERTIME_COMP",
    label: "Überstundenausgleich",
    colorVar: "--leave-type-overtime",
    requestable: true,
  },
  { code: "SPECIAL", label: "Sonderurlaub", colorVar: "--leave-type-special", requestable: true },
  {
    code: "EDUCATION",
    label: "Bildungsurlaub",
    colorVar: "--leave-type-education",
    requestable: true,
  },
  { code: "SICK", label: "Krankmeldung", colorVar: "--leave-type-sick", requestable: true },
  {
    code: "SICK_CHILD",
    label: "Kinderkrank",
    colorVar: "--leave-type-sick-child",
    requestable: true,
  },
  {
    code: "UNPAID",
    label: "Unbezahlter Urlaub",
    colorVar: "--leave-type-unpaid",
    requestable: true,
  },
  {
    code: "MATERNITY",
    label: "Mutterschutz",
    colorVar: "--leave-type-maternity",
    requestable: true,
  },
  { code: "PARENTAL", label: "Elternzeit", colorVar: "--leave-type-parental", requestable: true },
  { code: "HOLIDAY", label: "Feiertag", colorVar: "--leave-type-holiday", requestable: false },
];

/** The nine requestable types, in form order. Replaces the page's former `TYPE_OPTIONS`. */
export const LEAVE_TYPE_OPTIONS: readonly LeaveTypeEntry[] = LEAVE_TYPES.filter(
  (t) => t.requestable,
);

/** Fill tokens that are not leave-type codes. */
const NEUTRAL_APPROVED_VAR = "--leave-type-absent";
const NEUTRAL_PENDING_VAR = "--leave-type-absent-muted";
const FALLBACK_VAR = "--leave-type-default";

/** The neutral word an EMPLOYEE sees on a colleague's bar. German, user-facing. */
export const NEUTRAL_CHIP_LABEL = "abwesend";

function entryFor(code: LeaveTypeCode): LeaveTypeEntry | undefined {
  return LEAVE_TYPES.find((t) => t.code === code);
}

/** `var(--x)` for the bar background. */
function background(colorVar: string): string {
  return `var(${colorVar})`;
}

/** `var(--x-text, #ffffff)` for the bar text. The `#ffffff` fallback is today's hardcoded
 *  `.cal-chip { color: white }` — it keeps rendering unchanged until Plan 257-03 declares the
 *  foreground tokens, so no intermediate state is broken. */
function textColor(colorVar: string): string {
  return `var(${colorVar}-text, #ffffff)`;
}

/**
 * May this viewer learn the absence TYPE of this entry?
 *
 * The role comparison is exact and case-sensitive on purpose — the JWT carries the Prisma `Role`
 * enum verbatim (`ADMIN` | `MANAGER` | `EMPLOYEE`, packages/db/prisma/schema.prisma). A relaxed
 * comparison would let an unexpected value through on the permissive side, which is the side
 * that leaks.
 */
export function canSeeLeaveType(isOwn: boolean, role: string | null | undefined): boolean {
  return isOwn === true || role === "MANAGER" || role === "ADMIN";
}

export interface ChipVisual {
  /** CSS value for `style:background`. */
  background: string;
  /** CSS value for `style:color`. WCAG AA against `background` once Plan 257-03 lands. */
  textColor: string;
  /** The absence type for the tooltip, or `null` when this viewer must not learn it. */
  typeLabel: string | null;
  /** What the bar prints: the type when visible, the neutral word otherwise. */
  chipLabel: string;
}

/** The subset of `CalEntry` this decision needs. */
export interface ChipEntry {
  typeCode: LeaveTypeCode | null;
  typeName: string | null;
  status: string;
  isOwn: boolean;
}

/**
 * Background, text colour, tooltip type and bar label — derived together, from one decision, so
 * they cannot drift apart (D-10). Call this ONCE per bar.
 */
export function resolveChipVisual(entry: ChipEntry, role: string | null | undefined): ChipVisual {
  const type = entry.typeCode ? entryFor(entry.typeCode) : undefined;

  if (!canSeeLeaveType(entry.isOwn, role) || !entry.typeCode) {
    const neutralVar = entry.status === "APPROVED" ? NEUTRAL_APPROVED_VAR : NEUTRAL_PENDING_VAR;
    return {
      background: background(neutralVar),
      textColor: textColor(neutralVar),
      typeLabel: null,
      chipLabel: NEUTRAL_CHIP_LABEL,
    };
  }

  const label = entry.typeName ?? type?.label ?? entry.typeCode;
  const colorVar = type?.colorVar ?? FALLBACK_VAR;
  return {
    background: background(colorVar),
    textColor: textColor(colorVar),
    typeLabel: label,
    chipLabel: label,
  };
}
