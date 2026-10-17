/**
 * § 9 BUrlG credit supersession — the ONE place a `Section9Credit` moves to `SUPERSEDED`.
 *
 * Two callers, one rule (Issue #468 A-3 for the correction, Issue #662 for the cancellation):
 *   - `applyLeaveCorrection` (Step 8b) supersedes the credits the corrected range leaves behind;
 *   - the approval of a cancellation (`PATCH /leave/requests/:id`, CANCELLATION_REQUESTED ->
 *     CANCELLED) and the #614 employment-exit cancellation supersede EVERY remaining credit of the
 *     cancelled request, on both sides (the request as the vacation and as the sick request).
 *
 * A credit is never deleted. The status change is an optimistic lock (`updateMany` with a
 * `status != SUPERSEDED` guard): a concurrent writer that superseded the same credit first makes
 * this one throw {@link Section9ConcurrentCorrectionError}, so the ledger undo below never runs
 * twice for one credit. A CONFIRMED credit booked a ledger entry at confirm time
 * (`reverseVacationDays`, gave the days back); undoing it here is the exact mirror
 * (`deductVacationDays`). AU_PENDING / REJECTED credits never booked anything.
 *
 * Everything runs inside the caller's transaction, every audit row goes through the port.
 */
import type { Prisma } from "@clokr/db";
import { deductVacationDays } from "./leave-days";

/**
 * WR-02 (Issue #468 review): thrown inside the caller's transaction when the optimistic-lock
 * `updateMany` on a § 9 credit's status affected 0 rows — a concurrent or replayed writer already
 * superseded it first. Never escapes the handler; translated into a 409 asking the caller to retry.
 */
export class Section9ConcurrentCorrectionError extends Error {
  constructor() {
    super("SECTION9_CONCURRENT_CORRECTION");
    this.name = "Section9ConcurrentCorrectionError";
  }
}

export type Section9AuditPort = (entry: {
  action: string;
  entity: string;
  entityId: string;
  oldValue?: object;
  newValue?: object;
}) => Promise<void>;

/** The columns of a credit the supersession reads. */
export type SupersedableSection9Credit = {
  id: string;
  status: string;
  creditedStart: Date | null;
  creditedEnd: Date | null;
  creditedDays: Prisma.Decimal | null;
  vacationRequest: { leaveTypeId: string };
};

const isoDay = (d: Date | null): string | null => (d ? d.toISOString().split("T")[0] : null);

export async function supersedeSection9Credit(
  tx: Prisma.TransactionClient,
  input: {
    credit: SupersedableSection9Credit;
    /** True only for a CONFIRMED credit — the only one that booked a ledger entry. */
    ledgerUndo: boolean;
    employeeId: string;
    tenantId: string;
    holidays: Set<string>;
    audit: Section9AuditPort;
    /** Merged into the audit `newValue` next to `status: "SUPERSEDED"` (cause, reason, note). */
    auditNewValue: Record<string, unknown>;
  },
): Promise<void> {
  const { credit } = input;
  const { count } = await tx.section9Credit.updateMany({
    where: { id: credit.id, status: { not: "SUPERSEDED" } },
    data: { status: "SUPERSEDED" },
  });
  if (count !== 1) throw new Section9ConcurrentCorrectionError();

  // CR-01 (Issue #468 review): undo the ledger entry for WHATEVER type the confirm path booked
  // for (SPECIAL/UNPAID/EDUCATION/MATERNITY/PARENTAL legally receive a § 9 credit too).
  if (input.ledgerUndo) {
    await deductVacationDays(
      tx,
      input.employeeId,
      credit.vacationRequest.leaveTypeId,
      credit.creditedStart!,
      credit.creditedEnd!,
      Number(credit.creditedDays),
      input.holidays,
      input.tenantId,
    );
  }

  await input.audit({
    action: "SECTION9_CREDIT_SUPERSEDED",
    entity: "Section9Credit",
    entityId: credit.id,
    oldValue: {
      status: credit.status,
      creditedStart: isoDay(credit.creditedStart),
      creditedEnd: isoDay(credit.creditedEnd),
      creditedDays: credit.creditedDays !== null ? Number(credit.creditedDays) : null,
    },
    newValue: { status: "SUPERSEDED", ...input.auditNewValue },
  });
}

/**
 * Issue #662: a cancelled request leaves no § 9 credit standing. Supersedes every non-superseded
 * credit that references the request on either side, inside the caller's transaction, AFTER the
 * cancellation's own `reverseVacationDays` (so a CONFIRMED credit's days are given back once by
 * the cancellation and taken out once by the undo — net zero double credit).
 *
 * Returns the superseded credit ids.
 */
export async function supersedeSection9CreditsOfCancelledRequest(
  tx: Prisma.TransactionClient,
  input: {
    requestId: string;
    employeeId: string;
    tenantId: string;
    holidays: Set<string>;
    audit: Section9AuditPort;
  },
): Promise<string[]> {
  const credits = await tx.section9Credit.findMany({
    where: {
      OR: [{ vacationRequestId: input.requestId }, { sickRequestId: input.requestId }],
      status: { not: "SUPERSEDED" },
      employee: { tenantId: input.tenantId },
    },
    include: { vacationRequest: { select: { leaveTypeId: true } } },
    orderBy: { id: "asc" },
  });
  for (const credit of credits) {
    await supersedeSection9Credit(tx, {
      credit,
      ledgerUndo: credit.status === "CONFIRMED",
      employeeId: input.employeeId,
      tenantId: input.tenantId,
      holidays: input.holidays,
      audit: input.audit,
      auditNewValue: {
        cancelledLeaveRequestId: input.requestId,
        auditReason: "Stornierung",
        note: "§ 9 BUrlG — durch Stornierung des Antrags überholt",
      },
    });
  }
  return credits.map((c) => c.id);
}
