// Phase 76.2 (ARCH-V19-01 revision 1 — checker INFO #6 pre-flight) — extracted from
// apps/api/src/routes/time-entries.ts so the unified clock resolver (services/clock/resolver.ts)
// and the future-source test can share the § 8 BUrlG leave check without re-implementing it.
//
// Phase 100b Plan 14 (D-05): this function returns a stable LeaveTypeCode, never a display
// string. Before this change the LeaveRequest branch returned the tenant-EDITABLE
// `LeaveType.name`, while the Absence branch already returned `DISPLAY_NAME[absence.type]` — a
// mapping OF a code. Two different kinds of value shared one field name (`type`), and the only
// consumer (`time-entries.ts`'s § 8 BUrlG error message) interpolated whichever one it got
// directly into a legal-compliance message. A tenant renaming "Urlaub" would then change the
// wording of a statutory rejection message — the identity of an absence type must be its code,
// never its name (ADR 0001, `leave-type.ts`'s own module header). The caller renders the
// display text itself via `DISPLAY_NAME[code]`, the one Phase 97/98b mapping.
import type { LeaveTypeCode, Prisma } from "@clokr/db";

/** § 8 BUrlG: Prüft ob aktiver Urlaub an dem Tag vorliegt */
export async function hasApprovedLeaveOnDate(
  prisma: Prisma.TransactionClient,
  employeeId: string,
  dateStr: string,
): Promise<{ code: LeaveTypeCode; status: "APPROVED" | "CANCELLATION_REQUESTED" } | null> {
  const leave = await prisma.leaveRequest.findFirst({
    where: {
      employeeId,
      // CR-02 (Phase 76.2 code review): CLAUDE.md audit-proof rule —
      // ALL queries on soft-deletable models (TimeEntry, LeaveRequest, Absence)
      // MUST include deletedAt: null. Otherwise a soft-deleted APPROVED leave
      // would still block clock-in via the resolver's BUrlG § 8 check.
      deletedAt: null,
      status: { in: ["APPROVED", "CANCELLATION_REQUESTED"] },
      startDate: { lte: new Date(dateStr + "T23:59:59Z") },
      endDate: { gte: new Date(dateStr + "T00:00:00Z") },
    },
    // Deliberately select ONLY `code`, never `name` — this file must never read the
    // tenant-editable display text (AC-4). The name -> code resolution helper in `leave-type.ts`
    // exists exclusively for the one-time backfill/self-heal path and is guarded by its own test
    // to forbid any call from a request handler; this function IS called from request handlers
    // (time-entries.ts, services/clock/resolver.ts), so it may not use that helper either.
    include: { leaveType: { select: { code: true } } },
  });
  if (leave) {
    // LeaveType.code is NOT NULL in the database as of issue #206 (schema.prisma, migration
    // 20260923090815_leave_type_code_not_null) — the six preconditions measured against int/prod
    // on 2026-09-23 (recorded on issue #206) found zero rows without a code before the column was
    // tightened. The `?? "OTHER"` fallback below therefore no longer guards against a real
    // database state; it survives purely as defence for a hand-built test stub whose shape
    // (`leave-check.test.ts`) can still give the `code` field a null value at the TypeScript
    // level. It deliberately does NOT resolve the code by reading the (tenant-editable) name —
    // that would both reintroduce a name-based lookup this file exists to remove and violate the
    // backfill-only restriction named above.
    return {
      code: leave.leaveType.code ?? "OTHER",
      status: leave.status as "APPROVED" | "CANCELLATION_REQUESTED",
    };
  }

  const absence = await prisma.absence.findFirst({
    where: {
      employeeId,
      deletedAt: null,
      startDate: { lte: new Date(dateStr + "T23:59:59Z") },
      endDate: { gte: new Date(dateStr + "T00:00:00Z") },
      type: { in: ["MATERNITY", "PARENTAL"] },
    },
  });
  if (absence)
    return {
      // Absence.type IS already the stable LeaveTypeCode (schema.prisma:861) — no mapping
      // needed, unlike before this change where the caller received DISPLAY_NAME[absence.type]
      // (a rendering of the code) here but the LeaveRequest branch's raw, tenant-editable display
      // text above. Both branches now return the same KIND of value.
      code: absence.type,
      status: "APPROVED" as const,
    };

  return null;
}
