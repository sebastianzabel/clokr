/**
 * Phase 100B Plan 13 (Wave 5, LAST conversion plan — workload reaches zero) — Abwesenheiten's
 * `LeaveRequest` facade.
 *
 * ADR 0001 rule 3: every caller outside this context reaches `LeaveRequest` through one of the
 * functions below, never through `prisma.leaveRequest`/`app.prisma.leaveRequest`/`tx.leaveRequest`
 * directly. `LeaveRequest` is added to `convertedModels` in
 * `apps/api/scripts/foreign-context-access-exceptions.json` in the same commit — a future direct
 * access is a hard error, not a slip to re-discover.
 *
 * D-07: every export's first parameter is `db: Prisma.TransactionClient`.
 *
 * `contexts/absence/leave-check.ts`'s `hasApprovedLeaveOnDate` is DELIBERATELY untouched by this
 * plan — it already has the D-07 shape, it is this context's OWN code (not a foreign access), and
 * the plan's own call-site table (100B-13-PLAN.md) assigns its eventual promotion into this facade
 * to plan 14, not here. Two import paths to the same question in the tree for no benefit is
 * exactly what this plan avoids (same reasoning `contexts/absence/index.ts`'s own header states).
 *
 * ── A1/A2/A3 — the three leave-status sets carry LEGAL meaning, and are three functions ─────────
 * {@link getApprovedLeaveOverlapping} (A1), {@link getActiveLeaveOverlapping} (A2) and
 * {@link getCalendarLeaveOverlapping} (A3) all take a date range and return overlapping
 * `LeaveRequest` rows — and answer three DIFFERENT questions, forced into view by
 * `composition/dashboard.ts`, where the SAME shape of query appears three times with three
 * different `status` filters, each correct for its own widget:
 *
 *   - A1 `status: "APPROVED"` — THE SOLL-REDUCTION SET. A day only stops counting toward an
 *     employee's expected working time once leave is APPROVED (ArbZG/BUrlG: only an approved
 *     absence reduces Soll). Feeds every close/cron/status Soll calculation in the tree.
 *   - A2 `status in [APPROVED, CANCELLATION_REQUESTED]` — TODAY'S PRESENCE / ROSTER-SOLL SET. Per
 *     CLAUDE.md § Leave Cancellation Flow step 2: "Leave remains active ... until cancellation is
 *     approved" — a leave under `CANCELLATION_REQUESTED` still blocks clock-in and still reduces
 *     the week's roster Soll. Dropping this status here would silently let an employee whose
 *     cancellation is merely REQUESTED (not yet approved) clock in and count as present, reversing
 *     § 8 BUrlG.
 *   - A3 `status in [APPROVED, CANCELLATION_REQUESTED, PENDING]` — CALENDAR/DISPLAY SET, Phase 95
 *     SHIFT-01. Adds `PENDING` on top of A2 so an unapproved request still renders as "beantragt"
 *     instead of a blank cell. This set is NEVER a Soll input — leaking A3 into a Soll query would
 *     let a merely-requested (not yet approved) day reduce Soll, which no rule permits.
 *
 * A single function taking a `status` argument would hand this decision straight back to every
 * caller — exactly D-02's argument #2 ("the function expresses the QUESTION a caller asks, not the
 * caller's `where`"; a caller with a special case does not get a passed-through filter). Three
 * names, three meanings, kept apart by the exact-set membership test in
 * `__tests__/facade-leave-requests.test.ts`, seen RED three times (once per function, by widening
 * or narrowing its own status set by one value) before being committed green — see this plan's
 * SUMMARY for the three transcripts.
 *
 * ── A1's select union (read all 11 pre-facade call sites' `select`/`include` first) ─────────────
 * Ten of the eleven A1 sites use one of three narrow shapes (a subset of `{id, employeeId,
 * leaveTypeId, startDate, endDate, halfDay}`). The eleventh,
 * `working-time-account/close-month-data.ts`'s `fetchCloseMonthData` (a FULL-ROW read with
 * `include: { leaveType: true }`), is the widest: its own comment says the `leaveType` include
 * exists SPECIFICALLY so `overtime.ts`'s Karenz-overrun detector
 * (`find-karenz-overrun-days.ts`'s `karenzOverrunFromRequests`) can reuse this SAME bulk fetch
 * rather than issue a second `leaveRequest.findMany` (which would double-count against
 * `overtime-perf-n1.test.ts`'s per-model ≤1 assertion — PERF-V1814-01 discipline). Reading that
 * detector's own `KarenzSickRow` type forward shows the ACTUAL fields it dereferences: `id`,
 * `startDate`, `endDate`, `status`, `attestPresent`, `attestValidFrom`, `attestValidTo` and
 * `leaveType.code` — every field on the FULL row it does NOT touch (`note`, `documentPath`... no
 * such fields exist on `LeaveRequest`; concretely: `reviewedBy`, `reviewedAt`, `reviewNote`,
 * `cancellationRequestedBy`, `specialLeaveRuleId`, `days`, `daysProvisional`, `createdAt`,
 * `updatedAt`, `deletedAt`) is untouched, confirming the FULL-ROW shape there is R-C incidental
 * (no `select` was ever written), not an essential wider need — same precedent as A4
 * (`contexts/absence/facade/absences.ts`, plan 12) for the identical situation. The union below
 * (`id, employeeId, leaveTypeId, startDate, endDate, halfDay, status, attestPresent,
 * attestValidFrom, attestValidTo, leaveType: { code }`) is a strict superset of every real caller's
 * actual field use across all 11 sites, confirmed by reading, not assumed.
 *
 * `contexts/scheduling/api/shifts.ts`'s module-private `findShiftConflict` (a single-day
 * `leaveRequest.findFirst({ employeeId, status: "APPROVED", deletedAt: null, startDate: { lte:
 * day }, endDate: { gte: day } }, include: { leaveType: { select: { code } } })`) is A1 too — same
 * status set (APPROVED only, NOT A2's `CANCELLATION_REQUESTED`-inclusive set — read and confirmed,
 * per H2), just `from === to`. Absorbed into A1 taking `[0]`, mirroring plan 12's identical
 * absorption of that same function's sibling `absence.findFirst` call one function below it in the
 * same file. No caller change needed at either of `findShiftConflict`'s two call sites — plan 12
 * already threaded `tenantId` through its signature for the `Absence` half; this plan's half reuses
 * the SAME already-threaded parameter.
 *
 * ── A9 vs A1 — `startDate`-IN-WINDOW is not overlap ──────────────────────────────────────────────
 * {@link getLeaveStartingInWindow} (A9, `attendance-checker.ts`'s "upcoming absence" reminder)
 * filters `startDate: { gte: from, lte: to }` with NO `endDate` filter at all — it answers "which
 * leave STARTS in this window", not "which leave OVERLAPS this window". A leave that started
 * BEFORE the window and merely overlaps it is correctly excluded: folding this into A1 (or A2/A3)
 * would change WHICH reminders fire (an employee already on long-running leave would get a
 * spurious "upcoming absence" email on every day the window happens to still cover their leave).
 *
 * ── A7 — the plan's own proposal (ONE function, "EmployeeScope plus an explicit window") is NOT
 *    what the three real call sites ask, once read ───────────────────────────────────────────────
 * All three pre-facade sites filter `status: "PENDING"` + `deletedAt: null`, but reading each
 * `where`/`select`/consumer shows three genuinely different questions, not one question in three
 * scopes:
 *   - `composition/dashboard.ts`'s own-employee "how many of MY requests are pending" (no date
 *     filter at all, result used only via `.length`) → {@link getOwnPendingLeaveRequests}.
 *   - `attendance-checker.ts`'s tenant-wide manager reminder, filtered on `createdAt: { lt: cutoff
 *     }` (a STALENESS cutoff, computed per-tenant from `TenantConfig.reminderPendingLeaveHours`) —
 *     an entirely different DATE FIELD than the other two sites, with a full `include` for the
 *     notification text → {@link getStalePendingLeaveRequestsForReminder}.
 *   - `composition/reports.ts`'s tenant-wide year aggregate, filtered on `startDate` within a
 *     calendar year, projected down to `{employeeId, leaveTypeId, days}` for a per-type sum, never
 *     an individual row → {@link getPendingLeaveDaysInYear}.
 * A shared "explicit window" parameter cannot represent both "before a `createdAt` cutoff" and
 * "within a `startDate` year range" without becoming exactly the generic `where`-carrying function
 * D-02 forbids. Applying this plan's OWN divergence-handling instruction (written for A9 vs A1, the
 * hazard the plan explicitly named) to a site the plan itself did not flag — same protocol plans 11
 * (A21) and 12 (`findShiftConflict`'s Prisma-call-shape finding) already established for
 * plan-proposed mergers that do not survive reading the real `where` clauses: NOT merged. Three
 * separately-named functions, documented here, in this plan's SUMMARY, and as a decision comment on
 * GitHub issue #100.
 *
 * ── A10 — same finding, same resolution, for the activity feed ──────────────────────────────────
 * `platform/api/activity.ts`'s three `leaveRequest.findMany` calls share no `where` shape at all:
 * "own" filters `{employeeId, deletedAt: null}` ordered by `updatedAt`; "reviewedBy" filters
 * `{reviewedBy: userId, deletedAt: null, status: in[APPROVED,REJECTED], employee:{tenantId}}`
 * ordered by `reviewedAt`; "team" filters `{deletedAt: null, employee:{tenantId}, employeeId: {not:
 * employeeId}}` ordered by `createdAt`. Three different filter fields, three different sort
 * columns, three different `select` shapes consumed three different ways downstream (own status
 * badge text vs. reviewer-name approval text vs. submitter-name inbox text). This is the SAME
 * pattern as A7 above — not "one question, three scopes" but three questions that happen to share a
 * status-adjacent shape. Three separately-named functions: {@link getOwnLeaveActivity},
 * {@link getReviewedLeaveActivity}, {@link getTeamLeaveSubmissions}.
 *
 * ── `getPendingLeaveForShiftProtection` — H5, the last crossing out of `services/` ───────────────
 * `services/phorest/sync-shifts.ts`'s "pending-leave gewinnt" shift-protection read (Phase 95,
 * SHIFT-02) filters `status: { in: ["PENDING", "CANCELLATION_REQUESTED"] }` — READ AND CONFIRMED:
 * this is NEITHER A2 (`[APPROVED, CANCELLATION_REQUESTED]`, APPROVED IS included) NOR A3 (A2 plus
 * `PENDING`, APPROVED IS included) — it is its OWN question, "which NOT-YET-DECIDED leave should
 * protect a Phorest-covered shift from soft-cancel", deliberately EXCLUDING `APPROVED` (an
 * `APPROVED` leave already produces its own shift-removal via a different path; protecting against
 * that here would be the wrong rule for the wrong status). Named
 * {@link getPendingLeaveForShiftProtection} for the question it actually asks, not reused from A2
 * or A3. This is the SECOND and LAST genuine boundary crossing out of `services/` (ADR entry F) —
 * after this plan, `measure:context-access --rows` is empty under `services/` entirely.
 *
 * ── The three DSGVO/hard-delete/retention compliance functions (D-08) — the phase's LAST three ──
 * {@link anonymizeLeaveRequestsForEmployee} and {@link hardDeleteLeaveRequestsForEmployee}
 * deliberately carry NO `deletedAt: null` guard — Art. 17 erasure and a hard delete must both reach
 * soft-deleted rows, or a deleted employee's leave notes survive the "deletion". Each carries a
 * named F3 exception (no `tenantId` parameter) because each one's SOLE caller already
 * tenant-validates `employeeId` upstream, before this function is ever reached — same shape as
 * every other hard-delete/anonymise compliance function in this phase (`hardDeleteAbsencesForEmployee`,
 * plan 12; `hardDeleteEntitlementsForEmployee`, plan 10; `hardDeleteOvertimeDataForEmployee`, plan
 * 06). `anonymizeLeaveRequestsForEmployee`'s `where` keeps the pre-existing `note: { not: null }`
 * optimisation clause verbatim (D-01: no behaviour change) — it is an optimisation, not a
 * correctness filter; omitting it would still anonymise correctly, just touch more rows.
 *
 * {@link archiveLeaveRequestsBefore} is the one exception among the three that DOES carry
 * `deletedAt: null` in its `where` — but, exactly as `archiveAbsencesBefore` (plan 12) and
 * `archiveEntriesBefore` (plan 08, T9) document for their own siblings, that clause is an
 * IDEMPOTENCY guard (a second nightly retention run must not re-archive, and re-log, an
 * already-archived row), NOT a soft-delete read filter of the kind the other two compliance
 * functions above deliberately omit. It also carries a `tenantId` parameter (unlike the other two)
 * because its caller (`data-retention.ts`'s per-tenant loop) already has one in scope, making the
 * added `employee: {tenantId}` a proven no-op defence-in-depth addition, not a new constraint —
 * same shape and precedent as its two siblings.
 *
 * With this file, every one of the phase's 169 measured cross-context accesses goes through a
 * facade. `LeaveRequest` — 28 accesses, the largest single model — is the closing conversion.
 */
import type { LeaveRequestStatus, LeaveTypeCode, Prisma } from "@clokr/db";
import { type EmployeeScope, employeeScopeWhere } from "../../platform";

// ── A1 — the Soll-reduction set: status: "APPROVED" only ─────────────────────────────────────────

export interface ApprovedLeaveOverlap {
  id: string;
  employeeId: string;
  leaveTypeId: string;
  startDate: Date;
  endDate: Date;
  halfDay: boolean;
  status: LeaveRequestStatus;
  attestPresent: boolean;
  attestValidFrom: Date | null;
  attestValidTo: Date | null;
  leaveType: { code: LeaveTypeCode | null };
}

/**
 * A1 — every `APPROVED` `LeaveRequest` overlapping `[from, to]` for the given
 * {@link EmployeeScope}, soft-delete-filtered. THE SOLL-REDUCTION SET (§ 8 BUrlG / ArbZG — only an
 * APPROVED absence reduces expected working time). See this module's own header for why
 * {@link getActiveLeaveOverlapping} (A2) and {@link getCalendarLeaveOverlapping} (A3) are SEPARATE
 * functions, never this one with an extra status value folded in.
 *
 * Sites: `composition/dashboard.ts` (open-items calculation), `contexts/scheduling/api/shifts.ts`
 * (`/shifts/week` calendar/roster reads, `generate-week`, `copy-week`, plus `findShiftConflict`'s
 * single-day conflict check with `from === to`, absorbed — see module header),
 * `contexts/time-tracking/api/time-entries.ts` (Bug-5 open-month recompute — SALDO INPUT),
 * `contexts/working-time-account/{close-month-data,month-saldo,recalculate-snapshots}.ts`,
 * `api/overtime.ts` (2×) and `plugins/auto-close-month.ts` (2×) — the close/cron path, ALL feeding
 * `calcLeaveAbsenceMinutesTz` through `closeEmployeeMonth()` — SALDO INPUT.
 */
export async function getApprovedLeaveOverlapping(
  db: Prisma.TransactionClient,
  scope: EmployeeScope,
  from: Date,
  to: Date,
): Promise<ApprovedLeaveOverlap[]> {
  return db.leaveRequest.findMany({
    where: {
      ...employeeScopeWhere(scope),
      status: "APPROVED",
      deletedAt: null,
      startDate: { lte: to },
      endDate: { gte: from },
    },
    select: {
      id: true,
      employeeId: true,
      leaveTypeId: true,
      startDate: true,
      endDate: true,
      halfDay: true,
      status: true,
      attestPresent: true,
      attestValidFrom: true,
      attestValidTo: true,
      leaveType: { select: { code: true } },
    },
  });
}

// ── A2 — today's presence / roster-Soll set: APPROVED + CANCELLATION_REQUESTED ───────────────────

export interface ActiveLeaveOverlap {
  employeeId: string;
  startDate: Date;
  endDate: Date;
  halfDay: boolean;
  status: LeaveRequestStatus;
  leaveType: { name: string };
}

/**
 * A2 — every `LeaveRequest` with `status in [APPROVED, CANCELLATION_REQUESTED]` overlapping
 * `[from, to]` for the given {@link EmployeeScope}, soft-delete-filtered. Per CLAUDE.md § Leave
 * Cancellation Flow step 2: a leave under `CANCELLATION_REQUESTED` remains ACTIVE — still blocks
 * clock-in, still reduces roster Soll — until the cancellation itself is approved. See this
 * module's own header for why this must never merge with A1 (drops the cancellation-pending case,
 * reversing § 8 BUrlG) or A3 (adds PENDING, which must never reduce Soll).
 *
 * Sites: `composition/dashboard.ts`'s today's-presence bulk fetch,
 * `contexts/scheduling/api/shifts.ts`'s `/shifts/week` Soll-Korrelation row. Guarded by
 * `apps/api/src/__tests__/shift-week-leave-absence-minutes.test.ts`'s case E (plan 02) and
 * `contexts/absence/__tests__/leave-check.test.ts` — run immediately after this function's two
 * call sites are rewired (R4, T-100B-59).
 */
export async function getActiveLeaveOverlapping(
  db: Prisma.TransactionClient,
  scope: EmployeeScope,
  from: Date,
  to: Date,
): Promise<ActiveLeaveOverlap[]> {
  return db.leaveRequest.findMany({
    where: {
      ...employeeScopeWhere(scope),
      status: { in: ["APPROVED", "CANCELLATION_REQUESTED"] },
      deletedAt: null,
      startDate: { lte: to },
      endDate: { gte: from },
    },
    select: {
      employeeId: true,
      startDate: true,
      endDate: true,
      halfDay: true,
      status: true,
      leaveType: { select: { name: true } },
    },
  });
}

// ── A3 — calendar/display set: A2's set + PENDING, NEVER a Soll input ─────────────────────────────

export interface CalendarLeaveOverlap {
  employeeId: string;
  startDate: Date;
  endDate: Date;
  status: LeaveRequestStatus;
  leaveType: { name: string; code: LeaveTypeCode | null };
}

/**
 * A3 — every `LeaveRequest` with `status in [APPROVED, CANCELLATION_REQUESTED, PENDING]`
 * overlapping `[from, to]` for the given {@link EmployeeScope}, soft-delete-filtered. Phase 95
 * SHIFT-01: an open (`PENDING`) request renders as "beantragt" in the calendar instead of a blank
 * cell. DISPLAY ONLY — see this module's own header for why this must NEVER feed a Soll
 * calculation (a merely-requested day has not been approved and must not reduce expected working
 * time).
 *
 * Sites: `composition/dashboard.ts`'s week-calendar overlay (tenant-wide and own-employee
 * variants) — shared by BOTH `/team-week` and `/my-week`. `leaveType.code` is additive (Issue
 * #205, finding 3): `/team-week` uses it for a rename-stable `leaveTypeCode` field alongside the
 * existing display `reason`; `/my-week`'s own response shape is unaffected by this widening.
 */
export async function getCalendarLeaveOverlapping(
  db: Prisma.TransactionClient,
  scope: EmployeeScope,
  from: Date,
  to: Date,
): Promise<CalendarLeaveOverlap[]> {
  return db.leaveRequest.findMany({
    where: {
      ...employeeScopeWhere(scope),
      status: { in: ["APPROVED", "CANCELLATION_REQUESTED", "PENDING"] },
      deletedAt: null,
      startDate: { lte: to },
      endDate: { gte: from },
    },
    select: {
      employeeId: true,
      startDate: true,
      endDate: true,
      status: true,
      leaveType: { select: { name: true, code: true } },
    },
  });
}

// ── A7a/A7b/A7c — three PENDING-status questions, NOT one function (see module header) ───────────

/**
 * A7a — the requesting employee's own `PENDING` `LeaveRequest`s, no date filter. Sole site:
 * `composition/dashboard.ts`'s "own pending leave requests" open-items count (consumed only via
 * `.length`). `tenantId` is defence-in-depth (`employee: { tenantId }`) — `employeeId` here is
 * already the caller's own tenant-validated identifier, same "proven no-op" shape D-10 establishes
 * for every `EmployeeScope`-adjacent function in this phase.
 */
export async function getOwnPendingLeaveRequests(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
): Promise<Array<{ id: string }>> {
  return db.leaveRequest.findMany({
    where: { employeeId, employee: { tenantId }, deletedAt: null, status: "PENDING" },
    select: { id: true },
  });
}

export interface StalePendingLeaveRequestForReminder {
  id: string;
  employeeId: string;
  employee: { firstName: string; lastName: string };
  leaveType: { name: string };
}

/**
 * A7b — every tenant-wide `PENDING` `LeaveRequest` created BEFORE `createdBefore` (a per-tenant
 * staleness cutoff derived from `TenantConfig.reminderPendingLeaveHours`) — the manager reminder
 * feed. Filters on `createdAt`, NOT `startDate`/`endDate` — a genuinely different date dimension
 * than A7c below, which is why these are two functions, not one with a "window" parameter (see
 * module header). Sole site: `contexts/time-tracking/plugins/attendance-checker.ts`'s
 * "Pending leave request reminder" cron feature.
 */
export async function getStalePendingLeaveRequestsForReminder(
  db: Prisma.TransactionClient,
  tenantId: string,
  createdBefore: Date,
): Promise<StalePendingLeaveRequestForReminder[]> {
  return db.leaveRequest.findMany({
    where: {
      deletedAt: null,
      status: "PENDING",
      createdAt: { lt: createdBefore },
      employee: { tenantId },
    },
    select: {
      id: true,
      employeeId: true,
      employee: { select: { firstName: true, lastName: true } },
      leaveType: { select: { name: true } },
    },
  });
}

export interface PendingLeaveDaysInYear {
  employeeId: string;
  leaveTypeId: string;
  days: Prisma.Decimal;
}

/**
 * A7c — tenant-wide `PENDING` `LeaveRequest.days` for the given calendar `year` (filtered on
 * `startDate`, NOT `createdAt` — see A7b above and the module header for why these stay separate),
 * projected down for the per-employee/per-type pending-days sum. Sole site:
 * `composition/reports.ts`'s `GET /leave-overview` bulk fetch.
 */
export async function getPendingLeaveDaysInYear(
  db: Prisma.TransactionClient,
  tenantId: string,
  year: number,
): Promise<PendingLeaveDaysInYear[]> {
  return db.leaveRequest.findMany({
    where: {
      employee: { tenantId },
      status: "PENDING",
      deletedAt: null,
      startDate: {
        gte: new Date(Date.UTC(year, 0, 1)),
        lt: new Date(Date.UTC(year + 1, 0, 1)),
      },
    },
    select: { employeeId: true, leaveTypeId: true, days: true },
  });
}

// ── A8 — count of tenant-wide pending/cancellation-requested approvals, excluding one employee ──

/**
 * A8 — count of tenant-wide `LeaveRequest`s with `status in [PENDING, CANCELLATION_REQUESTED]`,
 * optionally excluding one employee's own requests (so a manager's own pending request doesn't
 * double-count against their team's approval queue). Sole site: `composition/dashboard.ts`'s
 * "team-wide pending approvals" card.
 */
export async function countPendingApprovals(
  db: Prisma.TransactionClient,
  tenantId: string,
  excludeEmployeeId?: string,
): Promise<number> {
  return db.leaveRequest.count({
    where: {
      employee: { tenantId },
      deletedAt: null,
      status: { in: ["PENDING", "CANCELLATION_REQUESTED"] },
      ...(excludeEmployeeId ? { employeeId: { not: excludeEmployeeId } } : {}),
    },
  });
}

// ── A9 — startDate-IN-WINDOW, NOT overlap (see module header for why this differs from A1) ───────

export interface UpcomingApprovedLeave {
  id: string;
  startDate: Date;
  employee: { userId: string; firstName: string };
  leaveType: { name: string };
}

/**
 * A9 — every `APPROVED` `LeaveRequest` whose `startDate` falls IN `[from, to]` (NOT overlapping
 * it — see this module's own header, folding this into A1 would change which reminders fire),
 * tenant-wide. Sole site: `contexts/time-tracking/plugins/attendance-checker.ts`'s "Upcoming
 * absence reminder" cron feature.
 */
export async function getLeaveStartingInWindow(
  db: Prisma.TransactionClient,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<UpcomingApprovedLeave[]> {
  return db.leaveRequest.findMany({
    where: {
      deletedAt: null,
      status: "APPROVED",
      startDate: { gte: from, lte: to },
      employee: { tenantId },
    },
    select: {
      id: true,
      startDate: true,
      employee: { select: { userId: true, firstName: true } },
      leaveType: { select: { name: true } },
    },
  });
}

// ── A10a/A10b/A10c — three activity-feed questions, NOT one (see module header) ──────────────────

export interface OwnLeaveActivityItem {
  id: string;
  status: LeaveRequestStatus;
  updatedAt: Date;
  leaveType: { name: string } | null;
}

/**
 * A10a — the requesting employee's own `LeaveRequest`s, most recently updated first, no status
 * filter (every status renders its own activity-feed text: submitted/approved/rejected/
 * cancelled/cancellation-requested). Sole site: `contexts/platform/api/activity.ts`'s "own leave
 * requests (recent status changes)" feed.
 */
export async function getOwnLeaveActivity(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
  limit: number,
): Promise<OwnLeaveActivityItem[]> {
  return db.leaveRequest.findMany({
    where: { employeeId, employee: { tenantId }, deletedAt: null },
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: {
      id: true,
      status: true,
      updatedAt: true,
      leaveType: { select: { name: true } },
    },
  });
}

export interface ReviewedLeaveActivityItem {
  id: string;
  status: LeaveRequestStatus;
  reviewedAt: Date | null;
  leaveType: { name: string } | null;
  employee: { firstName: string; lastName: string };
}

/**
 * A10b — `LeaveRequest`s this manager (`reviewerId`) has approved or rejected, most recently
 * reviewed first. Tenant-scoped via `employee: { tenantId }` as defence-in-depth (CLAUDE.md §
 * Multi-Tenancy Convention) — `reviewedBy` is already tenant-bound by the regular review flow, but
 * guarding here prevents an impersonation bug elsewhere from leaking cross-tenant review rows
 * through this read. Sole site: `contexts/platform/api/activity.ts`'s "leave approvals/rejections
 * this manager performed" feed.
 */
export async function getReviewedLeaveActivity(
  db: Prisma.TransactionClient,
  reviewerId: string,
  tenantId: string,
  limit: number,
): Promise<ReviewedLeaveActivityItem[]> {
  return db.leaveRequest.findMany({
    where: {
      reviewedBy: reviewerId,
      deletedAt: null,
      status: { in: ["APPROVED", "REJECTED"] },
      employee: { tenantId },
    },
    orderBy: { reviewedAt: "desc" },
    take: limit,
    select: {
      id: true,
      status: true,
      reviewedAt: true,
      leaveType: { select: { name: true } },
      employee: { select: { firstName: true, lastName: true } },
    },
  });
}

export interface TeamLeaveSubmissionItem {
  id: string;
  createdAt: Date;
  leaveType: { name: string } | null;
  employee: { firstName: string; lastName: string };
}

/**
 * A10c — recent tenant-wide `LeaveRequest` submissions (any status), most recently created first,
 * optionally excluding one employee's own submissions (so the manager's team feed doesn't
 * duplicate their own "own leave requests" feed entries). Sole site:
 * `contexts/platform/api/activity.ts`'s "recent team leave submissions" feed.
 */
/**
 * Phase 91b Plan 07 (Issue #91), D-10 — `employeeIds`, when given, narrows to that set INSIDE this
 * SAME `where`, before `take: limit` runs. `undefined` (every caller before this plan) is
 * byte-identical to today. An empty array correctly yields zero rows via Prisma's own
 * `{ in: [] }` builder semantics (confirmed by a dedicated test — this is Prisma's normal query
 * builder, not the raw-SQL `Prisma.join` case Plan 91b-02 had to guard). Filtering the RETURNED
 * rows after `take` would under-fill the page whenever an in-scope row exists beyond the
 * tenant-wide top-`limit` cut — the narrowing MUST happen inside the query.
 */
export async function getTeamLeaveSubmissions(
  db: Prisma.TransactionClient,
  tenantId: string,
  excludeEmployeeId: string | undefined,
  limit: number,
  employeeIds?: string[],
): Promise<TeamLeaveSubmissionItem[]> {
  return db.leaveRequest.findMany({
    where: {
      deletedAt: null,
      employee: { tenantId },
      // Both constraints must combine when both are given: a plain object-literal spread of two
      // `employeeId` keys would let the second silently overwrite the first, re-admitting the
      // caller's OWN submissions (already covered by getOwnLeaveActivity above) into this "team"
      // feed the moment a scope filter is also supplied. Prisma's `AND` array intersects both.
      ...(excludeEmployeeId || employeeIds
        ? {
            AND: [
              ...(excludeEmployeeId ? [{ employeeId: { not: excludeEmployeeId } }] : []),
              ...(employeeIds ? [{ employeeId: { in: employeeIds } }] : []),
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      createdAt: true,
      leaveType: { select: { name: true } },
      employee: { select: { firstName: true, lastName: true } },
    },
  });
}

// ── Shift-protection read (H5) — the last genuine boundary crossing out of `services/` ───────────

export interface PendingLeaveForShiftProtection {
  employeeId: string;
  startDate: Date;
  endDate: Date;
}

/**
 * `getPendingLeaveForShiftProtection` — every `LeaveRequest` with `status in [PENDING,
 * CANCELLATION_REQUESTED]` (deliberately EXCLUDING `APPROVED` — see this module's own header)
 * overlapping `[from, to]` for the given {@link EmployeeScope}. Phase 95 SHIFT-02: protects a
 * Phorest-covered shift from the PHOREST_REMOVED soft-cancel on any day the employee has an
 * active, not-yet-decided leave request. Sole site: `services/phorest/sync-shifts.ts` — the
 * SECOND and LAST genuine boundary crossing out of `services/` (ADR entry F); after this plan
 * `measure:context-access --rows` is empty under `services/`.
 */
export async function getPendingLeaveForShiftProtection(
  db: Prisma.TransactionClient,
  scope: EmployeeScope,
  from: Date,
  to: Date,
): Promise<PendingLeaveForShiftProtection[]> {
  return db.leaveRequest.findMany({
    where: {
      ...employeeScopeWhere(scope),
      deletedAt: null,
      status: { in: ["PENDING", "CANCELLATION_REQUESTED"] },
      startDate: { lte: to },
      endDate: { gte: from },
    },
    select: { employeeId: true, startDate: true, endDate: true },
  });
}

// ── Compliance slices (D-08) — deliberately NOT soft-delete-guarded, two ways + one idempotent ───

/**
 * F3 exception (D-08, no `tenantId` parameter): DSGVO Art. 17 anonymisation — nulls `note` for
 * every `LeaveRequest` row belonging to `employeeId`, regardless of `deletedAt` (a soft-deleted
 * row's PII must be scrubbed too, same as every other field `platform/anonymize.ts`'s
 * `anonymizeEmployeeData()` clears). The `note: { not: null }` clause is the PRE-EXISTING
 * optimisation (fewer rows touched, same result) preserved verbatim (D-01) — not a correctness
 * filter. Runs inside the CALLER's own `$transaction` (`db` is a `tx`, D-07) — `anonymize.ts`'s
 * handler validates `id` against `req.user.tenantId` before this transaction is ever opened.
 */
export async function anonymizeLeaveRequestsForEmployee(
  db: Prisma.TransactionClient,
  employeeId: string,
): Promise<void> {
  await db.leaveRequest.updateMany({
    where: { employeeId, note: { not: null } },
    data: { note: null },
  });
}

/**
 * F3 exception (D-08, no `tenantId` parameter): HARD delete of every `LeaveRequest` row for
 * `employeeId`, invoked ONLY from `platform/api/employees.ts`'s `DELETE /:id/hard-delete`
 * sequence inside its own `$transaction`, whose handler already validates `id` against
 * `req.user.tenantId` before this function is ever reached. No `deletedAt` guard — a hard delete
 * must reach soft-deleted rows too. `onDelete: Restrict` on `LeaveRequest.employee` makes the
 * CALLER's ordering the invariant (H5 in plan 12's sense) — this function is called IN PLACE in
 * that sequence, unchanged.
 */
export async function hardDeleteLeaveRequestsForEmployee(
  db: Prisma.TransactionClient,
  employeeId: string,
): Promise<void> {
  await db.leaveRequest.deleteMany({ where: { employeeId } });
}

/**
 * Retention archival (§ 16 Abs. 2 ArbZG / CLAUDE.md § Data Retention): soft-deletes every
 * `LeaveRequest` for the given `employeeIds` whose `endDate` is at or before `cutoff`. The
 * `deletedAt: null` clause in the `where` below is an IDEMPOTENCY guard — it keeps a second run of
 * the nightly retention job from re-touching (and re-logging) rows a previous run already archived
 * — NOT a soft-delete-read filter of the kind the other two compliance functions above deliberately
 * omit (see this module's own header). Same shape and precedent as `archiveAbsencesBefore`
 * (plan 12) and `archiveEntriesBefore` (plan 08, T9): `tenantId` is present (unlike the other two
 * compliance functions here) because the sole caller (`data-retention.ts`'s per-tenant loop)
 * already has one in scope, making `employee: {tenantId}` a proven no-op defence-in-depth
 * addition, not a new constraint.
 */
export async function archiveLeaveRequestsBefore(
  db: Prisma.TransactionClient,
  employeeIds: string[],
  tenantId: string,
  cutoff: Date,
): Promise<number> {
  if (employeeIds.length === 0) return 0;
  const result = await db.leaveRequest.updateMany({
    where: {
      employeeId: { in: employeeIds },
      employee: { tenantId },
      deletedAt: null, // idempotency guard — see module header, NOT a soft-delete read filter
      endDate: { lte: cutoff },
    },
    data: { deletedAt: new Date() },
  });
  return result.count;
}
