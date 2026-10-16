// Time-entry invariant checks (overlap, month-lock, retro-window) and effective
// schedule resolution — lifted out of ./api/time-entries.ts in Phase 101B (Issue #101). Consumed
// across contexts (working-time-account, platform, scheduling); under ADR 0001 they must reach
// those consumers through time-tracking/index.ts, and an index.ts that re-exports a ROUTE module
// drags the whole route file's import set onto the public surface. The bodies are unchanged —
// this was a relocation, not a rewrite.
//
// getEffectiveSchedule() below is also called by working-time-account/overtime-balance.ts — it
// lives here rather than there because "which schedule applies to this employee on this day" is a
// Zeiterfassung question, not an Arbeitszeitkonto one.

import { FastifyInstance } from "fastify";
import { Prisma } from "@clokr/db";
import { isMonthClosed, dateStrInTz, todayInTz, monthRangeUtc } from "../working-time-account"; // Phase 101B
import {
  getRetroEntryWindowDays,
  computeRetroLimitStr,
  computeEntryAgeInDays,
} from "./retro-config"; // Phase 76.29 — RETRO-01 window guard
import {
  checkOverlap,
  EntryConflictError,
  overlapMessageForCaller,
  type OverlapConflict,
} from "./entry-overlap-error"; // Issue #70, D-13
import type { AccessContext } from "../platform"; // Issue #70, D-13 — the caller of the write

// `checkOverlap` lives in ./entry-overlap-error.ts (a leaf): the facade needs it too, and importing it
// from here would route the facade through working-time-account and back (import cycle, Issue #92).
export { checkOverlap };

// The in-transaction overlap re-check of every manual writer (Issue #70, D-10). Runs AFTER
// `lockEmployeeForEntryWrite(tx, …)`, so it sees every committed row of a racing writer of the
// same employee; throws `EntryConflictError` (the route answers 409) carrying the text worded by
// the caller's reach (D-13). The date scoping of open entries is `checkOverlap`'s own.
export async function recheckOverlapInTx(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    employeeId: string;
    newStart: Date;
    newEnd: Date | null;
    date: Date;
    tz: string;
    excludeEntryId?: string;
    callerEmployeeId: string | null;
    access: AccessContext;
  },
): Promise<void> {
  const conflict = await checkOverlap(
    tx,
    params.employeeId,
    params.newStart,
    params.newEnd,
    params.excludeEntryId,
    params.date,
  );
  if (!conflict) return;
  throw new EntryConflictError(
    await overlapMessageForCaller(tx, {
      conflict,
      tz: params.tz,
      tenantId: params.tenantId,
      employeeId: params.employeeId,
      callerEmployeeId: params.callerEmployeeId,
      access: params.access,
    }),
  );
}

// Shared time-entry invariants enforced by POST /time-entries, PUT /time-entries/:id
// and the CSV import (POST /imports/time-entries). Extracting them here (D-01/D-03)
// guarantees the three write paths cannot drift: month-lock via SaldoSnapshot, retro-window
// guard (RETRO-01), and overlap — all with self-exclusion for edits. Since Issue #70 an employee
// may hold several entries per day, so there is no one-per-day step any more: the interval
// overlap (and, in the database, the exclusion constraint) is the only day-level rule.
// Returns { error, windowDays?, entryAgeInDays? } or null.
// Callers map "abgeschlossen" (month-lock) and "RETRO_WINDOW_EXCEEDED" errors to HTTP 403
// and everything else to 409.
//
// Exemptions from the retro-window guard (RETRO-01 / RETRO-05):
//   - isCorrectionByManager=true  → manager editing a DIFFERENT employee's entry (inline correction)
//   - grantId present             → caller pre-validated an approved RetroEntryRequest (Plan 03)
//   - NFC/terminal punches        → naturally exempt (see nfc-punch route comment below)
//   - CSV import                  → exempt via isCorrectionByManager:true (see imports.ts)
export async function validateTimeEntryInvariants(
  app: FastifyInstance,
  params: {
    employeeId: string;
    date: Date; // calendar date (midnight) used for the month key and open-entry scoping
    dateStr: string; // YYYY-MM-DD in tenant TZ, used for logging/consistency
    newStart: Date;
    newEnd: Date | null;
    tz: string;
    tenantId: string;
    // Issue #70, D-13: who is writing — the overlap text is worded by the caller's reach
    // (`overlapMessageForCaller`). Required so no caller can forget it.
    access: AccessContext;
    /** The caller's own employee id; `null` for an actor without one (API key). */
    callerEmployeeId: string | null;
    excludeEntryId?: string;
    isCorrectionByManager?: boolean; // skip retro-window guard for manager-on-behalf edits
    grantId?: string; // approved RetroEntryRequest id — Plan 03 wires consumption
    // Phase 96 (RETRO-16/D-10): employee editing their OWN still-pending coupled
    // Nachtrag entry (retroRequestId set, isInvalid=true, coupled request still
    // PENDING) — exempt from the retro-window guard so a typo fix doesn't 403.
    // PUT-only; POST never has an `existing` row to compute this from.
    isOwnPendingEdit?: boolean;
    // Race fix (retro-grant-race-403-vs-409, 2026-07): the POST grant-consumption path
    // passes true here. The overlap check (step 2 below) is an advisory pre-tx query against
    // the TimeEntry table — under concurrent same-grant writes, the loser can observe the
    // winner's already-committed entry and get a generic 409 ("overlaps with existing entry")
    // instead of the single-use grant being the authoritative discriminator (403, "Antrag
    // bereits verwendet"). When true, the check is skipped here; the caller's own $transaction
    // re-runs it (via checkOverlap against `tx`, under the Employee row lock of Issue #70) AFTER
    // the grant-flip succeeds, so only the winner ever reaches it, and the loser is rejected by
    // the grant-flip itself before any conflict check runs. Never set for PUT: PUT updates an
    // existing row by id (excludeEntryId) and re-checks overlap inside its own transaction.
    deferConflictChecksToTx?: boolean;
  },
): Promise<{
  error: string;
  windowDays?: number;
  entryAgeInDays?: number;
  /** Set when `error` is an overlap: the conflicting entry (the text is already worded by reach). */
  overlap?: OverlapConflict;
} | null> {
  const {
    employeeId,
    date,
    newStart,
    newEnd,
    tz,
    tenantId,
    excludeEntryId,
    isCorrectionByManager,
    grantId,
    isOwnPendingEdit,
    deferConflictChecksToTx,
    access,
    callerEmployeeId,
  } = params;

  // 1. month-lock via SaldoSnapshot (mirror POST) — authoritative even with no entries.
  // Phase 100B Plan 07 (W1, isMonthClosed) — THE canonical Monatsabschluss signal.
  // RETRO-01 C2: lock-check runs FIRST — a locked month returns the lock message, never RETRO_WINDOW_EXCEEDED.
  const { start: lockedMonthStart } = monthRangeUtc(date.getFullYear(), date.getMonth() + 1, tz);
  const monthLocked = await isMonthClosed(app.prisma, employeeId, tenantId, lockedMonthStart);
  if (monthLocked) {
    return { error: "Monat ist abgeschlossen und kann nicht bearbeitet werden" };
  }

  // 1.5. Retro-window guard (RETRO-01) — AFTER month-lock (C2), BEFORE overlap.
  // Fires when the entry date is older than the tenant's configured window AND neither
  // an approved manager correction nor a pre-validated retro grant is present.
  // Uses tenant-TZ date strings — never raw UTC arithmetic (C1 / DST-safety).
  if (!isCorrectionByManager && !grantId && !isOwnPendingEdit) {
    const windowDays = await getRetroEntryWindowDays(app.prisma, tenantId);
    const todayStr = dateStrInTz(todayInTz(tz), tz);
    const retroLimitStr = computeRetroLimitStr(tz, windowDays);
    if (params.dateStr < retroLimitStr) {
      const entryAgeInDays = computeEntryAgeInDays(todayStr, params.dateStr);
      return { error: "RETRO_WINDOW_EXCEEDED", windowDays, entryAgeInDays };
    }
  }

  // 2. overlap (mirror POST) — preserve v1.8.13 same-day open-entry scoping + tz message.
  // Skipped when deferConflictChecksToTx is set — see param doc above.
  if (!deferConflictChecksToTx) {
    const overlap = await checkOverlap(
      app.prisma,
      employeeId,
      newStart,
      newEnd,
      excludeEntryId,
      date,
    );
    if (overlap) {
      return {
        error: await overlapMessageForCaller(app.prisma, {
          conflict: overlap,
          tz,
          tenantId,
          employeeId,
          callerEmployeeId,
          access,
        }),
        overlap,
      };
    }
  }

  return null;
}

// ── Effektiven Arbeitsplan ermitteln (Employee > TenantConfig > Hardcoded) ────
export async function getEffectiveSchedule(
  app: FastifyInstance,
  employeeId: string,
  forDate?: Date,
) {
  const targetDate = forDate ?? new Date();
  const schedule = await app.prisma.workSchedule.findFirst({
    where: { employeeId, validFrom: { lte: targetDate } },
    orderBy: { validFrom: "desc" },
  });
  if (schedule) return schedule;

  const employee = await app.prisma.employee.findUnique({
    where: { id: employeeId },
    select: { tenantId: true },
  });
  const tenantConfig = employee
    ? await app.prisma.tenantConfig.findUnique({ where: { tenantId: employee.tenantId } })
    : null;

  return {
    type: "FIXED_SCHEDULE" as const,
    weeklyHours: tenantConfig?.defaultWeeklyHours ?? 40,
    monthlyHours: null,
    mondayHours: tenantConfig?.defaultMondayHours ?? 8,
    tuesdayHours: tenantConfig?.defaultTuesdayHours ?? 8,
    wednesdayHours: tenantConfig?.defaultWednesdayHours ?? 8,
    thursdayHours: tenantConfig?.defaultThursdayHours ?? 8,
    fridayHours: tenantConfig?.defaultFridayHours ?? 8,
    saturdayHours: tenantConfig?.defaultSaturdayHours ?? 0,
    sundayHours: tenantConfig?.defaultSundayHours ?? 0,
    overtimeThreshold: tenantConfig?.overtimeThreshold ?? 60,
    allowOvertimePayout: tenantConfig?.allowOvertimePayout ?? false,
    overtimeMode: "CARRY_FORWARD" as const,
  };
}
