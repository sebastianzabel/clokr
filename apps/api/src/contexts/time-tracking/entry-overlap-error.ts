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

import { uniqueViolationTarget } from "../../utils/prisma-unique-violation";

/** The exclusion constraint of closed, non-deleted entries (migration `*_time_entry_no_overlap`). */
const OVERLAP_CONSTRAINT = "TimeEntry_no_overlap_closed";
/** The partial unique index of one open, non-deleted entry per employee and day. */
const OPEN_PER_DAY_INDEX = "TimeEntry_employeeId_date_open_unique";

/** Neutral overlap text: names neither a date nor a time (see `overlapMessageForCaller`). */
export const OVERLAP_MESSAGE_NEUTRAL = "Überschneidung mit einem bestehenden Eintrag dieses Tages.";
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
