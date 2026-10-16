import { PrismaClient } from "@clokr/db";
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";
import {
  getTenantTimezone,
  dateStrInTz,
  getDayOfWeekInTz,
  countBsDaysInIsoWeek,
  getVocationalSchoolMinutesForDate,
} from "../working-time-account"; // Phase 101B
import {
  hasVocationalSchoolDay, // Phase 100B Plan 12 — A6
  getVocationalSchoolDays, // Phase 100B Plan 12 — A6
  BS_DAILY_DEFAULT_MIN,
  isMinorAtDate, // Issue #511 (D-05) — the one under-18 decision
} from "../absence"; // Phase 101B (Issue #101, wave 7) — merged from two deep imports
import type { TimeEntry } from "@clokr/db";
import { findEntriesOfDay } from "./day-entries"; // Phase 69b — the single day lookup
import { addWorkingMinutes } from "./entry-durations"; // Phase 79 (Issue #79), D-03/D-12
import { evaluateDayBreaks, hasAckableFinding } from "./day-break-rule"; // Issue #80 — the day-level § 4/§ 3 rule, #511 D-12
import type { DayBreakEvaluation, DayBreakRow } from "./day-break-rule"; // Issue #80
import { listDayBreaksOfDay, listAcksOfDay, loadBreaksOfEntries } from "./day-break-store"; // Issue #80 (D-06), #511 (D-15)
import { BREAK_REGIMES, breakRegimeFor, isApprenticeWithoutBirthDate } from "./break-regime"; // Issue #511 — the thresholds the messages quote, D-05 regime
import type { PlacementCertainty, PlacementFinding } from "./day-break-placement"; // Issue #511
import { WITHHELD_FINDING_CODE, WITHHELD_FINDING_TEXT } from "./withheld-finding"; // Issue #85 D-07

// Phase 69b: in-memory equivalents of the former `findFirst({ endTime: { not: null }, orderBy })`
// rest-period lookups. Only closed rows count; the first maximum/minimum wins on ties.
function latestEnding(entries: TimeEntry[]): TimeEntry | null {
  let best: TimeEntry | null = null;
  for (const e of entries) {
    if (e.endTime === null) continue;
    if (best === null || e.endTime.getTime() > best.endTime!.getTime()) best = e;
  }
  return best;
}

function earliestStarting(entries: TimeEntry[]): TimeEntry | null {
  return entries.find((e) => e.endTime !== null) ?? null; // entries arrive in startTime order
}

export interface ArbZGWarning {
  code:
    | "BREAK_TOO_SHORT"
    | "MAX_DAILY_EXCEEDED"
    | "MAX_DAILY_AVG_EXCEEDED"
    | "MAX_WEEKLY_EXCEEDED"
    | "MIN_REST_VIOLATED"
    | "BREAK_SEGMENT_TOO_SHORT"
    | "BREAK_TOO_LATE"
    | "BREAK_OUTSIDE_WINDOW"
    | "BREAK_POSITION_UNKNOWN"
    | "FINDING_WITHHELD";
  severity: "warning" | "error";
  message: string;
  /**
   * Phase 91 (BREAK-03) — set when the §4 BREAK_TOO_SHORT finding was downgraded
   * from a blocking "error" because the day's TimeEntry.breakStatus is WAIVED
   * ("durchgearbeitet" — BAG 12.02.2025, 5 AZR 51/24). Optional/additive so
   * existing consumers reading only .code/.severity/.message are unaffected.
   */
  waived?: boolean;
  /**
   * Issue #80 (D-01/D-18) — set to true only when the day's closed WORK entries lie in two or more
   * salons. Additive like `waived`: absent otherwise, so existing consumers are unaffected.
   */
  crossSalon?: boolean;
  /**
   * Issue #511 (D-10, D-07) — how certain a Satz-2/3 finding is: VIOLATION, or UNCLEAR when the
   * unrecorded travel between salons decides it. Absent on every Phase-80 finding and on the
   * position-unknown hint. Additive like `waived`.
   */
  certainty?: PlacementCertainty;
  /** Issue #511 (D-10) — display text of the provision the finding rests on; never a control value. */
  legalBasis?: string;
  /**
   * Issue #511 (D-06) — true only on BREAK_POSITION_UNKNOWN and, since Issue #85 (D-07), on
   * FINDING_WITHHELD: a hint is never a violation, marker, notice or month-close block.
   */
  hint?: true;
}

/**
 * The one neutral item a reader whose reach covers only part of a day gets instead of the day's
 * findings (Issue #85 D-07): no minute, no hour, no threshold, no finding category. Built here from
 * the constants of `withheld-finding.ts`, nowhere else.
 */
export function withheldFindingWarning(): ArbZGWarning {
  return {
    code: WITHHELD_FINDING_CODE,
    severity: "warning",
    message: WITHHELD_FINDING_TEXT,
    hint: true,
  };
}

const CLARIFICATION_NOTE = "Klärung nötig: Fahrzeit oder Pause?";
const BIRTH_DATE_MISSING_NOTE =
  "Geburtsdatum nicht hinterlegt – geprüft nach § 4 ArbZG, für Jugendliche gilt § 11 JArbSchG.";

/** "6" / "4,5": a whole number of hours without a trailing zero, German decimal comma. */
function hoursText(minutes: number): string {
  return String(minutes / 60).replace(".", ",");
}

/** "Pause" for one, "Pausen" for any other count. */
function pauseCount(n: number): string {
  return n === 1 ? "1 Pause" : `${n} Pausen`;
}

/** Rounds UP to a whole minute so a violation never prints as exactly the limit ("6:00"). */
function ceilMinutes(minutes: number): number {
  return Math.ceil(minutes - 1e-9);
}

/** Renders the finding's intervals as "08:00–14:01, 15:00–21:30" in the tenant time zone. */
function rangesText(finding: PlacementFinding, tz: string): string {
  return finding.intervals
    .map(
      (i) =>
        `${formatInTimeZone(i.startTime, tz, "HH:mm")}–${formatInTimeZone(i.endTime, tz, "HH:mm")}`,
    )
    .join(", ");
}

/**
 * Builds the § 4 (break) and § 3 (daily maximum) findings of one day from its evaluation.
 *
 * Message templates, severities and key order are the pre-80 ones. `crossSalon: true` is appended
 * on a cross-salon day (D-01/D-18). MAX_DAILY_EXCEEDED is an "error" always — an acknowledgement
 * waives only the § 4 finding, never the § 3 day sum (D-18).
 */
export function dayLimitWarnings(
  evaluation: DayBreakEvaluation,
  bsMinutesToday: number,
  options?: { birthDateMissing?: boolean },
): ArbZGWarning[] {
  const warnings: ArbZGWarning[] = [];
  const { netWorkedMin, totalBreakMin, waived, crossSalon } = evaluation;
  const crossFlag = crossSalon ? { crossSalon: true as const } : {};
  const birthDateNote = options?.birthDateMissing ? ` ${BIRTH_DATE_MISSING_NOTE}` : "";

  // Issue #511 (D-05): an employee under 18 on the work date is checked under § 11 Abs. 1 JArbSchG.
  // The adult branches below are untouched, so the two-argument call for an adult day returns the
  // pre-80 strings byte for byte (day-break-equivalence-80).
  const minorRules = BREAK_REGIMES.JARBSCHG_11;
  if (evaluation.placement.regime === "JARBSCHG_11") {
    if (evaluation.breakShortfall) {
      // The matched duty band; the highest band is the one that blocks (mirror of the adult 45 min).
      const band = minorRules.thresholds.find((b) => b.requiredMin === evaluation.requiredBreakMin);
      const highest = minorRules.thresholds[0];
      warnings.push({
        code: "BREAK_TOO_SHORT",
        severity: band === highest && !waived ? "error" : "warning",
        message: `§ 11 Abs. 1 JArbSchG: Bei mehr als ${hoursText(band?.overMin ?? 0)} Stunden Arbeitszeit sind mindestens ${evaluation.requiredBreakMin} Minuten Ruhepause vorgeschrieben. Erfasst: ${Math.round(totalBreakMin)} Min.`,
        ...(waived ? { waived: true } : {}),
        ...crossFlag,
      });
    }
  } else if (evaluation.requiredBreakMin === 45 && evaluation.breakShortfall) {
    // § 4 ArbZG – Ruhepausenvorschrift
    // Phase 91 (BREAK-03): a waived day downgrades the >9h branch from "error" to "warning" and flags
    // waived:true — the >6h branch is already a "warning" and only gets the waived flag added.
    warnings.push({
      code: "BREAK_TOO_SHORT",
      severity: waived ? "warning" : "error", // waived → downgrade from blocking error
      message: `§ 4 ArbZG: Bei über 9 Stunden Arbeitszeit sind mindestens 45 Minuten Pause vorgeschrieben. Erfasst: ${Math.round(totalBreakMin)} Min.${birthDateNote}`,
      ...(waived ? { waived: true } : {}),
      ...crossFlag,
    });
  } else if (evaluation.requiredBreakMin === 30 && evaluation.breakShortfall) {
    warnings.push({
      code: "BREAK_TOO_SHORT",
      severity: "warning",
      message: `§ 4 ArbZG: Bei über 6 Stunden Arbeitszeit sind mindestens 30 Minuten Pause vorgeschrieben. Erfasst: ${Math.round(totalBreakMin)} Min.${birthDateNote}`,
      ...(waived ? { waived: true } : {}),
      ...crossFlag,
    });
  }

  // § 3 ArbZG – Tägliche Höchstarbeitszeit (10h absolut, 8h nur als 24-Wochen-Schnitt relevant)
  // Phase 63 D-06: mixed-day rule — BS-Zeit + WORK-Zeit > 10h → MAX_DAILY_EXCEEDED.
  const dailyTotalMin = netWorkedMin + bsMinutesToday;
  if (dailyTotalMin > 10 * 60) {
    warnings.push({
      code: "MAX_DAILY_EXCEEDED",
      severity: "error",
      message: `§ 3 ArbZG: Tägliche Höchstarbeitszeit von 10 Stunden überschritten. Erfasst: ${(dailyTotalMin / 60).toFixed(1)} h.`,
      ...crossFlag,
    });
  }

  return warnings;
}

/**
 * Builds the Satz-2/3 findings of one day (Issue #511, D-02, D-07, D-10, D-11) from the placement
 * result of the day kernel, one item per finding. It RENDERS findings and decides nothing: Satz 2
 * and Satz 3 live only in `day-break-placement.ts`, and every number printed here comes from the
 * finding or from the regime table, never from a literal threshold.
 *
 * All items are severity "warning" (D-11): a placement finding never blocks a save, and a waiver
 * (`waived: true`) documents the decision without changing the finding.
 *
 * The text always carries the clock times, so it is for readers whose reach covers the whole day
 * only. A reader with partial coverage gets the single neutral hint of `redactedDayCheck`
 * (api/day-breaks.ts, Issue #85 D-07) instead - the former count-and-duration variant of this
 * function was removed in Phase 85b because its sum-bearing text must not be reusable by accident.
 * `birthDateMissing` appends the note.
 */
export function placementWarnings(
  evaluation: DayBreakEvaluation,
  options: { tz: string; birthDateMissing?: boolean },
): ArbZGWarning[] {
  const { placement } = evaluation;
  const rules = BREAK_REGIMES[placement.regime];
  const minSegmentMin = rules.minSegmentMs / 60_000;

  return placement.findings.map((finding): ArbZGWarning => {
    let text: string;
    switch (finding.code) {
      case "BREAK_TOO_LATE": {
        const longest = ceilMinutes(finding.longestBlockMin ?? 0);
        const duration = `${Math.floor(longest / 60)}:${String(longest % 60).padStart(2, "0")} Std.`;
        text =
          `${finding.legalBasis}: ${duration} am Stück ohne Ruhepause von mindestens ` +
          `${minSegmentMin} Min (${rangesText(finding, options.tz)}). ` +
          `Zulässig sind höchstens ${hoursText(rules.maxBlockMin)} Std.`;
        break;
      }
      case "BREAK_SEGMENT_TOO_SHORT": {
        const nc = finding.nonCounted ?? { tooShort: 0, edge: 0, outsideWindow: 0 };
        const parts: string[] = [];
        if (nc.tooShort > 0) {
          parts.push(`${pauseCount(nc.tooShort)} unter ${minSegmentMin} Min nicht angerechnet`);
        }
        if (nc.edge > 0) {
          parts.push(
            `${pauseCount(nc.edge)} am Beginn oder Ende der Arbeitszeit nicht angerechnet`,
          );
        }
        text =
          `${finding.legalBasis}: ${parts.join(", ")} – angerechnet ` +
          `${Math.round(finding.qualifyingMin ?? 0)} Min Ruhepause, vorgeschrieben ` +
          `${Math.round(finding.requiredMin ?? 0)} Min.`;
        break;
      }
      case "BREAK_OUTSIDE_WINDOW": {
        const n = finding.nonCounted?.outsideWindow ?? 0;
        const window =
          rules.windowMin === 60
            ? "in der ersten oder letzten Stunde"
            : `in den ersten oder letzten ${rules.windowMin} Minuten`;
        text =
          `${finding.legalBasis}: ${pauseCount(n)} ${window} der Arbeitszeit nicht angerechnet` +
          ` (${rangesText(finding, options.tz)}).`;
        break;
      }
      case "BREAK_POSITION_UNKNOWN":
        text =
          `${finding.legalBasis}: Lage der Pause nicht erfasst – Aufteilung in Abschnitte von ` +
          `mindestens ${minSegmentMin} Min und Höchstdauer am Stück nicht prüfbar.`;
        break;
    }
    if (finding.certainty === "UNCLEAR") text += ` ${CLARIFICATION_NOTE}`;
    if (options.birthDateMissing) text += ` ${BIRTH_DATE_MISSING_NOTE}`;

    const isHint = finding.code === "BREAK_POSITION_UNKNOWN";
    return {
      code: finding.code,
      severity: "warning",
      message: text,
      ...(finding.certainty !== null ? { certainty: finding.certainty } : {}),
      legalBasis: finding.legalBasis,
      ...(isHint ? { hint: true as const } : {}),
      ...(evaluation.waived ? { waived: true } : {}),
      ...(evaluation.crossSalon ? { crossSalon: true } : {}),
    };
  });
}

/**
 * Prüft ArbZG-Konformität für einen Mitarbeiter nach einem geänderten Eintrag.
 * Gibt eine Liste von Warnungen zurück (blockiert NICHT das Speichern).
 *
 * Phase 63 — Berufsschule integration (D-05..D-08):
 *   - VOCATIONAL_SCHOOL Absences contribute their `vocationalSchoolMinutesPerDay`
 *     (per tenant, default 480) to every ArbZG branch:
 *       § 3 Tageshöchst (MAX_DAILY_EXCEEDED, mixed-day check)
 *       § 3 Wochensumme (MAX_WEEKLY_EXCEEDED)
 *       § 3 24-week avg (MAX_DAILY_AVG_EXCEEDED)
 *       § 5 Ruhezeit (MIN_REST_VIOLATED, BS-end = 18:00 single / 24:00 block)
 *   - NO new warning codes (D-08) — reuse existing 5 codes; ArbZG doesn't care WHY
 *     a day is over the limit.
 *   - All Absence queries include `deletedAt: null` per CLAUDE.md soft-delete rule.
 */
export async function checkArbZG(
  prisma: PrismaClient,
  employeeId: string,
  changedDate: Date,
): Promise<ArbZGWarning[]> {
  const warnings: ArbZGWarning[] = [];

  // Look up tenant timezone and current schedule type for this employee
  const employee = await prisma.employee.findUniqueOrThrow({
    where: { id: employeeId },
    select: {
      tenantId: true,
      isTimeTrackingExempt: true, // Phase 76.7 (D-05, ARBZG-V19-01)
      birthDate: true, // Issue #511 (D-05) — decides the § 11 JArbSchG break regime
      classification: true, // Issue #511 (D-05) — only an apprentice's missing birth date is noted
      workSchedules: {
        orderBy: { validFrom: "desc" },
        take: 1,
        // Phase 76.31-05: full schedule needed so the slot resolver can compute
        // the individual daily Soll (FIRST_LONG_DAY fallback → weeklyHours/workDays).
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
      },
    },
  });

  // Phase 76.7 (D-05) — § 18 ArbZG-exempt employees skip every ArbZG check
  // (§ 3 daily max, § 4 breaks, § 5 rest period). BUrlG (vacation) still applies.
  if (employee.isTimeTrackingExempt) return warnings; // already []

  const tz = await getTenantTimezone(prisma, employee.tenantId);
  const schedule = employee.workSchedules[0] ?? null;
  const scheduleType = schedule?.type ?? "FIXED_SCHEDULE";

  // Phase 63 — load tenant config for BS-minutes-per-day; fall back to default
  // so a missing TenantConfig row never throws (mirrors saldo helper semantics).
  // Phase 76.31-05 — also read the bsSlot* override columns so the slot resolver
  // walks the full D-06 4-layer hierarchy (Employee ?? Pattern ?? TenantConfig ?? legacy ?? daily-Soll).
  const tenantConfig = await prisma.tenantConfig.findUnique({
    where: { tenantId: employee.tenantId },
    select: {
      vocationalSchoolMinutesPerDay: true,
      vocationalSchoolBlockMinutesPerWeek: true,
      bsSlotFirstLongDayMinutes: true,
      bsSlotSecondLongDayMinutes: true,
      bsSlotShortDayMinutes: true,
      bsSlotBlockWeekMinutes: true,
    },
  });
  const bsDailyMin = tenantConfig?.vocationalSchoolMinutesPerDay ?? BS_DAILY_DEFAULT_MIN;

  const dateStr = dateStrInTz(changedDate, tz);

  // Phase 63 — Is the changed date itself a BS day? Looked up once and reused by
  // the §3 daily mixed-day branch + §5 rest-period BS-end heuristic.
  // Phase 100B Plan 12 — A6's R-B single-day sibling, contexts/absence facade.
  const bsAbsenceToday = await hasVocationalSchoolDay(
    prisma,
    employeeId,
    employee.tenantId,
    changedDate,
  );
  // Phase 76.31-05 (D-08 FULL) — the §3 daily 10h check must count the REAL slot-
  // resolved BS minutes, not a flat 480. A LONG day is 9.5h (570 min); counting it
  // as 480 under-warns on the 10h cap (RESEARCH R5). The resolver returns 0 when no
  // BS absence exists for the date, so the branch stays a no-op on non-BS days.
  const bsMinutesToday = bsAbsenceToday
    ? await getVocationalSchoolMinutesForDate(prisma, employeeId, changedDate, tenantConfig, {
        schedule,
        scheduleType,
      })
    : 0;

  // ── 1. Tagessicht: alle abgeschlossenen Slots des Tages ────────────────────
  // Phase 69b: read through findEntriesOfDay (the former one-day window on the DATE column equals
  // equality on the UTC-midnight date); closed WORK rows only, in start order.
  const daySlots = (
    await findEntriesOfDay(prisma, {
      tenantId: employee.tenantId,
      employeeId,
      date: new Date(dateStr),
    })
  ).filter((e) => e.endTime !== null && e.type === "WORK");

  if (daySlots.length > 0) {
    // Decision (Issue #70, D-04): several entries per day are the normal case here. The gap rule (a
    // gap between salons is travel, never a break) and the waiver rule (entry-level WAIVED never
    // waives a cross-salon day) live in day-break-rule.ts (D-01/D-16); this branch only feeds it
    // every closed WORK row of the day, whatever the salon.
    // Issue #511 (D-15): the Break rows of the day's entries come from the store's one loader, so
    // the kernel can place the breaks (Satz 2/3); the day lookup itself stays untouched.
    const breaksByEntry = await loadBreaksOfEntries(prisma, {
      tenantId: employee.tenantId,
      entryIds: daySlots.map((s) => s.id),
    });
    const rows: DayBreakRow[] = daySlots.map((s) => ({
      id: s.id,
      startTime: s.startTime,
      endTime: s.endTime!,
      breakMinutes: s.breakMinutes,
      breakStatus: s.breakStatus,
      salonId: s.salonId,
      breaks: breaksByEntry.get(s.id) ?? [],
    }));
    // Issue #80 (80-AC6): gap breaks and acknowledgements are read only when the day has two or
    // more closed WORK rows — a single-entry day issues no extra query and stays unchanged.
    const dayParams = { tenantId: employee.tenantId, employeeId, date: new Date(dateStr) };
    // Issue #511 (D-05): the regime follows the employee's age ON THE WORK DATE (UTC-midnight date
    // of the tenant-local day); a missing birth date is the adult regime, noted for apprentices.
    const regime = breakRegimeFor(isMinorAtDate(employee.birthDate, dayParams.date));
    const birthDateMissing = isApprenticeWithoutBirthDate(employee);
    const [dayBreaks, acks] =
      rows.length >= 2
        ? await Promise.all([
            listDayBreaksOfDay(prisma, dayParams),
            listAcksOfDay(prisma, dayParams),
          ])
        : [[], []];
    let evaluation = evaluateDayBreaks({
      rows,
      dayBreaks,
      acks: acks.map((a) => ({ snapshot: a.snapshot })),
      regime,
    });
    // Issue #511 (D-12): a single-entry day can carry an ackable placement finding. Only such a day
    // reads its acknowledgements (and re-evaluates with them); a finding-free single-entry day
    // still issues no extra query (80-AC6 intent). A single entry has no gap, so no day breaks.
    if (rows.length === 1 && hasAckableFinding(evaluation)) {
      const singleDayAcks = await listAcksOfDay(prisma, dayParams);
      evaluation = evaluateDayBreaks({
        rows,
        dayBreaks,
        acks: singleDayAcks.map((a) => ({ snapshot: a.snapshot })),
        regime,
      });
    }
    warnings.push(...dayLimitWarnings(evaluation, bsMinutesToday, { birthDateMissing }));
    // Issue #511 (D-10): the Satz-2/3 findings, appended after the Phase-80 ones.
    warnings.push(...placementWarnings(evaluation, { tz, birthDateMissing }));

    // § 5 ArbZG – Mindestruhezeit (11h zwischen Arbeitstagen)
    // Previous day: its last closed slot (any type).
    const prevDate = new Date(changedDate);
    prevDate.setDate(prevDate.getDate() - 1);
    const prevDateStr = dateStrInTz(prevDate, tz);

    // Decision (Issue #70, D-04): the rest period is measured from the LATEST end of the previous
    // day, which is right for several entries per day because the selection rule is "latest
    // endTime" over every row of that day (`latestEnding`), not "the" entry.
    const prevLastSlot = latestEnding(
      await findEntriesOfDay(prisma, {
        tenantId: employee.tenantId,
        employeeId,
        date: new Date(prevDateStr),
      }),
    );

    if (prevLastSlot?.endTime && daySlots.length > 0) {
      const restMin = (daySlots[0].startTime.getTime() - prevLastSlot.endTime.getTime()) / 60000;
      if (restMin < 11 * 60) {
        const restH = (restMin / 60).toFixed(1);
        warnings.push({
          code: "MIN_REST_VIOLATED",
          severity: "warning",
          message: `§ 5 ArbZG: Mindestruhezeit von 11 Stunden zwischen Arbeitstagen unterschritten. Ruhezeit: ${restH} h.`,
        });
      }
    }

    // Next day: its first closed slot (any type).
    const nextDate = new Date(changedDate);
    nextDate.setDate(nextDate.getDate() + 1);
    const nextDateStr = dateStrInTz(nextDate, tz);

    // Decision (Issue #70, D-04): the rest period is measured to the EARLIEST start of the next
    // day, over every row of that day (`earliestStarting`) — several entries per day need no special
    // case.
    const nextFirstSlot = earliestStarting(
      await findEntriesOfDay(prisma, {
        tenantId: employee.tenantId,
        employeeId,
        date: new Date(nextDateStr),
      }),
    );

    const lastSlotToday = daySlots[daySlots.length - 1];
    if (nextFirstSlot && lastSlotToday.endTime) {
      const restMin = (nextFirstSlot.startTime.getTime() - lastSlotToday.endTime.getTime()) / 60000;
      if (restMin < 11 * 60) {
        const restH = (restMin / 60).toFixed(1);
        warnings.push({
          code: "MIN_REST_VIOLATED",
          severity: "warning",
          message: `§ 5 ArbZG: Mindestruhezeit zum Folgetag unterschritten. Ruhezeit: ${restH} h.`,
        });
      }
    }
  }

  // Phase 63 D-07 — §5 Mindestruhezeit on a BS-day.
  // The day-view branch above only fires when daySlots.length > 0. A BS-only day
  // (no regular work) also needs to be checked: 11h gap from BS-end → next-day
  // work, and 11h gap from prev-day work → BS-start (we treat BS start as 08:00
  // tenant-TZ by symmetry to the 18:00 end; this is the most conservative).
  // For the next-day check we use 18:00 tenant-TZ as BS-end on single days and
  // 24:00 on block-week days (≥5 BS days in the same ISO week, D-07).
  if (bsAbsenceToday) {
    const nextDate = new Date(changedDate);
    nextDate.setDate(nextDate.getDate() + 1);
    const nextDateStr = dateStrInTz(nextDate, tz);

    // Decision (Issue #70, D-04): the Berufsschultag rest period, like the one above, is measured to
    // the EARLIEST start of the next day over every row of that day.
    const nextFirstSlot = earliestStarting(
      await findEntriesOfDay(prisma, {
        tenantId: employee.tenantId,
        employeeId,
        date: new Date(nextDateStr),
      }),
    );

    if (nextFirstSlot) {
      // Detect block-week: ≥5 BS days in the same ISO week as `changedDate`.
      const bsDaysThisWeek = await countBsDaysInIsoWeek(prisma, employeeId, changedDate);
      const isBlockWeek = bsDaysThisWeek >= 5;
      // Synthetic BS-end timestamp in tenant TZ:
      //   single day  → 18:00 of `changedDate`
      //   block week  → 24:00 (= next day 00:00) of `changedDate`
      const bsEndLocal = isBlockWeek ? `${nextDateStr}T00:00:00` : `${dateStr}T18:00:00`;
      const bsEndUtc = fromZonedTime(bsEndLocal, tz);
      const restMin = (nextFirstSlot.startTime.getTime() - bsEndUtc.getTime()) / 60000;
      if (restMin < 11 * 60) {
        const restH = (restMin / 60).toFixed(1);
        warnings.push({
          code: "MIN_REST_VIOLATED",
          severity: "warning",
          message: `§ 5 ArbZG: Mindestruhezeit zum Folgetag unterschritten. Ruhezeit: ${restH} h.`,
        });
      }
    }
  }

  // ── 2. Wochensicht: § 3 ArbZG – max. 48h / Woche ─────────────────────────
  // Derive week boundaries in tenant timezone to avoid UTC vs. local mismatch.
  // changedDate is UTC; dateStrInTz gives the calendar date in tenant TZ.
  const dayOfWeek = getDayOfWeekInTz(changedDate, tz); // 0=So, 1=Mo, ...
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  // Compute the date string for Monday in the tenant timezone
  const changedDateStr = dateStrInTz(changedDate, tz);
  const changedMs = new Date(changedDateStr + "T00:00:00Z").getTime();
  const mondayMs = changedMs - daysFromMonday * 86400000;
  const monday = new Date(mondayMs);
  const sunday = new Date(mondayMs + 6 * 86400000 + 86399999);

  const weekSlots = await prisma.timeEntry.findMany({
    where: {
      employeeId,
      deletedAt: null,
      startTime: { gte: monday, lte: sunday },
      endTime: { not: null },
      type: "WORK",
    },
  });

  const weeklyNetMin = weekSlots.reduce((sum, e) => addWorkingMinutes(sum, e), 0);

  // Phase 76.31-05 (D-08 FULL) — sum the slot-resolved BS minutes for every
  // VOCATIONAL_SCHOOL day in this ISO week, instead of a flat bsDailyMin × N (or
  // the weekly-cap shortcut). getVocationalSchoolMinutesForDate returns the same
  // per-date amount used by the §3 daily check AND the saldo math — so a LONG day
  // counts 570 min (9.5h), a block week auto-caps via blockWeekMinutes/N, and the
  // 48h weekly cap reflects the real credited load (RESEARCH R5). Soft-delete-aware.
  // Phase 100B Plan 12 — A6, contexts/absence facade.
  const bsWeekRows = await getVocationalSchoolDays(
    prisma,
    { kind: "employee", employeeId, tenantId: employee.tenantId },
    monday,
    sunday,
  );
  const bsWeekDateStrs = Array.from(
    new Set(bsWeekRows.map((r) => r.startDate.toISOString().slice(0, 10))),
  );
  let bsMinutesThisWeek = 0;
  for (const ds of bsWeekDateStrs) {
    bsMinutesThisWeek += await getVocationalSchoolMinutesForDate(
      prisma,
      employeeId,
      new Date(`${ds}T00:00:00.000Z`),
      tenantConfig,
      { schedule, scheduleType },
    );
  }
  const weeklyTotalMin = weeklyNetMin + bsMinutesThisWeek;

  if (weeklyTotalMin > 48 * 60) {
    warnings.push({
      code: "MAX_WEEKLY_EXCEEDED",
      severity: "error",
      message: `§ 3 ArbZG: Wöchentliche Höchstarbeitszeit von 48 Stunden überschritten. Diese Woche: ${(weeklyTotalMin / 60).toFixed(1)} h.`,
    });
  }

  // ── 3. 24-Wochen-Durchschnitt: § 3 ArbZG – max. 8h/Werktag im Durchschnitt ─
  // The 8h/day rule in § 3 ArbZG is NOT a daily limit — it is a 24-week rolling average.
  // A 4-day/39h week (9.75h/day, 4 days) is perfectly legal because:
  //   936h total / 144 Werktage (24 × 6) = 6.5h/Werktag < 8h → no warning.
  // Denominator is always 144 Werktage (Mon–Sat × 24 weeks), regardless of how many
  // days the employee actually worked.
  // MONTHLY_HOURS employees (Minijobber, pure tracking) have no daily target — skip this check.
  if (scheduleType !== "MONTHLY_HOURS") {
    const windowStart = new Date(changedDate);
    windowStart.setDate(windowStart.getDate() - 167); // 168 days = 24 weeks × 7
    windowStart.setHours(0, 0, 0, 0);

    const avgEntries = await prisma.timeEntry.findMany({
      where: {
        employeeId,
        deletedAt: null,
        startTime: { gte: windowStart, lte: changedDate },
        endTime: { not: null },
        type: "WORK",
      },
      select: { startTime: true, endTime: true, breakMinutes: true },
    });

    const totalNetMin = avgEntries.reduce((sum, e) => addWorkingMinutes(sum, e), 0);

    // Phase 63 D-05 — Count VOCATIONAL_SCHOOL absence days in the same 168-day
    // window and multiply by bsDailyMin. We use a simple `count × daily` even on
    // block weeks here because the 24-week denominator (144 Werktage) is so
    // large that block-week capping vs. uncapped contribution makes a
    // negligible difference (max delta over 24 weeks ≈ a few minutes/Werktag).
    // Phase 100B Plan 12 — A6, contexts/absence facade.
    const bsAvgAbsences = await getVocationalSchoolDays(
      prisma,
      { kind: "employee", employeeId, tenantId: employee.tenantId },
      windowStart,
      changedDate,
    );
    const bsDistinctDaysInWindow = new Set(
      bsAvgAbsences.map((a) => a.startDate.toISOString().slice(0, 10)),
    ).size;
    const totalWithBsMin = totalNetMin + bsDistinctDaysInWindow * bsDailyMin;

    // 24 weeks × 6 Werktage (Mon–Sat) = 144 Werktage
    const WERKTAGE_IN_24_WEEKS = 144;
    const avgPerWerktag = totalWithBsMin / WERKTAGE_IN_24_WEEKS;

    if (avgPerWerktag > 8 * 60) {
      const avgH = (avgPerWerktag / 60).toFixed(1);
      warnings.push({
        code: "MAX_DAILY_AVG_EXCEEDED",
        severity: "warning",
        message: `§ 3 ArbZG: 24-Wochen-Durchschnitt von 8 Stunden überschritten. Aktueller Schnitt: ${avgH} h/Tag.`,
      });
    }
  }

  return warnings;
}
