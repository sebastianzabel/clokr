/**
 * Issue #614 — the leave-correction core: "how a corrected range is re-booked".
 *
 * Lifted out of `PATCH /api/v1/leave/requests/:id/correct` (`api/leave.ts`) so the manager's
 * correction and the exit-day shortening of the anonymization (plan 614-04, D-02: shorten via the
 * EXISTING correction mechanics) run ONE implementation instead of two copies. The domain blocks
 * are moved verbatim (Phase 94 / Issue #468 provenance stays with the code: delta-lock, § 9 credit
 * supersede/clip, stored Überstundenausgleich minutes, revalidation of removed days); only the
 * HTTP seams changed — a refusal is returned as data, audits go through a port, the actor is an
 * input.
 *
 * Three phases, same shape as `employment-exit.ts`:
 *   1. {@link prepareLeaveCorrection}  every read and EVERY pre-write refusal, in the order the
 *      route always had; returns a refusal `{ ok: false, statusCode, body, reason }` or a plan.
 *   2. {@link applyLeaveCorrection}    the transactional writes (reverse old booking, § 9
 *      supersede, row update, apply new booking, § 9 re-credit, revalidate removed days) inside
 *      the CALLER's transaction; every audit row goes through the port.
 *   3. {@link finishLeaveCorrection}   snapshot recalculation + balance persist, after commit.
 *
 * The caller owns tenant, scope and status checks (the route: 404 / 404 / APPROVED-only 409) and
 * the post-transaction `LEAVE_CORRECTED` audit. A `Section9ConcurrentCorrectionError` thrown by
 * `applyLeaveCorrection` rolls the caller's transaction back; the route maps it to 409.
 *
 * Deliberately NOT re-exported from `contexts/absence/index.ts` (import-cycle cap 22) and not
 * under `facade/`: the importers are `api/leave.ts` and, from plan 614-04, `employment-exit.ts`.
 */
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import { EFFECTIVE_LEAVE_STATUSES } from "./effective-leave-statuses"; // Issue #478
import { computeAffectedMonths, monthsInRange } from "./correction-lock";
import {
  resolveLeaveDays,
  getHolidayMap,
  deductVacationDays,
  reverseVacationDays,
} from "./leave-days";
import { BS_ONLY_LEAVE_ERROR, BS_ONLY_LEAVE_ERROR_CODE } from "./bs-leave-days";
import { scheduledLeaveMinutes, overtimeCompReversalMinutes } from "./overtime-comp-minutes";
import { ensureLeaveType } from "./ensure-leave-type";
import { isSickLeaveTypeCode, type RequestableCode } from "./leave-type";
import { activeParentalReductions, reducedYearsAffectedByRange } from "./parental-leave-reduction";
import { intersectRanges, planSection9CreditsForCorrection } from "./section9-detect";
import {
  getTenantTimezone,
  monthRangeUtc,
  isMonthClosed,
  bookOvertimeCompensation,
  reverseOvertimeCompensation,
  recalculateSnapshots,
  computeOvertimeBalanceHours,
  persistOvertimeBalance,
} from "../working-time-account";
import { revalidateLeaveCancellationEntries } from "../time-tracking";
import { Section9ConcurrentCorrectionError, supersedeSection9Credit } from "./section9-supersede";

export { Section9ConcurrentCorrectionError };

/** The request being corrected, as the route reads it (tenant already checked by the caller). */
export type CorrectableLeaveRequest = Prisma.LeaveRequestGetPayload<{
  include: { leaveType: true; employee: { select: { tenantId: true } } };
}>;

export interface LeaveCorrectionInput {
  existing: CorrectableLeaveRequest;
  start: Date;
  end: Date;
  halfDay: boolean;
  type?: RequestableCode;
  note?: string | null;
  /** The mandatory Korrektur-Begründung; carried into the § 9 audit rows. */
  reason: string;
  tenantId: string;
}

/** Internal machine marker of a refusal; the route sends `statusCode` + `body` only. */
export type LeaveCorrectionRefusalReason =
  "CLOSED_MONTH" | "HALF_DAY_SICK" | "OVERLAP" | "PARENTAL_REDUCTION" | "BS_ONLY";

export interface LeaveCorrectionRefusal {
  ok: false;
  statusCode: 400 | 409;
  body: { error: string; code?: string };
  reason: LeaveCorrectionRefusalReason;
}

function refusal(
  statusCode: 400 | 409,
  body: { error: string; code?: string },
  reason: LeaveCorrectionRefusalReason,
): LeaveCorrectionRefusal {
  return { ok: false, statusCode, body, reason };
}

type TouchingSection9Credit = Prisma.Section9CreditGetPayload<{
  include: {
    vacationRequest: {
      select: {
        id: true;
        leaveTypeId: true;
        halfDay: true;
        leaveType: { select: { code: true } };
      };
    };
  };
}>;

interface Section9ClipPricing {
  id: string;
  start: Date;
  end: Date;
  priced: number;
  vacationLeaveTypeId: string;
}

/** Everything {@link applyLeaveCorrection} / {@link finishLeaveCorrection} and the caller's audit need. */
export interface LeaveCorrectionPlan {
  existing: CorrectableLeaveRequest;
  start: Date;
  end: Date;
  halfDay: boolean;
  note: string | null | undefined;
  reason: string;
  tenantId: string;
  oldTypeCode: CorrectableLeaveRequest["leaveType"]["code"];
  newType: string;
  days: number;
  daysProvisionalForCorrection: boolean | null;
  newLeaveTypeId: string;
  holidays: Set<string>;
  /** Stored (or A-4 recomputed) minutes the OLD OVERTIME_COMP booking reverses; null otherwise. */
  oldOtMinutes: number | null;
  oldOtSource: "stored" | "recomputed" | null;
  /** Minutes the NEW OVERTIME_COMP booking books; null otherwise. */
  newOtMinutes: number | null;
  touchingSection9Credits: TouchingSection9Credit[];
  section9CorrectionPlan: ReturnType<typeof planSection9CreditsForCorrection>;
  section9ClipPricings: Section9ClipPricing[];
}

export type LeaveCorrectionPrepared =
  { ok: true; plan: LeaveCorrectionPlan } | LeaveCorrectionRefusal;

/** Writes one audit row inside the caller's transaction; the route binds this to `app.audit`. */
export interface LeaveCorrectionPort {
  /** Written as `reviewedBy` on a § 9 correction credit. */
  actorUserId: string | null;
  audit(entry: {
    action: string;
    entity: string;
    entityId: string;
    oldValue?: object;
    newValue?: object;
  }): Promise<void>;
}

/** Phase 1 — pure reads. Every pre-write refusal of the correction, in the route's order. */
export async function prepareLeaveCorrection(
  app: FastifyInstance,
  input: LeaveCorrectionInput,
): Promise<LeaveCorrectionPrepared> {
  const { existing, start, end, tenantId } = input;
  const body = { halfDay: input.halfDay, note: input.note, type: input.type };

  // ── Delta-Lock guard (EDIT-03 / T-94-01) ───────────────────────────────
  // Blocks (409) any correction whose CHANGED days (symmetric date diff; plus
  // retained days when type/halfDay changed) touch a finalized (locked) month.
  // The retained overlap of a shortened leave stays untouched, so shortening a
  // long Elternzeit at its unlocked tail is allowed even if early months closed.
  const existingTypeCode = existing.leaveType.code;
  const typeChanged = body.type != null && body.type !== existingTypeCode;
  const halfDayChanged = body.halfDay !== existing.halfDay;
  const affectedMonths = computeAffectedMonths({
    oldStart: existing.startDate,
    oldEnd: existing.endDate,
    newStart: start,
    newEnd: end,
    typeChanged,
    halfDayChanged,
  });

  // WR-94-01: a day-invariant metadata edit (note-only — identical dates, type
  // and halfDay) produces zero affected days, so the day-based delta-lock above
  // would wave it through. But Revisionssicherheit forbids editing an entry that
  // lies in a finalized (locked) month — even a note change fires a net-zero
  // reverse/apply pair against the locked year's entitlement ledger. When nothing
  // day-related changed but the note did, lock-check the FULL retained range.
  const noteChanged = (body.note ?? null) !== (existing.note ?? null);
  const monthsToCheck =
    affectedMonths.length === 0 && noteChanged
      ? computeAffectedMonths({
          oldStart: existing.startDate,
          oldEnd: existing.endDate,
          newStart: start,
          newEnd: end,
          typeChanged: true, // force the retained intersection into the affected set
          halfDayChanged: false,
        })
      : affectedMonths;

  if (monthsToCheck.length > 0) {
    const tz = await getTenantTimezone(app.prisma, existing.employee.tenantId);
    for (const { year, month } of monthsToCheck) {
      const { start: monthStart } = monthRangeUtc(year, month, tz);
      // Phase 100B Plan 07 (W1, isMonthClosed) — THE canonical Monatsabschluss signal.
      const locked = await isMonthClosed(
        app.prisma,
        existing.employeeId,
        existing.employee.tenantId,
        monthStart,
      );
      if (locked) {
        return refusal(
          409,
          { error: "Gesperrter Monat — Korrektur nicht möglich" },
          "CLOSED_MONTH",
        );
      }
    }
  }

  // ── Recalc model (94-02): REVERSE the OLD booking (by the OLD leaveType),
  //    then APPLY the NEW booking (by the NEW leaveType). Never branches on
  //    the effective type alone — that would leave a VACATION/OVERTIME_COMP
  //    day consumed when corrected INTO a sick type. All domain guards run
  //    PRE-WRITE so a rejected correction never leaves a partial saldo write.
  const oldTypeCode = existingTypeCode; // from existing.leaveType.code (delta-lock step)
  const newType = body.type ?? oldTypeCode;

  // IN-94-01 (Phase 97, D-21) used to guard here: a LeaveType row whose `code` was NULL
  // (pre-backfill, or written by the old image during a rolling deploy) left oldTypeCode
  // undefined, and the reverse/apply dispatch below would silently fall through to a no-op —
  // updating dates/days WITHOUT adjusting the entitlement ledger (a stranded Kontingent).
  // Issue #206's migration (20260923090815_leave_type_code_not_null) tightened that column to
  // required, making that state impossible to construct: `existing.leaveType.code` is a
  // required `LeaveTypeCode` now, so `oldTypeCode` (and therefore `newType`) can never be
  // falsy for a real row. The assertion moved from this application guard into the database
  // constraint — it did not disappear.

  // ── Step 7a: half-day-sick reject (pre-write) — Krankheit ist immer ganztägig.
  if (body.halfDay && (newType === "SICK" || newType === "SICK_CHILD")) {
    return refusal(
      400,
      {
        error:
          "Halbe Kranktage sind nicht zulässig — Krankheit wird immer ganztägig gutgeschrieben.",
      },
      "HALF_DAY_SICK",
    );
  }

  // ── Step 7b: overlap guard (pre-write) for a CHANGED date range. Excludes
  //    the request itself (id:{not}). An identical-range correction (type/
  //    halfDay-only) introduces no new collision, so it is not re-checked.
  const dateChanged =
    start.getTime() !== existing.startDate.getTime() ||
    end.getTime() !== existing.endDate.getTime();
  if (dateChanged) {
    const overlaps = await app.prisma.leaveRequest.findMany({
      where: {
        employeeId: existing.employeeId,
        deletedAt: null,
        status: { in: ["PENDING", ...EFFECTIVE_LEAVE_STATUSES] }, // Issue #478: same set as POST
        startDate: { lte: end },
        endDate: { gte: start },
        id: { not: existing.id },
      },
      include: { leaveType: true },
    });
    // Issue #468 (Rule 1/3 auto-fix, blocking): the R1 exception from POST /requests
    // (leave.ts above, "§ 9 BUrlG — wird ein Mitarbeiter während genehmigten Urlaubs
    // krank...") was never mirrored here, so correcting EITHER side of an already-APPROVED
    // sick-over-vacation § 9 pair always 409'd — even a trivial shortening of the vacation's
    // tail that leaves the sick days fully inside the new range. Without this, the § 9
    // credit-aware correction this plan adds (Steps 8b/10b above) could never actually be
    // exercised through PATCH /correct for the "credit stays inside" shape central to this
    // phase. Mirrored bidirectionally: /correct can be called on either side of the pair.
    const correctedIsSick = isSickLeaveTypeCode(newType);
    const blockingOverlap = overlaps.find((o) => {
      // § 9 exception never applies vs PENDING (Issue #478: CANCELLATION_REQUESTED counts as active)
      if (!(EFFECTIVE_LEAVE_STATUSES as readonly string[]).includes(o.status)) return true;
      const otherIsSick = isSickLeaveTypeCode(o.leaveType.code);
      if (correctedIsSick !== otherIsSick) return false; // § 9 case — permitted either way
      return true; // same-kind overlap (vacation/vacation, sick/sick) — still blocked
    });
    if (blockingOverlap) {
      return refusal(409, { error: "Überschneidung mit bestehendem Antrag" }, "OVERLAP");
    }
  }

  // ── Step 7c (Issue #468 plan 07, D-10): a declared Elternzeit-Kürzung is changed only by
  // its own correction entry (revocation), never implicitly by moving the Elternzeit it
  // anchors on. A type change away from PARENTAL always invalidates every ACTIVE reduction's
  // anchor; a date change invalidates it only when a reduced year's own full-month count
  // would actually differ — a day-level shift inside the same full months stays allowed.
  if (existingTypeCode === "PARENTAL") {
    const activeReductions = await activeParentalReductions(app.prisma, existing.id, tenantId);
    if (activeReductions.length > 0) {
      if (typeChanged) {
        return refusal(
          409,
          {
            error:
              "Für diese Elternzeit ist eine Kürzung erklärt — bitte die Kürzung zuerst widerrufen.",
          },
          "PARENTAL_REDUCTION",
        );
      }
      const affectedYears = reducedYearsAffectedByRange({
        oldStart: existing.startDate,
        oldEnd: existing.endDate,
        newStart: start,
        newEnd: end,
        reducedYears: activeReductions,
      });
      if (affectedYears.length > 0) {
        return refusal(
          409,
          {
            error: `Für diese Elternzeit ist eine Kürzung für ${affectedYears.join(", ")} erklärt — bitte die Kürzung zuerst widerrufen.`,
          },
          "PARENTAL_REDUCTION",
        );
      }
    }
  }

  // Holidays across the UNION of old+new range: the reverse needs the OLD
  // range, the apply + day recompute need the NEW range.
  const unionStart = existing.startDate < start ? existing.startDate : start;
  const unionEnd = existing.endDate > end ? existing.endDate : end;
  const holidayMap = await getHolidayMap(
    app.prisma,
    tenantId,
    existing.employeeId,
    unionStart,
    unionEnd,
  );
  const holidays = new Set(holidayMap.keys());
  // Phase 107 (D-09/D-10): roster-aware recompute of the corrected (NEW) range. Unlike
  // POST /requests and the PENDING edit above, this path produces a new APPROVED value, so
  // daysProvisional is also written below -- but only when the employee is actually
  // SHIFT_BASED (a separate check, since resolveLeaveDays()'s `.provisional` is always
  // `false` for every other type and would otherwise overwrite the column's `null` "not
  // applicable" state with a misleading `false`).
  // Issue #436 (D-04/D-09): priced against the corrected (NEW) leave type, excluding this
  // request itself.
  const {
    days,
    provisional: correctionProvisional,
    vocationalSchoolOnly: correctVocationalSchoolOnly,
  } = await resolveLeaveDays(
    app.prisma,
    existing.employeeId,
    tenantId,
    start,
    end,
    body.halfDay,
    holidays,
    { mode: "request", leaveTypeCode: newType, excludeRequestId: existing.id },
  );

  // Issue #448 (D-02): one rule on every write path — before the transaction opens, same
  // guard shape as the delta-lock 409 above.
  if (correctVocationalSchoolOnly) {
    return refusal(400, { error: BS_ONLY_LEAVE_ERROR, code: BS_ONLY_LEAVE_ERROR_CODE }, "BS_ONLY");
  }

  const wsForCorrection = await app.prisma.workSchedule.findFirst({
    where: { employeeId: existing.employeeId },
    orderBy: { validFrom: "desc" },
    select: { type: true },
  });
  const daysProvisionalForCorrection =
    wsForCorrection?.type === "SHIFT_BASED" ? correctionProvisional : null;

  // Resolve the NEW leaveTypeId when the type changed (ensureLeaveType migrates
  // legacy names / creates the canonical type on demand).
  const newLeaveTypeId =
    typeChanged && body.type != null
      ? await ensureLeaveType(app.prisma, app.log, tenantId, body.type)
      : existing.leaveTypeId;

  // Issue #468 (D-01): resolved ONCE on app.prisma, BEFORE the transaction opens —
  // getTenantTimezone() is typed against FastifyInstance["prisma"], not a tx client, and
  // its own 5-minute cache makes a second lookup pointless.
  const tzForCorrection = await getTenantTimezone(app.prisma, tenantId);

  // Issue #468 (D-02): the OLD and NEW Überstundenausgleich amounts are resolved HERE — pure
  // reads on app.prisma, before the transaction opens — never inside it. The OLD side reverses
  // the STORED booking (never a recomputation, so a schedule edited after approval cannot
  // change what gets reversed); a legacy row with no stored value falls back to today's
  // recomputation (A-4), logged so the fallback stays visible. The NEW side is always priced
  // fresh against the corrected range.
  let oldOtMinutes: number | null = null;
  let oldOtSource: "stored" | "recomputed" | null = null;
  if (oldTypeCode === "OVERTIME_COMP") {
    const reversal = await overtimeCompReversalMinutes(
      app.prisma,
      tenantId,
      existing,
      async () => ({ holidays, tz: tzForCorrection }),
    );
    oldOtMinutes = reversal.minutes;
    oldOtSource = reversal.source;
    if (reversal.source === "recomputed") {
      app.log.warn(
        { leaveRequestId: existing.id, employeeId: existing.employeeId },
        "OVERTIME_COMP correction without a stored booking — recomputed (Issue #468 A-4 legacy fallback)",
      );
    }
  }
  let newOtMinutes: number | null = null;
  if (newType === "OVERTIME_COMP") {
    newOtMinutes = await scheduledLeaveMinutes(
      app.prisma,
      existing.employeeId,
      tenantId,
      start,
      end,
      body.halfDay,
      holidays,
      tzForCorrection,
    );
  }

  // Issue #468 (D-04/A-3, finding 2/G18): pure reads BEFORE the transaction opens — the §
  // 9 credits touching this request (either side), classified against the NEW range by
  // planSection9CreditsForCorrection, then every clipped replacement range re-priced. Only
  // the write (status, ledger undo/re-credit, audit) happens inside the CR-01 transaction
  // below (Steps 8b/10b).
  const touchingSection9Credits = await app.prisma.section9Credit.findMany({
    where: {
      OR: [{ vacationRequestId: existing.id }, { sickRequestId: existing.id }],
      status: { not: "SUPERSEDED" },
      employee: { tenantId },
    },
    include: {
      vacationRequest: {
        select: {
          id: true,
          leaveTypeId: true,
          halfDay: true,
          leaveType: { select: { code: true } },
        },
      },
    },
  });
  const section9CorrectionPlan = planSection9CreditsForCorrection({
    credits: touchingSection9Credits.map((c) => ({
      id: c.id,
      status: c.status,
      creditedStart: c.creditedStart,
      creditedEnd: c.creditedEnd,
      overlapStart: c.overlapStart,
      overlapEnd: c.overlapEnd,
    })),
    newStart: start,
    newEnd: end,
    typeChanged,
  });
  type Section9ClipPricing = {
    id: string;
    start: Date;
    end: Date;
    priced: number;
    vacationLeaveTypeId: string;
  };
  const section9ClipPricings: Section9ClipPricing[] = [];
  for (const clip of section9CorrectionPlan.clip) {
    const credit = touchingSection9Credits.find((c) => c.id === clip.id)!;
    // D-04: the VACATION-side type code never changes on this path (a type change on the
    // vacation side always forces a full supersede above, never a clip) — stable for
    // either side of the correction.
    const isVacationSide = credit.vacationRequestId === existing.id;
    const { days: priced } = await resolveLeaveDays(
      app.prisma,
      existing.employeeId,
      tenantId,
      clip.start,
      clip.end,
      isVacationSide ? body.halfDay : credit.vacationRequest.halfDay,
      holidays,
      {
        mode: "request",
        leaveTypeCode: credit.vacationRequest.leaveType.code,
        excludeRequestId: isVacationSide ? existing.id : credit.vacationRequest.id,
      },
    );
    section9ClipPricings.push({
      id: clip.id,
      start: clip.start,
      end: clip.end,
      priced,
      vacationLeaveTypeId: credit.vacationRequest.leaveTypeId,
    });
  }

  // ── WR-03 (Issue #468 review): locked-month guard for the § 9 ledger writes below ──
  // The delta-lock above (computeAffectedMonths) only covers THIS request's own
  // changed days. The § 9 ledger undo (Step 8b, deductVacationDays over a superseded
  // credit's OWN creditedStart/creditedEnd) and the re-credit (Step 10b,
  // reverseVacationDays over the clipped replacement range) move LeaveEntitlement days
  // for ranges that are not guaranteed to be a subset of that delta — guard every
  // distinct month either write actually touches, same 409 message/convention as the
  // delta-lock check above.
  const section9LedgerMonths = new Map<string, { year: number; month: number }>();
  for (const sup of section9CorrectionPlan.supersede) {
    if (!sup.ledgerUndo) continue;
    const credit = touchingSection9Credits.find((c) => c.id === sup.id)!;
    for (const m of monthsInRange(credit.creditedStart!, credit.creditedEnd!)) {
      section9LedgerMonths.set(`${m.year}-${m.month}`, m);
    }
  }
  for (const cp of section9ClipPricings) {
    if (cp.priced <= 0) continue;
    for (const m of monthsInRange(cp.start, cp.end)) {
      section9LedgerMonths.set(`${m.year}-${m.month}`, m);
    }
  }
  for (const { year, month } of section9LedgerMonths.values()) {
    const { start: monthStart } = monthRangeUtc(year, month, tzForCorrection);
    const locked = await isMonthClosed(app.prisma, existing.employeeId, tenantId, monthStart);
    if (locked) {
      return refusal(409, { error: "Gesperrter Monat — Korrektur nicht möglich" }, "CLOSED_MONTH");
    }
  }

  return {
    ok: true,
    plan: {
      existing,
      start,
      end,
      halfDay: input.halfDay,
      note: input.note,
      reason: input.reason,
      tenantId,
      oldTypeCode,
      newType,
      days,
      daysProvisionalForCorrection,
      newLeaveTypeId,
      holidays,
      oldOtMinutes,
      oldOtSource,
      newOtMinutes,
      touchingSection9Credits,
      section9CorrectionPlan,
      section9ClipPricings,
    },
  };
}

/**
 * Phase 2 — the writes, Steps 8–11 of the 94 CR-01 transaction. Runs inside the caller's `tx`;
 * returns the updated row (same `include` as before the extraction).
 */
export async function applyLeaveCorrection(
  tx: Prisma.TransactionClient,
  plan: LeaveCorrectionPlan,
  port: LeaveCorrectionPort,
) {
  const {
    existing,
    start,
    end,
    tenantId,
    oldTypeCode,
    newType,
    days,
    daysProvisionalForCorrection,
    newLeaveTypeId,
    holidays,
    oldOtMinutes,
    newOtMinutes,
    touchingSection9Credits,
    section9CorrectionPlan,
    section9ClipPricings,
  } = plan;
  const body = { halfDay: plan.halfDay, note: plan.note, reason: plan.reason };

  // ── Step 8: REVERSE the OLD booking (dispatch on the OLD typeCode) ──────
  if (oldTypeCode === "VACATION") {
    await reverseVacationDays(
      tx,
      existing.employeeId,
      existing.leaveTypeId,
      existing.startDate,
      existing.endDate,
      Number(existing.days),
      holidays,
      tenantId,
    );
  } else if (oldTypeCode === "OVERTIME_COMP") {
    // Issue #468 (D-02): reverses the STORED/recomputed-fallback amount resolved ABOVE,
    // before the transaction opened — never a fresh recomputation inside the transaction.
    await reverseOvertimeCompensation(
      tx,
      existing.employeeId,
      tenantId,
      (oldOtMinutes ?? 0) / 60,
      `Korrektur Überstundenausgleich ${existing.startDate.toISOString().split("T")[0]}`,
    );
  }
  // SICK / SICK_CHILD / PARENTAL / MATERNITY / SPECIAL / UNPAID / EDUCATION:
  // entitlement-neutral on the reverse side (no usedDays / balance booking).

  // ── Step 8b: SUPERSEDE § 9 credits the new range leaves behind (Issue #468, D-04/A-3,
  //    finding 2/G18) — classified ABOVE (section9CorrectionPlan), written here. A
  //    CONFIRMED credit actually booked a ledger entry at confirm time (reverseVacationDays
  //    — gave the day back); undoing it here is the exact mirror: deductVacationDays takes
  //    the day back out again. AU_PENDING/REJECTED credits never booked anything, so only
  //    their status changes. Worked numbers (see <objective>): approve 10 → 10; confirm 3
  //    → 7; correct to 7 with the credit now outside: reverse 10 → −3, undo (deduct) 3 → 0,
  //    apply 7 → 7.
  for (const sup of section9CorrectionPlan.supersede) {
    const credit = touchingSection9Credits.find((c) => c.id === sup.id)!;
    // WR-02 (Issue #468 review): `touchingSection9Credits` was read BEFORE this transaction
    // opened, so the shared supersession guards the status transition itself (optimistic lock,
    // 409 on a concurrent writer) - see section9-supersede.ts, the one place the rule lives.
    await supersedeSection9Credit(tx, {
      credit,
      ledgerUndo: sup.ledgerUndo,
      employeeId: existing.employeeId,
      tenantId,
      holidays,
      audit: port.audit,
      auditNewValue: {
        correctedLeaveRequestId: existing.id,
        newStartDate: start.toISOString().split("T")[0],
        newEndDate: end.toISOString().split("T")[0],
        auditReason: body.reason,
        note: "§ 9 BUrlG — durch Korrektur des Antrags überholt",
      },
    });
  }

  // ── Step 9: update the row (94-01 base + NEW leaveTypeId) ───────────────
  const updatedRow = await tx.leaveRequest.update({
    where: { id: existing.id },
    data: {
      startDate: start,
      endDate: end,
      halfDay: body.halfDay,
      days,
      daysProvisional: daysProvisionalForCorrection, // Phase 107 (D-10)
      note: body.note,
      leaveTypeId: newLeaveTypeId,
      // Issue #468 (D-02): keeps the stored booking current — null when the corrected
      // type is no longer OVERTIME_COMP, so a later correction never reverses a stale
      // amount from a type the request has since moved away from.
      overtimeCompMinutes: newType === "OVERTIME_COMP" ? newOtMinutes : null,
    },
    include: {
      leaveType: true,
      employee: { select: { firstName: true, lastName: true, employeeNumber: true } },
    },
  });

  // ── Step 10: APPLY the NEW booking (dispatch on the NEW typeCode) ───────
  //    "Light" for Krankheit = NO entitlement apply on the new side (it does
  //    NOT skip the OLD-side reversal nor the recalc tail).
  if (newType === "VACATION") {
    await deductVacationDays(
      tx,
      existing.employeeId,
      newLeaveTypeId,
      start,
      end,
      days,
      holidays,
      tenantId,
    );
  } else if (newType === "OVERTIME_COMP") {
    // Issue #468 (D-02): books the amount resolved ABOVE, before the transaction opened —
    // never a fresh recomputation inside the transaction.
    await bookOvertimeCompensation(
      tx,
      existing.employeeId,
      tenantId,
      (newOtMinutes ?? 0) / 60,
      `Überstundenausgleich ${start.toISOString().split("T")[0]} – ${end.toISOString().split("T")[0]}`,
    );
  }
  // SICK / SICK_CHILD / PARENTAL / MATERNITY / SPECIAL / UNPAID / EDUCATION:
  // entitlement-neutral on the apply side (light).

  // ── Step 10b: RE-CREDIT the clipped part of a partially-superseded CONFIRMED credit
  //    (Issue #468, D-04/A-3) — a new revision+1 correction credit for exactly the part
  //    that is still inside the new range, re-priced ABOVE (section9ClipPricings). A clip
  //    priced at 0 days (e.g. the clipped range is a non-workday) becomes a plain
  //    supersede — no replacement row, nothing to re-credit. Worked: partial (2 of 3 days
  //    stay) — reverse 10 → −3, undo (deduct) 3 → 0, apply 7 → 7, re-credit 2 → 5.
  for (const cp of section9ClipPricings) {
    if (cp.priced <= 0) continue;
    const original = touchingSection9Credits.find((c) => c.id === cp.id)!;
    // The sick/vacation overlap is recomputed against the NEW range of whichever side of
    // the pair this correction touches — `start`/`end` are the corrected request's own
    // new range, which is exactly the side `original` references via existing.id.
    const overlapClip = intersectRanges(original.overlapStart, original.overlapEnd, start, end)!;
    const created = await tx.section9Credit.create({
      data: {
        employeeId: original.employeeId,
        sickRequestId: original.sickRequestId,
        vacationRequestId: original.vacationRequestId,
        revision: original.revision + 1,
        supersedesId: original.id,
        status: "CONFIRMED",
        overlapStart: overlapClip.start,
        overlapEnd: overlapClip.end,
        creditedStart: cp.start,
        creditedEnd: cp.end,
        creditedDays: cp.priced,
        attestSource: original.attestSource,
        attestValidFrom: original.attestValidFrom,
        attestValidTo: original.attestValidTo,
        documentPath: original.documentPath,
        reason: "Korrektur: Antrag geändert — § 9-Gutschrift angepasst",
        reviewedBy: port.actorUserId,
        reviewedAt: new Date(),
      },
    });
    // CR-01 (Issue #468 review): re-credit the clipped part for WHATEVER type the
    // original credit's vacation side is — symmetric with the Step 8b undo above and
    // with the confirm path's unconditional reverseVacationDays() call.
    await reverseVacationDays(
      tx,
      existing.employeeId,
      cp.vacationLeaveTypeId,
      cp.start,
      cp.end,
      cp.priced,
      holidays,
      tenantId,
    );
    await port.audit({
      action: "SECTION9_CREDIT_CORRECTED",
      entity: "Section9Credit",
      entityId: created.id,
      newValue: {
        supersedesId: original.id,
        revision: created.revision,
        creditedStart: cp.start.toISOString().split("T")[0],
        creditedEnd: cp.end.toISOString().split("T")[0],
        creditedDays: cp.priced,
        correctedLeaveRequestId: existing.id,
      },
    });
  }

  // ── Step 11: revalidate removed-day time entries (old range \ new range).
  //    A shortened/moved leave frees days whose leave-caused invalidation must
  //    be cleared. Delta-lock already guarantees these fall in unlocked months;
  //    locked / soft-deleted entries are never touched (Revisionssicherheit).
  // Phase 100B Plan 08 — T6, contexts/time-tracking facade (H2 guard unchanged).
  // Issue #370, D-05: accumulate the revalidated rows across both calls below so they
  // can be audited once, inside this same transaction, before it closes.
  const revalidatedEntries: Awaited<ReturnType<typeof revalidateLeaveCancellationEntries>> = [];
  const revalidateRemoved = async (from: Date, to: Date) => {
    if (from > to) return;
    revalidatedEntries.push(
      ...(await revalidateLeaveCancellationEntries(tx, existing.employeeId, tenantId, from, to)),
    );
  };
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  if (start > existing.startDate) {
    // head removed: [oldStart .. newStart-1]
    await revalidateRemoved(existing.startDate, new Date(start.getTime() - ONE_DAY_MS));
  }
  if (end < existing.endDate) {
    // tail removed: [newEnd+1 .. oldEnd]
    await revalidateRemoved(new Date(end.getTime() + ONE_DAY_MS), existing.endDate);
  }
  // Issue #370, D-05: one TimeEntry UPDATE audit per revalidated row, inside the tx so a
  // rollback (94 CR-01) never leaves an orphan audit row — same rule as overtime.ts's
  // COMP-V1814-05 comment.
  for (const row of revalidatedEntries) {
    await port.audit({
      action: "UPDATE",
      entity: "TimeEntry",
      entityId: row.id,
      oldValue: row.oldValue,
      newValue: row.newValue,
    });
  }

  return updatedRow;
}

/**
 * Phase 3 — after the transaction committed: the snapshot recalculation (error logged, never
 * thrown) and the overtime balance persist (non-transactional; an error propagates, Issue #294).
 */
export async function finishLeaveCorrection(
  app: FastifyInstance,
  plan: Pick<LeaveCorrectionPlan, "existing" | "start">,
): Promise<void> {
  const { existing, start } = plan;
  // Saldo recalculation from the EARLIER of old/new start, so an extended range is recomputed
  // from the right month on (EDIT / T-94-05).
  const recalcFrom = existing.startDate < start ? existing.startDate : start;
  await recalculateSnapshots(app, existing.employeeId, recalcFrom).catch((err) =>
    app.log.error(
      { err, employeeId: existing.employeeId },
      "Failed to recalculate snapshots after leave correction",
    ),
  );
  // Issue #294: swallower removed — a failing recompute now answers non-2xx instead of a
  // silent 200 with a stale balance. Full atomicity is NOT available at this site: the
  // booking pair above is already committed inside the CR-01 transaction, and this recompute
  // reads the leave row through `app.prisma` — it must run AFTER that transaction commits, or
  // it would read the pre-correction state. Threading a client through
  // computeOvertimeBalanceBreakdown() was ruled out (it performs ~15 separate app.prisma reads
  // plus getEffectiveSchedule(app, …)). Inlined via computeOvertimeBalanceHours +
  // persistOvertimeBalance (rather than the updateOvertimeAccount() wrapper) — byte-identical
  // behaviour, same null-guard for the §18-exempt path, same non-transactional app.prisma write.
  const effectiveBalanceHoursForCorrection = await computeOvertimeBalanceHours(
    app,
    existing.employeeId,
  );
  if (effectiveBalanceHoursForCorrection !== null) {
    await persistOvertimeBalance(
      app,
      app.prisma,
      existing.employeeId,
      effectiveBalanceHoursForCorrection,
    );
  }
}
