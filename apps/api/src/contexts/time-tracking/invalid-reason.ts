import type { InvalidReasonCode } from "@clokr/db";

/**
 * Phase 96 lineage: `invalidReason` is now a derived field in the same way
 * `breakMinutes` became one in Phase 129 — no caller sets it directly, it exists
 * only as the rendered form of `invalidReasonCode`.
 *
 * `LEGACY_UNMAPPED` is deliberately excluded from this map: a row backfilled to
 * that code keeps whatever text was already stored in `invalidReason` (Phase 96
 * plan 01's backfill), it is never rendered through this mapping.
 */

/**
 * The one and only Code -> German-text mapping (D-09). `invalidReasonFields()`
 * below is the *only* place in `apps/api/src` that may contain a German
 * invalid-reason literal — plans 03-05's grep sweeps
 * (`grep -rn 'invalidReason ===' apps/api/src`, `grep -rn 'invalidReason:' apps/api/src/routes`)
 * enforce that no second mapping or text-based comparison exists anywhere else.
 */
export const INVALID_REASON_TEXT: Record<Exclude<InvalidReasonCode, "LEGACY_UNMAPPED">, string> = {
  MISSING_CLOCK_OUT: "Ausstempeln fehlt",
  LEAVE_CANCELLATION_PENDING: "Urlaubsstornierung ausstehend",
  // Written with the \u2013 escape rather than a literal en-dash character so
  // the code point survives any editor, copy-paste, or dash autocorrection intact.
  RETRO_APPROVAL_PENDING: "Nachtrag \u2013 Genehmigung ausstehend",
};

/**
 * Prisma `data:` fragment for a writable invalid-reason code. The return type
 * requires both fields together, so a caller cannot set `invalidReasonCode`
 * without also setting its matching `invalidReason` text (or vice versa).
 */
export function invalidReasonFields(code: Exclude<InvalidReasonCode, "LEGACY_UNMAPPED">): {
  invalidReasonCode: InvalidReasonCode;
  invalidReason: string;
} {
  return { invalidReasonCode: code, invalidReason: INVALID_REASON_TEXT[code] };
}

/**
 * Shared "clear the invalid reason" fragment for every revalidation path.
 * Frozen so no caller can mutate the shared object.
 */
export const CLEARED_INVALID_REASON = Object.freeze({
  invalidReasonCode: null,
  invalidReason: null,
} as const);
