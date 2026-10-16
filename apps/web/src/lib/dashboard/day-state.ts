/**
 * day-state.ts
 *
 * Phase 115 (GitHub issue #118) — the ONE derivation that answers "what is today's clock
 * state" for the dashboard, in THREE values instead of a boolean.
 *
 * Since Issue #70 (Phase 70b) a day may hold SEVERAL entries (one per stretch, possibly in different
 * salons). The three-state answer is unchanged — it names the entry a clock event acts on — and
 * `dayTotals()` below sums the whole day for the "Heutiger Eintrag" card.
 *
 * WHY THIS MODULE EXISTS: `dashboard/+page.svelte:159` held `let clockedIn = $state(false)`,
 * assigned only from `entries.find(e => !e.endTime)`. That predicate means "there is an entry
 * without endTime" — so "day finished" and "day not started" collapsed onto the same value,
 * while the "Heutiger Eintrag" card directly below — fed by the SAME HTTP response — read
 * `endTime` and said the opposite. In the reported incident an 8:21 h day that ended at 17:46
 * was labelled "Noch nicht eingestempelt / Bereit für deinen Tag" with an active Einstempeln
 * button at 20:50.
 *
 * VOCABULARY — taken from the server, not invented here:
 *
 *   server (apps/api/src/contexts/time-tracking/presence.ts) │ this module
 *   ────────────────────────────────────────┼────────────
 *   "clocked_in"  (presence.ts:150)         │ "running"
 *   "present"     (presence.ts:155)         │ "finished"
 *   neither                                 │ "idle"
 *
 * `apps/api/src/composition/dashboard.ts:1009-1017` uses the same discriminator under the names
 * clocked_in / complete / partial / none. We take the server's RULE and its WORDS and apply
 * them to the response the page already has, rather than fetching a second endpoint — see
 * the phase plan: sourcing the hero card from /dashboard/my-week while the entry card keeps
 * reading /time-entries would re-create the very two-source split this phase removes.
 *
 * ENTRY SELECTION — a deliberate mirror of `openEntryOf` / `latestEndingClosed`
 * (`apps/api/src/contexts/time-tracking/day-entries.ts`, Issue #70), the two selectors every
 * clock path uses: the open entry wins if there is one; otherwise the closed entry with the LATEST
 * `endTime`, ties going to the later start and then the larger id, and a trip between two salons
 * (Issue #92, kind TRAVEL) is never chosen. That is what makes the entry this
 * module names provably the entry the resolver would REOPEN — and therefore what makes
 * `reopenGapStartLabel()` able to state the gap-break start as fact.
 *
 * `isInvalid` IS DELIBERATELY NOT FILTERED. Since Phase 118 (Issue #124) the resolver's READ
 * lookup no longer filters it either — this module is therefore an exact mirror of the
 * server, no longer a deliberate divergence. Why the filter would be wrong at either end:
 *   - An `isInvalid: true` OPEN entry on today is reachable in production
 *     (`attendance-checker.ts` auto-invalidates open entries older than `autoDeleteOpenHours`,
 *     default 14 h, i.e. on the same calendar day; the resolver's START branch creates one
 *     directly when leave is CANCELLATION_REQUESTED).
 *   - WITH the filter such a day would resolve to "idle" → the card offers Einstempeln →
 *     the resolver's START branch refuses a second open entry of the day (the partial unique
 *     index `TimeEntry_employeeId_date_open_unique`, 409), and the user would get a conflict
 *     instead of the action they need.
 *   - WITHOUT the filter the day resolves to "running" → the card offers Ausstempeln → the
 *     resolver finds the open entry and closes it. Since Phase 118 that is the success case;
 *     before it, this ended in CONFLICT NOT_CLOCKED_IN → HTTP 409 (exactly the finding from
 *     Issue #124).
 * Do NOT reintroduce this filter here.
 *
 * HISTORY: Phase 115 set `resolver.ts`/`state-machine.ts` as its scope boundary and defused
 * the REOPEN semantics only on the UI side. Phase 118 (Issue #124) opened the resolver itself:
 * the READ lookup no longer filters `isInvalid`, and a row coupled to a PENDING Zeitnachtrag is
 * rejected as CONFLICT RETRO_PENDING. `state-machine.ts` remains unchanged. The REOPEN
 * semantics themselves stay regression-tested
 * (`services/clock/__tests__/consolidate.cross-source.test.ts`, 2026-06-04 prod incident).
 * This module still removes the ACCIDENTAL path into REOPEN. It is NOT an authorisation
 * control — anyone who calls POST /clock-in directly still reaches REOPEN, by design. Nothing
 * here may be mistaken for a security boundary.
 */

import { isTravelRow, type TravelRowFields } from "$lib/time-entries/travel-entry-form";

export type DayStateKind = "running" | "finished" | "idle";

/** The subset of a GET /api/v1/time-entries row this module needs. */
export interface ClockDayEntry extends TravelRowFields {
  id: string;
  startTime: string; // full ISO instant
  endTime: string | null; // full ISO instant or null
  breakMinutes?: number | null;
  isLocked?: boolean | null;
  isInvalid?: boolean | null;
  /** Issue #70 — the entry's own salon; only multi-salon tenants ever see it rendered. */
  salonId?: string;
  /** Issue #70 — display name of `salonId` (GET /time-entries `salonName`). */
  salonName?: string;
  /** Server-computed per-entry working minutes (closed rows); `null` for an open row. */
  workingMinutes?: number | null;
}

export interface DayState {
  kind: DayStateKind;
  /** The ONE entry both the hero card and "Heutiger Eintrag" describe. */
  entry: ClockDayEntry | null;
  /** entry?.isLocked === true — a locked month is immutable (CLAUDE.md Revisionssicherheit). */
  isLocked: boolean;
}

export const IDLE_DAY_STATE: DayState = { kind: "idle", entry: null, isLocked: false };

/**
 * Turns today's rows into the three-state answer. Since Issue #70 the array may hold several rows:
 * the open row wins, else the closed row ending last — the mirror of the server's selectors.
 */
export function resolveDayState(entries: ClockDayEntry[] | null | undefined): DayState {
  const rows = entries ?? [];

  // Open entry wins — mirrors `openEntryOf`, which looks for `endTime === null` FIRST.
  const open = rows.find((e) => e.endTime === null || e.endTime === undefined);
  if (open) {
    return { kind: "running", entry: open, isLocked: open.isLocked === true };
  }

  // Otherwise the closed entry with the LATEST endTime — mirrors `latestEndingClosed`: a tie goes to
  // the later start, then to the larger id, so the same row wins whatever order the list arrives in.
  let closed: ClockDayEntry | null = null;
  // Issue #92 (D-06): a trip between two salons is skipped, exactly like the server's
  // `latestEndingClosed` — a re-clock never acts on a trip, so the entry named here stays the one
  // the resolver would reopen.
  for (const e of rows) {
    if (!e.endTime) continue;
    if (isTravelRow(e)) continue;
    if (closed === null) {
      closed = e;
      continue;
    }
    const diff = new Date(e.endTime).getTime() - new Date(closed.endTime!).getTime();
    if (diff > 0) closed = e;
    else if (diff === 0) {
      const startDiff = new Date(e.startTime).getTime() - new Date(closed.startTime).getTime();
      if (startDiff > 0 || (startDiff === 0 && e.id > closed.id)) closed = e;
    }
  }
  if (closed) {
    return { kind: "finished", entry: closed, isLocked: closed.isLocked === true };
  }

  // Defensive: an idle day may still carry a row to display (a row without a usable endTime shape).
  return { ...IDLE_DAY_STATE, entry: rows[0] ?? null };
}

/**
 * The label of the card's PRIMARY clock action, or `null` when there must not be one.
 */
export function primaryClockLabel(day: DayState): "Einstempeln" | "Ausstempeln" | null {
  if (day.kind === "running") return "Ausstempeln";
  if (day.kind === "idle") return "Einstempeln";
  // Acceptance criterion #2: "Auf einem abgeschlossenen Tag zeigt die Karte KEINE primäre
  // 'Einstempeln'-Schaltfläche mehr, sondern den Tagesabschluss." null means the caller must
  // not render the button at all — not render it disabled.
  return null;
}

/**
 * May the finished day be deliberately reopened (behind a Rückfrage)?
 *
 * A locked month is excluded: `resolver.ts`'s REOPEN branch answers a REOPEN on a locked
 * entry with CONFLICT MONTH_LOCKED → HTTP 409. Offering the action there would be the same
 * disease this phase treats — the UI proposing something the server refuses.
 */
export function canReopenFinishedDay(day: DayState): boolean {
  return day.kind === "finished" && !day.isLocked;
}

/**
 * "17:46" — the local HH:MM of the recorded clock-out.
 *
 * This is `gapBreakStart` in `resolver.ts`'s REOPEN branch: the timestamp that branch uses as
 * the start of the phantom break it creates. That is why the Rückfrage may name it as fact
 * ("Der Zeitraum 17:46–jetzt wird als Pause erfasst") rather than as a guess.
 */
export function reopenGapStartLabel(day: DayState): string | null {
  if (day.kind !== "finished") return null;
  const end = day.entry?.endTime;
  if (!end) return null;
  const d = new Date(end);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Replace-by-id or append. Used for the optimistic update after a clock-in so a co-existing
 * row (e.g. an invalid one) survives the ~200 ms until `loadData()` returns, and so a REOPEN
 * updates the same row instead of appending a phantom second one.
 */
export function upsertDayEntry(entries: ClockDayEntry[], entry: ClockDayEntry): ClockDayEntry[] {
  const i = entries.findIndex((e) => e.id === entry.id);
  if (i === -1) return [...entries, entry];
  const next = [...entries];
  next[i] = entry;
  return next;
}

/**
 * The worked minutes of ONE entry as the card shows them live: an open row counts up to `now`, a
 * closed row to its own end, minus its break minutes. Moved unchanged from the dashboard page
 * (Issue #70); it stays a DISPLAY value of the open entry only — closed rows of a multi-row day use
 * the server's per-entry `workingMinutes` (CLAUDE.md #79, the one working-time formula).
 */
export function entryWorkedMinutes(entry: ClockDayEntry, now: Date): number {
  const start = new Date(entry.startTime).getTime();
  const end = entry.endTime ? new Date(entry.endTime).getTime() : now.getTime();
  const gross = Math.max(0, (end - start) / 60000);
  return Math.max(0, gross - (entry.breakMinutes ?? 0));
}

/** The sums of a day's rows for the "Heutiger Eintrag" card (Issue #70, D-07). */
export interface DayTotals {
  /** Earliest start of the day (ISO instant), `null` without rows. */
  startTime: string | null;
  /** Latest end (ISO instant); `null` while a row is running, and without rows. */
  endTime: string | null;
  /** Σ break minutes of every row. */
  breakMinutes: number;
  /** Σ working minutes: the server's `workingMinutes` of closed rows plus the running row's live value. */
  workingMinutes: number;
  rowCount: number;
}

/**
 * Σ over today's rows. A closed row contributes the server-computed `workingMinutes` (its own
 * fallback — the page's display formula — only when a row arrives without one, e.g. an optimistic
 * row adopted from a clock-in response); the open row contributes its live minutes at `now`.
 */
export function dayTotals(rows: readonly ClockDayEntry[], now: Date): DayTotals {
  let startMs: number | null = null;
  let endMs: number | null = null;
  let running = false;
  let breakMinutes = 0;
  let workingMinutes = 0;
  for (const row of rows) {
    const start = new Date(row.startTime).getTime();
    if (startMs === null || start < startMs) startMs = start;
    breakMinutes += row.breakMinutes ?? 0;
    if (!row.endTime) {
      running = true;
      workingMinutes += entryWorkedMinutes(row, now);
      continue;
    }
    const end = new Date(row.endTime).getTime();
    if (endMs === null || end > endMs) endMs = end;
    workingMinutes +=
      typeof row.workingMinutes === "number" && Number.isFinite(row.workingMinutes)
        ? row.workingMinutes
        : entryWorkedMinutes(row, now);
  }
  return {
    startTime: startMs === null ? null : new Date(startMs).toISOString(),
    endTime: running || endMs === null ? null : new Date(endMs).toISOString(),
    breakMinutes,
    workingMinutes,
    rowCount: rows.length,
  };
}

/** „2 Einträge heute“ for two or more rows, `null` otherwise (a one-entry day shows no count). */
export function entryCountLabel(count: number): string | null {
  return count >= 2 ? `${count} Einträge heute` : null;
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** „07:00–11:00“ for a closed row, „seit 11:30“ for the running one. */
export function entryRangeLabel(entry: ClockDayEntry): string {
  return entry.endTime
    ? `${hhmm(entry.startTime)}–${hhmm(entry.endTime)}`
    : `seit ${hhmm(entry.startTime)}`;
}

/** Today's rows in start order (then id), the order the compact list shows them in. */
export function entriesInStartOrder(rows: readonly ClockDayEntry[]): ClockDayEntry[] {
  return [...rows].sort(
    (a, b) =>
      new Date(a.startTime).getTime() - new Date(b.startTime).getTime() || (a.id < b.id ? -1 : 1),
  );
}
