// Session clock of the operator console (Issue #89, D-03).
//
// The remaining time is always `expiresAt - now`, never a counter that is decremented once a
// second: a background tab throttles its timers, and a decrementing counter would drift behind
// the real expiry of the 15-minute token. All helpers are pure.

/** At or below this the chip turns to the warning state. */
export const WARNING_THRESHOLD_MS = 120_000;
/** The second, later announcement. */
export const FINAL_ANNOUNCEMENT_MS = 30_000;

export const ANNOUNCE_2_MINUTES = "Die Sitzung endet in 2 Minuten. Eingaben bitte abschließen.";
export const ANNOUNCE_30_SECONDS = "Die Sitzung endet in 30 Sekunden.";

export type SessionState = "normal" | "warning" | "expired";

/** Milliseconds until `expiresAt`, never negative. */
export function remainingMs(expiresAt: number, now: number): number {
  return Math.max(0, expiresAt - now);
}

/** `mm:ss`, zero-padded; a partial second rounds up so 00:00 appears only at expiry. */
export function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function sessionState(ms: number): SessionState {
  if (ms <= 0) return "expired";
  return ms <= WARNING_THRESHOLD_MS ? "warning" : "normal";
}

/**
 * The sentence to announce when the remaining time crosses a threshold between two readings, or
 * null. Each threshold fires once: only the reading that moves from above to at-or-below counts.
 * When one reading jumps over both (a throttled tab), the later threshold wins. Nothing is
 * announced at expiry - the redirect to the sign-in page says it.
 */
export function announcementFor(previousMs: number, ms: number): string | null {
  if (ms <= 0) return null;
  if (previousMs > FINAL_ANNOUNCEMENT_MS && ms <= FINAL_ANNOUNCEMENT_MS) {
    return ANNOUNCE_30_SECONDS;
  }
  if (previousMs > WARNING_THRESHOLD_MS && ms <= WARNING_THRESHOLD_MS) {
    return ANNOUNCE_2_MINUTES;
  }
  return null;
}
