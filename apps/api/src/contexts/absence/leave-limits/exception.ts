/**
 * Issue #836 (D-836-09/10/19) — the exception building blocks. Pure, no I/O.
 *
 * An approval or a correction that pushes a salon group over a rule needs an explicit exception
 * with a reason (§ 7 Abs. 1 BUrlG weighing stays with the approver). The 409 body and the audit
 * snapshot carry rule ids, salons and COUNTS only — never the id of another person (D-836-10,
 * DSGVO Art. 32): the audit of one employee's approval must not name the colleagues on leave.
 */
import { z } from "zod";
import { addedDayRanges } from "../leave-correction";
import { LEAVE_LIMIT_EXCEPTION_REQUIRED, isLeaveLimitCountedCode } from "./constants";
import type { LeaveLimitExceedance } from "./check";
import { toLeaveLimitWarnings, type LeaveLimitWarning } from "./response";

const EXCEPTION_REASON_MESSAGE = "Die Begründung der Ausnahme muss 10 bis 500 Zeichen lang sein.";

/** The exception an approver grants: a reason of 10 to 500 characters after trimming. */
export const limitExceptionSchema = z.object({
  reason: z.string().trim().min(10, EXCEPTION_REASON_MESSAGE).max(500, EXCEPTION_REASON_MESSAGE),
});

export type LeaveLimitException = z.infer<typeof limitExceptionSchema>;

export function leaveLimitExceptionRequiredBody(exceedances: readonly LeaveLimitExceedance[]): {
  error: string;
  code: typeof LEAVE_LIMIT_EXCEPTION_REQUIRED;
  exceedances: LeaveLimitWarning[];
} {
  return {
    error:
      "Die Urlaubsgrenze ist überschritten. Für die Genehmigung ist eine Ausnahme mit Begründung nötig.",
    code: LEAVE_LIMIT_EXCEPTION_REQUIRED,
    exceedances: toLeaveLimitWarnings(exceedances),
  };
}

export type LeaveLimitExceptionAudit = {
  reason: string;
  rules: Array<{
    ruleId: string;
    name: string | null;
    groupKind: "ALL" | "CLASSIFICATION" | "ACCESS_ROLE";
    classification: string | null;
    accessRoleId: string | null;
    maxPersons: number;
    validFrom: string | null;
    validUntil: string | null;
    salonId: string | null;
  }>;
  days: Array<{ day: string; salonId: string; ruleId: string; count: number }>;
};

/** The snapshot stored in the APPROVE / LEAVE_CORRECTED audit; ids of rules and salons, counts. */
export function buildLeaveLimitExceptionAudit(
  reason: string,
  exceedances: readonly LeaveLimitExceedance[],
): LeaveLimitExceptionAudit {
  const rules = new Map<string, LeaveLimitExceptionAudit["rules"][number]>();
  const days: LeaveLimitExceptionAudit["days"] = [];
  for (const e of exceedances) {
    if (!rules.has(e.rule.id)) {
      rules.set(e.rule.id, {
        ruleId: e.rule.id,
        name: e.rule.name,
        groupKind: e.rule.groupKind,
        classification: e.rule.classification,
        accessRoleId: e.rule.accessRoleId,
        maxPersons: e.rule.maxPersons,
        validFrom: e.rule.validFrom,
        validUntil: e.rule.validUntil,
        salonId: e.rule.salonId,
      });
    }
    for (const d of e.days) {
      days.push({ day: d.day, salonId: e.salonId, ruleId: e.rule.id, count: d.count });
    }
  }
  days.sort((a, b) =>
    a.day !== b.day
      ? a.day < b.day
        ? -1
        : 1
      : a.salonId !== b.salonId
        ? a.salonId < b.salonId
          ? -1
          : 1
        : a.ruleId < b.ruleId
          ? -1
          : a.ruleId > b.ruleId
            ? 1
            : 0,
  );
  return {
    reason,
    rules: [...rules.values()].sort((a, b) => (a.ruleId < b.ruleId ? -1 : 1)),
    days,
  };
}

const dayString = (date: Date) => date.toISOString().slice(0, 10);

/**
 * The day ranges of a correction that can newly load a limit (D-836-19): none when the new type
 * is uncounted, the whole new range when an uncounted type becomes counted, else only the ADDED
 * days. A shortening therefore never asks for an exception. `halfDay` never matters — a half day
 * counts as one person.
 */
export function correctionCandidateRanges(input: {
  oldStart: Date;
  oldEnd: Date;
  newStart: Date;
  newEnd: Date;
  oldTypeCode: string;
  newTypeCode: string;
}): Array<{ startDay: string; endDay: string }> {
  if (!isLeaveLimitCountedCode(input.newTypeCode)) return [];
  if (!isLeaveLimitCountedCode(input.oldTypeCode)) {
    return [{ startDay: dayString(input.newStart), endDay: dayString(input.newEnd) }];
  }
  return addedDayRanges(input.oldStart, input.oldEnd, input.newStart, input.newEnd).map((r) => ({
    startDay: dayString(r.start),
    endDay: dayString(r.end),
  }));
}
