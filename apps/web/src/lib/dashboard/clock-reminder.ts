/**
 * What a tap on a shift reminder does on the dashboard (Issue #609, D-09/D-14, AC-4).
 *
 * The reminder notification only NAVIGATES to `/dashboard?clock=1`. This module decides what such
 * an arrival does and words the confirmation; it issues no request of its own. The one and only
 * stamp stays the dashboard's unchanged `handleClock()`, run after an explicit confirm, so a
 * crafted link can at most open a dialog (T-609-22) and a tap on a stale reminder never stamps
 * the opposite of what the person sees (T-609-23).
 */
import type { DayStateKind } from "$lib/dashboard/day-state";

export type ClockReminderAction = "wait" | "none" | "confirm-in" | "confirm-out" | "focus-card";

export interface ClockReminderInput {
  /** The value of the `clock` query parameter, `null` when absent. */
  param: string | null;
  /** The page cannot decide yet (data or router not ready): nothing may happen. */
  loading: boolean;
  /** A § 18 ArbZG-exempt person has no clock card. */
  isExempt: boolean;
  dayKind: DayStateKind;
  /** The salon choice is required and not made yet (the idle clock-in is blocked). */
  clockInBlocked: boolean;
}

export interface ClockReminderDialog {
  title: string;
  description: string;
  confirmLabel: string;
}

/** The query parameter the reminder link carries; only the value "1" arms the confirmation. */
export const CLOCK_REMINDER_PARAM = "clock";

export function clockReminderAction(input: ClockReminderInput): ClockReminderAction {
  if (input.param !== "1") return "none";
  if (input.loading) return "wait";
  if (input.isExempt) return "none";
  if (input.dayKind === "finished") return "none";
  if (input.dayKind === "running") return "confirm-out";
  return input.clockInBlocked ? "focus-card" : "confirm-in";
}

function hhmm(now: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timeZone ? { timeZone } : {}),
  }).format(now);
}

/** Title, text and button of the confirmation; the time is the person's current time. */
export function clockReminderDialog(
  action: "confirm-in" | "confirm-out",
  now: Date,
  timeZone?: string,
): ClockReminderDialog {
  const time = hhmm(now, timeZone);
  if (action === "confirm-in") {
    return {
      title: "Jetzt einstempeln?",
      description: `Du stempelst jetzt um ${time} ein.`,
      confirmLabel: "Einstempeln",
    };
  }
  return {
    title: "Jetzt ausstempeln?",
    description: `Du stempelst jetzt um ${time} aus.`,
    confirmLabel: "Ausstempeln",
  };
}

/** Path, query and hash of `url` without the `clock` parameter; other parameters are kept. */
export function stripClockParam(url: URL): string {
  if (!url.searchParams.has(CLOCK_REMINDER_PARAM)) return url.pathname + url.search + url.hash;
  const next = new URL(url.href);
  next.searchParams.delete(CLOCK_REMINDER_PARAM);
  return next.pathname + next.search + next.hash;
}
