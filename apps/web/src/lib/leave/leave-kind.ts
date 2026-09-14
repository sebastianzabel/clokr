/**
 * Categorize an approved leave request into a render kind — by its stable type code.
 *
 * Phase 97 (D-04): `apps/web/src/routes/(app)/teamcal/+page.svelte` used to hold the fourth
 * independent copy of the German sick-type names (`SICK_TYPE_NAMES`), matched against
 * `leaveType.name`. A tenant renaming that display name silently broke the teamcal colour-coding.
 * This module is the code-driven replacement, pulled out of the page component because it is pure
 * logic and belongs here, not in a route file.
 *
 * An uncoded request (`typeCode === null`, e.g. a pre-backfill row) deliberately renders as a
 * vacation cell — that is exactly what the old name-based fallback did (every name other than the
 * two sick-type names fell through to "vacation"), and a missing cell would be worse than a
 * generically-coloured one.
 */
export const SICK_TYPE_CODES = new Set(["SICK", "SICK_CHILD"]);

export function leaveKind(typeCode: string | null | undefined): "vacation" | "sick" {
  return typeCode && SICK_TYPE_CODES.has(typeCode) ? "sick" : "vacation";
}
