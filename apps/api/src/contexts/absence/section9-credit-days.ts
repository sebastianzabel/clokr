/**
 * section9-credit-days.ts — the ONE place that answers "how many vacation days has § 9 BUrlG
 * given back for these leave requests?".
 *
 * Phase 104, Pitfall 2. D-05 deliberately never mutates LeaveRequest.days, so any consumer that
 * derives usedDays from Σ LeaveRequest.days is, without this correction, computing the PRE-credit
 * number and will silently overwrite a confirmed credit (the v1.9.14 defect class).
 *
 * Only CONFIRMED credits count. AU_PENDING is effect-free by design (D-09: never credit and later
 * take back), and REJECTED is re-openable (D-11) but currently without effect.
 *
 * Issue #445 (D-10, P-14): the former total-only summing helper this module exposed could not
 * attribute a credit to a specific entitlement YEAR when its window crosses a year boundary.
 * `listConfirmedSection9CreditsByRequest` below returns the per-credit rows instead — its only
 * caller (`leave-days.ts`'s `countedLeaveDaysWithin`) attributes each credit to a year by the
 * same chronological rule the self-heal uses for leave requests.
 */
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";

/**
 * Phase 104 review (IN-03): `tenantId` is REQUIRED, not optional. The helper used to rely
 * entirely on the caller having produced tenant-scoped ids. That holds for today's single
 * caller (leave-self-heal.ts), but this module is documented as "the ONE place" and will
 * attract more callers — a defence-in-depth predicate here matches the idiom the report
 * path already uses (`employee: { tenantId }` in reports.ts) and cannot be forgotten.
 */
export async function listConfirmedSection9CreditsByRequest(
  prisma: FastifyInstance["prisma"] | Prisma.TransactionClient,
  vacationRequestIds: string[],
  tenantId: string,
): Promise<
  Array<{
    vacationRequestId: string;
    creditedDays: number;
    creditedStart: Date | null;
    creditedEnd: Date | null;
  }>
> {
  if (vacationRequestIds.length === 0) return [];
  const credits = await prisma.section9Credit.findMany({
    where: {
      vacationRequestId: { in: vacationRequestIds },
      status: "CONFIRMED",
      employee: { tenantId },
    },
    select: { vacationRequestId: true, creditedDays: true, creditedStart: true, creditedEnd: true },
  });
  return credits.map((c) => ({
    vacationRequestId: c.vacationRequestId,
    creditedDays: Number(c.creditedDays ?? 0),
    creditedStart: c.creditedStart,
    creditedEnd: c.creditedEnd,
  }));
}
