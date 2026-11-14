/**
 * Issue #942 — an own entry of an EARLIER day that was never clocked out („Ausstempeln fehlt“).
 *
 * Mein Tag reads today's clock state from today's rows only (`resolveDayState`), exactly like the
 * clock resolver decides per day (`openEntryOf`, Issue #70). An entry left open on a previous day is
 * therefore invisible on the stage, while Zeiten shows it as „läuft seit … · Ausstempeln fehlt“.
 * This module is the ONE place that
 *  - picks that entry from the own rows of a past window (`openEarlierEntry`),
 *  - words the hint of the stage (`openEarlierEntryText`),
 *  - builds the link into the existing edit flow of Zeiten (`endEntryHref`), and
 *  - resolves that link on the Zeiten side (`entryToEndFromParam`).
 *
 * No figure is computed: an open entry counts 0 everywhere (the saldo counts closed entries only),
 * and ending it goes through the unchanged `PUT /time-entries/:id` of the Zeiten edit dialog.
 */
import { isTravelRow, type TravelRowFields } from "$lib/time-entries/travel-entry-form";

/**
 * How far back Mein Tag looks for an open entry: the window of the team's „Ausstempeln fehlt“
 * tasks (`OPEN_TASKS_WINDOW_DAYS`, `apps/api/src/composition/tasks-open.ts`).
 */
export const OPEN_ENTRY_WINDOW_DAYS = 62;

/** The fields of one `GET /time-entries` row this module reads. */
export interface OpenEntryCandidate extends TravelRowFields {
  id: string;
  /** The entry's own calendar day (`@db.Date`, ISO), as the list sends it. */
  date?: string | null;
  startTime: string;
  endTime: string | null;
  isLocked?: boolean | null;
}

export interface OpenEarlierEntry {
  id: string;
  /** The entry's calendar day, `YYYY-MM-DD`. */
  day: string;
  startTime: string;
  /** How many open entries of earlier days exist (this one included). */
  count: number;
}

/** The calendar day of a row: its `date` column, else the local day of its start. */
export function entryDay(e: Pick<OpenEntryCandidate, "date" | "startTime">): string {
  if (e.date) return e.date.split("T")[0];
  const d = new Date(e.startTime);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * The oldest open entry of a day before `today` (it is closest to the month close), with the number
 * of such entries. A locked row (closed month) cannot be ended any more and is skipped; a travel row
 * is always closed and never a candidate. `null` when nothing is open.
 */
export function openEarlierEntry(
  rows: readonly OpenEntryCandidate[],
  today: string,
): OpenEarlierEntry | null {
  const open = rows
    .filter((e) => e.endTime === null && e.isLocked !== true && !isTravelRow(e))
    .map((e) => ({ e, day: entryDay(e) }))
    .filter((x) => x.day < today)
    .sort((a, b) =>
      a.day === b.day ? a.e.startTime.localeCompare(b.e.startTime) : a.day.localeCompare(b.day),
    );
  if (open.length === 0) return null;
  const first = open[0];
  return { id: first.e.id, day: first.day, startTime: first.e.startTime, count: open.length };
}

const WEEKDAY_SHORT = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d, 12);
  return `${WEEKDAY_SHORT[date.getDay()]}, ${d}.${m}.`;
}

function localHm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function previousDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d - 1, 12);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export interface OpenEarlierEntryText {
  /** The headline naming the day and the start time of the open entry (e.g. Monday 9.11., 00:27). */
  title: string;
  /** What it means and, where certain, what Einstempeln does today. */
  detail: string;
}

/**
 * The wording of the stage hint. The clock resolver looks back ONE day only (Phase 376: a shift
 * across midnight, bounded by the tenant's `autoDeleteOpenHours`), so for an entry older than
 * yesterday it is certain that clocking in today starts a new entry and leaves the old one open.
 * For yesterday's entry the outcome depends on that tenant bound, so nothing is promised.
 */
export function openEarlierEntryText(entry: OpenEarlierEntry, today: string): OpenEarlierEntryText {
  const title = `Dein Eintrag vom ${dayLabel(entry.day)} ist noch offen – seit ${localHm(entry.startTime)}.`;
  const parts = ["Trag sein Ende ein – solange es fehlt, zählt die Zeit nicht."];
  if (entry.day < previousDay(today)) {
    parts.push("Einstempeln beginnt heute einen neuen Eintrag, der offene bleibt offen.");
  }
  if (entry.count > 1) {
    parts.push(`Insgesamt sind ${entry.count} Einträge früherer Tage offen.`);
  }
  return { title, detail: parts.join(" ") };
}

/** The query parameter that asks Zeiten to open the edit dialog of an open entry. */
export const END_ENTRY_PARAM = "end";

/** The link from Mein Tag into the existing „Ende eintragen“ flow of Zeiten. */
export function endEntryHref(entry: Pick<OpenEarlierEntry, "id" | "day">): string {
  return `/ich/zeiten?date=${entry.day}&${END_ENTRY_PARAM}=${encodeURIComponent(entry.id)}`;
}

/**
 * Zeiten side: the entry the `?end=` parameter names, only when it is among the ALREADY LOADED own
 * rows, still open and not locked. An unknown, closed or locked id resolves to `null` — nothing
 * opens, nothing throws, and the URL reveals nothing about other ids.
 */
export function entryToEndFromParam<T extends OpenEntryCandidate>(
  rows: readonly T[] | null | undefined,
  raw: string | null | undefined,
): T | null {
  if (!raw) return null;
  const hit = (rows ?? []).find((e) => e.id === raw);
  if (!hit || hit.endTime !== null || hit.isLocked === true || isTravelRow(hit)) return null;
  return hit;
}
