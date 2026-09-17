/**
 * Phase 100b Plan 01 (AC-1/AC-2, D-06) — Abwesenheiten's public surface.
 *
 * What is exported here is this context's public surface — ADR 0001 rule 3 (no direct table
 * access across foreign schemas; access only through the owning context's public interface) is
 * why this file exists at all. Anything NOT exported here is
 * module-internal and may change at any time without notice — a caller outside this context that
 * needs a new question answered gets a new named export, never a reach-around import of an
 * internal module.
 *
 * The implementation lives in `./facade/` (added wave by wave from plan 100B-10 onward) — that is
 * where a new facade function goes, not here. This file is a PURE re-export surface and contains
 * no Prisma call: it deliberately sits outside `SCOPED_DIRS`
 * (`apps/api/scripts/lint-tenant-scoping-types.ts`), and only `./facade/**` is walked by plan
 * 100B-04's tenant-gate extension. A query placed directly in this file would be invisible to
 * that gate — do not "helpfully" move one here.
 *
 * ── Wave 5 progress (D-01: a context is either fully converted or not touched) — CLOSED ─────────
 * Converted: `LeaveType` (plan 10, A17-A19), `LeaveEntitlement` (plan 10, A11-A16 plus the two H1
 * deviation-preserving siblings), `EmployeeVocationalSchoolPattern` (plan 11, A20/A21a/A21b),
 * `Section9Credit` (plan 11, A22 plus its two DSGVO compliance functions), `Absence` (plan 12,
 * A4/A5/A6 plus three compliance functions — D-09's A4/A5 split is the single highest-consequence
 * grouping decision in the phase; see `./facade/absences.ts`'s own module header) and, closing the
 * wave and the phase's whole conversion effort, `LeaveRequest` (plan 13, A1-A3/A7-A10/A9 plus the
 * shift-protection read and three compliance functions — A1/A2/A3's three-status-set split is the
 * SECOND highest-consequence grouping decision in the phase; see `./facade/leave-requests.ts`'s
 * own module header). Grouped one file per model under `./facade/`.
 *
 * With this plan, `measure:context-access --check 0` exits 0 and `--rows` prints nothing — every
 * cross-context Prisma access measured in this phase now goes through a facade.
 *
 * D-02: a facade function expresses the QUESTION a caller asks, not the caller's `where`. Two
 * callers with the same question share one function; a caller with a special case does not get a
 * function with a passed-through `where`.
 *
 * D-07: every facade function's first parameter is `db: Prisma.TransactionClient`, never
 * `app: FastifyInstance` — `hasApprovedLeaveOnDate` below already has this shape
 * (`leave-check.ts:18`, parameter named `prisma`) and is called both with `app.prisma`
 * (`contexts/time-tracking/api/time-entries.ts`) and with a `tx`
 * (`services/clock/resolver.ts`); it is the pattern every later facade function in this
 * context copies. `apps/api/scripts/lint-facade-signatures.ts` (plan 03) enforces this
 * mechanically.
 *
 * D-08: the soft-delete guard is NOT applied uniformly across this surface. Reading functions
 * carry `deletedAt: null` (as `hasApprovedLeaveOnDate` already does). The named compliance
 * functions this context exposes (DSGVO Art. 17 anonymisation support, hard-delete support,
 * retention archival support) deliberately OMIT it and say so in their own docblock — a blanket
 * guard here would be an Art. 17 regression, not an improvement: a deleted employee's leave rows
 * must still be reachable for the anonymisation pass to null out their notes.
 *
 * Plan 100B-14 (AC-4, D-05): `hasApprovedLeaveOnDate` returns a stable `LeaveTypeCode`, never a
 * display string — see `leave-check.ts`'s own header. Both of its two callers
 * (`time-entries.ts`, `services/clock/resolver.ts`) were rewired in the same plan to import it
 * from this index rather than the concrete file, so AC-1's "the index IS the public surface" is
 * true for this function too — no second import path to the same function survives in the tree.
 */
export { hasApprovedLeaveOnDate } from "./leave-check";

// ── LeaveRequest (plan 13, A1-A3/A7-A10/A9 + shift-protection + 3 compliance — closing model) ──
export {
  getApprovedLeaveOverlapping,
  getActiveLeaveOverlapping,
  getCalendarLeaveOverlapping,
  getOwnPendingLeaveRequests,
  getStalePendingLeaveRequestsForReminder,
  getPendingLeaveDaysInYear,
  countPendingApprovals,
  getLeaveStartingInWindow,
  getOwnLeaveActivity,
  getReviewedLeaveActivity,
  getTeamLeaveSubmissions,
  getPendingLeaveForShiftProtection,
  anonymizeLeaveRequestsForEmployee,
  hardDeleteLeaveRequestsForEmployee,
  archiveLeaveRequestsBefore,
} from "./facade/leave-requests";
export type {
  ApprovedLeaveOverlap,
  ActiveLeaveOverlap,
  CalendarLeaveOverlap,
  StalePendingLeaveRequestForReminder,
  PendingLeaveDaysInYear,
  UpcomingApprovedLeave,
  OwnLeaveActivityItem,
  ReviewedLeaveActivityItem,
  TeamLeaveSubmissionItem,
  PendingLeaveForShiftProtection,
} from "./facade/leave-requests";

// ── LeaveType (plan 10, A17-A19) ─────────────────────────────────────────────────────────────
export {
  getLeaveTypeByCode,
  getLeaveTypeByDisplayName,
  listLeaveTypes,
  updateLeaveType,
} from "./facade/leave-types";
export type { UpdateLeaveTypeInput } from "./facade/leave-types";

// ── LeaveEntitlement (plan 10, A11-A16 + H1 siblings) ────────────────────────────────────────
export {
  getVacationEntitlement,
  listEntitlementsForYear,
  getEntitlementsForEmployee,
  getEntitlementById,
  getExpiringCarryOver,
  upsertVacationEntitlement,
  getVacationEntitlementByDisplayName,
  getVacationEntitlementsForYearByDisplayName,
  hardDeleteEntitlementsForEmployee,
} from "./facade/entitlements";
export type { UpsertVacationEntitlementData } from "./facade/entitlements";

// ── EmployeeVocationalSchoolPattern (plan 11, A20/A21a/A21b) ─────────────────────────────────
export {
  getActiveBsPattern,
  listActiveBsPatternsForWeek,
  listActiveBsPatternsWithFederalStateOverride,
} from "./facade/vocational-school-patterns";
export type { ActiveBsPatternSlots, WeekBsPattern } from "./facade/vocational-school-patterns";

// ── Section9Credit (plan 11, A22 + 2 DSGVO compliance functions) ────────────────────────────
export {
  getConfirmedSection9Credits,
  getSection9DocumentPaths,
  anonymizeSection9CreditsForEmployee,
} from "./facade/section9-credits";
export type { ConfirmedSection9Credit } from "./facade/section9-credits";

// ── Absence (plan 12, A4/A5/A6 + 3 compliance functions — D-09's A4/A5 split, see the file) ──
export {
  getAbsencesOverlapping,
  getRosterSollAbsencesOverlapping,
  getVocationalSchoolDays,
  hasVocationalSchoolDay,
  getAbsenceDocumentPaths,
  anonymizeAbsencesForEmployee,
  hardDeleteAbsencesForEmployee,
  archiveAbsencesBefore,
} from "./facade/absences";
export type { OverlappingAbsence, RosterSollAbsence, VocationalSchoolDay } from "./facade/absences";

// ── JArbSchG §9 Berufsschule bound values (issue #246, E-6) ──────────────────────────────────
// Declared public: a constant carries no query semantics, no soft-delete guard, no tenant scope
// — the number itself IS the invariant, so a value re-export needs no facade function around it.
export {
  BS_DAILY_MIN_BOUND,
  BS_DAILY_MAX_BOUND,
  BS_BLOCK_WEEKLY_MIN_BOUND,
  BS_BLOCK_WEEKLY_MAX_BOUND,
  BS_DAILY_DEFAULT_MIN, // Phase 101B (Issue #101, wave 7) — added alongside the bound constants
} from "./vocational-school-constants";

// ── Phase 101B (Issue #101, wave 7) — the remaining absence-context deep imports ─────────────
// widened onto this surface so no production file outside `contexts/absence` reaches into a
// leaf module directly any more, except the two permanent register sites (E-4, E-8; see
// `apps/api/scripts/context-boundary-import-exceptions.json`).
export { loadBsSlotOverrides } from "./load-bs-slot-overrides";
export { DISPLAY_NAME, isSickLeaveTypeCode } from "./leave-type";
export { mondayOfWeekUtc } from "./vacation-calc";
export { recalcProvisionalLeaveForShiftChange } from "./shift-leave-recalc-resolver";
export type { RecalcDeps, AdjustmentRecord } from "./shift-leave-recalc-resolver";
// resolveLeaveDays/getHolidayMap/deductVacationDays/reverseVacationDays are DEFINED in
// ./leave-days (the leaf plan 04 lifted them into) — sourced from there, never from
// ./api/leave, so this index never has to publish a route module's whole import set.
export {
  resolveLeaveDays,
  getHolidayMap,
  deductVacationDays,
  reverseVacationDays,
} from "./leave-days";
export { checkJArbSchG } from "./jarbschg";
export { buildSlotOverrideHierarchy, resolveBsTagSlot } from "./bs-slot-resolver";
export type { WeekContext } from "./bs-slot-resolver";
export { selfHealUsedDays, loadVacationTypeMeta } from "./leave-self-heal";
export { karenzOverrunFromRequests } from "./find-karenz-overrun-days";
// Closes the one production dynamic import() no-restricted-imports cannot see
// (composition/reports.ts previously did `await import("./plugins/carryover-warning")`).
// carryoverWarningPlugin from the same module is already registered from app.ts at boot,
// so the module is loaded eagerly in every running process regardless — nothing here needed
// the lazy form, so it becomes a plain static import like everything else on this surface.
export { runCarryoverWarningOnce } from "./plugins/carryover-warning";

// Two more symbols from ./leave-type and ./vacation-calc are deliberately NOT re-exported here:
// their only foreign callers are the two permanent register sites (E-8: platform's test
// bootstrap helper, E-4: platform's employee-creation route). Widening this surface to cover
// them would silently dissolve those register entries — see
// apps/api/scripts/context-boundary-import-exceptions.json for E-4/E-8's own reasons.
