// Time-entry invariant checks (one-per-day, overlap, month-lock, retro-window) and effective
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
import { isMonthClosed } from "../working-time-account";
import { dateStrInTz, todayInTz, monthRangeUtc } from "../working-time-account/timezone";
import {
  getRetroEntryWindowDays,
  computeRetroLimitStr,
  computeEntryAgeInDays,
} from "./retro-config"; // Phase 76.29 — RETRO-01 window guard

// ── Überlappungsprüfung ────────────────────────────────────────────────────────
// entryDate (optional): the calendar date of the entry being created/updated.
// An open entry (endTime = null) has no natural upper bound, so it must only be
// treated as "still running" for conflict purposes ON ITS OWN DAY. Without this
// scoping a single stale open entry (e.g. a forgotten clock-out) would be treated
// as running until year 9999 and would block creating OR editing entries on any
// later day — even in a following month (v1.8.13 cross-day/cross-month fix).
// Closed entries that legitimately span midnight are still caught by the
// { endTime: { gt: startTime } } branch, which is not date-scoped.
//
// tz (optional): tenant timezone used to format the conflict message. The server
// container runs in UTC, so without it the message printed times in UTC with no
// date — making a cross-month conflict impossible for the user to identify.
// Prisma client shape shared by `app.prisma` (top-level) and the `tx` handle inside
// `$transaction(async (tx) => ...)` — lets checkOverlap / checkEntryConflicts run
// against either, which the grant-consumption race fix (retro-grant-race-403-vs-409)
// relies on to re-run conflict checks INSIDE the tx after the single-use grant flip.
type DbClient = FastifyInstance["prisma"] | Prisma.TransactionClient;

export async function checkOverlap(
  db: DbClient,
  employeeId: string,
  startTime: Date,
  endTime: Date | null,
  excludeId?: string,
  entryDate?: Date,
  tz?: string,
): Promise<string | null> {
  // Kein endTime = offener Eintrag → als "läuft noch" behandeln
  const effectiveEnd = endTime ?? new Date("9999-12-31");

  // When the entry date is known, only open entries on the SAME calendar date
  // count as an active conflict. Fall back to the original broad match otherwise.
  const openEntryCondition: Prisma.TimeEntryWhereInput = entryDate
    ? { endTime: null, date: entryDate }
    : { endTime: null };

  const overlapping = await db.timeEntry.findFirst({
    where: {
      employeeId,
      deletedAt: null,
      id: excludeId ? { not: excludeId } : undefined,
      startTime: { lt: effectiveEnd },
      OR: [
        openEntryCondition, // offener Eintrag am selben Tag läuft noch
        { endTime: { gt: startTime } }, // abgeschlossener Eintrag endet nach neuem Start
      ],
    },
  });

  if (!overlapping) return null;

  // Include the date (and format in the tenant tz) so the user can identify the
  // conflicting entry — critical when it is a stale open entry from another day.
  const dateOpts: Intl.DateTimeFormatOptions = {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    ...(tz ? { timeZone: tz } : {}),
  };
  const timeOpts: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
    ...(tz ? { timeZone: tz } : {}),
  };
  const dateLabel = overlapping.startTime.toLocaleDateString("de-DE", dateOpts);
  const fmt = (d: Date | null) => (d ? d.toLocaleTimeString("de-DE", timeOpts) : "läuft");
  return `Überschneidung mit bestehendem Eintrag vom ${dateLabel} (${fmt(overlapping.startTime)} – ${fmt(overlapping.endTime)})`;
}

// One-per-day existence check (step 1 of validateTimeEntryInvariants), extracted so it
// can be re-run against a `tx` handle from inside the grant-consumption $transaction
// (retro-grant-race-403-vs-409 fix) — see param doc on deferConflictChecksToTx below.
export async function checkOneEntryPerDay(
  db: DbClient,
  employeeId: string,
  date: Date,
  excludeEntryId?: string,
): Promise<string | null> {
  const existingEntry = await db.timeEntry.findFirst({
    where: {
      employeeId,
      deletedAt: null,
      date,
      ...(excludeEntryId ? { id: { not: excludeEntryId } } : {}),
    },
  });
  if (existingEntry) {
    return "Es existiert bereits ein Eintrag für diesen Tag. Bitte den bestehenden Eintrag bearbeiten.";
  }
  return null;
}

// Shared time-entry invariants enforced by POST /time-entries, PUT /time-entries/:id
// and the CSV import (POST /imports/time-entries). Extracting them here (D-01/D-03)
// guarantees the three write paths cannot drift: one-entry-per-day, month-lock via
// SaldoSnapshot, retro-window guard (RETRO-01), and overlap — all with self-exclusion for edits.
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
    date: Date; // calendar date (midnight) used for one-per-day + month key
    dateStr: string; // YYYY-MM-DD in tenant TZ, used for logging/consistency
    newStart: Date;
    newEnd: Date | null;
    tz: string;
    tenantId: string;
    excludeEntryId?: string;
    isCorrectionByManager?: boolean; // skip retro-window guard for manager-on-behalf edits
    grantId?: string; // approved RetroEntryRequest id — Plan 03 wires consumption
    // Phase 96 (RETRO-16/D-10): employee editing their OWN still-pending coupled
    // Nachtrag entry (retroRequestId set, isInvalid=true, coupled request still
    // PENDING) — exempt from the retro-window guard so a typo fix doesn't 403.
    // PUT-only; POST never has an `existing` row to compute this from.
    isOwnPendingEdit?: boolean;
    // Race fix (retro-grant-race-403-vs-409, 2026-07): the POST grant-consumption path
    // passes true here. Both the one-per-day check (step 1) AND the overlap check
    // (step 3) below are advisory pre-tx queries against the TimeEntry table — under
    // concurrent same-grant writes, the loser can observe the winner's already-committed
    // entry in EITHER check and get a generic 409 ("day already taken" / "overlaps with
    // existing entry") instead of the single-use grant being the authoritative
    // discriminator (403, "Antrag bereits verwendet"). When true, both checks are
    // skipped here; the caller's own $transaction re-runs them (via checkOneEntryPerDay
    // / checkOverlap against `tx`) AFTER the grant-flip succeeds, so only the winner
    // ever reaches them, and the loser is rejected by the grant-flip itself before any
    // conflict check runs. Never set for PUT: PUT updates an existing row by id
    // (excludeEntryId), which does not race the same way and whose catch block does
    // not re-run these checks.
    deferConflictChecksToTx?: boolean;
  },
): Promise<{ error: string; windowDays?: number; entryAgeInDays?: number } | null> {
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
  } = params;

  // 1. one-per-day (mirror POST) — exclude self when editing.
  // Skipped when deferConflictChecksToTx is set (see param doc above) — the caller's own
  // $transaction is the authoritative source of truth in that case.
  if (!deferConflictChecksToTx) {
    const oneDayError = await checkOneEntryPerDay(app.prisma, employeeId, date, excludeEntryId);
    if (oneDayError) {
      return { error: oneDayError };
    }
  }

  // 2. month-lock via SaldoSnapshot (mirror POST) — authoritative even with no entries.
  // Phase 100B Plan 07 (W1, isMonthClosed) — THE canonical Monatsabschluss signal.
  // RETRO-01 C2: lock-check runs FIRST — a locked month returns the lock message, never RETRO_WINDOW_EXCEEDED.
  const { start: lockedMonthStart } = monthRangeUtc(date.getFullYear(), date.getMonth() + 1, tz);
  const monthLocked = await isMonthClosed(app.prisma, employeeId, tenantId, lockedMonthStart);
  if (monthLocked) {
    return { error: "Monat ist abgeschlossen und kann nicht bearbeitet werden" };
  }

  // 2.5. Retro-window guard (RETRO-01) — AFTER month-lock (C2), BEFORE overlap.
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

  // 3. overlap (mirror POST) — preserve v1.8.13 same-day open-entry scoping + tz message.
  // Skipped when deferConflictChecksToTx is set — see param doc above.
  if (!deferConflictChecksToTx) {
    const overlap = await checkOverlap(
      app.prisma,
      employeeId,
      newStart,
      newEnd,
      excludeEntryId,
      date,
      tz,
    );
    if (overlap) {
      return { error: overlap };
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
