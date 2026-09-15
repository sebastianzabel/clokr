import type { LeaveTypeCode } from "@clokr/db";

/**
 * Phase 97 lineage (T2, D-04): the ONE and only Code -> German-display-name mapping for
 * absence types, mirroring `invalid-reason.ts` from Phase 96.
 *
 * Before this module the nine names lived hand-copied in six places across the leave route, the
 * reports route, three helpers under `utils/` and one short-lived module that phase 97 deletes
 * outright. The two sickness names existed five times independently, the vacation name in four
 * different comparison forms. (The deleted module is deliberately not named here: plan 08 asserts
 * repo-wide that no reference to its path survives, and a docblock counts as a reference.)
 *
 * The identity of an absence type is `LeaveType.code`. `LeaveType.name` is display text a
 * tenant may rename freely (AC-2) — never compare against it, never derive behaviour from it.
 */

/**
 * The nine codes a `LeaveRequest` can carry — the REQUEST side of the vocabulary. Content and
 * order are unchanged from the pre-Phase-98b tuple this renames; the order is stable and
 * load-bearing for the leave-type dropdown order in the API's Zod schema.
 *
 * Renamed, not widened, on purpose (Phase 98b, D-01). Phase 98b grows the Prisma `LeaveTypeCode`
 * enum to eleven members by adding the two IMPOSED codes. This tuple is imported by
 * `routes/leave.ts` as `TYPE_CODES` and fed directly into `z.enum()` at both request-body
 * validation sites — widening it would mean a client could submit an imposed code as a
 * `LeaveRequest.type` with no compile error and no red test. A rename breaks every import site
 * until a human looks at it; a widened definition under the old name breaks nothing and changes
 * everything.
 */
export const REQUESTABLE_CODES = [
  "VACATION",
  "OVERTIME_COMP",
  "SPECIAL",
  "UNPAID",
  "SICK",
  "SICK_CHILD",
  "EDUCATION",
  "MATERNITY",
  "PARENTAL",
] as const satisfies readonly LeaveTypeCode[];

/** A code that a `LeaveRequest` may carry. Today identical to `LeaveTypeCode`; from the Phase-98b
 *  schema change onward a strict subset of it. */
export type RequestableCode = (typeof REQUESTABLE_CODES)[number];

/**
 * Code -> display name, the two policy flags a newly created row is seeded with, and the two
 * notification-copy fields added for Issue #200:
 *
 * - `notificationTitle` — the notification headline, a complete noun phrase (e.g. the SICK
 *   entry's headline below). Used for the IN-APP notification title only — it does NOT reach the
 *   email subject; see `LEAVE_REQUEST_EMAIL_SUBJECT` below for that.
 * - `requestPhrase` — a verb phrase completing the sentence
 *   `{firstName} {lastName} {requestPhrase} ({period})`.
 *
 * Both are DISPLAY TEXT ONLY (ADR 0001) and must never become control values — no `===`, no
 * `.includes()`, no `switch`, ever.
 *
 * MATERNITY and PARENTAL are deliberately worded as a Meldung ("angemeldet"/"-Meldung"), never
 * as an Antrag ("beantragt"/"-antrag"): the issue states these are reported, not applied for.
 *
 * `isPaid` and `requiresApproval` exist only as columns of a `LeaveType` row, which an imposed
 * absence never has — that is why this table is keyed by `RequestableCode` and not by the full
 * `LeaveTypeCode` (D-01).
 */
export const LEAVE_TYPE_DEFS: Record<
  RequestableCode,
  {
    name: string;
    isPaid: boolean;
    requiresApproval: boolean;
    notificationTitle: string;
    requestPhrase: string;
  }
> = {
  VACATION: {
    name: "Urlaub",
    isPaid: true,
    requiresApproval: true,
    notificationTitle: "Neuer Urlaubsantrag",
    requestPhrase: "hat Urlaub beantragt",
  },
  OVERTIME_COMP: {
    name: "Überstundenausgleich",
    isPaid: true,
    requiresApproval: true,
    notificationTitle: "Neuer Antrag auf Überstundenausgleich",
    requestPhrase: "hat Überstundenausgleich beantragt",
  },
  SPECIAL: {
    name: "Sonderurlaub",
    isPaid: true,
    requiresApproval: true,
    notificationTitle: "Neuer Sonderurlaubsantrag",
    requestPhrase: "hat Sonderurlaub beantragt",
  },
  UNPAID: {
    name: "Unbezahlter Urlaub",
    isPaid: false,
    requiresApproval: true,
    notificationTitle: "Neuer Antrag auf unbezahlten Urlaub",
    requestPhrase: "hat unbezahlten Urlaub beantragt",
  },
  SICK: {
    name: "Krankmeldung",
    isPaid: true,
    requiresApproval: false,
    notificationTitle: "Neue Krankmeldung",
    requestPhrase: "hat sich krankgemeldet",
  },
  SICK_CHILD: {
    name: "Kinderkrank",
    isPaid: true,
    requiresApproval: false,
    notificationTitle: "Neue Kinderkrankmeldung",
    requestPhrase: "hat Kinderkrank gemeldet",
  },
  EDUCATION: {
    name: "Bildungsurlaub",
    isPaid: true,
    requiresApproval: true,
    notificationTitle: "Neuer Bildungsurlaubsantrag",
    requestPhrase: "hat Bildungsurlaub beantragt",
  },
  MATERNITY: {
    name: "Mutterschutz",
    isPaid: true,
    requiresApproval: false,
    notificationTitle: "Neue Mutterschutz-Meldung",
    requestPhrase: "hat Mutterschutz angemeldet",
  },
  PARENTAL: {
    name: "Elternzeit",
    isPaid: false,
    requiresApproval: true,
    notificationTitle: "Neue Elternzeit-Meldung",
    requestPhrase: "hat Elternzeit angemeldet",
  },
};

/**
 * The neutral email subject for a leave-request notification, uniform across all nine types
 * (Issue #200, owner decision 2026-09-15). `notify.ts` appends the brand suffix itself — do not
 * append it here.
 *
 * The in-app notification title above is type-specific; the mail subject deliberately is not.
 * Using the SICK entry's type-specific title as the mail subject would put Art.-9 GDPR
 * health-category data into an email SUBJECT line, which travels further than a body (inbox
 * list views, lock-screen push previews, mail-server logs). It covers ALL NINE types, not only
 * the sickness ones, because a per-type exception list would itself leak by omission — a
 * neutral subject on every leave notification reveals nothing, whereas "neutral only when it's
 * sickness" tells the reader it is sickness.
 */
export const LEAVE_REQUEST_EMAIL_SUBJECT = "Neue Abwesenheitsmeldung";

/**
 * Names written by seed scripts that predate the canonical set. Exactly two consumers are
 * permitted: the backfill/sweep script, and the one-time self-heal step in `ensureLeaveType()`
 * that gives a pre-phase-97 row its code once. No request handler, no report and no scheduler
 * may resolve a type through this list on the normal path.
 */
export const LEAVE_TYPE_LEGACY_ALIASES: Partial<Record<RequestableCode, readonly string[]>> = {
  VACATION: ["Jahresurlaub", "Urlaub (Jahresurlaub)"],
};

/**
 * Prisma `data:` fragment for a new LeaveType row. The return type requires `code` and `name`
 * together, so no caller can create a row with one and not the other — the same structural
 * pairing `invalidReasonFields()` enforces in Phase 96.
 *
 * The parameter is `RequestableCode`, not `LeaveTypeCode`: this function builds a `LeaveType`
 * row, and "Berufsschule beantragen" is factually wrong — the restriction is now a compile
 * error rather than a convention (D-01).
 */
export function leaveTypeFields(code: RequestableCode): {
  code: RequestableCode;
  name: string;
  isPaid: boolean;
  requiresApproval: boolean;
} {
  const def = LEAVE_TYPE_DEFS[code];
  return { code, name: def.name, isPaid: def.isPaid, requiresApproval: def.requiresApproval };
}

/**
 * The name -> code direction. **Backfill and one-time self-heal only.**
 *
 * This is the only function in the codebase that may derive identity from a display name, and
 * it exists exclusively to give a pre-Phase-97 row its code exactly once. No request handler,
 * no report, no scheduler may call it. Returns `null` for an unknown name deliberately: the
 * vocabulary is closed, there is no catch-all code, and there is no silent default to the
 * vacation code either (D-09) — an unmappable name is a data defect that must stay visible
 * rather than be absorbed.
 *
 * The comparison is EXACT: not case-insensitive and not a substring match. Matching a substring
 * of the display name is precisely the defect this phase removes — it classifies the
 * further-education leave type as vacation, because its German name ends in the same word
 * (D-11).
 */
export function leaveTypeCodeForName(name: string): RequestableCode | null {
  for (const code of REQUESTABLE_CODES) {
    if (LEAVE_TYPE_DEFS[code].name === name) return code;
  }
  for (const code of REQUESTABLE_CODES) {
    if ((LEAVE_TYPE_LEGACY_ALIASES[code] ?? []).includes(name)) return code;
  }
  return null;
}

/** The two sickness codes. Replaces five independent copies of ["Krankmeldung", "Kinderkrank"]. */
export const SICK_LEAVE_TYPE_CODES = [
  "SICK",
  "SICK_CHILD",
] as const satisfies readonly LeaveTypeCode[];

/** True when the code is one of the two sickness types. Null/undefined is NOT sick. */
export function isSickLeaveTypeCode(code: LeaveTypeCode | null | undefined): boolean {
  return code === "SICK" || code === "SICK_CHILD";
}
