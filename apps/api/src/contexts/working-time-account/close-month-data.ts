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
import { getAbsencesOverlapping, getActiveLeaveOverlapping } from "../absence"; // Phase 100B Plan 12 — A4; Plan 13 — A2; Issue #446
import { holidaysAtWorkLocation } from "../platform"; // Phase 71b (issue #71) — work-location resolution
import { dateStrInTz, monthDayBounds } from "./timezone";

/**
 * Bulk-fetch all data needed by the close-month status handlers for a given date range
 * and set of employees. Issues four DB queries in parallel plus one batched holiday
 * resolution (still a constant query count, independent of employee and day count).
 *
 * @param prisma   - Prisma client instance (app.prisma)
 * @param tenantId - Tenant scope for the holiday resolution
 * @param employeeIds - All relevant employee IDs (already tenant-scoped by the caller)
 * @param start    - First instant of the range (the `monthRangeUtc` start — an INSTANT, not a day)
 * @param end      - Last instant of the range (the `monthRangeUtc` end)
 * @param tz       - Tenant timezone: converts the instants to calendar days for the `@db.Date`
 *                   reads (Q2-Q4) and the holiday resolver's day-string window
 *
 * Issue #493: Q1 compares `start`/`end` with the stored `SaldoSnapshot.periodStart` key ON
 * PURPOSE (D-02, see the attribution comment in api/overtime.ts) — that key is instant-based.
 * Q2-Q4 read `@db.Date` columns, which Postgres compares by the UTC DATE of a bound, so they take
 * the tenant-local calendar days `firstDay`/`lastDay` instead; the instant of local Oct 1 00:00
 * (2025-09-30T22:00Z) would otherwise pull the previous month's last day into the range.
 * Q3 consumer proof (no saldo or close figure reads it): `findMissingWorkdays` adds a leave day
 * only inside its [spanStart, spanEnd], `karenzOverrunFromRequests` works per row and its result
 * is filtered to the month, year-status re-filters per month — a row ending the day before the
 * range therefore cannot change any output.
 *
 * @returns
 *  snapshotsByEmp - Map<employeeId, SaldoSnapshot[]> — non-superseded MONTHLY snapshots
 *  entriesByEmp   - Map<employeeId, {id, date, breakStatus, isLocked}[]> — WORK TimeEntries
 *                   with non-null endTime (Phase 92 — breakStatus/isLocked added for BREAK-05)
 *  leaveByEmp     - Map<employeeId, LeaveRequest[]> — effective leave (APPROVED +
 *                   CANCELLATION_REQUESTED, Issue #446) overlapping range, with leaveType
 *                   included (Phase 104 — also feeds the Karenz detector)
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
  // Issue #493: calendar-day bounds for the `@db.Date` reads Q2-Q4; Q1 and the holiday window keep
  // their own conventions (see the docblock).
  const { firstDay, lastDay } = monthDayBounds(start, end, tz);

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
    getWorkedEntriesInRange(
      prisma,
      { kind: "employees", employeeIds, tenantId },
      firstDay,
      lastDay,
    ),

    // Q3: all effective LeaveRequests (APPROVED + CANCELLATION_REQUESTED, Issue #446 D-02)
    // overlapping this date range. A2's select already carries leaveType.code (added in Phase
    // 104, R4/D-21; inherited from A1 by the widening) so the SAME bulk-fetch also serves the
    // Karenz-overrun detector — karenzOverrunFromRequests filters APPROVED itself
    // (find-karenz-overrun-days.ts:102), so the hint is unchanged. Still exactly ONE bulk
    // leaveRequest read — a second leaveRequest query here would double-count against
    // overtime-perf-n1.test.ts's per-model ≤1 assertion.
    // Phase 100B Plan 13 — A2, contexts/absence facade.
    getActiveLeaveOverlapping(
      prisma,
      { kind: "employees", employeeIds, tenantId },
      firstDay,
      lastDay,
    ),

    // Q4: all Absences overlapping this date range.
    // Phase 100B Plan 12 — A4, contexts/absence facade.
    getAbsencesOverlapping(prisma, { kind: "employees", employeeIds, tenantId }, firstDay, lastDay),
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
