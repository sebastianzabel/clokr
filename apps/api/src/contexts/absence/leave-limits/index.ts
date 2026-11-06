/**
 * Issue #836 — barrel of the leave-limits module (Abwesenheiten). Callers import this file by
 * relative path; it is NOT re-exported from `contexts/absence/index.ts` (D-836-21, import-cycle gate).
 */
export {
  LEAVE_LIMIT_COUNTED_CODES,
  LEAVE_LIMIT_COUNTED_STATUSES,
  LEAVE_LIMIT_EXCEPTION_REQUIRED,
  LEAVE_LIMIT_LOAD_MAX_DAYS,
  isLeaveLimitCountedCode,
} from "./constants";
export { groupKeyOf, ruleAppliesOn, strictestRulesOn, type LeaveLimitRuleRow } from "./rules";
export { parallelLeaveLoad, type CountedPersonDay, type LeaveLoad } from "./parallel-leave-load";
export { countedDaysOfLeave, type PersonDayFacts } from "./counted-days";
export { groupMembershipOn, type GroupMemberFacts } from "./group-membership";
export { loadLeaveLimitFacts, type StoredLeaveRow } from "./load-facts";
export {
  evaluateLeaveLimits,
  type LeaveLimitCandidate,
  type LeaveLimitExceedance,
  type LeaveLimitRuleSnapshot,
} from "./check";
export { toLeaveLimitWarnings, type LeaveLimitWarning } from "./response";
