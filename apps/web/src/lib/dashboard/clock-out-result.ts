/**
 * Phase 307 Plan 02 (D-04) — translates a `POST /:id/clock-out` response into a two-valued
 * result the dashboard can act on without ever silently treating a non-close as a success.
 *
 * WHY THIS MODULE EXISTS: the dashboard page (`routes/(app)/dashboard/+page.svelte`) is not
 * mountable in this repo's test setup — `apps/web/vitest.config.ts` registers no `$app/*` alias
 * and the page imports `$app/*` directly (the same wall `dashboard-clock-card.test.ts` and
 * `dashboard-today-shift-source.test.ts` already document). The BEHAVIOUR this module owns
 * therefore has to live in a plain `src/lib/` module to be testable at all; the page itself only
 * gets a thin, quelltext-verified call site.
 *
 * `resolution.entry` is OPTIONAL — the measured truth, not an oversight: `DEBOUNCE_NOOP` carries
 * no `entry` field (`apps/api/src/services/clock/types.ts`'s `ClockResolution` union), so a type
 * that declared it required (the pre-Phase-307 `ClockOutResponse` on the dashboard page did
 * exactly that) lets a reader who trusts the type reach `resolution.entry.id` and crash with a
 * TypeError the moment a non-CLOCKED_OUT/CONSOLIDATED kind actually arrives.
 *
 * The `ClockResolutionKind` mirror below is held in sync with the server's union by the parity
 * test in `__tests__/clock-out-result.test.ts` (describe B): it reads BOTH source files, extracts
 * the `kind` name sets, and fails the moment they diverge — a silently stale mirror is exactly
 * what let `DEBOUNCE_NOOP` go unhandled here in the first place. `interpretClockOut()`'s `switch`
 * additionally exhausts all six names via a `never` default arm, so a seventh name breaks
 * `pnpm --filter @clokr/web typecheck` too — two independent assurances for the same guarantee.
 */

/** Mirror of `ClockResolution["kind"]` in `apps/api/src/services/clock/types.ts`. */
export type ClockResolutionKind =
  | "CLOCKED_IN"
  | "CLOCKED_OUT"
  | "CONSOLIDATED"
  | "CONFIRMED"
  | "DEBOUNCE_NOOP"
  | "CONFLICT";

/** The subset of a closed TimeEntry this module needs to pass through. */
export interface ClockOutEntry {
  id: string;
  endTime: string;
}

export interface ClockOutResolution {
  kind: ClockResolutionKind;
  // Measured wire truth: absent on DEBOUNCE_NOOP/CONFLICT/CLOCKED_IN/CONFIRMED, present on
  // CLOCKED_OUT/CONSOLIDATED — never declared required (see module docblock above).
  entry?: ClockOutEntry;
}

/** The full `POST /:id/clock-out` 200 response body. */
export interface ClockOutResponse {
  resolution: ClockOutResolution;
  action?: "NOOP"; // legacy 200-with-field shape (`/nfc-punch`'s sibling branch); never sent by
  // `/:id/clock-out` since Phase 307 Plan 02, but the type stays honest about what could arrive.
  audit?: { id: string };
  warnings?: unknown[];
  entry?: ClockOutEntry; // top-level, breaks-included re-fetch — see time-entries.ts's clock-out handler
}

export interface ClockOutClosed {
  kind: "closed";
  entry: ClockOutEntry;
}

export interface ClockOutNotClosed {
  kind: "not-closed";
  message: string;
}

export type ClockOutInterpretation = ClockOutClosed | ClockOutNotClosed;

/**
 * Translate a clock-out response into "closed" (with the entry) or "not-closed" (with a German
 * message) — never a silent no-op that reads as success. Exhausts all six `ClockResolutionKind`
 * values explicitly; the `never` assignment in the default arm is what breaks `typecheck` the
 * moment a seventh name is added to the server union without being handled here.
 *
 * No 60-second constant lives here: the server's 409 body already names the exact reopen time
 * (see `apps/api/src/contexts/time-tracking/clock-out-debounce-message.ts`) and that text arrives
 * via the existing `ApiError`/`catch`/`toasts.error(...)` path, not through this function — this
 * module's own DEBOUNCE_NOOP message is a defensive fallback for a shape `/:id/clock-out` no
 * longer sends, and can therefore only ever name the REASON, never a time it cannot know.
 */
export function interpretClockOut(response: ClockOutResponse): ClockOutInterpretation {
  const kind = response.resolution.kind;
  switch (kind) {
    case "CLOCKED_OUT":
    case "CONSOLIDATED": {
      const entry = response.resolution.entry ?? response.entry;
      if (!entry) {
        return {
          kind: "not-closed",
          message:
            "Ausstempeln konnte nicht bestätigt werden — der Server hat keinen aktualisierten Eintrag geliefert.",
        };
      }
      return { kind: "closed", entry };
    }
    case "DEBOUNCE_NOOP":
      return {
        kind: "not-closed",
        message:
          "Ausstempeln hat nicht funktioniert (Schutz vor Doppeltipp) — bitte kurz warten und erneut versuchen.",
      };
    case "CONFLICT":
      return {
        kind: "not-closed",
        message: "Ausstempeln war nicht möglich — der Server meldet einen Konflikt.",
      };
    case "CLOCKED_IN":
    case "CONFIRMED":
      return {
        kind: "not-closed",
        message: "Ausstempeln war nicht erfolgreich — unerwartete Serverantwort.",
      };
    default: {
      // Exhaustiveness: a 7th ClockResolutionKind value makes this a compile error.
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
