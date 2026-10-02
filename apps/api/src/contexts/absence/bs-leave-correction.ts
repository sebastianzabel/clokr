// Issue #448 (D-04) — a Berufsschultag that appears LATER over already-booked vacation must
// never leave a vacation day booked for a day the Azubi was legally released from work (§ 15
// BBiG, same legal basis as D-01/D-02 in ./bs-leave-days.ts). Plan 01 already makes every NEW
// price BS-free (resolveLeaveDays, D-02) and the saldo correct for an existing booking
// (close-employee-month.ts, D-03); this module repairs the STORED price (LeaveRequest.days) and
// the entitlement booking of a request that was priced BEFORE the BS day existed.
//
// ADR 0002 Entscheidung 10: this is invariant-carrying work ("a Berufsschultag never consumes a
// vacation day") and both writes it touches (Absence, LeaveRequest/LeaveEntitlement) belong to
// Abwesenheiten — no cross-context event is involved. It therefore runs SYNCHRONOUSLY and
// fail-closed, inside the SAME `tx` as the BS write that triggered it (owner's call sites:
// vocational-school-generator.ts's create/restore step, api/vocational-school.ts's
// manual-insert). A failure here rolls the BS row back too.
//
// No `recalculateSnapshots()` call: the request's DATES never change here, only `days` — the
// saldo (Arbeitszeitkonto) derives from dates and BS rows directly (plan 01, D-03), never from
// the stored `days` value, so there is nothing for a snapshot recalc to pick up.
//
// PENDING requests are re-priced too, even though no entitlement booking exists yet for them:
// otherwise a later approval would deduct the stale (pre-BS) price, breaking "same counting rule
// everywhere" for Anspruch. Recorded as a planner decision for the Issue #448 comment.
//
// Removing a BS day does NOT re-charge leave (no caller of this module does so) — the owner's AC
// is silent on it; a follow-up issue tracks it, not built here.

import { FastifyInstance } from "fastify";
import { Prisma } from "@clokr/db";
import {
  isStammsalonScopeMatch,
  resolveScopedHolderIds,
  userIdsHoldingPermission,
} from "../platform";
import { isMonthClosed, monthRangeUtc } from "../working-time-account";
import { EFFECTIVE_LEAVE_STATUSES } from "./effective-leave-statuses";
import {
  deductVacationDays,
  getHolidayMap,
  resolveLeaveDays,
  reverseVacationDays,
} from "./leave-days";

type AuditFn = FastifyInstance["audit"];

/** The audit reason persisted verbatim into `newValue.auditReason` (D-04). */
export const BS_LEAVE_CORRECTION_REASON = "Berufsschultag nachträglich – kein Urlaub";

/** In-app notification type: a correction WAS applied (open month). */
export const LEAVE_CORRECTED_VOCATIONAL_SCHOOL = "LEAVE_CORRECTED_VOCATIONAL_SCHOOL";
/** In-app notification type: the month is closed — nothing changed, a manual booking is needed. */
export const LEAVE_CORRECTION_NEEDED_VOCATIONAL_SCHOOL =
  "LEAVE_CORRECTION_NEEDED_VOCATIONAL_SCHOOL";

const DEFAULT_TZ = "Europe/Berlin"; // same fallback getTenantTimezone() itself uses

/** The subset of a `LeaveRequest` row this module reads/writes — shared by every helper below. */
type CandidateRequest = {
  id: string;
  employeeId: string;
  leaveTypeId: string;
  startDate: Date;
  endDate: Date;
  halfDay: boolean;
  days: Prisma.Decimal;
  status: string;
  reviewedBy: string | null;
  employee: { userId: string; firstName: string; lastName: string };
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** German dd.MM.yyyy — display only, never compared (CLAUDE.md). */
function fmtDMY(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${d.getUTCFullYear()}`;
}

function fmtDays(n: number): string {
  // Trim a trailing ".00"/".50" artefact without losing a genuine half day.
  return String(Math.round(n * 100) / 100);
}

/**
 * The Azubi's own user (if active) + the approver — `reviewedBy` when it is an active user of
 * the same tenant, else the Stammsalon-scoped holders of `leave-request:approve:ZUGEWIESEN`
 * (same three-step narrowing `contexts/absence/api/leave.ts`'s LEAVE_REQUEST notification uses).
 * THE ONE `userIdsHoldingPermission(` call site this module owns — see docs/permissions.md
 * "## Empfängersuchen".
 */
async function resolveApproverRecipients(
  tx: Prisma.TransactionClient,
  tenantId: string,
  request: CandidateRequest,
): Promise<string[]> {
  if (request.reviewedBy) {
    const reviewer = await tx.user.findFirst({
      where: { id: request.reviewedBy, isActive: true, employee: { tenantId } },
      select: { id: true },
    });
    if (reviewer) return [reviewer.id];
  }
  const holderIds = await userIdsHoldingPermission(
    tx,
    tenantId,
    "leave-request:approve:ZUGEWIESEN",
  );
  const scopedHolderIds = await resolveScopedHolderIds(
    tx,
    tenantId,
    holderIds,
    "leave-request:approve:ZUGEWIESEN",
    (reach) => isStammsalonScopeMatch(tx, tenantId, reach, request.employeeId, request.startDate),
  );
  const users = await tx.user.findMany({
    where: { id: { in: scopedHolderIds }, isActive: true, employee: { tenantId } },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

/** Corrected (open month) notification — Azubi always, approver(s) unless the request is PENDING. */
async function notifyCorrected(
  tx: Prisma.TransactionClient,
  tenantId: string,
  request: CandidateRequest,
  bsDate: Date,
  newDays: number,
): Promise<void> {
  const employeeName = `${request.employee.firstName} ${request.employee.lastName}`;
  const title = "Urlaub korrigiert: Berufsschultag";
  const message =
    `Der ${fmtDMY(bsDate)} ist ein Berufsschultag. Im Urlaub ${fmtDMY(request.startDate)}–` +
    `${fmtDMY(request.endDate)} von ${employeeName} wurde dafür kein Urlaubstag berechnet ` +
    `(neu: ${fmtDays(newDays)} Tage).`;

  const employeeUser = await tx.user.findFirst({
    where: { id: request.employee.userId, isActive: true },
    select: { id: true },
  });
  if (employeeUser) {
    await tx.notification.create({
      data: {
        userId: employeeUser.id,
        type: LEAVE_CORRECTED_VOCATIONAL_SCHOOL,
        title,
        message,
        link: "/leave",
        relatedType: "LeaveRequest",
        relatedId: request.id,
      },
    });
  }

  if (request.status === "PENDING") return; // no approver exists yet

  const approverIds = await resolveApproverRecipients(tx, tenantId, request);
  for (const userId of approverIds) {
    await tx.notification.create({
      data: {
        userId,
        type: LEAVE_CORRECTED_VOCATIONAL_SCHOOL,
        title,
        message,
        link: `/team/leave?request=${request.id}`,
        relatedType: "LeaveRequest",
        relatedId: request.id,
      },
    });
  }
}

/**
 * Closed-month (or locked-pattern-skip) notification: nothing was changed, the approver(s) are
 * asked to review a manual correction booking. Deduplicated — at most once per (request,
 * recipient), across however many calls ever reach it (re-runs, several BS dates of the same
 * request, generator + manual-insert both touching it).
 */
async function notifyCorrectionNeeded(
  tx: Prisma.TransactionClient,
  tenantId: string,
  request: CandidateRequest,
  bsDate: Date,
): Promise<void> {
  const employeeName = `${request.employee.firstName} ${request.employee.lastName}`;
  const title = "Korrekturbuchung prüfen: Berufsschultag im Urlaub";
  const message =
    `Laut Berufsschulmuster ist der ${fmtDMY(bsDate)} ein Berufsschultag im Urlaub ` +
    `${fmtDMY(request.startDate)}–${fmtDMY(request.endDate)} von ${employeeName}. Der Monat ist ` +
    `abgeschlossen, deshalb wurde nichts geändert. Bitte eine Korrekturbuchung prüfen.`;

  const recipientIds = await resolveApproverRecipients(tx, tenantId, request);
  for (const userId of recipientIds) {
    const existing = await tx.notification.findFirst({
      where: {
        userId,
        type: LEAVE_CORRECTION_NEEDED_VOCATIONAL_SCHOOL,
        relatedType: "LeaveRequest",
        relatedId: request.id,
      },
      select: { id: true },
    });
    if (existing) continue; // dedupe (D-04 must_haves: at most once per request + recipient)
    await tx.notification.create({
      data: {
        userId,
        type: LEAVE_CORRECTION_NEEDED_VOCATIONAL_SCHOOL,
        title,
        message,
        link: `/team/leave?request=${request.id}`,
        relatedType: "LeaveRequest",
        relatedId: request.id,
      },
    });
  }
}

/**
 * D-04 — call this inside the SAME transaction as the write that created/restored a
 * VOCATIONAL_SCHOOL Absence for `(args.employeeId, args.date)`. Re-prices every open VACATION
 * request of the employee covering that date through `resolveLeaveDays()` (which now excludes
 * the date, plan 01 D-02), books the difference back (reverse old / deduct new, same pair as
 * `PATCH /requests/:id/correct`), audits `LEAVE_CORRECTED`, and notifies. A date whose month is
 * already closed changes nothing and only raises the "correction needed" notification.
 *
 * Returns the ids of requests that were corrected and the ids that were only flagged — IDs
 * only, no side channel.
 */
export async function correctLeaveForNewVocationalSchoolDay(
  tx: Prisma.TransactionClient,
  audit: AuditFn,
  args: {
    tenantId: string;
    employeeId: string;
    date: Date;
    trigger: "PATTERN" | "MANUAL";
    actorUserId?: string;
  },
): Promise<{ corrected: string[]; flagged: string[] }> {
  const corrected: string[] = [];
  const flagged: string[] = [];

  const requests: CandidateRequest[] = await tx.leaveRequest.findMany({
    where: {
      employeeId: args.employeeId,
      employee: { tenantId: args.tenantId },
      deletedAt: null,
      status: { in: ["PENDING", ...EFFECTIVE_LEAVE_STATUSES] },
      leaveType: { code: "VACATION" }, // selection by code, never by name (CLAUDE.md)
      startDate: { lte: args.date },
      endDate: { gte: args.date },
    },
    select: {
      id: true,
      employeeId: true,
      leaveTypeId: true,
      startDate: true,
      endDate: true,
      halfDay: true,
      days: true,
      status: true,
      reviewedBy: true,
      employee: { select: { userId: true, firstName: true, lastName: true } },
    },
  });
  if (requests.length === 0) return { corrected, flagged };

  // Closed-month gate — exactly as manual-insert computes it (tenant-TZ month start of the BS
  // date itself), read inline because getTenantTimezone()'s signature is FastifyInstance["prisma"]
  // (not tx-compatible) — same reasoning as shift-leave-recalc-resolver.ts's own inline read.
  const tenantConfigRow = await tx.tenantConfig.findUnique({
    where: { tenantId: args.tenantId },
    select: { timezone: true },
  });
  const tenantTz = tenantConfigRow?.timezone ?? DEFAULT_TZ;
  const { start: monthStart } = monthRangeUtc(
    args.date.getUTCFullYear(),
    args.date.getUTCMonth() + 1,
    tenantTz,
  );
  const monthClosed = await isMonthClosed(tx, args.employeeId, args.tenantId, monthStart);

  for (const request of requests) {
    if (monthClosed) {
      await notifyCorrectionNeeded(tx, args.tenantId, request, args.date);
      flagged.push(request.id);
      continue;
    }

    const holidayMap = await getHolidayMap(
      tx,
      args.tenantId,
      args.employeeId,
      request.startDate,
      request.endDate,
    );
    const holidays = new Set(holidayMap.keys());
    const resolved = await resolveLeaveDays(
      tx,
      args.employeeId,
      args.tenantId,
      request.startDate,
      request.endDate,
      request.halfDay,
      holidays,
      { mode: "request", leaveTypeCode: "VACATION", excludeRequestId: request.id },
    );
    const newDays = Math.round(resolved.days * 100) / 100;
    const oldDays = Math.round(Number(request.days) * 100) / 100;

    if (newDays === oldDays) continue; // idempotent no-op (T-448-07)

    const isBooked = request.status === "APPROVED" || request.status === "CANCELLATION_REQUESTED";

    if (isBooked) {
      await reverseVacationDays(
        tx,
        request.employeeId,
        request.leaveTypeId,
        request.startDate,
        request.endDate,
        oldDays,
        holidays,
        args.tenantId,
      );
    }

    const updated = await tx.leaveRequest.update({
      where: { id: request.id },
      data: { days: newDays },
    });

    if (isBooked) {
      await deductVacationDays(
        tx,
        request.employeeId,
        request.leaveTypeId,
        request.startDate,
        request.endDate,
        newDays,
        holidays,
        args.tenantId,
      );
    }

    // Revisionssicherheit (D-04): every automatic correction gets a LEAVE_CORRECTED audit row,
    // inside this same transaction — a rollback of the BS write rolls this back too (T-448-06).
    await audit({
      tx,
      userId: args.actorUserId,
      action: "LEAVE_CORRECTED",
      entity: "LeaveRequest",
      entityId: request.id,
      oldValue: { ...request, days: oldDays },
      newValue: {
        ...updated,
        days: newDays,
        auditReason: BS_LEAVE_CORRECTION_REASON,
        origin: args.actorUserId ? undefined : "SYSTEM",
        trigger: args.trigger,
        vocationalSchoolDate: isoDate(args.date),
      },
    });

    await notifyCorrected(tx, args.tenantId, request, args.date, newDays);
    corrected.push(request.id);
  }

  return { corrected, flagged };
}

/**
 * D-04 — called (non-dry-run only) after the generator's locked-skip collection: for every date
 * in `args.dates` that the generator could NOT create a BS row for (BERSCH-09, month closed),
 * find any effective (APPROVED/CANCELLATION_REQUESTED) VACATION request of the employee covering
 * it and raise the same "correction needed" notification `correctLeaveForNewVocationalSchoolDay`
 * raises for its own closed-month branch — deduplicated the same way. Writes nothing else; a
 * PENDING request is not flagged here (no booking exists to reconcile yet, and it will still be
 * re-priced correctly once it is itself approved, since approval re-prices PENDING → APPROVED
 * through the same `resolveLeaveDays()` BS exclusion, plan 01 D-02).
 */
export async function flagLockedVocationalSchoolLeaveOverlaps(
  db: Prisma.TransactionClient,
  args: { tenantId: string; employeeId: string; dates: Date[] },
): Promise<string[]> {
  if (args.dates.length === 0) return [];

  const minDate = args.dates.reduce((a, b) => (a < b ? a : b));
  const maxDate = args.dates.reduce((a, b) => (a > b ? a : b));

  const requests: CandidateRequest[] = await db.leaveRequest.findMany({
    where: {
      employeeId: args.employeeId,
      employee: { tenantId: args.tenantId },
      deletedAt: null,
      status: { in: [...EFFECTIVE_LEAVE_STATUSES] },
      leaveType: { code: "VACATION" },
      startDate: { lte: maxDate },
      endDate: { gte: minDate },
    },
    select: {
      id: true,
      employeeId: true,
      leaveTypeId: true,
      startDate: true,
      endDate: true,
      halfDay: true,
      days: true,
      status: true,
      reviewedBy: true,
      employee: { select: { userId: true, firstName: true, lastName: true } },
    },
  });

  const flagged: string[] = [];
  for (const request of requests) {
    const overlapDate = args.dates.find(
      (d) => d.getTime() >= request.startDate.getTime() && d.getTime() <= request.endDate.getTime(),
    );
    if (!overlapDate) continue;
    await notifyCorrectionNeeded(db, args.tenantId, request, overlapDate);
    flagged.push(request.id);
  }
  return flagged;
}
