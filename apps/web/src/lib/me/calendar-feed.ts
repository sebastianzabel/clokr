// Issue #597 (Phase 851): the client of the own calendar subscription „Mein Dienstplan“ -
// /api/v1/me/calendar-feed (Unterbau token, API #903). The secret URL exists only in the answer to
// create/rotate; the web never stores it and the status read never contains it.
import { api, ApiError } from "$api/client";
import { hasAnyPermission, type PermissionHolder } from "$lib/permissions";

/** The own-read permissions the feed is built from; creating a feed needs at least one of them,
 *  exactly as `POST /me/calendar-feed` and every poll of the feed check (API #903). */
export const CALENDAR_FEED_PERMISSIONS = [
  "shift:read:EIGENE",
  "leave-request:read:EIGENE",
] as const;

/** May this person set up the subscription? The API's rule: an employee profile and at least one
 *  of the feed permissions. Decided by permission only, never by a role. */
export function canSubscribeCalendar(
  user: (PermissionHolder & { employeeId?: string | null }) | null | undefined,
): boolean {
  return !!user?.employeeId && hasAnyPermission(user, CALENDAR_FEED_PERMISSIONS);
}

export interface CalendarFeedState {
  active: boolean;
  createdAt: string | null;
  rotatedAt: string | null;
  lastUsedAt: string | null;
}

export interface CalendarFeedIssued extends CalendarFeedState {
  url: string;
  webcalUrl: string;
}

/** The own feed state; null while the API offers no feed (route absent, API key, no rights). */
export async function loadCalendarFeed(): Promise<CalendarFeedState | null> {
  try {
    return await api.get<CalendarFeedState>("/me/calendar-feed");
  } catch (e) {
    if (e instanceof ApiError && [400, 403, 404].includes(e.status)) return null;
    throw e;
  }
}

/** Creates the link or replaces it; the old link stops working at once. */
export function issueCalendarFeed(): Promise<CalendarFeedIssued> {
  return api.post<CalendarFeedIssued>("/me/calendar-feed", {});
}

export function revokeCalendarFeed(): Promise<void> {
  return api.delete<void>("/me/calendar-feed");
}

/** "zuletzt abgerufen …" in German, or the never-polled wording. */
export function lastUsedText(state: CalendarFeedState): string {
  if (!state.lastUsedAt) return "Noch nicht von einem Kalender abgerufen";
  const d = new Date(state.lastUsedAt);
  return `Zuletzt abgerufen am ${d.toLocaleDateString("de-DE")} um ${d.toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
  })} Uhr`;
}
