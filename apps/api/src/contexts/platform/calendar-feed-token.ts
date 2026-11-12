/**
 * Issue #597 — the ONE module of the calendar-feed token („Mein Dienstplan“ als Kalender-Abo).
 *
 * A calendar app cannot send a header, so a subscribable feed carries its secret in the URL. That
 * makes the token a capability: whoever holds the link reads the feed. The trade-off is accepted
 * and kept small (decision on #597):
 *   - the token is 32 random bytes (base64url, 43 characters); only its SHA-256 is stored, and the
 *     token itself is returned exactly once (on creation or rotation);
 *   - one token per user; rotating replaces it (the old link stops working at once), revoking
 *     deletes it;
 *   - the feed reads only the person's own data and only while the user is active, the tenant is
 *     active and the user still holds the own-read permissions the feed is built from — so a role
 *     removal, a deactivation or an anonymization ends the link without any extra step;
 *   - the feed is minimal (no free-text notes, no names of other persons, sick leave shown neutrally);
 *   - the token is never logged in clear (`redactCalendarFeedPath`).
 * Every invalid state (unknown, revoked, malformed, inactive) answers the same way: `null` here,
 * one identical 404 in the route.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Prisma } from "@clokr/db";
import { ACTIVE_TENANT_WHERE } from "./tenant-status";
import { effectivePermissionKeysForUser } from "./request-permissions";
import { NOT_ANONYMIZED_EMPLOYEE_WHERE } from "./employee-anonymization-filter";

/** Base64url of 32 bytes is 43 characters. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** `lastUsedAt` is refreshed at most this often (a calendar app polls every few minutes). */
const LAST_USED_THROTTLE_MS = 60 * 60 * 1000;

export function generateCalendarFeedToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashCalendarFeedToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The feed path below the API prefix; the token travels as the `token` query parameter. */
export const CALENDAR_FEED_PATH = "/api/v1/calendar-feed/dienstplan.ics";

/** Replaces a calendar-feed token in a request URL so it never reaches a log line. */
export function redactCalendarFeedPath(url: string): string {
  if (!url.includes("/calendar-feed/")) return url;
  return url.replace(/([?&]token=)[^&#]*/g, "$1[ausgeblendet]");
}

export type CalendarFeedTokenState = {
  active: boolean;
  createdAt: Date | null;
  rotatedAt: Date | null;
  lastUsedAt: Date | null;
};

type Db = Prisma.TransactionClient;

export async function calendarFeedTokenState(
  db: Db,
  tenantId: string,
  userId: string,
): Promise<CalendarFeedTokenState> {
  const row = await db.calendarFeedToken.findFirst({
    where: { userId, tenantId },
    select: { createdAt: true, rotatedAt: true, lastUsedAt: true },
  });
  return {
    active: row !== null,
    createdAt: row?.createdAt ?? null,
    rotatedAt: row?.rotatedAt ?? null,
    lastUsedAt: row?.lastUsedAt ?? null,
  };
}

/**
 * Creates the user's token or rotates it (a new secret, the old one is gone). Returns the token in
 * clear — the only moment it exists outside the caller's calendar app — and whether it rotated.
 */
export async function issueCalendarFeedToken(
  db: Db,
  tenantId: string,
  userId: string,
): Promise<{ token: string; rotated: boolean; id: string }> {
  const token = generateCalendarFeedToken();
  const tokenHash = hashCalendarFeedToken(token);
  const existing = await db.calendarFeedToken.findFirst({
    where: { userId, tenantId },
    select: { id: true },
  });
  if (existing) {
    await db.calendarFeedToken.update({
      where: { id: existing.id, tenantId },
      data: { tokenHash, rotatedAt: new Date(), lastUsedAt: null },
    });
    return { token, rotated: true, id: existing.id };
  }
  const created = await db.calendarFeedToken.create({
    data: { tenantId, userId, tokenHash },
    select: { id: true },
  });
  return { token, rotated: false, id: created.id };
}

/** Deletes the user's token; returns its id, or `null` when there was none. */
export async function revokeCalendarFeedToken(
  db: Db,
  tenantId: string,
  userId: string,
): Promise<string | null> {
  const existing = await db.calendarFeedToken.findFirst({
    where: { userId, tenantId },
    select: { id: true },
  });
  if (!existing) return null;
  await db.calendarFeedToken.deleteMany({ where: { id: existing.id, tenantId } });
  return existing.id;
}

/** DSGVO anonymization: the person's feed token goes (not retention-relevant). */
export async function deleteCalendarFeedTokensOfUser(
  db: Db,
  tenantId: string,
  userId: string,
): Promise<number> {
  const removed = await db.calendarFeedToken.deleteMany({ where: { userId, tenantId } });
  return removed.count;
}

export type ResolvedCalendarFeed = {
  tokenId: string;
  tenantId: string;
  userId: string;
  employeeId: string;
  /** `shift:read:EIGENE` — the feed's shifts. */
  shifts: boolean;
  /** `leave-request:read:EIGENE` — the feed's leave. */
  leave: boolean;
};

/**
 * Resolves a raw feed token to its person, or `null` for every invalid state: malformed, unknown,
 * an inactive user, a deactivated tenant, no employee, an anonymized person, or neither own-read
 * permission. Refreshes `lastUsedAt` at most once per hour (no audit row per poll).
 */
export async function resolveCalendarFeedToken(
  db: Db,
  rawToken: string,
  now: Date = new Date(),
): Promise<ResolvedCalendarFeed | null> {
  if (!TOKEN_PATTERN.test(rawToken)) return null;
  const row = await db.calendarFeedToken.findUnique({
    where: { tokenHash: hashCalendarFeedToken(rawToken) },
    select: { id: true, tenantId: true, userId: true, lastUsedAt: true },
  });
  if (!row) return null;
  const [user, tenant, employee] = await Promise.all([
    db.user.findFirst({ where: { id: row.userId, isActive: true }, select: { id: true } }),
    db.tenant.findFirst({
      where: { id: row.tenantId, ...ACTIVE_TENANT_WHERE },
      select: { id: true },
    }),
    db.employee.findFirst({
      where: { userId: row.userId, tenantId: row.tenantId, ...NOT_ANONYMIZED_EMPLOYEE_WHERE },
      select: { id: true },
    }),
  ]);
  if (!user || !tenant || !employee) return null;
  const keys = new Set(await effectivePermissionKeysForUser(db, row.userId, row.tenantId));
  const shifts = keys.has("shift:read:EIGENE");
  const leave = keys.has("leave-request:read:EIGENE");
  if (!shifts && !leave) return null;
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
    await db.calendarFeedToken.updateMany({
      where: { id: row.id, tenantId: row.tenantId },
      data: { lastUsedAt: now },
    });
  }
  return {
    tokenId: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    employeeId: employee.id,
    shifts,
    leave,
  };
}
