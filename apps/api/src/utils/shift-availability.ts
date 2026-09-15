import type { AbsenceType, LeaveTypeCode } from "@clokr/db";
import { leaveTypeCodeForAbsenceType } from "./absence-type";

/**
 * Phase 98 (T3, plan 03) — the two availability classifiers that used to live side by side in
 * `routes/shifts.ts` (`classifyLeaveTypeCode` and `classifyAbsenceType`), extracted into one
 * testable module. This is `98-RESEARCH.md`'s §3.3d "the doubling in its purest form": both
 * functions mapped onto the same four buckets, restating in two independent `switch` statements
 * the exact correspondence `absence-type.ts` (Phase 98, plan 01) now writes down once — including
 * the one pair spelled differently on each side of `ABSENCE_TYPE_CORRESPONDENCE` (the special-leave
 * and unpaid-leave `AbsenceType` values against their differently-spelled `LeaveTypeCode`
 * counterparts). `classifyAbsenceType` now reads that written correspondence instead of repeating
 * it here.
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

/**
 * Classify an `AbsenceType` enum value into our availability bucket — by delegating through the
 * written `AbsenceType <-> LeaveTypeCode` correspondence (`absence-type.ts`, Phase 98 plan 01)
 * rather than restating it in a second `switch`.
 *
 * Why a delegation: the special-leave value mapping to `"special"` and the unpaid-leave value
 * mapping to `"other"` used to be restated here directly, next to `classifyLeaveTypeCode`'s own
 * `switch` saying the same thing about their differently-spelled `LeaveTypeCode` counterparts
 * (`SPECIAL`, `UNPAID` — see `ABSENCE_TYPE_CORRESPONDENCE` in `absence-type.ts` for the exact
 * `AbsenceType` spelling on the other side). Phase 98 wrote the correspondence down once, in
 * `absence-type.ts`; this function reads it instead of repeating it, so the two functions cannot
 * drift apart again without the delegation test in
 * `apps/api/src/__tests__/shift-availability.test.ts` noticing.
 *
 * Why `VOCATIONAL_SCHOOL` is checked BEFORE the correspondence lookup: it has no leave-side
 * counterpart AND no leave-side bucket — `classifyLeaveTypeCode` cannot produce
 * `"vocational_school"`, so this branch cannot be delegated. Phase 63 (D-20): this bucket carries
 * the lock-icon semantic in the shift planner and its own badge in the frontend.
 *
 * Why `OTHER` falls to `"other"` explicitly rather than by accident: it has no counterpart
 * either, and it is NOT a dead value — 15 production rows depend on it (plan 01's `<the_trap>`;
 * the reason is recorded in `ABSENCE_TYPE_CORRESPONDENCE.OTHER`). Do not "simplify" this branch
 * away.
 *
 * Why an out-of-enum value degrades to `"other"` rather than throwing, stated here because the
 * choice is otherwise invisible: the pre-Phase-98 implementation took a plain `string` and ended
 * in `default: return "other"`, so anything unrecognised landed in the generic bucket. The
 * parameter is now typed `AbsenceType` and the correspondence table is exhaustive at compile
 * time, but a value the compiler never saw can still arrive at runtime (a `$queryRaw` row, a
 * payload cast to `AbsenceType`, a rolling deploy where a migration added an enum member ahead of
 * the image). `leaveTypeCodeForAbsenceType()` returns `null` for such a value instead of throwing,
 * so it lands in `"other"` — one misclassified roster cell, not a 500 on the whole week view. This
 * is fail-soft by decision, not by accident; `shift-availability.test.ts` pins it.
 *
 * The behaviour is identical to the pre-Phase-98 `switch` for all eight `AbsenceType` values,
 * pinned by `apps/api/src/__tests__/shift-availability.test.ts`.
 */
export function classifyAbsenceType(type: AbsenceType): AvailabilityBucket {
  if (type === "VOCATIONAL_SCHOOL") return "vocational_school";
  const code = leaveTypeCodeForAbsenceType(type);
  return code === null ? "other" : classifyLeaveTypeCode(code);
}
