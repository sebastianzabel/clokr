import type { AbsenceType, LeaveTypeCode } from "@clokr/db";

/**
 * Phase 98 (T3, Option D) — the ONE written source for which `AbsenceType` value corresponds to
 * which `LeaveTypeCode`, and, just as explicitly, which values have no counterpart on the other
 * side. The counterpart of `leave-type.ts` (Phase 97, T2): that module is the Code<->name
 * mapping within `LeaveTypeCode`; this module is the Code<->Code mapping BETWEEN the two
 * vocabularies.
 *
 * This module implements Option D from `98-RESEARCH.md` — the language only. It maps between two
 * vocabularies that still exist SEPARATELY: `AbsenceType` (the Prisma enum backing `Absence.type`)
 * and `LeaveTypeCode` (the Prisma enum backing `LeaveType.code`, wrapped by `leave-type.ts`).
 * Option A — one enum, `Absence.type : LeaveTypeCode` — is a deliberate FOLLOW-UP phase. Do not
 * read this module as a claim that the two enums were merged; they were not, and no schema file
 * is touched by writing this module down.
 *
 * This module must NOT grow a display-label table. Absence display labels live where they live
 * today (`presence.ts`'s `ABSENCE_LABELS`, the two iCal ternary chains in `routes/leave.ts`) —
 * giving this module labels would create a SECOND display vocabulary competing with
 * `LEAVE_TYPE_DEFS`, and would pull the Option A display refactor into Option D's scope. If you
 * are about to add a `name` or `label` field here: don't — that is Option A's job, not this
 * module's.
 *
 * ADR 0001 rule 5, "no generalization on spec": two `Record`s and two accessors below. No
 * registry, no extension mechanism, no generic bidirectional-map builder.
 */

/** All eight `AbsenceType` values as a tuple, in schema order (`schema.prisma`'s `enum
 *  AbsenceType` block). Mirrors `LEAVE_TYPE_CODES`'s shape in `leave-type.ts`. */
export const ABSENCE_TYPES = [
  "SICK",
  "SICK_CHILD",
  "SPECIAL_LEAVE",
  "UNPAID_LEAVE",
  "MATERNITY",
  "PARENTAL",
  "OTHER",
  "VOCATIONAL_SCHOOL",
] as const satisfies readonly AbsenceType[];

/**
 * An `AbsenceType`'s relationship to the `LeaveTypeCode` vocabulary: either it corresponds to a
 * specific code, or it does not — and if it does not, `why` says so in a full sentence, not a
 * placeholder. A discriminated union rather than `LeaveTypeCode | null`: `null` can only say
 * "nothing here", never WHY, and a reader could not tell a deliberate non-correspondence from a
 * forgotten entry. The union forces every one of the eight entries to carry either a counterpart
 * or a written reason.
 */
export type AbsenceCorrespondence =
  | { readonly kind: "corresponds"; readonly code: LeaveTypeCode }
  | { readonly kind: "absence_only"; readonly why: string };

/**
 * The `AbsenceType` -> `LeaveTypeCode` direction, all eight entries.
 *
 * Six correspondences:
 * - `SICK` <-> `SICK`, `SICK_CHILD` <-> `SICK_CHILD`, `MATERNITY` <-> `MATERNITY`,
 *   `PARENTAL` <-> `PARENTAL` — same spelling on both sides.
 * - `SPECIAL_LEAVE` <-> `SPECIAL`, `UNPAID_LEAVE` <-> `UNPAID` — the same thing, spelled
 *   differently. This pair is the reason this module exists: the correspondence was correct but
 *   unwritten and untested before this plan.
 *
 * Two absence-only values, each with its reason:
 * - `VOCATIONAL_SCHOOL` — Berufsschule (BBiG § 15/§ 17). Imposed by the training contract, never
 *   requested; it is the only `AbsenceType` the saldo calculation branches on
 *   (`close-employee-month.ts` credits it but excludes it from the day-dedup, then re-adds the
 *   precise § 15 slot credit — see `98-RESEARCH.md` §5.1). There is deliberately no leave
 *   counterpart: "Berufsschule beantragen" is factually wrong.
 * - `OTHER` — has NO writer anywhere in production code, which makes it look like a dead enum
 *   value. It is not. `98-RESEARCH.md` §2.6 measured 15 production rows: hand-inserted
 *   pre-tracking bridge rows (note text: time tracking was not yet active), `startDate`
 *   2026-01-01 through 2026-05-26, across 13 employees, neutralising five months of Soll.
 *   `days = 0.00` on all of them is misleading — the Soll credit comes from the DATE RANGE, not
 *   from `days` (`calcLeaveAbsenceMinutesTz()` in `timezone.ts` never reads `days`). Removing or
 *   renaming `OTHER` would change the saldo of these 13 production employees across five months,
 *   violating the issue's own criterion "no saldo and no leave entitlement changes". `OTHER` is
 *   NOT removable and NOT renameable for that reason — see the CI gate's G5 assertion in
 *   `absence-type-mapping-guard.test.ts`, which pins exactly this.
 */
export const ABSENCE_TYPE_CORRESPONDENCE: Record<AbsenceType, AbsenceCorrespondence> = {
  SICK: { kind: "corresponds", code: "SICK" },
  SICK_CHILD: { kind: "corresponds", code: "SICK_CHILD" },
  SPECIAL_LEAVE: { kind: "corresponds", code: "SPECIAL" },
  UNPAID_LEAVE: { kind: "corresponds", code: "UNPAID" },
  MATERNITY: { kind: "corresponds", code: "MATERNITY" },
  PARENTAL: { kind: "corresponds", code: "PARENTAL" },
  OTHER: {
    kind: "absence_only",
    why:
      "No writer in production code, yet 15 production rows exist: hand-inserted pre-tracking " +
      "bridge rows across 13 employees, startDate 2026-01-01 through 2026-05-26, neutralising " +
      "five months of Soll (98-RESEARCH.md §2.6). days = 0.00 on all of them is misleading — the " +
      "Soll credit comes from the date range, not from days. This value is NOT removable and NOT " +
      "renameable; doing either changes production saldi.",
  },
  VOCATIONAL_SCHOOL: {
    kind: "absence_only",
    why:
      "Berufsschule (BBiG § 15/§ 17). Imposed by the training contract, never requested; it is " +
      "the only AbsenceType the saldo calculation branches on (close-employee-month.ts credits " +
      "it but excludes it from the day-dedup, then re-adds the precise § 15 slot credit). There " +
      'is deliberately no leave counterpart: "Berufsschule beantragen" is factually wrong.',
  },
};

/**
 * A `LeaveTypeCode`'s relationship to the `AbsenceType` vocabulary — the mirror of
 * `AbsenceCorrespondence`. Same reasoning: a discriminated union, not `AbsenceType | null`.
 */
export type LeaveTypeCorrespondence =
  | { readonly kind: "corresponds"; readonly type: AbsenceType }
  | { readonly kind: "leave_only"; readonly why: string };

/**
 * The `LeaveTypeCode` -> `AbsenceType` direction, all nine entries — the mirror table of
 * `ABSENCE_TYPE_CORRESPONDENCE`.
 *
 * Three leave-only codes, each with its reason: `VACATION`, `OVERTIME_COMP`, `EDUCATION` are
 * requested and granted from an entitlement, never imposed; `Absence` has no status and no
 * entitlement coupling, so there is no sensible imposed form of any of them.
 */
export const LEAVE_TYPE_CODE_CORRESPONDENCE: Record<LeaveTypeCode, LeaveTypeCorrespondence> = {
  SICK: { kind: "corresponds", type: "SICK" },
  SICK_CHILD: { kind: "corresponds", type: "SICK_CHILD" },
  SPECIAL: { kind: "corresponds", type: "SPECIAL_LEAVE" },
  UNPAID: { kind: "corresponds", type: "UNPAID_LEAVE" },
  MATERNITY: { kind: "corresponds", type: "MATERNITY" },
  PARENTAL: { kind: "corresponds", type: "PARENTAL" },
  VACATION: {
    kind: "leave_only",
    why:
      "Requested and granted from an entitlement, never imposed; Absence has no status and no " +
      "entitlement coupling, so there is no sensible imposed form of vacation.",
  },
  OVERTIME_COMP: {
    kind: "leave_only",
    why:
      "Requested and granted from an entitlement (overtime balance), never imposed; Absence has " +
      "no status and no entitlement coupling, so there is no sensible imposed form of overtime " +
      "compensation.",
  },
  EDUCATION: {
    kind: "leave_only",
    why:
      "Requested and granted from an entitlement (Bildungsurlaub), never imposed; Absence has " +
      "no status and no entitlement coupling, so there is no sensible imposed form of it.",
  },
};

/** `AbsenceType` -> `LeaveTypeCode`, or `null` when the type has no leave counterpart. */
export function leaveTypeCodeForAbsenceType(type: AbsenceType): LeaveTypeCode | null {
  const entry = ABSENCE_TYPE_CORRESPONDENCE[type];
  return entry.kind === "corresponds" ? entry.code : null;
}

/** `LeaveTypeCode` -> `AbsenceType`, or `null` when the code has no absence counterpart. */
export function absenceTypeForLeaveTypeCode(code: LeaveTypeCode): AbsenceType | null {
  const entry = LEAVE_TYPE_CODE_CORRESPONDENCE[code];
  return entry.kind === "corresponds" ? entry.type : null;
}

/**
 * The four `AbsenceType` values ADR 0001 assigns to `LeaveRequest` — requested, not imposed. See
 * `docs/adr/0001-drei-kontexte.md`, the section distinguishing the two absence models. Plan 02's
 * seed gate (both `reset-demo.ts` and `seed-demo.ts`) consumes this constant to assert neither
 * seed creates an `Absence` row with one of these types.
 */
export const ADR_REQUESTED_ONLY_ABSENCE_TYPES = [
  "SICK",
  "SICK_CHILD",
  "SPECIAL_LEAVE",
  "UNPAID_LEAVE",
] as const satisfies readonly AbsenceType[];
