// Phase 63 — JArbSchG §9 helper (D-09..D-13)
//
// Hard-block + soft-warn helper for AZUBI minor-protection on a Berufsschultag.
// Called by POST + PUT /api/v1/time-entries BEFORE any DB write (Plan 03 wires it).
//
// Rules:
//   D-10 — Hard block when ALL hold:
//     1. Employee classification === "AZUBI"
//     2. birthDate set AND age at `date` < 18 (JArbSchG §9 Abs. 1 Nr. 2)
//     3. VOCATIONAL_SCHOOL Absence exists for (employeeId, date), not soft-deleted
//     4. plannedNetWorkMin > 225 (= 5 UStd × 45 min)
//   D-11 — Verbatim German error message (UStd vocabulary + statute reference)
//   D-12 — Soft-warn when AZUBI ≥ 18 on a BS-day with > 225 net work min:
//          emits an ArbZGWarning-compatible payload with code MAX_DAILY_EXCEEDED
//          and a "JArbSchG-Empfehlung:" prefix to distinguish from §3 daily-cap warns.
//   D-13 — JArbSchG check NEVER runs on locked-month dates (the route checks
//          locked-month BEFORE calling this helper).
//
// LOCKED invariants (CLAUDE.md):
//   - Soft-delete: every Absence query includes deletedAt: null.
//   - Information-disclosure: helper does NOT return birthDate to the caller
//     (only `blocked`, `message`, `softWarn`). Verified in tests.

import type { PrismaClient, ScheduleType } from "@clokr/db";
import {
  JARBSCHG_MAX_WORK_ON_BS_DAY_MIN,
  JARBSCHG_MINOR_AGE_THRESHOLD,
  JARBSCHG_LONG_DAY_INSTRUCTION_MIN,
  BS_DAILY_DEFAULT_MIN,
} from "./vocational-school-constants.js";
import { resolveBsTagSlot, buildSlotOverrideHierarchy } from "./bs-slot-resolver";
import { sortedBsDatesInIsoWeek, computeDailySollMinutes } from "./vocational-school-saldo.js";

// ── Public types ─────────────────────────────────────────────────────────────

export interface JArbSchGResult {
  blocked: boolean;
  message: string | null;
  softWarn?: {
    code: "MAX_DAILY_EXCEEDED";
    severity: "warning";
    message: string;
  };
}

export interface JArbSchGArgs {
  employeeId: string;
  date: Date;
  plannedNetWorkMin: number;
}

/**
 * Phase 76.31-07 — two-mode slot classification result for the §9 long-day check.
 *
 *   RESOLVER: the target `date` IS a BS-day whose ISO-week slot context resolves →
 *             isLongDay drives the slot-aware §9 decision.
 *   LEGACY:   no BS-Absence context on `date` → the caller applies the pre-76.31
 *             flat 225-min threshold (preserves all existing seedBsAbsence tests).
 *
 * D-10: this is the Absence-based re-expression of v1.9's event-model-coupled
 * classification. No event-model query — driven purely by BS `Absence` rows.
 */
type SlotClassification = { mode: "RESOLVER"; isLongDay: boolean } | { mode: "LEGACY" };

// ── Verbatim D-11 message (German, JArbSchG-aligned vocabulary) ──────────────

/** D-11 verbatim hard-block message. Stable contract — do not edit without updating
 * .planning/phases/63-berufsschule-saldo-arbzg-inbox/CONTEXT.md D-11. */
const HARD_BLOCK_MESSAGE =
  "Reguläre Arbeit am Berufsschultag mit mehr als 5 Unterrichtsstunden (225 Min) ist für jugendliche Auszubildende (unter 18) nach JArbSchG §9 Abs. 1 Nr. 2 untersagt. Bitte den Eintrag entsprechend kürzen oder einen anderen Mitarbeiter einplanen.";

/** D-12 soft-warn for AZUBI ≥ 18. "JArbSchG-Empfehlung:" prefix disambiguates from the
 * generic ArbZG §3 MAX_DAILY_EXCEEDED message (RESEARCH Pitfall #7). */
const SOFT_WARN_MESSAGE =
  "JArbSchG-Empfehlung: Reguläre Arbeit am Berufsschultag mit mehr als 5 UStd (225 Min) wird für Azubis nicht empfohlen.";

// ── Date helpers ─────────────────────────────────────────────────────────────

/**
 * Returns whole years between `birthDate` and `atDate`, ignoring sub-day precision.
 *
 * UTC-only — TZ-agnostic by design (the JArbSchG age gate operates on the calendar
 * date of the work shift; the choice of TZ for that date is the route's problem, not
 * this helper's).
 *
 * Birthday EXACTLY on `atDate` returns the new age (whole-year boundary inclusive).
 * Source equivalent to date-fns `differenceInYears`. No external dep — `date-fns`
 * (plain) is NOT installed in @clokr/api (verified in package.json).
 */
export function ageAtDate(birthDate: Date, atDate: Date): number {
  const by = birthDate.getUTCFullYear();
  const bm = birthDate.getUTCMonth();
  const bd = birthDate.getUTCDate();
  const ay = atDate.getUTCFullYear();
  const am = atDate.getUTCMonth();
  const ad = atDate.getUTCDate();
  let years = ay - by;
  if (am < bm || (am === bm && ad < bd)) years--;
  return years;
}

/** Compute [start, next) UTC midnight range for the calendar date of `date`. */
function dateRangeUtc(date: Date): { start: Date; next: Date } {
  const start = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0),
  );
  const next = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, next };
}

// ── Core helper ──────────────────────────────────────────────────────────────

/**
 * Decide whether a planned TimeEntry mutation on a Berufsschultag is allowed,
 * disallowed (JArbSchG hard-block), or merely soft-warned.
 *
 * Returns `{ blocked: false, message: null }` (fail-open) when any precondition
 * is missing:
 *   - Employee not found
 *   - Classification !== AZUBI
 *   - No VOCATIONAL_SCHOOL Absence on `date` (or soft-deleted)
 *   - Planned net work ≤ 225 min
 *   - birthDate is null (fail-open per RESEARCH A1)
 */
export async function checkJArbSchG(
  prisma: PrismaClient,
  args: JArbSchGArgs,
): Promise<JArbSchGResult> {
  // 1. Load employee — only the two fields we need. T-63-05 mitigation: never echo
  //    birthDate back to the caller; only the boolean result derives from it.
  const employee = await prisma.employee.findUnique({
    where: { id: args.employeeId },
    select: { classification: true, birthDate: true },
  });

  // Fail-open if employee missing or not an AZUBI.
  if (!employee) return { blocked: false, message: null };
  if (employee.classification !== "AZUBI") return { blocked: false, message: null };

  // 2. Check that the day is a BS-day (soft-delete-aware). Without a BS Absence the
  //    rule simply doesn't apply.
  const { start, next } = dateRangeUtc(args.date);
  const bs = await prisma.absence.findFirst({
    where: {
      employeeId: args.employeeId,
      deletedAt: null, // CLAUDE.md soft-delete rule
      type: "VOCATIONAL_SCHOOL",
      startDate: { gte: start, lt: next },
    },
    select: { id: true },
  });
  if (!bs) return { blocked: false, message: null };

  // 3. JArbSchG only fires above the 225-min threshold. Below that, both AZUBI < 18
  //    and AZUBI ≥ 18 are silently allowed (the route's existing ArbZG check may still
  //    advise on other violations, but JArbSchG is silent).
  if (args.plannedNetWorkMin <= JARBSCHG_MAX_WORK_ON_BS_DAY_MIN) {
    return { blocked: false, message: null };
  }

  // 4. Age gate. Fail-open if birthDate is missing — surfacing a hard-block in that case
  //    would lock managers out without recourse. The right product behavior is to nudge
  //    admins to set birthDate via a separate UI; meanwhile entries flow through.
  if (!employee.birthDate) {
    return { blocked: false, message: null };
  }

  const age = ageAtDate(employee.birthDate, args.date);
  if (age < JARBSCHG_MINOR_AGE_THRESHOLD) {
    // Hard block — D-11 verbatim message.
    return { blocked: true, message: HARD_BLOCK_MESSAGE };
  }

  // 5. AZUBI ≥ 18: D-12 soft-warn. Reuses the existing MAX_DAILY_EXCEEDED channel
  //    so the frontend doesn't need a new warning code (D-08).
  return {
    blocked: false,
    message: null,
    softWarn: {
      code: "MAX_DAILY_EXCEEDED",
      severity: "warning",
      message: SOFT_WARN_MESSAGE,
    },
  };
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Phase 76.31-07 — Absence-based slot classification for the §9 long-day check.
 *
 * This is the 1.8.x re-expression of v1.9's event-model-coupled classification.
 * It ports the CLASSIFICATION logic (slot → isLongDay) but drives it from BS `Absence`
 * rows in the target date's ISO week — no event-model query, no event-model import (D-10).
 *
 * Returns:
 *   - `{ mode: "LEGACY" }` when the target `date` is NOT itself a BS-day (no BS Absence
 *     on that day). The caller then applies the pre-76.31 flat 225-min threshold. This
 *     preserves ALL existing jarbschg tests that assert flat-225 behavior with a single
 *     seedBsAbsence on the day but no full ISO-week slot context.
 *   - `{ mode: "RESOLVER", isLongDay }` when `date` IS one of the ISO-week BS-days.
 *     isLongDay per BBiG §15 Abs.2 / BVaDiG-2024:
 *       FIRST_LONG_DAY / BLOCK_WEEK → always a long day (pauschal slots)
 *       SECOND_LONG_DAY / SHORT_DAY → long ONLY when creditedMinutes > 225 (netto threshold)
 *
 * Note: the `date` IS always among the ISO-week BS dates when this helper is reached,
 * because checkJArbSchG only calls it after confirming a BS Absence on `date`. The
 * membership check below is a defensive belt-and-braces guard.
 */
async function classifyBsSlotFromAbsence(
  prisma: PrismaClient,
  employeeId: string,
  date: Date,
  tenantConfig?: {
    bsSlotFirstLongDayMinutes: number | null;
    bsSlotSecondLongDayMinutes: number | null;
    bsSlotShortDayMinutes: number | null;
    bsSlotBlockWeekMinutes: number | null;
    vocationalSchoolMinutesPerDay: number | null;
    vocationalSchoolBlockMinutesPerWeek: number | null;
  } | null,
): Promise<SlotClassification> {
  // 1. Sorted distinct BS-Absence date strings in the target date's ISO week
  //    (soft-delete-filtered — shared source of truth with the saldo path).
  const bsDatesInWeek = await sortedBsDatesInIsoWeek(prisma, employeeId, date);

  // 2. If `date` is not itself a BS-day → LEGACY (flat-225 path).
  const targetDs = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
    .toISOString()
    .slice(0, 10);
  const idx = bsDatesInWeek.indexOf(targetDs);
  if (idx < 0) return { mode: "LEGACY" };

  // 3. Derive the ISO-week ordinal + block-week flag from the BS dates.
  const ordinalInWeek = idx + 1; // 1-based
  const isBlockWeek = bsDatesInWeek.length >= 5;

  // 4. Load the employee bsSlot* overrides + the active BS Pattern + the active schedule
  //    for the daily Soll. Explicit-null in every layer → delegate to the next layer down.
  const dayStart = new Date(targetDs + "T00:00:00.000Z");
  const [employeeSlots, patternSlots, schedule] = await Promise.all([
    prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        bsSlotFirstLongDayMinutes: true,
        bsSlotSecondLongDayMinutes: true,
        bsSlotShortDayMinutes: true,
        bsSlotBlockWeekMinutes: true,
      },
    }),
    prisma.employeeVocationalSchoolPattern.findFirst({
      where: {
        employeeId,
        isActive: true,
        validFrom: { lte: dayStart },
        OR: [{ validUntil: null }, { validUntil: { gte: dayStart } }],
      },
      orderBy: { validFrom: "desc" },
      select: {
        bsSlotFirstLongDayMinutes: true,
        bsSlotSecondLongDayMinutes: true,
        bsSlotShortDayMinutes: true,
        bsSlotBlockWeekMinutes: true,
      },
    }),
    prisma.workSchedule.findFirst({
      where: { employeeId, validFrom: { lte: dayStart } },
      orderBy: { validFrom: "desc" },
      select: {
        type: true,
        weeklyHours: true,
        mondayHours: true,
        tuesdayHours: true,
        wednesdayHours: true,
        thursdayHours: true,
        fridayHours: true,
        saturdayHours: true,
        sundayHours: true,
      },
    }),
  ]);

  // dailySollMinutes only matters for the FIRST_LONG_DAY amount, and FIRST_LONG_DAY is
  // long regardless of amount. When no schedule is loaded → BS_DAILY_DEFAULT_MIN (480).
  const dailySollMinutes = schedule ? computeDailySollMinutes(schedule) : BS_DAILY_DEFAULT_MIN;

  const hierarchy = buildSlotOverrideHierarchy({
    employee: employeeSlots ?? null,
    pattern: patternSlots ?? null,
    tenantConfig: {
      bsSlotFirstLongDayMinutes: tenantConfig?.bsSlotFirstLongDayMinutes ?? null,
      bsSlotSecondLongDayMinutes: tenantConfig?.bsSlotSecondLongDayMinutes ?? null,
      bsSlotShortDayMinutes: tenantConfig?.bsSlotShortDayMinutes ?? null,
      bsSlotBlockWeekMinutes: tenantConfig?.bsSlotBlockWeekMinutes ?? null,
      vocationalSchoolMinutesPerDay: tenantConfig?.vocationalSchoolMinutesPerDay ?? null,
      vocationalSchoolBlockMinutesPerWeek:
        tenantConfig?.vocationalSchoolBlockMinutesPerWeek ?? null,
    },
    dailySollMinutes,
  });

  const scheduleType = (schedule?.type ?? "FIXED_SCHEDULE") as ScheduleType;
  const res = resolveBsTagSlot(
    date,
    ordinalInWeek,
    { bsDatesInWeek, isBlockWeek },
    hierarchy,
    scheduleType,
  );

  // Long-day classification (CD-4): pauschal slots always long; netto slots long only
  // above the 225-min instruction-time threshold.
  const isLongDay =
    res.slotType === "FIRST_LONG_DAY" ||
    res.slotType === "BLOCK_WEEK" ||
    res.creditedMinutes > JARBSCHG_LONG_DAY_INSTRUCTION_MIN;

  return { mode: "RESOLVER", isLongDay };
}
