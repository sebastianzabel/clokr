/**
 * Issue #608 (D-08, D-09, D-10, D-16, P-608-10 .. P-608-12) - what a web push may say, and where a
 * tap leads.
 *
 * A push payload carries exactly three keys - `title`, `body`, `url` - and every text is a constant
 * of this module: no notification message, name or figure ever reaches a lock screen (AC-4).
 *
 * **Invariant: absence from this registry means NOT pushed.** `NOTIFICATION_PUSH_POLICY` holds one
 * entry per key of `NOTIFICATION_EMAIL_POLICY` - either a neutral German du-form text with a TTL
 * class (`send`) or a written reason (`never`). `resolvePushPolicy` returns `undefined` for anything
 * else and the dispatcher then sends nothing and warns (fail-closed, the e-mail registry's rule).
 * `apps/api/src/__tests__/notification-push-policy-608.test.ts` scans every `app.notify()` call site
 * under apps/api/src, so a new notification type without an entry turns that test red - nobody has
 * to remember AC-4 ("no health or saldo data in plain text on the lock screen"). A type whose e-mail
 * policy is `never` is `never` here too (parity, tested).
 *
 * Exception to the parity (Issue #609, D-08): a type may be e-mail `never` AND pushed when its text is a
 * neutral nudge without personal content (the shift reminders). The exceptions are the named list
 * `PUSH_WITHOUT_EMAIL` in the policy test, each with a written reason; the test proves the list holds
 * no stale entry and no `never` type.
 *
 * Known limitation (D-16): `contexts/absence/bs-leave-correction.ts` and
 * `contexts/absence/vocational-school-generator.ts` insert notification rows directly instead of
 * calling `notify()`; those types never push (nor e-mail). They are out of scope of this registry.
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

// ── Registry (D-08) ──────────────────────────────────────────────────────────────────────────

export type PushPolicy =
  { push: "send"; body: string; ttlSeconds: number } | { push: "never"; reason: string };

/** How long the push service may hold a message for an offline device before it drops it. */
const TTL_1H = 60 * 60;
const TTL_12H = 12 * 60 * 60;
const TTL_24H = 24 * 60 * 60;
const TTL_3D = 3 * 24 * 60 * 60;
/** The only TTL classes an entry may use (the policy test pins the set). */
export const PUSH_TTL_CLASSES: readonly number[] = [TTL_1H, TTL_12H, TTL_24H, TTL_3D];

const NEVER_HEALTH_REASON =
  "Art. 9 DSGVO health-adjacent payload (§ 9 BUrlG Krank-im-Urlaub): not even a neutral text may " +
  "appear on a lock screen, because the mere existence of the message discloses health data. The " +
  "e-mail policy is `never` too.";

// A text must stay valid for every recipient of its type (employee, manager, admin) and for every
// leave type, including sick leave: it never names a decision, a person, a figure or a date.
// prettier-ignore
export const NOTIFICATION_PUSH_POLICY: Record<string, PushPolicy> = {
  // Leave and retro-entry requests
  LEAVE_REQUEST:          { push: "send", body: "Es gibt einen neuen Antrag zur Prüfung.", ttlSeconds: TTL_3D },
  RETRO_ENTRY_REQUESTED:  { push: "send", body: "Es gibt einen neuen Antrag zur Prüfung.", ttlSeconds: TTL_3D },
  LEAVE_APPROVED:         { push: "send", body: "Es gibt eine Rückmeldung zu deinem Antrag.", ttlSeconds: TTL_3D },
  LEAVE_REJECTED:         { push: "send", body: "Es gibt eine Rückmeldung zu deinem Antrag.", ttlSeconds: TTL_3D },
  LEAVE_CANCELLED:        { push: "send", body: "Es gibt eine Rückmeldung zu deinem Antrag.", ttlSeconds: TTL_3D },
  RETRO_ENTRY_DECIDED:    { push: "send", body: "Es gibt eine Rückmeldung zu deinem Antrag.", ttlSeconds: TTL_3D },
  LEAVE_DAYS_ADJUSTED:    { push: "send", body: "Es gibt eine Änderung zu einem Urlaubsantrag.", ttlSeconds: TTL_3D },
  RETRO_ENTRY_UPDATED:    { push: "send", body: "Ein Antrag wurde geändert.", ttlSeconds: TTL_3D },
  RETRO_ENTRY_WITHDRAWN:  { push: "send", body: "Ein Antrag wurde geändert.", ttlSeconds: TTL_3D },
  PENDING_LEAVE_REMINDER: { push: "send", body: "Es warten Anträge auf deine Prüfung.", ttlSeconds: TTL_24H },

  // Account and month close
  ACCOUNT_LOCKED:         { push: "send", body: "Es gibt ein Sicherheitsereignis zu einem Konto.", ttlSeconds: TTL_24H },
  MONTH_CLOSE_BLOCKED:    { push: "send", body: "Der Monatsabschluss braucht deine Aufmerksamkeit.", ttlSeconds: TTL_3D },
  MONTH_CLOSE_DEFERRED:   { push: "send", body: "Der Monatsabschluss braucht deine Aufmerksamkeit.", ttlSeconds: TTL_3D },
  GAP_WARNING_MANAGER:    { push: "send", body: "Im Monatsabschluss gibt es offene Punkte.", ttlSeconds: TTL_3D },

  // Time recording
  CLOCK_OUT_REMINDER:     { push: "send", body: "Du bist noch eingestempelt.", ttlSeconds: TTL_12H },
  MISSING_ENTRIES:        { push: "send", body: "Bitte prüfe deine Zeiterfassung.", ttlSeconds: TTL_24H },
  GAP_WARNING_EMPLOYEE:   { push: "send", body: "Bitte prüfe deine Zeiterfassung.", ttlSeconds: TTL_24H },
  OPEN_ENTRY_INVALIDATED: { push: "send", body: "Es gibt eine Änderung an deiner Zeiterfassung.", ttlSeconds: TTL_24H },
  BREAK_UNCONFIRMED:      { push: "send", body: "Es gibt einen Hinweis zur Arbeitszeiterfassung.", ttlSeconds: TTL_24H },
  BREAK_COMPLIANCE_ALERT: { push: "send", body: "Es gibt einen Hinweis zur Arbeitszeiterfassung.", ttlSeconds: TTL_24H },
  BREAK_CROSS_SALON_VIOLATION: { push: "send", body: "Es gibt einen Hinweis zur Arbeitszeiterfassung.", ttlSeconds: TTL_24H },
  BREAK_PLACEMENT_VIOLATION:   { push: "send", body: "Es gibt einen Hinweis zur Arbeitszeiterfassung.", ttlSeconds: TTL_24H },

  // Shift reminders (Issue #609): a time-bound nudge, a late delivery would be wrong, so TTL_1H
  REMINDER_SHIFT_START:   { push: "send", body: "Deine Schicht hat begonnen. Jetzt einstempeln?", ttlSeconds: TTL_1H },
  REMINDER_SHIFT_END:     { push: "send", body: "Feierabend? Jetzt ausstempeln.", ttlSeconds: TTL_1H },
  REMINDER_DAY_CLOSE:     { push: "send", body: "Heute fehlt noch deine Zeit.", ttlSeconds: TTL_1H },

  // Absence reminders
  UPCOMING_ABSENCE:       { push: "send", body: "Es gibt einen neuen Hinweis in Clokr.", ttlSeconds: TTL_24H },
  VACATION_EXPIRY:        { push: "send", body: "Es gibt einen Hinweis zu deinem Urlaub.", ttlSeconds: TTL_3D },
  CARRYOVER_EXPIRING:     { push: "send", body: "Es gibt einen Hinweis zu deinem Urlaub.", ttlSeconds: TTL_3D },

  // Shift planning
  SHIFT_LEAVE_CONFLICT:   { push: "send", body: "Es gibt einen Hinweis zur Schichtplanung.", ttlSeconds: TTL_24H },
  SHIFT_WEEK_OVERBOOKED:  { push: "send", body: "Es gibt einen Hinweis zur Schichtplanung.", ttlSeconds: TTL_24H },

  // Never pushed
  SECTION9_AU_PENDING_EMPLOYEE: { push: "never", reason: NEVER_HEALTH_REASON },
  SECTION9_AU_PENDING_MANAGER:  { push: "never", reason: NEVER_HEALTH_REASON },
  SECTION9_CREDIT_CONFIRMED:    { push: "never", reason: NEVER_HEALTH_REASON },
  SECTION9_CREDIT_REJECTED:     { push: "never", reason: NEVER_HEALTH_REASON },
  SUPPORT_ACCESS_STARTED: {
    push: "never",
    reason:
      "In-app only (Issue #93, D-14): the notice that an operator support access started goes to " +
      "tenant admins inside the application; the e-mail policy is `never` too.",
  },
};

/**
 * Resolve the push policy for a notification type; `undefined` for anything not registered - the
 * caller must treat that as "do not push" and warn naming the type. `hasOwnProperty` keeps a type
 * literally named `constructor` or `toString` from resolving to an inherited member.
 */
export function resolvePushPolicy(type: string): PushPolicy | undefined {
  return Object.prototype.hasOwnProperty.call(NOTIFICATION_PUSH_POLICY, type)
    ? NOTIFICATION_PUSH_POLICY[type]
    : undefined;
}

// ── Tap target (D-09) ────────────────────────────────────────────────────────────────────────

/** Every person may open the dashboard (`/inbox` needs a permission), so it is the safe fallback. */
export const PUSH_FALLBACK_URL = "/dashboard";

const MAX_PUSH_URL_LENGTH = 512;

/**
 * The tap target of a push: the notification's own relative link when it is a safe same-origin
 * path, else {@link PUSH_FALLBACK_URL}. Same rule family as the web's `safeNext`: starts with a
 * single `/`, no backslash, no control character or whitespace, no percent-encoded `/`, `\` or
 * `.` (any case), at most 512 characters, and a parse against a dummy origin stays on that origin.
 * The returned value is the dot-segment-normalised path, never the raw input.
 * The service worker re-validates the origin on its side (plan 04).
 */
export function safePushUrl(link: string | null | undefined): string {
  if (typeof link !== "string" || link.length === 0 || link.length > MAX_PUSH_URL_LENGTH) {
    return PUSH_FALLBACK_URL;
  }
  if (!link.startsWith("/") || link.startsWith("//") || link.includes("\\")) {
    return PUSH_FALLBACK_URL;
  }
  if (/\s/.test(link) || /%(2f|5c|2e)/i.test(link)) return PUSH_FALLBACK_URL;
  for (let i = 0; i < link.length; i++) {
    const code = link.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return PUSH_FALLBACK_URL;
  }
  try {
    // Normalise dot segments FIRST (review 2, WR-03): `/.//evil.example` passes every textual check
    // above, but WHATWG removes the `.` segment and leaves the protocol-relative `//evil.example`.
    // The value sent is the normalised path, and it must again start with exactly one `/`.
    const target = new URL(link, "http://x");
    if (target.origin !== "http://x") return PUSH_FALLBACK_URL;
    const path = `${target.pathname}${target.search}${target.hash}`;
    if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) {
      return PUSH_FALLBACK_URL;
    }
    return path;
  } catch {
    return PUSH_FALLBACK_URL;
  }
}
