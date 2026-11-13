// Presentation of a failed push call (Issue #608, D-14). An API refusal (the duck-typed `ApiError`:
// a numeric `status` and a message) carries the server's German text; anything else - a network
// failure whose message is the browser's English - gets the calm fallback.

export const PUSH_FALLBACK_ERROR = "Push konnte nicht eingerichtet werden.";

export function pushErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const { status, message } = error as { status?: unknown; message?: unknown };
    if (typeof status === "number" && typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return PUSH_FALLBACK_ERROR;
}

export function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { status?: unknown }).status === 404
  );
}
