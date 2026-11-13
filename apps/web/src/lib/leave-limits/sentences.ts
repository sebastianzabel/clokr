// Issue #836 — German texts for limit warnings (request response) and the 409 exception step.
// Pure display: every count, day and name comes from the API payload (already redacted to the
// reader's reach); nothing is derived or looked up here (AC-12).
import { fmtDateDe, fmtDateShortDe } from "$lib/reports/period-format";
import { groupPluralLabel, isBlackout } from "./labels";
import type { LeaveLimitWarning, LeaveLimitWarningPerson } from "./types";

const BLACKOUT_FALLBACK_NAME = "Urlaubssperre";

function dayWord(n: number): string {
  return n === 1 ? "1 Tag" : `${n} Tagen`;
}

/** "Anna Berg" -> "Anna B."; the last name is never printed in full. */
function shortName(person: LeaveLimitWarningPerson): string {
  const initial = person.lastName.trim().charAt(0);
  return initial ? `${person.firstName} ${initial}.` : person.firstName;
}

/** The distinct persons the API named over all days of one warning, in order of appearance. */
function namedPersons(warning: LeaveLimitWarning): LeaveLimitWarningPerson[] {
  const seen = new Map<string, LeaveLimitWarningPerson>();
  for (const day of warning.days) {
    for (const person of day.persons ?? []) {
      if (!seen.has(person.employeeId)) seen.set(person.employeeId, person);
    }
  }
  return [...seen.values()];
}

function windowText(warning: Pick<LeaveLimitWarning, "validFrom" | "validUntil">): string {
  const { validFrom, validUntil } = warning;
  if (validFrom && validUntil) return `vom ${fmtDateDe(validFrom)} bis ${fmtDateDe(validUntil)}`;
  if (validFrom) return `ab ${fmtDateDe(validFrom)}`;
  if (validUntil) return `bis ${fmtDateDe(validUntil)}`;
  return "ganzjährig";
}

function ruleLabel(warning: LeaveLimitWarning): string {
  return warning.ruleName?.trim() || BLACKOUT_FALLBACK_NAME;
}

/** One sentence per warning; the request is never blocked by it. */
export function warningSentences(warnings: LeaveLimitWarning[]): string[] {
  return warnings.map((warning) => {
    const dayCount = warning.days.length;
    if (isBlackout(warning)) {
      return `${ruleLabel(warning)} ${windowText(warning)}: an ${dayWord(dayCount)} betroffen.`;
    }
    // A reported day is always one the request counts on, so the others are count - 1.
    const others = Math.max(0, ...warning.days.map((d) => d.count - 1));
    const base = `An ${dayWord(dayCount)} sind schon ${others} ${groupPluralLabel(warning)} im Urlaub (höchstens ${warning.maxPersons})`;
    const names = namedPersons(warning).map(shortName);
    return names.length > 0 ? `${base}, darunter ${names.join(", ")}.` : `${base}.`;
  });
}

/** The multi-line text the exception ReasonDialog shows: per rule the group, the maximum, the days. */
export function exceedanceDescription(exceedances: LeaveLimitWarning[]): string {
  return exceedances
    .map((warning) => {
      const days = warning.days.map((d) => `${fmtDateShortDe(d.day)} (${d.count})`).join(", ");
      if (isBlackout(warning)) {
        return `${ruleLabel(warning)} ${windowText(warning)}: gesperrt an ${days}`;
      }
      return `${groupPluralLabel(warning)}, höchstens ${warning.maxPersons}: ${days}`;
    })
    .join("\n");
}
