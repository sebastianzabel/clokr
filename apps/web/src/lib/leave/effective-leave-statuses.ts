/**
 * Display mirror of `apps/api/src/contexts/absence/effective-leave-statuses.ts` (Issue #446
 * D-01). The API is authoritative for saldo, reports and every write; the web image cannot
 * import API or `packages/db` code (`apps/web/Dockerfile`'s `test ! -e /app/packages/db` gate),
 * so this copy exists purely to decide which leave bars are drawn in a calendar.
 * `__tests__/effective-leave-statuses.test.ts` reads the API source and fails the moment the two
 * tuples differ.
 */
export const EFFECTIVE_LEAVE_STATUSES = ["APPROVED", "CANCELLATION_REQUESTED"] as const;

export function isEffectiveLeaveStatus(status: string): boolean {
  return (EFFECTIVE_LEAVE_STATUSES as readonly string[]).includes(status);
}
