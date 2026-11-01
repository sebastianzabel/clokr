/**
 * Issue #608 (D-08, D-09, D-10, P-608-10) - the payload contract of a web push and the neutral
 * test message.
 *
 * A push payload carries exactly three keys - `title`, `body`, `url` - and every text is a constant
 * of this module: no notification message, name or figure ever reaches a lock screen (AC-4). Plan 03
 * adds the per-type registry, its resolver and `safePushUrl` to this file.
 */

export type PushPayload = { title: string; body: string; url: string };

/** Every push carries this title; the product name is the only thing a lock screen may show. */
export const PUSH_TITLE = "Clokr";

/** The neutral message of the "send a test" action (AC-2). */
export const PUSH_TEST_PAYLOAD: PushPayload = {
  title: PUSH_TITLE,
  body: "Testnachricht: Push-Benachrichtigungen sind eingerichtet.",
  url: "/settings",
};

/** A test push is worthless after an hour: the push service drops it instead of delivering late. */
export const PUSH_TEST_TTL_SECONDS = 60 * 60;
