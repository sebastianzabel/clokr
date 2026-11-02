/**
 * Issue #610 (D-10 refined, P-610-18) - the re-couple hint: a person whose QR-coupled phone has not
 * shown up on several recent shift days is told, once, to couple it again.
 *
 * Definition of "seen": `PresenceDevice.lastSeenAt` is the time of the last presence EVENT the
 * adapter posted (connected or disconnected). The adapter posts on transitions only, so a phone
 * that stays connected for days also produces no event. That is why only days the person clocked
 * by a NON-WiFi source count: on such a day the person was at work but the WLAN did not clock them,
 * which is exactly the failure this hint is about. A phone that is permanently in range would have
 * clocked them.
 *
 * Outage guard: if the adapter or the box was down, EVERY device looks gone. A tenant whose newest
 * event signal (a source's `lastUsedAt`, a device's `lastSeenAt`) is older than the window gets no
 * hint at all.
 *
 * This module decides and notifies. It reads no saldo, takes no clock decision and writes nothing
 * but notices.
 */

/** Number of recent qualifying shift days the phone must have been missing on. */
export const WIFI_HINT_SHIFT_DAYS = 3;
/** How far back (calendar days before today) a qualifying day may lie. */
export const WIFI_HINT_LOOKBACK_DAYS = 28;

const byDayDesc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);

export interface QualifyingDaysInput {
  /** Tenant-local day keys (YYYY-MM-DD) on which the person has a non-deleted shift. */
  shiftDays: Iterable<string>;
  /** Tenant-local day keys on which the person has a closed, non-deleted, non-WIFI WORK entry. */
  entryDays: Iterable<string>;
  /** Tenant-local today; a qualifying day lies strictly before it. */
  today: string;
  /** Oldest allowed day, inclusive. */
  lookbackStart: string;
}

/** The days present in both sets, strictly before today, from the look-back start on, newest first. */
export function qualifyingDays(input: QualifyingDaysInput): string[] {
  const entries = new Set(input.entryDays);
  const days = new Set<string>();
  for (const day of input.shiftDays) {
    if (day < input.today && day >= input.lookbackStart && entries.has(day)) days.add(day);
  }
  return [...days].sort(byDayDesc);
}

export interface RecoupleHintInput {
  /** Last presence event of the device; null until the first one after the pairing. */
  lastSeenAt: Date | null;
  /** When the device was coupled; a fresh pairing is a sign of life too. */
  addedAt: Date;
  /** Output of {@link qualifyingDays}, newest first. */
  qualifyingDaysDesc: string[];
  /** The tenant-local start of a day key as an instant. */
  dayStart: (day: string) => Date;
  /** Creation time of the newest hint notice for this device (any dismissal state), else null. */
  lastNoticeAt: Date | null;
  /** Newest event signal of the whole tenant (see the outage guard), else null. */
  tenantSignalAt: Date | null;
}

export type RecoupleHintReason =
  "FEWER_THAN_THREE_DAYS" | "SEEN_IN_WINDOW" | "ADAPTER_SILENT" | "ALREADY_NOTIFIED";

export type RecoupleHintDecision =
  { hint: true; sinceDay: string } | { hint: false; reason: RecoupleHintReason };

/**
 * Decide whether the person gets the hint for this device.
 *
 * `sinceDay` is the third-newest qualifying day: the phone showed no sign of life since the start of
 * that day. One hint per "unseen episode": a notice newer than the last sign of life (event or
 * pairing) means the person was already told; a later event re-arms it.
 */
export function decideRecoupleHint(input: RecoupleHintInput): RecoupleHintDecision {
  if (input.qualifyingDaysDesc.length < WIFI_HINT_SHIFT_DAYS) {
    return { hint: false, reason: "FEWER_THAN_THREE_DAYS" };
  }
  const sinceDay = input.qualifyingDaysDesc[WIFI_HINT_SHIFT_DAYS - 1];
  const windowStart = input.dayStart(sinceDay);

  const lastSign =
    input.lastSeenAt !== null && input.lastSeenAt > input.addedAt
      ? input.lastSeenAt
      : input.addedAt;
  if (lastSign >= windowStart) return { hint: false, reason: "SEEN_IN_WINDOW" };

  if (input.tenantSignalAt === null || input.tenantSignalAt < windowStart) {
    return { hint: false, reason: "ADAPTER_SILENT" };
  }
  if (input.lastNoticeAt !== null && input.lastNoticeAt > lastSign) {
    return { hint: false, reason: "ALREADY_NOTIFIED" };
  }
  return { hint: true, sinceDay };
}
