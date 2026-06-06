// Phase 76.2 (ARCH-V19-01 revision 1 — checker INFO #6 pre-flight) — extracted from
// apps/api/src/routes/time-entries.ts so the unified clock resolver (services/clock/resolver.ts)
// and the future-source test can share the § 8 BUrlG leave check without re-implementing it.
// No logic change from the pre-76.2 implementation.
import type { Prisma } from "@clokr/db";

/** § 8 BUrlG: Prüft ob aktiver Urlaub an dem Tag vorliegt */
export async function hasApprovedLeaveOnDate(
  prisma: Prisma.TransactionClient,
  employeeId: string,
  dateStr: string,
): Promise<{ type: string; status: "APPROVED" | "CANCELLATION_REQUESTED" } | null> {
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
    include: { leaveType: { select: { name: true } } },
  });
  if (leave)
    return {
      type: leave.leaveType.name,
      status: leave.status as "APPROVED" | "CANCELLATION_REQUESTED",
    };

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
      type: absence.type === "MATERNITY" ? "Mutterschutz" : "Elternzeit",
      status: "APPROVED" as const,
    };

  return null;
}
