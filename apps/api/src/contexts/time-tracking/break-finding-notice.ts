/**
 * break-finding-notice.ts
 *
 * Issue #80 (D-11) and Issue #511 (D-13) — the ONE module that builds the manager notification
 * texts of the next-day break-finding job (Feature 10 of the attendance checker):
 *   - `buildCrossSalonNotice`   the cross-salon § 4 Satz 1 ArbZG shortfall (Issue #80 wording,
 *                               pinned by the unit tests);
 *   - `buildBreakPlacementNotice` every other finding, i.e. a Satz 2 / Satz 3 ArbZG or § 11 JArbSchG
 *                               placement finding.
 *
 * Two levels of detail, decided by the CALLER from the recipient's reach over the day:
 *   - "redacted"  the day total and the finding only. The redacted cross-salon text contains no
 *                 salon name and no clock time BY CONSTRUCTION: this function never reads `entries`
 *                 for it, so a caller that passes them by mistake still cannot leak them (T-80-37).
 *                 The placement builder adds no time of its own; the caller hands it messages that
 *                 were already rendered at the recipient's detail level (T-511-29).
 *   - "full"      the same sentence plus the salons and the times of the day.
 *
 * Pure module: type-only imports, no Prisma, no Fastify, no clock. The caller formats the
 * `HH:MM` strings in the tenant time zone.
 */
import type { DayBreakEvaluation } from "./day-break-rule";

/** One entry of the day as shown to a recipient who may see the whole day. */
export interface CrossSalonNoticeEntry {
  /** Name of the salon the entry was worked in. */
  salonName: string;
  /** Start of the entry, "HH:MM" in the tenant time zone. */
  startLocal: string;
  /** End of the entry, "HH:MM" in the tenant time zone. */
  endLocal: string;
}

export interface CrossSalonNoticeInput {
  employeeName: string;
  /** Calendar day, "YYYY-MM-DD". */
  date: string;
  evaluation: Pick<DayBreakEvaluation, "netWorkedMin" | "totalBreakMin" | "requiredBreakMin">;
  detail: "full" | "redacted";
  /** Read only for detail "full". */
  entries?: readonly CrossSalonNoticeEntry[];
}

/** Neutral title; also used as the email subject, because a subject travels further than a body. */
export const CROSS_SALON_NOTICE_TITLE = "Pausenverstoß (salonübergreifend)";

/** "2026-03-10" -> "10.03.2026". */
function germanDate(date: string): string {
  const [year, month, day] = date.split("-");
  return `${day}.${month}.${year}`;
}

/** Hours with at most one decimal and a decimal comma: 480 -> "8", 570 -> "9,5". */
function germanHours(minutes: number): string {
  const hours = Math.round((minutes / 60) * 10) / 10;
  return String(hours).replace(".", ",");
}

/**
 * Builds the title and message of the cross-salon § 4 notification.
 *
 * The core sentence names the employee, the day, the day's net hours and the missing break (none
 * recorded, or the recorded minutes against the required ones). The redacted message is the core
 * plus a full stop; the full message appends the entries in parentheses. The wording is pinned by
 * the unit tests, not restated here.
 */
export function buildCrossSalonNotice(input: CrossSalonNoticeInput): {
  title: string;
  message: string;
} {
  const { evaluation } = input;
  const required = evaluation.requiredBreakMin;
  const recorded = Math.round(evaluation.totalBreakMin);
  const phrase =
    recorded === 0 ? `ohne ${required} Min Pause` : `mit ${recorded} statt ${required} Min Pause`;
  const core =
    `${input.employeeName}: Am ${germanDate(input.date)} insgesamt ` +
    `${germanHours(evaluation.netWorkedMin)} h ${phrase}, salonübergreifend`;

  if (input.detail === "full" && input.entries && input.entries.length > 0) {
    const parts = input.entries.map((e) => `${e.salonName} ${e.startLocal}–${e.endLocal}`);
    return { title: CROSS_SALON_NOTICE_TITLE, message: `${core} (${parts.join(", ")}).` };
  }
  return { title: CROSS_SALON_NOTICE_TITLE, message: `${core}.` };
}

/** Neutral title; also used as the email subject, because a subject travels further than a body. */
export const BREAK_PLACEMENT_NOTICE_TITLE = "Pausenverstoß (Pausenlage)";

export interface BreakPlacementNoticeInput {
  employeeName: string;
  /** Calendar day, "YYYY-MM-DD". */
  date: string;
  /**
   * The finding texts of the day, already rendered at the recipient's detail level by the
   * placement renderer. This builder adds no time, salon or id of its own.
   */
  findingMessages: readonly string[];
}

/**
 * Builds the title and message of the Satz 2 / Satz 3 placement notification (Issue #511, D-13):
 * the employee and the day in front of the finding texts, joined by a space.
 */
export function buildBreakPlacementNotice(input: BreakPlacementNoticeInput): {
  title: string;
  message: string;
} {
  return {
    title: BREAK_PLACEMENT_NOTICE_TITLE,
    message: `${input.employeeName}: Am ${germanDate(input.date)} ${input.findingMessages.join(" ")}`,
  };
}
