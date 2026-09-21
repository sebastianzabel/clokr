/**
 * month-close-notification.ts — how a blocked/deferred Monatsabschluss is NAMED and LINKED.
 *
 * Phase 292 (GitHub issue #292). Two senders now report the same subject — the daily cron
 * (`MONTH_CLOSE_BLOCKED`, "the blocked set changed") and the weekly escalation
 * (`MONTH_CLOSE_DEFERRED`, "it is still blocked, and it is N months old"). They must name the
 * same month and link to the same place, so both read these helpers.
 *
 * ── Why the deep link carries year+month ─────────────────────────────────────────────────────
 * The cron's notification used to link to a bare `/admin/month-close`, which opens on the
 * CURRENT year with nothing expanded, and its title named `prevMonth` — the ceiling of the
 * backfill range, not the month that is actually blocked. For the production case measured in
 * issue #292 (blocked since May, measured in September) that produced "Monatsabschluss August
 * 2026 nicht möglich" pointing at a page where August looks fine. The recipient is told the
 * wrong month and handed a link that confirms the wrong month. Both helpers below take the
 * OLDEST affected month, and the link names it.
 */

import { createHash } from "node:crypto";
import type { MonthKey } from "./month-close-window";

/**
 * `Notification.relatedType` for every message about a blocked or deferred Monatsabschluss.
 *
 * It is not a model name (there is no `MonthCloseDeferral` table — the state is derived, see
 * `deferred-month-close.ts`); it is the dedup namespace both senders share, so
 * `dismissByRelated()` and the "is one already open?" guard cannot drift apart by a typo.
 */
export const MONTH_CLOSE_DEFERRAL_RELATED_TYPE = "MonthCloseDeferral";

/** "Juni 2026" — the German month label used in notification titles. */
export function monthLabelDe(month: MonthKey): string {
  return new Date(
    `${month.year}-${String(month.month).padStart(2, "0")}-15T00:00:00Z`,
  ).toLocaleDateString("de-DE", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** Deep link into the Monatsabschluss admin page, preselecting and expanding that month. */
export function monthCloseDeepLink(month: MonthKey): string {
  return `/admin/month-close?year=${month.year}&month=${month.month}`;
}

/** The oldest of a set of months. Throws on an empty set — callers guard on length first. */
export function oldestMonth(months: MonthKey[]): MonthKey {
  return months.reduce((oldest, m) =>
    m.year < oldest.year || (m.year === oldest.year && m.month < oldest.month) ? m : oldest,
  );
}

/**
 * A stable fingerprint of "who is blocked, for which month".
 *
 * The daily cron used to write one notification per manager PER RUN for an unchanged blocked
 * set — measured: `notify()` has no deduplication, and the blocked set is rebuilt on every run,
 * so a four-month deferral produced ~120 identical bell entries per manager. That is the
 * habituation failure issue #292 names: a message that arrives every morning saying exactly what
 * it said yesterday stops being read. Keyed on this fingerprint, the cron now notifies when the
 * blocked set CHANGES; the weekly `MONTH_CLOSE_DEFERRED` escalation carries the recurring duty.
 */
export function blockedSetFingerprint(
  entries: Array<{ employeeId: string; year: number; month: number }>,
): string {
  const canonical = entries
    .map((e) => `${e.employeeId}@${e.year}-${String(e.month).padStart(2, "0")}`)
    .sort()
    .join("|");
  return createHash("sha1").update(canonical).digest("hex").slice(0, 16);
}
