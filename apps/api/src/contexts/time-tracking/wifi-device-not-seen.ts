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

import type { FastifyInstance } from "fastify";
import {
  ACTIVE_TENANT_WHERE, // Phase 88 (D-05a): a deactivated tenant is a suspended customer - no notices
  accessContextForJob,
  employeeScopeFor,
  reportPopulationWhere,
} from "../platform";
import { dateStrInTz, dayRangeUtc, getTenantTimezone } from "../working-time-account";
import { getShiftsInRange } from "../scheduling";

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

// ── The daily job (Feature 11 of the attendance checker) ──────────────────────────────────────

const NOTICE_TYPE = "WIFI_DEVICE_NOT_SEEN";
const DAY_MS = 86_400_000;

/**
 * Tells every person with a QR-coupled phone that went silent on their recent manually clocked
 * shift days to couple it again, and dismisses the open notice of a phone that showed up since.
 *
 * Read-only apart from notify/dismiss, and deliberately unaudited: a notice is no business mutation
 * (the Feature 9/10 precedent). The only recipient is the person's own user, never a manager.
 */
export async function checkWifiDevicesNotSeen(
  app: FastifyInstance,
  now: Date = new Date(),
): Promise<void> {
  app.log.info("Attendance checker: checking WLAN devices that were not seen (Feature 11)");
  try {
    const tenants = await app.prisma.tenant.findMany({
      where: ACTIVE_TENANT_WHERE,
      select: { id: true },
    });
    for (const tenant of tenants) {
      try {
        await checkTenant(app, tenant.id, now);
      } catch (err) {
        app.log.error({ err, tenantId: tenant.id }, "WLAN not-seen check failed for a tenant");
      }
    }
  } catch (err) {
    app.log.error({ err }, "WLAN not-seen check failed");
  }
}

async function checkTenant(app: FastifyInstance, tenantId: string, now: Date): Promise<void> {
  const prisma = app.prisma;
  const tz = await getTenantTimezone(prisma, tenantId);

  // Day keys by calendar arithmetic on the tenant-local today at 12:00 UTC (the Feature 10 idiom),
  // never the ISO rendering of a raw instant near midnight.
  const today = dateStrInTz(now, tz);
  const todayNoon = new Date(`${today}T12:00:00Z`);
  const dayKey = (daysAgo: number) =>
    new Date(todayNoon.getTime() - daysAgo * DAY_MS).toISOString().slice(0, 10);
  const yesterday = dayKey(1);
  const lookbackStart = dayKey(WIFI_HINT_LOOKBACK_DAYS);
  const fromDate = new Date(`${lookbackStart}T00:00:00Z`); // @db.Date columns: calendar-day bounds
  const toDate = new Date(`${yesterday}T00:00:00Z`);

  // QR devices of consenting, active people who are employed today and were never anonymised
  // (review IN-04: the one population rule of #613 - an exited person gets no hint).
  const todayRange = dayRangeUtc(today, tz);
  const devices = await prisma.presenceDevice.findMany({
    where: {
      tenantId,
      pairedVia: "QR",
      employee: {
        tenantId,
        wifiPresenceEnabled: true,
        user: { isActive: true },
        ...reportPopulationWhere(todayRange.start, todayRange.end),
      },
    },
    select: {
      id: true,
      employeeId: true,
      addedAt: true,
      lastSeenAt: true,
      employee: { select: { userId: true } },
    },
  });
  if (devices.length === 0) return;

  // The adapter-outage guard: the newest event signal of the whole tenant.
  const [sourceSignal, deviceSignal] = await Promise.all([
    prisma.presenceSource.aggregate({
      where: { tenantId, isActive: true, revokedAt: null, deletedAt: null },
      _max: { lastUsedAt: true },
    }),
    prisma.presenceDevice.aggregate({ where: { tenantId }, _max: { lastSeenAt: true } }),
  ]);
  const signals = [sourceSignal._max.lastUsedAt, deviceSignal._max.lastSeenAt].filter(
    (d): d is Date => d !== null,
  );
  const tenantSignalAt =
    signals.length === 0 ? null : new Date(Math.max(...signals.map((d) => d.getTime())));

  // Shift days and manually clocked days per person.
  const employeeIds = [...new Set(devices.map((d) => d.employeeId))];
  const shifts = await getShiftsInRange(
    prisma,
    employeeScopeFor(accessContextForJob(tenantId, "wifi-device-not-seen"), { employeeIds }),
    fromDate,
    toDate,
  );
  const entries = await prisma.timeEntry.findMany({
    where: {
      employeeId: { in: employeeIds },
      employee: { tenantId },
      deletedAt: null,
      type: "WORK",
      isInvalid: false, // review IN-04: only valid closed entries show that the person was at work
      endTime: { not: null },
      source: { not: "WIFI" },
      date: { gte: fromDate, lte: toDate },
    },
    select: { employeeId: true, date: true },
  });
  const shiftDays = new Map<string, Set<string>>();
  for (const shift of shifts) {
    const set = shiftDays.get(shift.employeeId) ?? new Set<string>();
    set.add(shift.date.toISOString().slice(0, 10));
    shiftDays.set(shift.employeeId, set);
  }
  const entryDays = new Map<string, Set<string>>();
  for (const entry of entries) {
    const set = entryDays.get(entry.employeeId) ?? new Set<string>();
    set.add(entry.date.toISOString().slice(0, 10));
    entryDays.set(entry.employeeId, set);
  }

  // Every earlier notice of these devices, in any dismissal state (the dedupe key).
  const notices = await prisma.notification.findMany({
    where: {
      type: NOTICE_TYPE,
      relatedType: "PresenceDevice",
      relatedId: { in: devices.map((d) => d.id) },
    },
    select: { relatedId: true, createdAt: true, dismissedAt: true },
  });
  const noticeState = new Map<string, { newest: Date; open: boolean }>();
  for (const n of notices) {
    if (n.relatedId === null) continue;
    const state = noticeState.get(n.relatedId) ?? { newest: n.createdAt, open: false };
    if (n.createdAt > state.newest) state.newest = n.createdAt;
    if (n.dismissedAt === null) state.open = true;
    noticeState.set(n.relatedId, state);
  }

  const counts: Record<string, number> = {};
  const count = (key: string) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };

  for (const device of devices) {
    // One failing person (a notify error, a dismiss error) must not abort the other devices of the
    // tenant for the day (review IN-04).
    try {
      const notice = noticeState.get(device.id) ?? null;
      const lastSign =
        device.lastSeenAt !== null && device.lastSeenAt > device.addedAt
          ? device.lastSeenAt
          : device.addedAt;

      // A sign of life after the open notice makes it obsolete.
      if (notice !== null && notice.open && lastSign > notice.newest) {
        await app.dismissByRelated("PresenceDevice", device.id, NOTICE_TYPE);
        count("DISMISSED");
      }

      const decision = decideRecoupleHint({
        lastSeenAt: device.lastSeenAt,
        addedAt: device.addedAt,
        qualifyingDaysDesc: qualifyingDays({
          shiftDays: shiftDays.get(device.employeeId) ?? [],
          entryDays: entryDays.get(device.employeeId) ?? [],
          today,
          lookbackStart,
        }),
        dayStart: (day) => dayRangeUtc(day, tz).start,
        lastNoticeAt: notice?.newest ?? null,
        tenantSignalAt,
      });
      if (!decision.hint) {
        count(decision.reason);
        continue;
      }

      await app.notify({
        userId: device.employee.userId,
        type: "WIFI_DEVICE_NOT_SEEN",
        title: "Handy neu koppeln",
        message:
          "Dein Handy wurde an deinen letzten Arbeitstagen im Salon-WLAN nicht erkannt. Bitte koppel es über den QR-Code im Salon neu.",
        link: "/settings",
        tenantId,
        relatedType: "PresenceDevice",
        relatedId: device.id,
      });
      count("NOTIFIED");
    } catch (err) {
      count("FAILED");
      app.log.error(
        { err, tenantId, deviceId: device.id },
        "WLAN not-seen check failed for a device",
      );
    }
  }

  // Counts per reason only: no names, no MAC addresses.
  app.log.info({ tenantId, counts }, "WLAN not-seen check finished for a tenant");
}
