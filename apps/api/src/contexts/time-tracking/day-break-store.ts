// Issue #80 (D-03/D-06) — the Zeiterfassung-internal reads of the day-break feature: the day's gap
// breaks (DayBreak), the day's cross-salon acknowledgements (DayBreakAck), the day's closed
// WORK rows and, since Issue #511 (D-15), the Break rows of those entries.
//
// This is NOT a facade: no foreign context calls it. Foreign callers go through
// `contexts/time-tracking/index.ts`. Every read carries `deletedAt: null` (soft delete, D-06) and
// binds the employee to the tenant (`employee: { tenantId }`), so a row of another tenant can never
// surface even if a caller passes a foreign employee id.
import type { DayBreak, DayBreakAck, Prisma } from "@clokr/db";
import { findEntriesOfDay, type DayEntriesDb } from "./day-entries";
import { getWorkedEntriesInRange } from "./facade/time-entries";
import type { EmployeeScope } from "../platform";
import type { DayBreakInterval, DayBreakRow } from "./day-break-rule";

/** `app.prisma` or the `tx` handle inside `$transaction(async (tx) => …)`. */
export type DayBreakStoreDb = DayEntriesDb;

/** `date` is the UTC-midnight Date of the tenant-local calendar day, compared by equality. */
interface DayParams {
  tenantId: string;
  employeeId: string;
  date: Date;
}

/**
 * The non-deleted gap breaks of `employeeId` on the calendar day `date`, bound to `tenantId`,
 * ordered by start time (then id).
 *
 * `date` is compared by equality against the `@db.Date` column — same contract as `findEntriesOfDay`.
 */
export async function listDayBreaksOfDay(
  db: DayBreakStoreDb,
  params: DayParams,
): Promise<DayBreak[]> {
  return db.dayBreak.findMany({
    where: {
      employeeId: params.employeeId,
      date: params.date,
      deletedAt: null,
      employee: { tenantId: params.tenantId },
    },
    orderBy: [{ startTime: "asc" }, { id: "asc" }],
  });
}

/**
 * The non-deleted acknowledgements of `employeeId` on the calendar day `date`, bound to `tenantId`,
 * ordered by creation time (then id). Whether one is still current is the kernel's decision
 * (`isAckSnapshotCurrent`), not the store's.
 */
export async function listAcksOfDay(
  db: DayBreakStoreDb,
  params: DayParams,
): Promise<DayBreakAck[]> {
  return db.dayBreakAck.findMany({
    where: {
      employeeId: params.employeeId,
      date: params.date,
      deletedAt: null,
      employee: { tenantId: params.tenantId },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

/**
 * Gap breaks and acknowledgements of several employees over `[from, to]` (inclusive calendar-day
 * bounds for the `@db.Date` column, CLAUDE.md Issue #493), one query per model. An empty
 * `employeeIds` returns empty arrays without a query.
 */
export async function loadDayBreakDataForDays(
  db: DayBreakStoreDb,
  params: { tenantId: string; employeeIds: readonly string[]; from: Date; to: Date },
): Promise<{ dayBreaks: DayBreak[]; acks: DayBreakAck[] }> {
  if (params.employeeIds.length === 0) return { dayBreaks: [], acks: [] };
  const where = {
    employeeId: { in: [...params.employeeIds] },
    deletedAt: null,
    date: { gte: params.from, lte: params.to },
    employee: { tenantId: params.tenantId },
  } satisfies Prisma.DayBreakWhereInput & Prisma.DayBreakAckWhereInput;
  const [dayBreaks, acks] = await Promise.all([
    db.dayBreak.findMany({
      where,
      orderBy: [{ date: "asc" }, { startTime: "asc" }, { id: "asc" }],
    }),
    db.dayBreakAck.findMany({
      where,
      orderBy: [{ date: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    }),
  ]);
  return { dayBreaks, acks };
}

/**
 * Issue #511 (D-15) — the ONE read of Break rows for the § 4 evaluation. Returns the Break rows of
 * the given entries grouped by entry id, each group in start order. An empty `entryIds` returns an
 * empty map without a query; otherwise exactly one `break.findMany`, bound to `tenantId` through
 * the entry's employee, so an entry id of another tenant yields nothing.
 *
 * `Break` has no soft delete (hard cascade from `TimeEntry`): the caller passes the ids of entries
 * it already read as non-deleted (`findEntriesOfDay` and the facade filter `deletedAt: null`).
 */
export async function loadBreaksOfEntries(
  db: DayBreakStoreDb,
  params: { tenantId: string; entryIds: readonly string[] },
): Promise<Map<string, DayBreakInterval[]>> {
  const byEntry = new Map<string, DayBreakInterval[]>();
  if (params.entryIds.length === 0) return byEntry;
  const breaks = await db.break.findMany({
    where: {
      timeEntryId: { in: [...params.entryIds] },
      timeEntry: { employee: { tenantId: params.tenantId } },
    },
    select: { timeEntryId: true, startTime: true, endTime: true },
    orderBy: [{ startTime: "asc" }, { id: "asc" }],
  });
  for (const b of breaks) {
    const list = byEntry.get(b.timeEntryId) ?? [];
    list.push({ startTime: b.startTime, endTime: b.endTime });
    byEntry.set(b.timeEntryId, list);
  }
  return byEntry;
}

/**
 * The closed WORK rows of one day, in start order, typed for the kernel, each carrying its Break
 * rows (`breaks`, Issue #511 D-15). This is the day-break routes' day lookup — the same filter
 * `checkArbZG` applies to `findEntriesOfDay`; never a second `timeEntry.find*`.
 */
export async function closedWorkRowsOfDay(
  db: DayBreakStoreDb,
  params: DayParams,
): Promise<Array<DayBreakRow & { isLocked: boolean }>> {
  const rows = (await findEntriesOfDay(db, params)).filter(
    (e) => e.endTime !== null && e.type === "WORK",
  );
  const breaksByEntry = await loadBreaksOfEntries(db, {
    tenantId: params.tenantId,
    entryIds: rows.map((e) => e.id),
  });
  return rows.map((e) => ({
    id: e.id,
    startTime: e.startTime,
    endTime: e.endTime!,
    breakMinutes: e.breakMinutes,
    breakStatus: e.breakStatus,
    salonId: e.salonId,
    isLocked: e.isLocked,
    breaks: breaksByEntry.get(e.id) ?? [],
  }));
}

/**
 * Closed WORK rows of `scope` in `[from, to]` — delegates to the facade's `getWorkedEntriesInRange`
 * (closed, valid AND invalid, not deleted, WORK — the same row set as `checkArbZG`'s day filter).
 * `from`/`to` are calendar-day bounds for the `@db.Date` column (CLAUDE.md Issue #493).
 */
export async function closedWorkRowsInRange(
  db: Prisma.TransactionClient,
  scope: EmployeeScope,
  from: Date,
  to: Date,
) {
  return getWorkedEntriesInRange(db, scope, from, to);
}
