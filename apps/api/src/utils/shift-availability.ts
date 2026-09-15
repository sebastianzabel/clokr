import type { LeaveTypeCode } from "@clokr/db";

/**
 * Phase 98b (Option A): there is now ONE absence vocabulary, so there is one classifier.
 * `classifyAbsenceType` existed only to translate an `AbsenceType` into a `LeaveTypeCode` before
 * bucketing it; with `Absence.type` typed as `LeaveTypeCode`, `classifyLeaveTypeCode` takes the
 * value directly. The fail-soft behaviour that function documented is preserved: an out-of-enum
 * value reaching `classifyLeaveTypeCode` at runtime (a `$queryRaw` row, a payload cast, a rolling
 * deploy where a migration added a member ahead of the image) lands in `"other"` via the
 * `default` branch rather than throwing — one misclassified roster cell, not a 500 on the whole
 * week view.
 *
 * The five buckets a leave type or absence type can classify into. Identical to `shifts.ts`'s
 * `ConflictType`; `available` / `unavailable` / `preferred` come from roster state, never from a
 * classifier — they are not part of this type.
 */
export type AvailabilityBucket = "vacation" | "sick" | "special" | "vocational_school" | "other";

/**
 * Classify a leave type into one of our availability buckets — by its stable CODE.
 *
 * Phase 97 (D-11): the previous implementation lower-cased the German display name and matched
 * substrings of it — the vacation bucket was "contains the word for leave, but not the words for
 * special or unpaid". That misclassified the further-education type as vacation, because its
 * German name ends in the same word and matches neither exclusion, and it broke entirely for a
 * tenant who renamed a type. Do not restate those substring tests here: the CI gate from plan 10
 * asserts that no such literal survives anywhere in this file.
 *
 * A null code (pre-backfill row, or one the old image wrote during a rolling deploy) falls
 * through to "other" — the same bucket an unrecognised type has always landed in.
 */
export function classifyLeaveTypeCode(code: LeaveTypeCode | null): AvailabilityBucket {
  switch (code) {
    case "VACATION":
      return "vacation";
    case "SICK":
    case "SICK_CHILD":
      return "sick";
    case "SPECIAL":
      return "special";
    // Phase 98b: VOCATIONAL_SCHOOL became a LeaveTypeCode member when the two vocabularies
    // merged. Without this explicit case it would fall into `default` and lose the dedicated
    // Berufsschule bucket the shift planner keys its lock icon and badge off (Phase 63, D-20) —
    // with no compile error and no red test, because `default` swallows it. The reasoning
    // `classifyAbsenceType`'s docblock used to give for keeping a SECOND function is the
    // reasoning for adding this case.
    case "VOCATIONAL_SCHOOL":
      return "vocational_school";
    // EDUCATION, UNPAID, OVERTIME_COMP, MATERNITY, PARENTAL, OTHER and an unset code all share
    // the generic bucket. EDUCATION landing here instead of `vacation` is the D-11 correction;
    // OTHER landing here is correct and deliberate, not an oversight.
    default:
      return "other";
  }
}
