// PERF-V1814-01: bulk-fetch-then-join — four bulk queries plus ONE batched holiday
// resolution, constant regardless of employee count.
//
// Both GET /overtime/close-month/status and GET /overtime/close-month/year-status
// previously issued 3+4N or 2+12×(2+4N) Prisma queries respectively (N = employee count).
// This helper replaces those per-employee loops with a single Promise.all of four queries
// that covers the entire date range, then one holidaysAtWorkLocation() call fed with the
// Q2 rows, then returns keyed Maps for O(1) in-memory lookup. Research A2 (Phase 71b, issue
// #71) decided against a per-employee resolver loop — the resolver itself is already
// batched (contexts/platform), so one call over the whole employeeIds list preserves the
// constant query count this module exists to guarantee.

import type { PrismaClient } from "@clokr/db";
import { getWorkedEntriesInRange } from "../time-tracking"; // Phase 100B Plan 08 — T2
import { getAbsencesOverlapping, getApprovedLeaveOverlapping } from "../absence"; // Phase 100B Plan 12 — A4; Plan 13 — A1
import { holidaysAtWorkLocation } from "../platform"; // Phase 71b (issue #71) — work-location resolution
import { dateStrInTz } from "./timezone";

/**
 * Bulk-fetch all data needed by the close-month status handlers for a given date range
 * and set of employees. Issues four DB queries in parallel plus one batched holiday
 * resolution (still a constant query count, independent of employee and day count).
 *
 * @param prisma   - Prisma client instance (app.prisma)
 * @param tenantId - Tenant scope for the holiday resolution
 * @param employeeIds - All relevant employee IDs (already tenant-scoped by the caller)
 * @param start    - Start of the date range (inclusive, UTC midnight)
 * @param end      - End of the date range (inclusive, last instant of the period)
 * @param tz       - Tenant timezone, for the holiday resolver's day-string window
 *
 * @returns
 *  snapshotsByEmp - Map<employeeId, SaldoSnapshot[]> — non-superseded MONTHLY snapshots
 *  entriesByEmp   - Map<employeeId, {id, date, breakStatus, isLocked}[]> — WORK TimeEntries
 *                   with non-null endTime (Phase 92 — breakStatus/isLocked added for BREAK-05)
 *  leaveByEmp     - Map<employeeId, LeaveRequest[]> — APPROVED leave overlapping range,
 *                   with leaveType included (Phase 104 — also feeds the Karenz detector)
 *  absencesByEmp  - Map<employeeId, Absence[]> — absences overlapping range
 *  holidaysByEmp  - Map<employeeId, Set<string>> — statutory + manual holiday dates at that
 *                   employee's own WORK LOCATION (§ 2 EFZG, Phase 71b), never tenant-wide
 */
export async function fetchCloseMonthData(
  prisma: PrismaClient,
  tenantId: string,
  employeeIds: string[],
  start: Date,
  end: Date,
  tz: string,
) {
  const [snapshots, entries, leave, absences] = await Promise.all([
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

    // Q2: all completed WORK TimeEntries in range. Extended (Phase 92, BREAK-05) with id +
    // breakStatus + isLocked so the status endpoint can derive unconfirmedBreakDays from this
    // SAME bulk fetch (N+1-safe, PERF-V1814-01 — no extra per-employee query added). Also the
    // per-day work location fed into the holiday resolver below (Phase 71b, issue #71).
    // Phase 100B Plan 08 — T2, contexts/time-tracking facade.
    getWorkedEntriesInRange(prisma, { kind: "employees", employeeIds, tenantId }, start, end),

    // Q3: all APPROVED LeaveRequests overlapping this date range. A1's select already carries
    // leaveType.code (added in Phase 104, R4/D-21) so the SAME bulk-fetch also serves the
    // Karenz-overrun detector — a second leaveRequest query here would double-count against
    // overtime-perf-n1.test.ts's per-model ≤1 assertion.
    // Phase 100B Plan 13 — A1, contexts/absence facade.
    getApprovedLeaveOverlapping(prisma, { kind: "employees", employeeIds, tenantId }, start, end),

    // Q4: all Absences overlapping this date range.
    // Phase 100B Plan 12 — A4, contexts/absence facade.
    getAbsencesOverlapping(prisma, { kind: "employees", employeeIds, tenantId }, start, end),
  ]);

  // ONE batched holiday resolution by work location (Phase 71b, issue #71) — fed with the
  // Q2 rows already fetched above, never a second time-entry read. Still a constant query
  // count regardless of employeeIds.length or the day count in [start, end].
  const holidaysByEmployee = await holidaysAtWorkLocation(
    prisma,
    tenantId,
    employeeIds,
    dateStrInTz(start, tz),
    dateStrInTz(end, tz),
    entries,
  );

  // ── Build O(1) lookup Maps keyed by employeeId ────────────────────────────────

  type SnapshotRow = (typeof snapshots)[number];
  type EntryRow = (typeof entries)[number];
  type LeaveRow = (typeof leave)[number];
  type AbsenceRow = (typeof absences)[number];

  const snapshotsByEmp = new Map<string, SnapshotRow[]>();
  const entriesByEmp = new Map<string, EntryRow[]>();
  const leaveByEmp = new Map<string, LeaveRow[]>();
  const absencesByEmp = new Map<string, AbsenceRow[]>();
  const holidaysByEmp = new Map<string, Set<string>>();

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

  for (const employeeId of employeeIds) {
    holidaysByEmp.set(employeeId, new Set(holidaysByEmployee.get(employeeId)?.keys() ?? []));
  }

  return { snapshotsByEmp, entriesByEmp, leaveByEmp, absencesByEmp, holidaysByEmp };
}
