// PERF-V1814-01: bulk-fetch-then-join — 5 queries, constant regardless of employee count.
//
// Both GET /overtime/close-month/status and GET /overtime/close-month/year-status
// previously issued 3+4N or 2+12×(2+4N) Prisma queries respectively (N = employee count).
// This helper replaces those per-employee loops with a single Promise.all of 5 queries
// that covers the entire date range, then returns keyed Maps for O(1) in-memory lookup.

import type { PrismaClient } from "@clokr/db";

/**
 * Bulk-fetch all data needed by the close-month status handlers for a given date range
 * and set of employees. Issues exactly 5 DB queries in parallel.
 *
 * @param prisma   - Prisma client instance (app.prisma)
 * @param tenantId - Tenant scope for publicHoliday query
 * @param employeeIds - All relevant employee IDs (already tenant-scoped by the caller)
 * @param start    - Start of the date range (inclusive, UTC midnight)
 * @param end      - End of the date range (inclusive, last instant of the period)
 *
 * @returns
 *  snapshotsByEmp - Map<employeeId, SaldoSnapshot[]> — non-superseded MONTHLY snapshots
 *  entriesByEmp   - Map<employeeId, {id, date, breakStatus, isLocked}[]> — WORK TimeEntries
 *                   with non-null endTime (Phase 92 — breakStatus/isLocked added for BREAK-05)
 *  leaveByEmp     - Map<employeeId, LeaveRequest[]> — APPROVED leave overlapping range
 *  absencesByEmp  - Map<employeeId, Absence[]> — absences overlapping range
 *  holidays       - PublicHoliday[] — tenant-specific DB holidays in range (tenant-wide)
 */
export async function fetchCloseMonthData(
  prisma: PrismaClient,
  tenantId: string,
  employeeIds: string[],
  start: Date,
  end: Date,
) {
  const [snapshots, entries, leave, absences, holidays] = await Promise.all([
    // Q1: all non-superseded MONTHLY SaldoSnapshots for these employees in this date range.
    // Filters superseded=false to match the authoritative snapshot per employee per month.
    prisma.saldoSnapshot.findMany({
      where: {
        employeeId: { in: employeeIds },
        periodType: "MONTHLY",
        periodStart: { gte: start, lte: end },
        superseded: false,
      },
    }),

    // Q2: all completed WORK TimeEntries in range. Select extended (Phase 92,
    // BREAK-05) with id + breakStatus + isLocked so the status endpoint can
    // derive unconfirmedBreakDays from this SAME bulk fetch (N+1-safe,
    // PERF-V1814-01 — no extra per-employee query added).
    // CLAUDE.md Soft Delete Convention: deletedAt: null is mandatory.
    prisma.timeEntry.findMany({
      where: {
        employeeId: { in: employeeIds },
        deletedAt: null,
        date: { gte: start, lte: end },
        endTime: { not: null },
        type: "WORK",
      },
      select: { employeeId: true, id: true, date: true, breakStatus: true, isLocked: true },
    }),

    // Q3: all APPROVED LeaveRequests overlapping this date range.
    // CLAUDE.md Soft Delete Convention: deletedAt: null is mandatory.
    prisma.leaveRequest.findMany({
      where: {
        employeeId: { in: employeeIds },
        deletedAt: null,
        status: "APPROVED",
        startDate: { lte: end },
        endDate: { gte: start },
      },
    }),

    // Q4: all Absences overlapping this date range.
    // CLAUDE.md Soft Delete Convention: deletedAt: null is mandatory.
    prisma.absence.findMany({
      where: {
        employeeId: { in: employeeIds },
        deletedAt: null,
        startDate: { lte: end },
        endDate: { gte: start },
      },
    }),

    // Q5: all tenant-specific DB PublicHolidays in range (tenant-wide, not per-employee).
    prisma.publicHoliday.findMany({
      where: { tenantId, date: { gte: start, lte: end } },
    }),
  ]);

  // ── Build O(1) lookup Maps keyed by employeeId ────────────────────────────────

  type SnapshotRow = (typeof snapshots)[number];
  type EntryRow = (typeof entries)[number];
  type LeaveRow = (typeof leave)[number];
  type AbsenceRow = (typeof absences)[number];

  const snapshotsByEmp = new Map<string, SnapshotRow[]>();
  const entriesByEmp = new Map<string, EntryRow[]>();
  const leaveByEmp = new Map<string, LeaveRow[]>();
  const absencesByEmp = new Map<string, AbsenceRow[]>();

  for (const s of snapshots) {
    if (!snapshotsByEmp.has(s.employeeId)) snapshotsByEmp.set(s.employeeId, []);
    snapshotsByEmp.get(s.employeeId)!.push(s);
  }

  for (const e of entries) {
    if (!entriesByEmp.has(e.employeeId)) entriesByEmp.set(e.employeeId, []);
    entriesByEmp.get(e.employeeId)!.push(e);
  }

  for (const lr of leave) {
    if (!leaveByEmp.has(lr.employeeId)) leaveByEmp.set(lr.employeeId, []);
    leaveByEmp.get(lr.employeeId)!.push(lr);
  }

  for (const ab of absences) {
    if (!absencesByEmp.has(ab.employeeId)) absencesByEmp.set(ab.employeeId, []);
    absencesByEmp.get(ab.employeeId)!.push(ab);
  }

  return { snapshotsByEmp, entriesByEmp, leaveByEmp, absencesByEmp, holidays };
}
