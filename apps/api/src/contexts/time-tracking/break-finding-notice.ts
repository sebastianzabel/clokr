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
 *   - "redacted"  (Issue #85 D-07) the neutral notice of `buildWithheldNotice`: the employee, the
 *                 calendar day and one fixed sentence - no day total, no break figure, no block
 *                 duration, no legal paragraph, no finding wording, no salon, no clock time.
 *                 `buildCrossSalonNotice` returns it BY CONSTRUCTION before it reads the
 *                 evaluation or `entries`, so a caller cannot obtain the old sum text for a
 *                 partially covering recipient (T-80-37, T-85b-30). The same notice is sent for a
 *                 placement finding; `buildBreakPlacementNotice` is called for full recipients
 *                 only.
 *   - "full"      the core sentence plus the salons and the times of the day (unchanged).
 *
 * Pure module: type-only imports plus the constants of the leaf `./withheld-finding`, no Prisma,
 * no Fastify, no clock. The caller formats the `HH:MM` strings in the tenant time zone.
 */
import type { DayBreakEvaluation } from "./day-break-rule";
import { WITHHELD_FINDING_TEXT, WITHHELD_NOTICE_TITLE } from "./withheld-finding";

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

/** Title of the full cross-salon notice; also the email subject, because a subject travels further than a body. */
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
 * The neutral notice for a recipient whose reach does not cover the whole day (Issue #85 D-07):
 * the employee name, the German calendar date and the fixed hint text. The date is the only digit
 * sequence; nothing here depends on the finding.
 */
export function buildWithheldNotice(input: { employeeName: string; date: string }): {
  title: string;
  message: string;
} {
  return {
    title: WITHHELD_NOTICE_TITLE,
    message: `${input.employeeName}, ${germanDate(input.date)}: ${WITHHELD_FINDING_TEXT}`,
  };
}

/**
 * Builds the title and message of the cross-salon § 4 notification.
 *
 * For any detail other than "full" it is the neutral notice, returned before the evaluation is
 * read. The full core sentence names the employee, the day, the day's net hours and the missing
 * break (none recorded, or the recorded minutes against the required ones); the entries are
 * appended in parentheses when given. The wording is pinned by the unit tests, not restated here.
 */
export function buildCrossSalonNotice(input: CrossSalonNoticeInput): {
  title: string;
  message: string;
} {
  if (input.detail !== "full") {
    return buildWithheldNotice({ employeeName: input.employeeName, date: input.date });
  }
  const { evaluation } = input;
  const required = evaluation.requiredBreakMin;
  const recorded = Math.round(evaluation.totalBreakMin);
  const phrase =
    recorded === 0 ? `ohne ${required} Min Pause` : `mit ${recorded} statt ${required} Min Pause`;
  const core =
    `${input.employeeName}: Am ${germanDate(input.date)} insgesamt ` +
    `${germanHours(evaluation.netWorkedMin)} h ${phrase}, salonübergreifend`;

  if (input.entries && input.entries.length > 0) {
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
