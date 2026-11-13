// Issue #835 — control decisions on planner refusals. The API answers `{ error, code }`; the code
// is the control value, the German text is display only (CLAUDE.md "Never use a new display
// string as a control value"). Read from the error's shape (`status`, `data.code`) instead of
// `instanceof`, so this module needs no runtime import of the API client (which pulls the auth
// store and SvelteKit's environment module) — same approach as `$lib/leave-limits/exception`.

export const LEAVE_PLAN_CLOSED = "LEAVE_PLAN_CLOSED";
export const LEAVE_PLAN_ALREADY_OPEN = "LEAVE_PLAN_ALREADY_OPEN";
export const LEAVE_PLAN_WISH_OVERLAP = "LEAVE_PLAN_WISH_OVERLAP";
export const LEAVE_PLAN_WISH_TAKEN_OVER = "LEAVE_PLAN_WISH_TAKEN_OVER";
export const LEAVE_PLAN_DEADLINE_PASSED = "LEAVE_PLAN_DEADLINE_PASSED";

/** The `data.code` of an ApiError-shaped object, or null for anything else. */
export function planErrorCode(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const { status, data } = err as Error & { status?: unknown; data?: unknown };
  if (typeof status !== "number") return null;
  const code = (data as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : null;
}

export const isPlanClosed = (err: unknown): boolean => planErrorCode(err) === LEAVE_PLAN_CLOSED;
export const isDeadlinePassed = (err: unknown): boolean =>
  planErrorCode(err) === LEAVE_PLAN_DEADLINE_PASSED;
export const isWishOverlap = (err: unknown): boolean =>
  planErrorCode(err) === LEAVE_PLAN_WISH_OVERLAP;
export const isWishTakenOver = (err: unknown): boolean =>
  planErrorCode(err) === LEAVE_PLAN_WISH_TAKEN_OVER;
export const isPlanAlreadyOpen = (err: unknown): boolean =>
  planErrorCode(err) === LEAVE_PLAN_ALREADY_OPEN;

/** The server's German message of a refusal, for inline display (never a control value). */
export function planErrorMessage(err: unknown, fallback = "Das hat nicht geklappt."): string {
  if (!(err instanceof Error)) return fallback;
  const data = (err as Error & { data?: unknown }).data as { error?: unknown } | null | undefined;
  if (typeof data?.error === "string" && data.error.length > 0) return data.error;
  return err.message || fallback;
}
