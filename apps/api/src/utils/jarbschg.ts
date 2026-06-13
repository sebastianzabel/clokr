// Phase 63 — JArbSchG §9 helper (D-09..D-13)
//
// Hard-block + soft-warn helper for AZUBI minor-protection on a Berufsschultag.
// Called by POST + PUT /api/v1/time-entries BEFORE any DB write (Plan 03 wires it).
//
// Rules:
//   D-10 — Hard block when ALL hold:
//     1. Employee classification === "AZUBI"
//     2. birthDate set AND age at `date` < 18 (JArbSchG §9 Abs. 1 Nr. 2)
//     3. Berufsschule event exists for (employeeId, date), not soft-deleted
//     4. isLongBsDay classification (Phase 83: slot-aware; pre-83: plannedNetWorkMin > 225)
//   D-11 — Verbatim German error message (UStd vocabulary + statute reference)
//   D-12 — Soft-warn when AZUBI ≥ 18 on a BS-day with > 225 net work min:
//          emits an ArbZGWarning-compatible payload with code MAX_DAILY_EXCEEDED
//          and a "JArbSchG-Empfehlung:" prefix to distinguish from §3 daily-cap warns.
//   D-13 — JArbSchG check NEVER runs on locked-month dates (the route checks
//          locked-month BEFORE calling this helper).
//
// LOCKED invariants (CLAUDE.md):
//   - Soft-delete: every Absence/WorkEvent query includes deletedAt: null.
//   - Information-disclosure: helper does NOT return birthDate to the caller
//     (only `blocked`, `message`, `softWarn`). Verified in tests.
//
// Phase 83 upgrade (BBIG-V19-06):
//   checkJArbSchG now resolves the BS-Tag slot type via resolveBsTagSlot() when
//   WorkEvent rows exist for the employee. Slot-type classification drives whether
//   the day is "long":
//     - FIRST_LONG_DAY / BLOCK_WEEK → always long (hard-block <18 on any plannedNetWorkMin>0)
//     - SECOND_LONG_DAY / SHORT_DAY → long when creditedMinutes > JARBSCHG_LONG_DAY_INSTRUCTION_MIN (225)
//   When no WorkEvent rows exist for the ISO week (legacy tenant, workEventModelLive=false),
//   the helper falls back to the pre-83 behavior: plannedNetWorkMin > 225 threshold applies.
//   This preserves ALL existing jarbschg tests that seed Absence rows.

import type { PrismaClient } from "@clokr/db";
import { WorkEventType } from "@clokr/db";
import {
  JARBSCHG_MAX_WORK_ON_BS_DAY_MIN,
  JARBSCHG_MINOR_AGE_THRESHOLD,
  JARBSCHG_LONG_DAY_INSTRUCTION_MIN,
} from "./vocational-school-constants.js";
// Phase 78 — adapter helper (compat-routed via tenant.workEventModelLive).
import { hasBsOnDate, isoWeekBoundsUtc, toIsoDate, resolveScheduleTypeAt } from "./work-event.js";
import { resolveBsTagSlot, buildSlotOverrideHierarchy } from "./bs-slot-resolver.js";
import type { WeekContext } from "./bs-slot-resolver.js";

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

// ── Slot classification result ────────────────────────────────────────────────

/**
 * Phase 83 — two-mode result for long-day classification:
 *   RESOLVER: WorkEvent rows found → slotType-aware result
 *   LEGACY:   No WorkEvent rows → falls back to flat 225-min threshold
 */
type SlotClassification = { mode: "RESOLVER"; isLongDay: boolean } | { mode: "LEGACY" };

// ── Core helper ──────────────────────────────────────────────────────────────

/**
 * Decide whether a planned TimeEntry mutation on a Berufsschultag is allowed,
 * disallowed (JArbSchG hard-block), or merely soft-warned.
 *
 * Returns `{ blocked: false, message: null }` (fail-open) when any precondition
 * is missing:
 *   - Employee not found
 *   - Classification !== AZUBI
 *   - No Berufsschule event on `date` (or soft-deleted)
 *   - Not a long-day classification (Phase 83 slot-aware) or ≤225min (legacy)
 *   - birthDate is null (fail-open per RESEARCH A1)
 */
export async function checkJArbSchG(
  prisma: PrismaClient,
  args: JArbSchGArgs,
): Promise<JArbSchGResult> {
  // 1. Load employee — only the fields we need. T-63-05 mitigation: never echo
  //    birthDate back to the caller; only the boolean result derives from it.
  const employee = await prisma.employee.findUnique({
    where: { id: args.employeeId },
    select: {
      classification: true,
      birthDate: true,
      tenantId: true,
      // Phase 83 — per-employee slot overrides for resolver hierarchy (BBIG-V19-03)
      bsSlotFirstLongDayMinutes: true,
      bsSlotSecondLongDayMinutes: true,
      bsSlotShortDayMinutes: true,
      bsSlotBlockWeekMinutes: true,
    },
  });

  // Fail-open if employee missing or not an AZUBI.
  if (!employee) return { blocked: false, message: null };
  if (employee.classification !== "AZUBI") return { blocked: false, message: null };

  // 2. Check that the day is a BS-day (soft-delete-aware). Without a BS event the
  //    rule simply doesn't apply. Phase 78 — adapter-routed BS detection.
  const hasBs = await hasBsOnDate(prisma, args.employeeId, args.date);
  if (!hasBs) return { blocked: false, message: null };

  // 3. Phase 83 — slot-aware long-day classification (BBIG-V19-06).
  //    Attempt to resolve the slot type via WorkEvent rows. Returns LEGACY mode
  //    when no WorkEvent rows exist (pre-83 tenant / absence-only path).
  const classification = await resolveSlotClassification(
    prisma,
    employee,
    args.employeeId,
    args.date,
  );

  if (classification.mode === "LEGACY") {
    // Pre-83 path: apply flat 225-min threshold.
    // This preserves ALL existing jarbschg tests (they use seedBsAbsence, not WorkEvent).
    if (args.plannedNetWorkMin <= JARBSCHG_MAX_WORK_ON_BS_DAY_MIN) {
      return { blocked: false, message: null };
    }
  } else {
    // Phase 83 resolver path: slot-type determines "long day" classification.
    if (!classification.isLongDay) {
      // SHORT_DAY / SECOND_LONG_DAY with creditedMinutes ≤ 225 → JArbSchG inactive.
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
    // Hard block — D-11 verbatim message (BBiG §15 + JArbSchG §9 Abs.1 Nr.2).
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
 * Phase 83 — resolve slot classification for the JArbSchG long-day check.
 *
 * Returns `{ mode: "LEGACY" }` when no WorkEvent rows exist for the ISO week
 * (the caller then applies the pre-83 flat 225-min threshold).
 *
 * Returns `{ mode: "RESOLVER", isLongDay }` when WorkEvent rows are found,
 * where `isLongDay` is determined by the slot type and credited minutes:
 *   FIRST_LONG_DAY / BLOCK_WEEK → always true (long by definition per BBiG §15)
 *   SECOND_LONG_DAY / SHORT_DAY → true when creditedMinutes > 225 (netto threshold)
 */
async function resolveSlotClassification(
  prisma: PrismaClient,
  employeeOverride: {
    tenantId: string;
    bsSlotFirstLongDayMinutes: number | null;
    bsSlotSecondLongDayMinutes: number | null;
    bsSlotShortDayMinutes: number | null;
    bsSlotBlockWeekMinutes: number | null;
  },
  employeeId: string,
  date: Date,
): Promise<SlotClassification> {
  // Load ISO-week WorkEvent rows for this employee (soft-delete-filtered per CLAUDE.md,
  // sorted date ASC per PITFALLS CD-2 determinism requirement).
  const { monday, nextMonday } = isoWeekBoundsUtc(date);
  const workEventRows = await prisma.workEvent.findMany({
    where: {
      employeeId,
      type: WorkEventType.VOCATIONAL_SCHOOL,
      deletedAt: null,
      date: { gte: monday, lt: nextMonday },
    },
    orderBy: { date: "asc" },
    select: { date: true },
  });

  if (workEventRows.length === 0) {
    // No WorkEvent rows — legacy tenant (workEventModelLive=false) or pre-migration.
    // Signal LEGACY so the caller applies the pre-83 flat 225-min threshold.
    // This preserves all existing jarbschg tests that use seedBsAbsence.
    return { mode: "LEGACY" };
  }

  // WorkEvent rows found — use resolver for accurate slot classification (BBIG-V19-06).
  const bsDatesInWeek = workEventRows.map((r) => toIsoDate(r.date));
  const isBlockWeek = bsDatesInWeek.length >= 5; // v1.9 known-limitation (FEATURES.md Scenario E)
  const dateIso = toIsoDate(date);
  const ordinalInWeek = Math.max(1, bsDatesInWeek.indexOf(dateIso) + 1);

  // Load active pattern for hierarchy (BBIG-V19-02 — Pattern > TenantConfig).
  const pattern = await prisma.employeeVocationalSchoolPattern.findFirst({
    where: { employeeId, isActive: true },
    select: {
      bsSlotFirstLongDayMinutes: true,
      bsSlotSecondLongDayMinutes: true,
      bsSlotShortDayMinutes: true,
      bsSlotBlockWeekMinutes: true,
    },
  });

  // Load tenantConfig for lower layers of the 4-level hierarchy.
  const tenantConfig = await prisma.tenantConfig.findUnique({
    where: { tenantId: employeeOverride.tenantId },
    select: {
      bsSlotFirstLongDayMinutes: true,
      bsSlotSecondLongDayMinutes: true,
      bsSlotShortDayMinutes: true,
      bsSlotBlockWeekMinutes: true,
      vocationalSchoolMinutesPerDay: true,
      vocationalSchoolBlockMinutesPerWeek: true,
    },
  });

  const hierarchy = buildSlotOverrideHierarchy({
    employee: employeeOverride,
    pattern: pattern ?? null,
    tenantConfig: tenantConfig ?? {
      bsSlotFirstLongDayMinutes: null,
      bsSlotSecondLongDayMinutes: null,
      bsSlotShortDayMinutes: null,
      bsSlotBlockWeekMinutes: null,
      vocationalSchoolMinutesPerDay: null,
      vocationalSchoolBlockMinutesPerWeek: null,
    },
  });

  const scheduleType = await resolveScheduleTypeAt(prisma, employeeId, date);
  const weekContext: WeekContext = { bsDatesInWeek, isBlockWeek };
  const slot = resolveBsTagSlot(date, ordinalInWeek, weekContext, hierarchy, scheduleType);

  // Long-day classification per RESEARCH Pattern 4 (CD-4 mitigation):
  //   FIRST_LONG_DAY / BLOCK_WEEK → always a long day (pauschal slots per BBiG §15 Abs.2 Satz 1)
  //   SECOND_LONG_DAY / SHORT_DAY → long when creditedMinutes > 225 (netto instruction-time threshold)
  const isLongDay =
    slot.slotType === "FIRST_LONG_DAY" ||
    slot.slotType === "BLOCK_WEEK" ||
    ((slot.slotType === "SECOND_LONG_DAY" || slot.slotType === "SHORT_DAY") &&
      slot.creditedMinutes > JARBSCHG_LONG_DAY_INSTRUCTION_MIN);

  return { mode: "RESOLVER", isLongDay };
}
