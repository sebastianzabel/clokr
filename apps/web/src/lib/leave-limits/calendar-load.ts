// Issue #836 — the team calendar marks days that are over a leave limit. Pure mapping of the
// `GET /leave/limits/load` response: the API decides what is exceeded (`exceeded`), this module
// only words it. Nothing is counted here (AC-12).
import { groupPluralLabel, isBlackout } from "./labels";
import type { LeaveLimitLoadResponse } from "./types";

/** The neutral hint for a day whose load includes leave approved before the rule existed (D-836-11). */
export const APPROVED_BEFORE_RULE_HINT = "Vor Anlage der Regel genehmigt";

/** What the calendar cell of an exceeded day shows. */
export interface ExceededDay {
  /** One tooltip line per salon/group that is over its limit on that day. */
  lines: string[];
  /** True when an exceeded group of the day counts leave approved before the rule. */
  approvedBeforeRule: boolean;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** First and last day of a month (`month` is 1-12) as `YYYY-MM-DD`. */
export function loadRangeForMonth(year: number, month: number): { from: string; to: string } {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(lastDay)}` };
}

/** Only exceeded days; the key is the `YYYY-MM-DD` day. */
export function exceededDaysFromLoad(view: LeaveLimitLoadResponse): Map<string, ExceededDay> {
  const result = new Map<string, ExceededDay>();
  const prefixSalon = view.salons.length > 1;
  for (const salon of view.salons) {
    for (const group of salon.groups) {
      for (const day of group.days) {
        if (!day.exceeded) continue;
        const entry = result.get(day.day) ?? { lines: [], approvedBeforeRule: false };
        const blackout = isBlackout({ groupKind: group.groupKind, maxPersons: day.max ?? -1 });
        const text = blackout
          ? `${day.ruleName?.trim() || "Urlaubssperre"}: ${day.count} im Urlaub`
          : `${groupPluralLabel(group)}: ${day.count} von höchstens ${day.max}`;
        entry.lines.push(prefixSalon ? `${salon.salonName} · ${text}` : text);
        if (day.approvedBeforeRuleCount > 0) entry.approvedBeforeRule = true;
        result.set(day.day, entry);
      }
    }
  }
  return result;
}

/** The tooltip of a badge: the lines, plus the neutral hint when pre-rule approvals are part of the load. */
export function limitBadgeTitle(day: ExceededDay): string {
  return [...day.lines, ...(day.approvedBeforeRule ? [APPROVED_BEFORE_RULE_HINT] : [])].join("\n");
}
