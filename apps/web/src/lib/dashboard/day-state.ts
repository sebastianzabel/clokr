/**
 * day-state.ts
 *
 * Phase 115 (GitHub issue #118) — the ONE derivation that answers "what is today's clock
 * state" for the dashboard, in THREE values instead of a boolean.
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
 *   server (apps/api/src/utils/presence.ts) │ this module
 *   ────────────────────────────────────────┼────────────
 *   "clocked_in"  (presence.ts:150)         │ "running"
 *   "present"     (presence.ts:155)         │ "finished"
 *   neither                                 │ "idle"
 *
 * `apps/api/src/routes/dashboard.ts:1009-1017` uses the same discriminator under the names
 * clocked_in / complete / partial / none. We take the server's RULE and its WORDS and apply
 * them to the response the page already has, rather than fetching a second endpoint — see
 * the phase plan: sourcing the hero card from /dashboard/my-week while the entry card keeps
 * reading /time-entries would re-create the very two-source split this phase removes.
 *
 * ENTRY SELECTION — a deliberate mirror of `apps/api/src/services/clock/resolver.ts:44-77`:
 * the open entry wins if there is one; otherwise the closed entry with the LATEST `endTime`
 * (the resolver uses `orderBy: { endTime: "desc" }`). That is what makes the entry this
 * module names provably the entry the resolver would REOPEN — and therefore what makes
 * `reopenGapStartLabel()` able to state the gap-break start as fact.
 *
 * `isInvalid` IS DELIBERATELY NOT FILTERED — and that is the opposite of what a naive
 * "mirror the server" reading would do. `resolvePresenceState` filters it and the resolver's
 * READ lookup filters it, but the resolver's WRITE path does not, and the day-uniqueness
 * index is partial:
 *   - An `isInvalid: true` OPEN entry on today is reachable in production
 *     (`attendance-checker.ts:236-266` auto-invalidates open entries older than
 *     `autoDeleteOpenHours`, default 14 h, i.e. on the same calendar day; `resolver.ts:82-91`
 *     creates one directly when leave is CANCELLATION_REQUESTED).
 *   - WITH the filter such a day would resolve to "idle" → the card offers Einstempeln →
 *     the resolver's START branch calls `timeEntry.create` → the partial unique index
 *     `TimeEntry_employeeId_date_unique_not_deleted` rejects it → P2002 → HTTP 500.
 *   - WITHOUT the filter the day resolves to "running" → the card offers Ausstempeln →
 *     the resolver finds no valid open entry → CONFLICT NOT_CLOCKED_IN → HTTP 409, which is
 *     exactly today's behaviour.
 * A confusing 409 is strictly better than a 500. Do NOT "align this with presence.ts".
 *
 * UMFANGSGRENZE: `apps/api/src/services/clock/resolver.ts` and `state-machine.ts` MUST NOT be
 * changed. Their REOPEN behaviour is deliberate and regression-tested for NFC/WIFI double
 * taps (`services/clock/__tests__/consolidate.cross-source.test.ts`, "2026-06-04 prod
 * incident"). This module is the UI-side answer to that: it removes the ACCIDENTAL path into
 * REOPEN. It is NOT an authorisation control — anyone can POST /clock-in directly and still
 * reach REOPEN, by design. Nothing here may be mistaken for a security boundary.
 */

export type DayStateKind = "running" | "finished" | "idle";

/** The subset of a GET /api/v1/time-entries row this module needs. */
export interface ClockDayEntry {
  id: string;
  startTime: string; // full ISO instant
  endTime: string | null; // full ISO instant or null
  breakMinutes?: number | null;
  isLocked?: boolean | null;
  isInvalid?: boolean | null;
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
 * Turns today's rows into the three-state answer. In practice the array holds 0 or 1 rows —
 * `TimeEntry_employeeId_date_unique_not_deleted` is a real database constraint, not a
 * convention — but n>1 is handled defensively because an array is the shape the page has.
 */
export function resolveDayState(entries: ClockDayEntry[] | null | undefined): DayState {
  const rows = entries ?? [];

  // Open entry wins — mirrors resolver.ts:44-52, which looks up `endTime: null` FIRST.
  const open = rows.find((e) => e.endTime === null || e.endTime === undefined);
  if (open) {
    return { kind: "running", entry: open, isLocked: open.isLocked === true };
  }

  // Otherwise the closed entry with the LATEST endTime — mirrors the resolver's
  // `orderBy: { endTime: "desc" }` (resolver.ts:54-66), so we name the row it would REOPEN.
  const closed = rows
    .filter((e) => !!e.endTime)
    .sort((a, b) => new Date(b.endTime!).getTime() - new Date(a.endTime!).getTime())[0];
  if (closed) {
    return { kind: "finished", entry: closed, isLocked: closed.isLocked === true };
  }

  // Defensive: an idle day may still carry a row to display. Practically unreachable given
  // the partial unique index above, but the array shape allows it.
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
 * A locked month is excluded: `resolver.ts:117-123` answers a REOPEN on a locked entry with
 * CONFLICT MONTH_LOCKED → HTTP 409. Offering the action there would be the same disease this
 * phase treats — the UI proposing something the server refuses.
 */
export function canReopenFinishedDay(day: DayState): boolean {
  return day.kind === "finished" && !day.isLocked;
}

/**
 * "17:46" — the local HH:MM of the recorded clock-out.
 *
 * This is `gapBreakStart` in `resolver.ts:126`: the timestamp the REOPEN branch uses as the
 * start of the phantom break it creates. That is why the Rückfrage may name it as fact
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
