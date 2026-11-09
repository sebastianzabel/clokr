/**
 * Issue #849 (4), #845 D-05 — the ONE text source of the time-entry sentences in the "Verlauf".
 *
 * Before, every TimeEntry became ONE item: the subject "Du" plus an infinitive fragment naming only
 * the end time. An entry with an end lost its clock-in, an entry an admin typed in read as if the
 * person had stamped it, and five manual entries ending at the same minute gave five identical lines.
 *
 * Now:
 * - a CLOCKED entry (NFC, web/mobile, WLAN) gives up to two events, a clock-in sentence at its start
 *   and a clock-out sentence at its end, each a complete sentence in the second person;
 * - a RECORDED entry (manual form, correction, or created by another person) gives one event that
 *   names the day and the span, with its author as the subject (the author's first name, or "Du");
 * - `dedupeActivitySentences()` drops a time-entry line whose sentence repeats one already shown.
 *
 * The API returns `who` (the bold subject) and `what` (the rest of the sentence); the web renders
 * `who` + " " + `what`, so together they are one complete German sentence. Pure — no Prisma.
 */
import { formatInTimeZone } from "date-fns-tz";

export interface EntryForActivity {
  id: string;
  startTime: Date;
  endTime: Date | null;
  createdAt: Date;
  source: string;
  createdBy: string | null;
}

export interface EntryActivityEvent {
  id: string;
  who: string;
  what: string;
  when: string;
}

const CLOCK_SOURCES = new Set(["NFC", "MOBILE", "WIFI"]);

/** Neutral subject when the author of an entry cannot be named (deleted or anonymised account). */
export const UNKNOWN_AUTHOR = "Jemand aus deinem Team";

function hhmm(d: Date, tz: string): string {
  return formatInTimeZone(d, tz, "HH:mm");
}

const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

function dayLabel(d: Date, tz: string): string {
  // "Mo, 02.11." — short German weekday (ISO 1 = Monday), day and month in the tenant time zone.
  const isoWeekday = Number(formatInTimeZone(d, tz, "i"));
  return `${WEEKDAYS[isoWeekday - 1]}, ${formatInTimeZone(d, tz, "dd.MM.")}`;
}

export function entryActivityEvents(
  entry: EntryForActivity,
  ctx: { tz: string; ownUserId: string; authorFirstName: string | null },
): EntryActivityEvent[] {
  const byOther = entry.createdBy !== null && entry.createdBy !== ctx.ownUserId;
  const clocked = CLOCK_SOURCES.has(entry.source) && !byOther;

  if (clocked) {
    const events: EntryActivityEvent[] = [
      {
        id: `te-${entry.id}-in`,
        who: "Du",
        what: `hast um ${hhmm(entry.startTime, ctx.tz)} eingestempelt.`,
        when: entry.startTime.toISOString(),
      },
    ];
    if (entry.endTime) {
      events.push({
        id: `te-${entry.id}-out`,
        who: "Du",
        what: `hast um ${hhmm(entry.endTime, ctx.tz)} ausgestempelt.`,
        when: entry.endTime.toISOString(),
      });
    }
    return events;
  }

  const span = entry.endTime
    ? `${hhmm(entry.startTime, ctx.tz)}–${hhmm(entry.endTime, ctx.tz)}`
    : `ab ${hhmm(entry.startTime, ctx.tz)}`;
  const day = dayLabel(entry.startTime, ctx.tz);
  return [
    {
      id: `te-${entry.id}`,
      who: byOther ? ctx.authorFirstName?.trim() || UNKNOWN_AUTHOR : "Du",
      what: byOther
        ? `hat für dich ${day} ${span} eingetragen.`
        : `hast für ${day} ${span} eingetragen.`,
      when: entry.createdAt.toISOString(),
    },
  ];
}

/**
 * Keeps the first (newest) time-entry item of every distinct sentence; the input is sorted newest
 * first. Only `category: "time"` items are compared — two different leave requests may share their
 * wording and are still two events.
 */
export function dedupeActivitySentences<T extends { who: string; what: string; category?: string }>(
  items: T[],
): T[] {
  const seen = new Set<string>();
  return items.filter((it) => {
    if (it.category !== undefined && it.category !== "time") return true;
    const key = `${it.who} ${it.what}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
