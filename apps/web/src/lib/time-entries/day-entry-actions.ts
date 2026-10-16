/**
 * day-entry-actions.ts
 *
 * Issue #70 (D-07/D-12) — the presentation decisions of the two time-entry pages once a day may
 * hold several entries: what a calendar cell opens, what "Neuer Eintrag" opens, which salons the
 * form offers, which salon the page sends, and the tooltip of a multi-entry cell.
 *
 * Presentation only. The server decides validity, the salon, an overlap (409) and the month lock;
 * nothing here is an access rule, and the header salon selection is deliberately not an input
 * (`selectedSalonId` is a view filter, never a booking salon).
 *
 * Pure module: `date-fns` formatting only, so it is unit-testable without a mounted page (this
 * repo's vitest setup does not mount route pages).
 */
import { format } from "date-fns";

/** The default form of a day without entries, exactly what the pages always preset. */
const DEFAULT_START = "09:00";
const DEFAULT_END = "17:00";
/** Length of the preset for a further entry on a day that already has some. */
const PRESET_MINUTES = 60;
const LATEST_END = "23:59";

/** What the pages need of a loaded entry row to decide; the pages' own row types extend it. */
export interface DayEntryRow {
  id: string;
  date?: string | null;
  startTime: string;
  endTime: string | null;
  /** The salon the entry was recorded in. */
  salonId?: string | null;
  /** Display name of that salon, served by `GET /time-entries` since 70b-06. */
  salonName?: string | null;
}

export interface SalonOption {
  id: string;
  name: string;
}

export type CellAction<T extends DayEntryRow> =
  { kind: "new" } | { kind: "edit"; entry: T } | { kind: "list" };

export type AddAction<T extends DayEntryRow> =
  { kind: "edit"; entry: T } | { kind: "new"; start: string; end: string };

/**
 * What clicking a calendar cell opens: nothing recorded -> the new form, exactly one entry -> that
 * entry for editing (the long-standing behaviour), several -> the list focused on the day.
 */
export function cellClickAction<T extends DayEntryRow>(dayEntries: readonly T[]): CellAction<T> {
  if (dayEntries.length === 0) return { kind: "new" };
  if (dayEntries.length === 1) return { kind: "edit", entry: dayEntries[0] };
  return { kind: "list" };
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function hhmmOf(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * What "Neuer Eintrag" (and "Weiteren Eintrag an diesem Tag") opens for a day.
 *
 * Without salon options (`multiEntryUi` false, D-12) the page behaves as it always did: a day with
 * an entry opens that entry (the first row), an empty day opens the 09:00-17:00 form. With salon
 * options a day with entries opens a NEW form whose start is the day's latest recorded end (a
 * second entry begins where the last one stopped) and whose end is an hour later, at most 23:59.
 * An entry still running has no end and sets nothing; a day with only a running entry falls back
 * to the default (the server refuses an overlap with it anyway).
 */
export function addActionForDay<T extends DayEntryRow>(
  dayEntries: readonly T[],
  multiEntryUi: boolean,
): AddAction<T> {
  if (!multiEntryUi && dayEntries.length > 0) return { kind: "edit", entry: dayEntries[0] };
  let latestEnd: string | null = null;
  for (const entry of dayEntries) {
    if (!entry.endTime) continue;
    const end = format(new Date(entry.endTime), "HH:mm");
    if (latestEnd === null || end > latestEnd) latestEnd = end;
  }
  if (!multiEntryUi || latestEnd === null) {
    return { kind: "new", start: DEFAULT_START, end: DEFAULT_END };
  }
  const end = Math.min(minutesOf(latestEnd) + PRESET_MINUTES, minutesOf(LATEST_END));
  return { kind: "new", start: latestEnd, end: hhmmOf(end) };
}

/**
 * The salons the entry form offers: the salons the caller reaches (from the salon-context store),
 * sorted by name, plus - when editing - the entry's own salon by its served name if the reach no
 * longer lists it (a deactivated salon, a salon outside today's reach). An entry whose answer
 * carries no name adds nothing; the form then simply cannot re-select it.
 */
export function salonFieldOptions(
  contextSalons: readonly SalonOption[],
  entry: DayEntryRow | null,
): SalonOption[] {
  const options = contextSalons.map((salon) => ({ id: salon.id, name: salon.name }));
  if (entry?.salonId && entry.salonName && !options.some((salon) => salon.id === entry.salonId)) {
    options.push({ id: entry.salonId, name: entry.salonName });
  }
  return options.sort((a, b) => a.name.localeCompare(b.name, "de") || a.id.localeCompare(b.id));
}

/**
 * The `salonId` the page sends with a save or a preview. A new entry sends the salon only when
 * one was picked (no pick: the server derives it); an edited entry only when the pick differs from
 * the entry's own salon (a salon change is an explicit act, never a side effect of saving).
 */
export function salonIdToSend(picked: string, entrySalonId: string | null): string | undefined {
  if (picked === "") return undefined;
  if (entrySalonId !== null && picked === entrySalonId) return undefined;
  return picked;
}

/** The tooltip of a calendar cell with several entries; none for zero or one. */
export function entryCountTitle(count: number): string | null {
  return count >= 2 ? `${count} Einträge` : null;
}
