/**
 * Single source of truth for whether a notification type is emailed.
 *
 * **Invariant: absence from this registry means NOT emailed.** This is the deliberate
 * inversion of the pre-2026-08-25 behaviour, where `notify.ts` looked a type up in
 * `EMAIL_TYPE_MAP` and only suppressed the email when an entry existed AND its toggle
 * was off — an unregistered type silently fell through and was sent. That was a
 * fail-OPEN gate on health-adjacent (§ 9 BUrlG, Art. 9 DSGVO) and other sensitive
 * notification payloads. This module (quick-260825-k3g) replaces both `EMAIL_TYPE_MAP`
 * and `EMAIL_SUPPRESSED_TYPES` with one exhaustive, explicit-per-type registry.
 *
 * Enforcement: `apps/api/src/__tests__/notification-email-policy.test.ts` scans every
 * `app.notify()` call site under `apps/api/src` and asserts each resolved type has an
 * entry here. Adding a 27th notification type without a corresponding entry fails that
 * test — the trap this file exists to close cannot silently reopen.
 *
 * SALDO-DISP-08 (verified 2026-08-18, Phase 97-02, carried forward from the old
 * `EMAIL_TYPE_MAP` comment): `emailOnOvertimeWarning` has no emitting type — no code
 * path passes an "overtime warning" to `app.notify()`. `CARRYOVER_EXPIRING` is the
 * BUrlG vacation-day warning, not an overtime signal. Nothing is suppressed for this
 * reason because nothing exists to suppress — see `docs/saldo-anzeige.md`. Forward
 * rule: if a day-over-day saldo notification is ever added, it must compare the
 * confirmed figure only and must exclude the open-month (Prognose) delta.
 */
import type { TenantConfig } from "@clokr/db";

type EmailKind = "toggle" | "always" | "never";
export type EmailPolicy =
  | { email: Extract<EmailKind, "toggle">; field: keyof TenantConfig }
  | { email: Extract<EmailKind, "always">; reason: string }
  | { email: Extract<EmailKind, "never">; reason: string };

// ── A. Existing toggles — unchanged from EMAIL_TYPE_MAP (11 entries, zero behaviour delta) ──
// prettier-ignore
const TOGGLE_ENTRIES: Record<string, EmailPolicy> = {
  LEAVE_REQUEST:           { email: "toggle", field: "emailOnLeaveRequest" },
  LEAVE_APPROVED:          { email: "toggle", field: "emailOnLeaveDecision" },
  LEAVE_REJECTED:          { email: "toggle", field: "emailOnLeaveDecision" },
  // LEAVE_CANCELLED has no emit site today — nothing calls
  // app.notify({ type: "LEAVE_CANCELLED" }). Kept as the sole permitted
  // "registered but unemitted" entry: the decision is already made and documented
  // for the day the emit site returns (see the reverse-hygiene test in
  // notification-email-policy.test.ts, which pins this exact key as the one
  // allowed exception).
  LEAVE_CANCELLED:         { email: "toggle", field: "emailOnLeaveDecision" },
  MISSING_ENTRIES:         { email: "toggle", field: "emailOnMissingEntries" }, // attendance-checker.ts (plural)
  GAP_WARNING_EMPLOYEE:    { email: "toggle", field: "emailOnMissingEntries" },
  GAP_WARNING_MANAGER:     { email: "toggle", field: "emailOnMissingEntries" },
  BREAK_UNCONFIRMED:       { email: "toggle", field: "emailOnMissingEntries" }, // Phase 92 (BREAK-06)
  BREAK_COMPLIANCE_ALERT:  { email: "toggle", field: "emailOnMissingEntries" }, // Phase 92 (BREAK-06)
  CLOCK_OUT_REMINDER:      { email: "toggle", field: "emailOnClockOutReminder" },
  MONTH_CLOSE_BLOCKED:     { email: "toggle", field: "emailOnMonthClose" }, // auto-close-month.ts
};

// ── B. Retro-Entry toggle — the four RETRO_ENTRY_* types (NEW field, @default(true)) ──
// They email today via the old fall-through hole. `@default(true)` on the new
// TenantConfig column means every existing tenant keeps exactly today's behaviour on
// the day of the migration, and the admin gains a real switch (quick-260825-k3g).
// prettier-ignore
const RETRO_ENTRY_ENTRIES: Record<string, EmailPolicy> = {
  RETRO_ENTRY_REQUESTED: { email: "toggle", field: "emailOnRetroEntry" },
  RETRO_ENTRY_UPDATED:   { email: "toggle", field: "emailOnRetroEntry" },
  RETRO_ENTRY_DECIDED:   { email: "toggle", field: "emailOnRetroEntry" },
  RETRO_ENTRY_WITHDRAWN: { email: "toggle", field: "emailOnRetroEntry" },
};

// ── C. always — 7 entries. Each emails today; each would regress under any existing toggle ──
const ALWAYS_ENTRIES: Record<string, EmailPolicy> = {
  ACCOUNT_LOCKED: {
    email: "always",
    reason:
      "A security event fanned out to tenant ADMINs. No emailOn* toggle covers the security " +
      "domain, and a lockout notice that a UI switch can silence is a bad default. No opt-out.",
  },
  PENDING_LEAVE_REMINDER: {
    email: "always",
    reason:
      'The closest candidate is emailOnLeaveRequest, but that switch is scoped to the "Neuer ' +
      'Urlaubsantrag" event; a reminder about an UNACTIONED request is a different event. It ' +
      "already has its own dedicated gate, TenantConfig.reminderPendingLeaveEnabled, which " +
      "decides whether the notification fires at all — a second email gate would be redundant.",
  },
  CARRYOVER_EXPIRING: {
    email: "always",
    reason:
      "§ 7 BUrlG Hinweispflicht (EuGH C-684/16). A duty-to-inform warning must not be " +
      "silenceable by a generic email switch. Already gated by carryoverWarningEnabled + thresholds.",
  },
  VACATION_EXPIRY: {
    email: "always",
    reason:
      "Same Hinweispflicht family as CARRYOVER_EXPIRING; already gated by vacationReminderStartMonth.",
  },
  UPCOMING_ABSENCE: {
    email: "always",
    reason: "Already gated by reminderUpcomingAbsenceEnabled / reminderUpcomingAbsenceDays.",
  },
  OPEN_ENTRY_INVALIDATED: {
    email: "always",
    reason:
      "The semantically closest toggle is emailOnClockOutReminder, which DEFAULTS TO FALSE; " +
      "mapping it there would silently kill a currently-active email path for every tenant on " +
      "defaults. It also reports an automatic, unattended mutation of a time entry " +
      "(Revisionssicherheit) — the employee must learn about it.",
  },
  SHIFT_LEAVE_CONFLICT: {
    email: "always",
    reason:
      "An operational Schichtplanung conflict for managers. No toggle covers shift planning; " +
      "emailOnLeaveDecision is the employee-facing leave-decision switch, not this.",
  },
};

// ── D. never — the four SECTION9_* types, reason mandatory ──
// Art. 9 DSGVO health-adjacent payloads (§ 9 BUrlG Krank-im-Urlaub). Phase 104 CR-02's
// decision is preserved verbatim, now expressed as a first-class policy instead of a
// side-car deny-list (EMAIL_SUPPRESSED_TYPES, deleted by this change).
const NEVER_REASON =
  "Art. 9 DSGVO health-adjacent payload (§ 9 BUrlG Krank-im-Urlaub). Phase 104 CR-02: must " +
  "never be emailed, regardless of tenant/user toggles.";
const NEVER_ENTRIES: Record<string, EmailPolicy> = {
  SECTION9_AU_PENDING_EMPLOYEE: { email: "never", reason: NEVER_REASON },
  SECTION9_AU_PENDING_MANAGER: { email: "never", reason: NEVER_REASON },
  SECTION9_CREDIT_CONFIRMED: { email: "never", reason: NEVER_REASON },
  SECTION9_CREDIT_REJECTED: { email: "never", reason: NEVER_REASON },
};

export const NOTIFICATION_EMAIL_POLICY: Record<string, EmailPolicy> = {
  ...TOGGLE_ENTRIES,
  ...RETRO_ENTRY_ENTRIES,
  ...ALWAYS_ENTRIES,
  ...NEVER_ENTRIES,
};

/**
 * Resolve the email policy for a notification type. Returns `undefined` for anything
 * not in the registry — the caller (`notify.ts`) must treat that as "do not email" and
 * log a warning naming the type.
 *
 * Uses `hasOwnProperty` (not `NOTIFICATION_EMAIL_POLICY[type]` directly) so a type
 * literally named `"constructor"` or `"toString"` cannot resolve to an inherited
 * `Object.prototype` member and produce a truthy non-policy (T-K3G-06).
 */
export function resolveEmailPolicy(type: string): EmailPolicy | undefined {
  return Object.prototype.hasOwnProperty.call(NOTIFICATION_EMAIL_POLICY, type)
    ? NOTIFICATION_EMAIL_POLICY[type]
    : undefined;
}
