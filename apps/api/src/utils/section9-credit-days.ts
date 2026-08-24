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
 */
import type { FastifyInstance } from "fastify";

export async function sumConfirmedSection9DaysByRequest(
  prisma: FastifyInstance["prisma"],
  vacationRequestIds: string[],
): Promise<number> {
  if (vacationRequestIds.length === 0) return 0;
  const credits = await prisma.section9Credit.findMany({
    where: { vacationRequestId: { in: vacationRequestIds }, status: "CONFIRMED" },
    select: { creditedDays: true },
  });
  return credits.reduce((s, c) => s + Number(c.creditedDays ?? 0), 0);
}
