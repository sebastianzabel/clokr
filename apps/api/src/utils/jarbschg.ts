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
import {
  sortedBsDatesInIsoWeek,
  computeDailySollMinutes,
  bsUnterrichtsMinutesByDateForIsoWeek,
} from "./vocational-school-saldo.js";
import { BS_PATTERN_ORDER_BY } from "./vocational-school-pattern-order.js";

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
  // 1. Load employee — only the fields we need. T-63-05 mitigation: never echo
  //    birthDate back to the caller; only the boolean result derives from it.
  //    tenantId feeds the slot-classification hierarchy (TenantConfig layer).
  const employee = await prisma.employee.findUnique({
    where: { id: args.employeeId },
    select: { classification: true, birthDate: true, tenantId: true },
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

  // 3. Slot-aware §9 classification (Phase 76.31-07, D-08 FULL scope). Re-expressed
  //    against BS Absence rows — a SHORT_DAY / SECOND_LONG_DAY with credited minutes
  //    ≤ 225 no longer spuriously hard-blocks a minor AZUBI, while a FIRST_LONG_DAY
  //    (or any slot > 225) still fires. When no ISO-week slot context resolves, the
  //    LEGACY flat-225 threshold applies (preserves all existing seedBsAbsence tests).
  const tenantConfig = await prisma.tenantConfig.findUnique({
    where: { tenantId: employee.tenantId },
    select: {
      bsSlotFirstLongDayMinutes: true,
      bsSlotSecondLongDayMinutes: true,
      bsSlotShortDayMinutes: true,
      bsSlotBlockWeekMinutes: true,
      vocationalSchoolMinutesPerDay: true,
      vocationalSchoolBlockMinutesPerWeek: true,
    },
  });

  const classification = await classifyBsSlotFromAbsence(
    prisma,
    args.employeeId,
    args.date,
    tenantConfig,
  );

  if (classification.mode === "LEGACY") {
    // Pre-76.31 flat-225 threshold. Below that, both AZUBI < 18 and AZUBI ≥ 18 are
    // silently allowed (the route's existing ArbZG check may still advise on other
    // violations, but JArbSchG is silent).
    if (args.plannedNetWorkMin <= JARBSCHG_MAX_WORK_ON_BS_DAY_MIN) {
      return { blocked: false, message: null };
    }
  } else {
    // Resolver path: slot-type determines the "long day" classification.
    if (!classification.isLongDay) {
      // SHORT_DAY / SECOND_LONG_DAY with credited minutes ≤ 225 → §9 inactive.
      return { blocked: false, message: null };
    }
    // Long day confirmed — any positive plannedNetWorkMin triggers the check.
    if (args.plannedNetWorkMin <= 0) {
      return { blocked: false, message: null };
    }
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
 *   - `{ mode: "LEGACY" }` when there is NO genuine multi-day ISO-week slot context —
 *     i.e. the target `date` is not itself a BS-day, OR it is the ONLY BS-day in its
 *     ISO week (< 2 distinct BS days). A lone BS-day cannot distinguish FIRST vs SHORT
 *     slot semantics, so the caller applies the pre-76.31 flat 225-min threshold. This
 *     preserves ALL existing jarbschg tests, which seed a single BS Absence on the day
 *     and assert the flat-225 behavior.
 *   - `{ mode: "RESOLVER", isLongDay }` when the target `date` is one of >= 2 distinct
 *     ISO-week BS-days (a real school-week whose per-day slot ordinals are meaningful).
 *     isLongDay per BBiG §15 Abs.2 / BVaDiG-2024:
 *       FIRST_LONG_DAY / BLOCK_WEEK → always a long day (pauschal slots)
 *       SECOND_LONG_DAY / SHORT_DAY → long ONLY when creditedMinutes > 225 (netto threshold)
 *
 * Rule 1 deviation from the plan's literal step-2 ("date IS among BS dates → RESOLVER"):
 * gating RESOLVER on >= 2 distinct BS days is what actually preserves the existing
 * single-seedBsAbsence suite (a single ordinal-1 day would otherwise resolve to
 * FIRST_LONG_DAY and hard-block a minor at any minute count, breaking the flat-225
 * tests + must_haves truth "existing jarbschg tests stay green"). The plan's own
 * LEGACY-preservation test (single day, <= 225 → not blocked) confirms this intent.
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

  // 2. LEGACY (flat-225) unless a genuine multi-day slot context exists:
  //    - `date` must itself be a BS-day (defensive — the caller already confirmed one),
  //    - AND there must be >= 2 distinct BS days in the ISO week so the per-day ordinal
  //      is meaningful. A lone BS day cannot be classified FIRST vs SHORT → flat path.
  const targetDs = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
    .toISOString()
    .slice(0, 10);
  const idx = bsDatesInWeek.indexOf(targetDs);
  if (idx < 0) return { mode: "LEGACY" };
  if (bsDatesInWeek.length < 2) return { mode: "LEGACY" };

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
      orderBy: BS_PATTERN_ORDER_BY,
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

  // Phase 76.38 (D-11): per-date Unterrichtszeit → duration-based §9 classification.
  // A genuine ordinal-1 Kurztag (≤ 225) resolves to SHORT_DAY (isLongDay false) →
  // §9 no longer spuriously hard-blocks. Null/absent → ordinal fallback (unchanged).
  const unterrichtsMinutesByDate = await bsUnterrichtsMinutesByDateForIsoWeek(
    prisma,
    employeeId,
    date,
  );

  const res = resolveBsTagSlot(
    date,
    ordinalInWeek,
    { bsDatesInWeek, isBlockWeek, unterrichtsMinutesByDate },
    hierarchy,
    scheduleType,
  );

  // Long-day classification (CD-4): pauschal slots always long; netto slots long only
  // above the 225-min instruction-time threshold.
  //
  // Phase 76.38 (D-11): a SHORT_DAY is a Kurztag by definition (≤ 5 Unterrichtsstunden),
  // so it is NEVER a §9 long day — regardless of its saldo credit. Under duration-based
  // classification the SHORT credit defaults to the individual daily Soll (which may
  // exceed 225 min), so the old `creditedMinutes > 225` proxy would misfire for a genuine
  // Kurztag. Gate SHORT_DAY out explicitly. FIRST_LONG_DAY / BLOCK_WEEK stay always-long;
  // SECOND_LONG_DAY keeps the >225 instruction-time proxy (a Langtag is long).
  const isLongDay =
    res.slotType === "FIRST_LONG_DAY" ||
    res.slotType === "BLOCK_WEEK" ||
    (res.slotType !== "SHORT_DAY" && res.creditedMinutes > JARBSCHG_LONG_DAY_INSTRUCTION_MIN);

  return { mode: "RESOLVER", isLongDay };
}
