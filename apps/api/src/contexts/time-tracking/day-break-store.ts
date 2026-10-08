// Issue #80 (D-03/D-06) — the Zeiterfassung-internal reads of the day-break feature: the day's gap
// breaks (DayBreak), the day's cross-salon acknowledgements (DayBreakAck) and the day's closed
// WORK rows.
//
// This is NOT a facade: no foreign context calls it. Foreign callers go through
// `contexts/time-tracking/index.ts`. Every read carries `deletedAt: null` (soft delete, D-06) and
// binds the employee to the tenant (`employee: { tenantId }`), so a row of another tenant can never
// surface even if a caller passes a foreign employee id.
import type { DayBreak, DayBreakAck, Prisma } from "@clokr/db";
import { findEntriesOfDay, type DayEntriesDb } from "./day-entries";
import { getWorkedEntriesInRange } from "./facade/time-entries";
import type { EmployeeScope } from "../platform";
import type { DayBreakRow } from "./day-break-rule";

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
 * The closed WORK rows of one day, in start order, typed for the kernel. This is the day-break
 * routes' day lookup — the same filter `checkArbZG` applies to `findEntriesOfDay`; never a second
 * `timeEntry.find*`.
 */
export async function closedWorkRowsOfDay(
  db: DayBreakStoreDb,
  params: DayParams,
): Promise<Array<DayBreakRow & { isLocked: boolean }>> {
  const rows = await findEntriesOfDay(db, params);
  return rows
    .filter((e) => e.endTime !== null && e.type === "WORK")
    .map((e) => ({
      id: e.id,
      startTime: e.startTime,
      endTime: e.endTime!,
      breakMinutes: e.breakMinutes,
      breakStatus: e.breakStatus,
      salonId: e.salonId,
      isLocked: e.isLocked,
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
