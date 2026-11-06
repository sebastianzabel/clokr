// Issue #836 — the approval/correction exception step. The API answers 409
// `LEAVE_LIMIT_EXCEPTION_REQUIRED` when a decision would exceed a leave limit; the UI then asks
// for a reason and resends with `limitException`. The code is the control value, never the German
// text (CLAUDE.md). Same decision as `isFourEyesConfirmation` in `$lib/api/roles`, but read from
// the error's shape (`status`, `data.code`) instead of `instanceof`, so this module needs no runtime
// import of the API client (which pulls the auth store and SvelteKit's environment module).
import type { ApiError } from "$api/client";
import type { LeaveLimitWarning } from "./types";

export const LEAVE_LIMIT_EXCEPTION_REQUIRED = "LEAVE_LIMIT_EXCEPTION_REQUIRED";

/** The bounds the API enforces on `limitException.reason` (trimmed length). */
export const EXCEPTION_REASON_MIN = 10;
export const EXCEPTION_REASON_MAX = 500;

function apiErrorData(err: unknown): { status: number; data: unknown } | null {
  if (!(err instanceof Error)) return null;
  const { status, data } = err as Error & { status?: unknown; data?: unknown };
  return typeof status === "number" ? { status, data } : null;
}

/** True only for the limit-exception 409 of the API. */
export function isLeaveLimitExceptionRequired(err: unknown): err is ApiError {
  const parsed = apiErrorData(err);
  if (!parsed || parsed.status !== 409) return false;
  const data = parsed.data as { code?: unknown } | undefined;
  return data?.code === LEAVE_LIMIT_EXCEPTION_REQUIRED;
}

/** The exceeded rules the 409 body carries; an unexpected body yields an empty list. */
export function exceedancesOf(err: unknown): LeaveLimitWarning[] {
  const data = apiErrorData(err)?.data as { exceedances?: unknown } | undefined;
  return Array.isArray(data?.exceedances) ? (data.exceedances as LeaveLimitWarning[]) : [];
}

/** Client-side pre-check (the API stays the authority): trimmed 10–500 characters. */
export function validateExceptionReason(reason: string): string | null {
  const length = reason.trim().length;
  if (length < EXCEPTION_REASON_MIN || length > EXCEPTION_REASON_MAX) {
    return "Die Begründung der Ausnahme muss 10 bis 500 Zeichen lang sein.";
  }
  return null;
}
