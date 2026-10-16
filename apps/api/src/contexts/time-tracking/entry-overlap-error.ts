// Issue #70 (Phase 70b-02), D-10/D-13 — how a database refusal of a TimeEntry write is recognised,
// and the German texts that answer it.
//
// Recognition reads STRUCTURED fields only, never `err.message`: Prisma fills `message` with an
// echo of the failed invocation including the argument values, so a substring search there can
// name the wrong constraint (the lesson of `utils/prisma-unique-violation.ts`, Issue #567).
//
// Measured shape (70b-01 spike S2, 2026-10-16, Prisma 7.6 with `@prisma/adapter-pg`, PostgreSQL 17
// and 18, identical inside and outside `$transaction`):
//  - closed overlap  -> `err.code === "P2039"`, `meta.driverAdapterError.cause.originalCode`
//    `"23P01"` (exclusion violation) and `cause.originalMessage` containing the constraint name
//    `TimeEntry_no_overlap_closed`. `cause.constraint` is ABSENT for a 23P01, so the constraint is
//    named through `originalMessage`, which is the database's own text.
//  - second open entry of a day -> `P2002` naming the index `TimeEntry_employeeId_date_open_unique`
//    (read through `uniqueViolationTarget`).
//  - an INVERTED closed row (end before start) -> `P2039` with `originalCode` `"22000"` from the
//    range constructor. It is NOT an overlap and deliberately NOT mapped here: it is unreachable
//    through the API (every writer validates end > start) and must stay a visible server error.

import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import { uniqueViolationTarget } from "../../utils/prisma-unique-violation";
import { resolveAccessReach, scopedTimeEntryIds, type AccessContext } from "../platform";

/** The exclusion constraint of closed, non-deleted entries (migration `*_time_entry_no_overlap`). */
const OVERLAP_CONSTRAINT = "TimeEntry_no_overlap_closed";
/** The partial unique index of one open, non-deleted entry per employee and day. */
const OPEN_PER_DAY_INDEX = "TimeEntry_employeeId_date_open_unique";

/** Neutral overlap text: names neither a date nor a time (see `overlapMessageForCaller`). */
export const OVERLAP_MESSAGE_NEUTRAL = "Überschneidung mit einem bestehenden Eintrag dieses Tages.";
/**
 * Clock text (Issue #70, 70b-03): a clock event — start, re-open or clock-out — would overlap a
 * recorded entry. It names no date, time or salon, so the clock routes need no reach decision.
 */
export const CLOCK_ENTRY_OVERLAP_MESSAGE =
  "Der Eintrag überschneidet sich mit einem bestehenden Eintrag dieses Tages.";
/** Open-per-day text: another entry of the day is still running. */
export const OPEN_ENTRY_PER_DAY_MESSAGE = "Es läuft bereits ein Eintrag an diesem Tag.";

/** True when `err` is the database refusing an overlap of two closed entries (23P01). */
export function isEntryOverlapViolation(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  if ((err as { code?: unknown }).code !== "P2039") return false;
  const meta = (err as { meta?: { driverAdapterError?: { cause?: Record<string, unknown> } } })
    .meta;
  const cause = meta?.driverAdapterError?.cause;
  if (cause?.originalCode !== "23P01") return false;
  const originalMessage = cause.originalMessage;
  return typeof originalMessage === "string" && originalMessage.includes(OVERLAP_CONSTRAINT);
}

/** True when `err` is the database refusing a second open entry of one employee and day. */
export function isOpenEntryPerDayViolation(err: unknown): boolean {
  const target = uniqueViolationTarget(err);
  return target !== null && target.includes(OPEN_PER_DAY_INDEX);
}

/** The entry an overlap check found: just enough to word the message and to judge the reach. */
export interface OverlapConflict {
  id: string;
  /** `@db.Date` calendar day of the conflicting entry (UTC midnight). */
  date: Date;
  startTime: Date;
  endTime: Date | null;
}

/**
 * Thrown inside a writer's transaction when the in-transaction overlap re-check finds a conflict;
 * the route maps it to a 409 carrying `userMessage`. A typed error, so no catch classifies by
 * reading `err.message`.
 */
export class EntryConflictError extends Error {
  constructor(readonly userMessage: string) {
    super("ENTRY_CONFLICT");
    this.name = "EntryConflictError";
  }
}

/**
 * The DETAILED overlap text: date and times of the conflicting entry in the tenant time zone
 * (without `tz` the server zone applies — the legacy fallback of `checkOverlap`). The wording is
 * byte-identical to the one that lived inside `checkOverlap` before Issue #70.
 */
export function overlapConflictMessage(conflict: OverlapConflict, tz?: string): string {
  // Include the date (and format in the tenant tz) so the user can identify the
  // conflicting entry — critical when it is a stale open entry from another day.
  const dateOpts: Intl.DateTimeFormatOptions = {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    ...(tz ? { timeZone: tz } : {}),
  };
  const timeOpts: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
    ...(tz ? { timeZone: tz } : {}),
  };
  const dateLabel = conflict.startTime.toLocaleDateString("de-DE", dateOpts);
  const fmt = (d: Date | null) => (d ? d.toLocaleTimeString("de-DE", timeOpts) : "läuft");
  return `Überschneidung mit bestehendem Eintrag vom ${dateLabel} (${fmt(conflict.startTime)} – ${fmt(conflict.endTime)})`;
}

export interface OverlapMessageInput {
  conflict: OverlapConflict;
  tz?: string;
  tenantId: string;
  /** The person the entry is written for. */
  employeeId: string;
  /** The caller's own employee id; `null` for an actor without one (API key). */
  callerEmployeeId: string | null;
  access: AccessContext;
}

/**
 * The ONE place that decides how an overlap 409 is worded (Issue #70, D-13). The detailed text
 * names the date and times of the conflicting entry — and with several entries per day, possibly
 * of an entry in a salon the caller cannot see, so that wording is a disclosure. It is therefore
 * given only to the person themself, to a whole-tenant `time-entry:read` reader, and to a reader
 * whose `time-entry:read:ZUGEWIESEN` reach contains the conflicting entry; every other caller gets
 * `OVERLAP_MESSAGE_NEUTRAL`, which confirms that a conflict exists (the writer needs that to
 * proceed) and nothing else. Same rule and same building blocks as `warningsVisibleToCaller()`
 * (DSGVO Art. 5 Abs. 1 lit. c, data minimisation). A database-level refusal carries no conflicting
 * row and is always neutral.
 */
export async function overlapMessageForCaller(
  db: Prisma.TransactionClient,
  input: OverlapMessageInput,
): Promise<string> {
  const detailed = overlapConflictMessage(input.conflict, input.tz);
  if (input.callerEmployeeId !== null && input.callerEmployeeId === input.employeeId) {
    return detailed;
  }
  const reach = await resolveAccessReach(db, input.access, "time-entry:read:ZUGEWIESEN");
  if (reach.kind === "wholeTenant") return detailed;
  const scoped = await scopedTimeEntryIds(
    db,
    input.tenantId,
    reach,
    input.conflict.date,
    input.conflict.date,
  );
  if (scoped === "all" || scoped.includes(input.conflict.id)) return detailed;
  return OVERLAP_MESSAGE_NEUTRAL;
}

// ── Überlappungsprüfung ────────────────────────────────────────────────────────
// entryDate (optional): the calendar date of the entry being created/updated.
// An open entry (endTime = null) has no natural upper bound, so it must only be
// treated as "still running" for conflict purposes ON ITS OWN DAY. Without this
// scoping a single stale open entry (e.g. a forgotten clock-out) would be treated
// as running until year 9999 and would block creating OR editing entries on any
// later day — even in a following month (v1.8.13 cross-day/cross-month fix).
// Closed entries that legitimately span midnight are still caught by the
// { endTime: { gt: startTime } } branch, which is not date-scoped.
//
// Returns the conflicting entry (or null). Wording the 409 is NOT done here: since Issue #70 the
// text depends on who asks (`overlapMessageForCaller` in ./entry-overlap-error.ts, D-13).
// Prisma client shape shared by `app.prisma` (top-level) and the `tx` handle inside
// `$transaction(async (tx) => ...)` — lets checkOverlap / checkEntryConflicts run
// against either, which the grant-consumption race fix (retro-grant-race-403-vs-409)
// relies on to re-run conflict checks INSIDE the tx after the single-use grant flip.
type DbClient = FastifyInstance["prisma"] | Prisma.TransactionClient;

export async function checkOverlap(
  db: DbClient,
  employeeId: string,
  startTime: Date,
  endTime: Date | null,
  excludeId?: string,
  entryDate?: Date,
): Promise<OverlapConflict | null> {
  // Kein endTime = offener Eintrag → als "läuft noch" behandeln
  const effectiveEnd = endTime ?? new Date("9999-12-31");

  // When the entry date is known, only open entries on the SAME calendar date
  // count as an active conflict. Fall back to the original broad match otherwise.
  const openEntryCondition: Prisma.TimeEntryWhereInput = entryDate
    ? { endTime: null, date: entryDate }
    : { endTime: null };

  // Soft-deleted entries free their interval (deletedAt: null), exactly like the database
  // exclusion constraint. The caller words the conflict (`overlapMessageForCaller`), because the
  // wording depends on who is asking.
  return db.timeEntry.findFirst({
    where: {
      employeeId,
      deletedAt: null,
      id: excludeId ? { not: excludeId } : undefined,
      startTime: { lt: effectiveEnd },
      OR: [
        openEntryCondition, // offener Eintrag am selben Tag läuft noch
        { endTime: { gt: startTime } }, // abgeschlossener Eintrag endet nach neuem Start
      ],
    },
    select: { id: true, date: true, startTime: true, endTime: true },
    // Several rows may conflict (a long new entry spanning two existing ones): the one named in the
    // 409 text is the earliest, whatever order the database happens to return — Issue #70 (70b-06).
    orderBy: [{ startTime: "asc" }, { id: "asc" }],
  });
}
