import { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { LeaveRequestStatus, Prisma } from "@clokr/db";
import { requireAuth } from "../../../middleware/auth";
import { generateICal, addOneDay, type ICalEvent } from "../ical";
import {
  mondayOfWeekUtc, // Phase 430 Plan 04 (D-15) — the one shared Monday derivation
} from "../vacation-calc"; // Phase 107 (D-04/D-09)
import { scheduledLeaveMinutes, overtimeCompReversalMinutes } from "../overtime-comp-minutes"; // Issue #614 — moved out of this route (Issue #468 D-01/D-02)
import { selfHealUsedDays, loadVacationTypeMeta } from "../leave-self-heal";
import { closedMonthLeaveMessage } from "../correction-lock"; // Issue #446 (D-07/D-08)
import { findClosedMonthsInRange } from "../closed-month-guard"; // Issue #446 (D-07)
import { EFFECTIVE_LEAVE_STATUSES, isEffectiveLeaveStatus } from "../effective-leave-statuses"; // Issue #446 (D-04)
// Phase 101B (Issue #101, D-11 Welle absence): lifted out of this file into ./leave-days.ts.
// resolveLeaveDays/getHolidayMap/deductVacationDays/reverseVacationDays are re-exported below
// (unchanged) so scheduling/api/shifts.ts, services/phorest/sync-shifts.ts and
// __tests__/shift-leave-recalc.test.ts (none touched by this plan) keep resolving these names
// from this same path until a later wave converts them to import from absence/index.ts.
// resolveWorkDays/recalculateCarryOver were never exported before the move (still not
// re-exported here) — this file's own remaining handlers still call them directly.
import {
  resolveLeaveDays,
  getHolidayMap,
  deductVacationDays,
  reverseVacationDays,
  type LeaveDaysPricing, // Issue #436, D-04/D-09
} from "../leave-days";
import { BS_ONLY_LEAVE_ERROR, BS_ONLY_LEAVE_ERROR_CODE } from "../bs-leave-days"; // Issue #448 (D-02)
import { vocationalSchoolDatesForLeaveRequests } from "../bs-leave-days"; // Issue #448 (D-05, plan 03)
import { ensureLeaveType } from "../ensure-leave-type"; // Issue #614 — moved out of this route
import {
  createLeaveRequestCore,
  autoCarryOver,
  overtimeCompBalanceRejection,
} from "../leave-request-create"; // Issue #835 (D-835-12) — the create core, lifted out of POST /requests
import {
  prepareLeaveCorrection,
  applyLeaveCorrection,
  finishLeaveCorrection,
  Section9ConcurrentCorrectionError,
} from "../leave-correction"; // Issue #614 — the /correct domain body
import {
  getShiftsInRange, // Phase 430 Plan 04 (D-15) — rosterImported on GET /hours-preview
} from "../../scheduling";
import {
  getOvertimeAccount,
  reverseOvertimeCompensation,
  getTenantTimezone,
  monthDateRange, // Issue #493 (D-10)
  recalculateSnapshots,
  getConfirmedCarryOver,
  loadNegativeBalanceTolerance,
  computeOvertimeBalanceBreakdown,
  computeOvertimeBalanceHours, // Issue #294 — pure read, run BEFORE the booking+persist transaction
  persistOvertimeBalance, // Issue #294 — booking + recompute in one $transaction
  todayInTz, // Phase 91b Plan 04 (#91), D-10 — Stichtag for the general leave-requests list
  type OvertimeBalanceBreakdown,
} from "../../working-time-account"; // Phase 100B Plan 06 — W8/W11/W12; Plan 07 — W1; Phase 101B
import {
  auditReasonSchema,
  requirePermission,
  hasPermission,
  permissionReach,
  userIdsHoldingPermission, // Phase 75b Plan 10 (#75), D-16: notification-recipient lookups
  accessContextFromRequest, // Phase 91b Plan 04 (#91), D-10/D-14
  resolveAccessReach, // Phase 91b Plan 04 (#91), D-10/D-14
  resolveStammsalonScopedEmployeeIds, // Phase 91b Plan 04 (#91), D-10
  isStammsalonScopeMatch, // Phase 91b Plan 04 (#91), D-10/D-14
  resolveScopedHolderIds, // Phase 91b Plan 09 (#91), D-17
  employeeScopeFor, // Phase 430 Plan 04 (D-15) — rosterImported's getShiftsInRange scope
  resolveSalonInReach, // Issue #558 (D-01) — the one validator of a chosen salon
  homeSalonsForDays, // Issue #840 (D-840-19) — Stammsalon per day, one call per calendar request
  findSalon, // Issue #840 (D-840-25) — the salon in view of the range form
} from "../../platform"; // Quick 260824-cjd
import { filterLeaveRowsToHomeSalon } from "../salon-leave-attribution"; // Issue #558 (D-02/D-08)
import { canSeeLeaveType } from "../leave-calendar-visibility"; // Issue #835 — moved out of this route (second caller)
import { maskCalendarRows } from "../leave-calendar-masking"; // Issue #840 (D-840-19) — per-person masking of the calendar read
import { isPersonVisibleOnSomeDay } from "../leave-limits/redact"; // Issue #840 (D-840-19) — the #836 per-person rule, no second one
import {
  buildLeaveLimitExceptionAudit,
  correctionCandidateRanges,
  evaluateLeaveLimits,
  leaveLimitExceptionRequiredBody,
  limitExceptionSchema,
  readerVisibilityFrom,
  toLeaveLimitWarnings,
} from "../leave-limits"; // Issue #836 (D-836-03/D-836-08/D-836-09/D-836-12)
import {
  loadLeaveRequestForReview,
  leaveDecisionGuard,
  decidePendingLeaveRequest,
  formatDateDe,
} from "../leave-decision"; // Issue #835 (D-835-12) — the decision core, lifted out of PATCH /requests/:id/review
import { supersedeSection9CreditsOfCancelledRequest } from "../section9-supersede";
import { intersectRanges } from "../section9-detect"; // Phase 104-05/06, Issue #468 (D-04/A-3)
import {
  findBlockingLeaveOverlap,
  leaveDaysUsedInYear,
  LEAVE_OVERLAP_ERROR,
} from "../leave-overlap"; // Phase 97 (T2) — code-based, replacing the removed section9-detect.ts name helper
import { activeParentalReductions } from "../parental-leave-reduction"; // Issue #468 plan 07 (D-10) — revoke-before-change guards
import { karenzOverrunFromRequests, normalizeKarenzDays } from "../find-karenz-overrun-days"; // Phase 104 gap closure (D-21)
import { sickLeaveDayCounts } from "../sick-leave-days"; // Issue #595 (D-04) — the one sick-day counter
import {
  ensureRegularVacationEntitlement,
  REGULAR_ENTITLEMENT_REASON_SELF_HEAL,
  vacationEntitlementWarning, // Issue #445 — one function builds the warning string (no business rule in composition/reports.ts)
  healEntitlementUsedDays, // Issue #445 (D-10) — injected into leave-self-heal.ts's ctx below
  effectiveCarryOverDays, // Issue #445 (D-13) — the FIFO expiry check (replaces the removed local helper)
  syncExitYearVacationEntitlement, // Issue #447 (D-06/D-07) — exit-year row sync, GET-time heal
  exitVacationOverUseWarning, // Issue #447 (D-08) — the one over-use warning string (approval + GET)
} from "../leave-days"; // Issue #445 — own statement: PR #437 edits the block above
import { vacationBalanceForRow, type VacationBalance } from "../facade/vacation-balance"; // Issue #451 (D-07) — the ONE Resturlaub function, additive on the VACATION row of GET /entitlements
import { revalidateLeaveCancellationEntries } from "../../time-tracking"; // Phase 100B Plan 08 — T6
import { REQUESTABLE_CODES as TYPE_CODES, DISPLAY_NAME, withHalfDayMarker } from "../leave-type"; // Phase 97 (T2, D-04) — the one mapping; DISPLAY_NAME added Phase 98b (D-04)

// Forwarded for the same backward-compatibility reason as the import above.
export { resolveLeaveDays, getHolidayMap, deductVacationDays, reverseVacationDays };

// Phase 104-10 — § 9 display-surface helpers (calendar/list/entitlement markers, D-28/D-29/D-31).

/** Inclusive list of ISO YYYY-MM-DD day strings between two Date-only values (UTC). */
function daysBetweenInclusiveIso(start: Date, end: Date): string[] {
  const days: string[] = [];
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (cur.getTime() <= last.getTime()) {
    days.push(cur.toISOString().split("T")[0]);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

/** Renders a Date as German "DD.MM." — used only in the § 9 entitlement movement label (D-31). */
function formatDayMonth(d: Date | null | undefined): string {
  if (!d) return "";
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.`;
}

/**
 * A Prisma client that may be either the top-level app.prisma or an interactive
 * transaction client (Prisma.TransactionClient). Entitlement/overtime helpers accept
 * this union so the leave-correction handler can run them inside a single
 * $transaction (Phase 94 CR-01: atomic reverse-OLD → apply-NEW booking).
 */
// ── Feste Abwesenheitstypen ──────────────────────────────────────────────────
// Phase 97 (T2, D-04): the nine codes, their German display names and the legacy seed aliases
// now live in ONE place, `utils/leave-type.ts`. `TYPE_CODES` is a transitional import alias so
// that move touched no call site. `LEAVE_TYPE_LEGACY_ALIASES` (formerly imported here as
// `LEGACY_ALIASES`) was removed with issue #206 once `ensureLeaveType()`'s legacy-name self-heal
// step — its only caller in this file — was removed; the name-to-code mapping still lives in
// `leave-type.ts` for its other caller.

/**
 * Issue #449 (D-1): a half-day leave request may only ever cover a single calendar date.
 * The entitlement booking deducts a flat 0.5 days for a half day (`vacation-calc.ts`) while
 * the saldo halves the SALDO MINUTES OF THE WHOLE REQUESTED RANGE
 * (`working-time-account/timezone.ts`) — a half day across e.g. Mon-Fri books 0.5 days of
 * entitlement but halves five days' worth of Soll, so entitlement, saldo, reports and DATEV
 * permanently disagree (Befund G5). This is deliberately an INPUT-side fix only — calculation
 * code is untouched (D-2); an existing multi-day half-day request stays approvable, and any
 * correction of it runs later through "Antrag korrigieren" after owner approval.
 *
 * One shared predicate + message, chained via `.refine()` onto all three write schemas
 * (createSchema, updateSchema, correctSchema) right after their existing start<=end check —
 * never copied per schema.
 */
const HALF_DAY_SINGLE_DATE_MESSAGE = "Ein halber Tag ist nur für ein einzelnes Datum möglich.";

function halfDayIsSingleDate(data: { halfDay?: boolean; startDate: string; endDate: string }) {
  return !data.halfDay || data.startDate === data.endDate;
}

const createSchema = z
  .object({
    type: z.enum(TYPE_CODES),
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((s) => !isNaN(new Date(s).getTime()), "Ungültiges Datum"),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((s) => !isNaN(new Date(s).getTime()), "Ungültiges Datum"),
    halfDay: z.boolean().default(false),
    note: z.string().optional().nullable(),
    specialLeaveRuleId: z.string().uuid().optional().nullable(),
    // Manager-on-behalf-of: when set, the caller (must be MANAGER or ADMIN) creates
    // the request for this employee instead of themselves. Tenant isolation is enforced.
    employeeId: z.string().uuid().optional(),
  })
  .refine((data) => new Date(data.startDate) <= new Date(data.endDate), {
    message: "Enddatum muss nach Startdatum liegen",
    path: ["endDate"],
  })
  .refine(halfDayIsSingleDate, { message: HALF_DAY_SINGLE_DATE_MESSAGE, path: ["endDate"] });

const reviewSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
  reviewNote: z.string().optional().nullable(),
  limitException: limitExceptionSchema.optional(), // Issue #836 (D-836-09): approver's exception over a salon limit
});

const updateSchema = z
  .object({
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((s) => !isNaN(new Date(s).getTime()), "Ungültiges Datum"),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((s) => !isNaN(new Date(s).getTime()), "Ungültiges Datum"),
    halfDay: z.boolean().default(false),
    note: z.string().optional().nullable(),
  })
  .refine((data) => new Date(data.startDate) <= new Date(data.endDate), {
    message: "Enddatum muss nach Startdatum liegen",
    path: ["endDate"],
  })
  .refine(halfDayIsSingleDate, { message: HALF_DAY_SINGLE_DATE_MESSAGE, path: ["endDate"] });

// Phase 94-01: Manager/Admin DIRECT-correction of an already-APPROVED request.
// Mirrors updateSchema but adds an optional `type` switch (type-specific recalc
// split lands in 94-02 — stored uniformly here).
const correctSchema = z
  .object({
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((s) => !isNaN(new Date(s).getTime()), "Ungültiges Datum"),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((s) => !isNaN(new Date(s).getTime()), "Ungültiges Datum"),
    halfDay: z.boolean().default(false),
    note: z.string().optional().nullable(),
    type: z.enum(TYPE_CODES).optional(),
    reason: auditReasonSchema, // Quick 260824-cjd — mandatory Korrektur-Begründung
    limitException: limitExceptionSchema.optional(), // Issue #836 (D-836-19): exception when a correction adds days over a limit
  })
  .refine((data) => new Date(data.startDate) <= new Date(data.endDate), {
    message: "Enddatum muss nach Startdatum liegen",
    path: ["endDate"],
  })
  .refine(halfDayIsSingleDate, { message: HALF_DAY_SINGLE_DATE_MESSAGE, path: ["endDate"] });

// Quick 260824-cjd — mandatory Storno-Begründung for withdraw/cancellation-request.
const stornoSchema = z.object({ reason: auditReasonSchema });

const attestSchema = z.object({
  attestPresent: z.boolean(),
  attestValidFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((s) => !isNaN(new Date(s).getTime()), "Ungültiges Datum")
    .nullable()
    .optional(),
  attestValidTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((s) => !isNaN(new Date(s).getTime()), "Ungültiges Datum")
    .nullable()
    .optional(),
});

/**
 * Pflichtbegründung für jeden § 9-Schritt (D-11) — bleibt bewusst NICHT optional und NICHT
 * nullable, die Begründung ist revisionssicherheitspflichtig.
 *
 * Phase 104 follow-up (owner-reported, not in REVIEW.md): `min(1)` alone only covers the
 * EMPTY-string case. Clokr frontends send `x ? x : null` (CLAUDE.md's Zod gotcha), and an
 * explicit null produced Zod's ENGLISH default invalid_type text
 * ("reason: Invalid input: expected string, received null") in the 400 body, while an empty
 * string produced the German message — the same mistake reported two different ways. The
 * type-level `error` makes null, a missing key and an empty/whitespace string all answer with
 * the identical German sentence.
 */
const SECTION9_MANDATORY_REASON = z
  .string({ error: "Begründung ist erforderlich" })
  .trim()
  .min(1, "Begründung ist erforderlich");

// Phase 104-06 — POST /section9/:id/confirm ("AU liegt vor").
// D-27: Gültigkeit + Herkunft + Pflichtbegründung. KEINE Arzt-/Diagnoseangaben (Art. 9 DSGVO).
const section9ConfirmSchema = z.object({
  attestSource: z.enum(["EAU", "PAPIER"]),
  attestValidFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  attestValidTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: SECTION9_MANDATORY_REASON,
});

// Phase 104-06 — POST /section9/:id/reject and /reopen. Pflichtbegründung (D-11).
// Bewusst NICHT .optional() und NICHT .nullable() — die Begründung bleibt Pflicht.
const section9ReasonSchema = z.object({
  reason: SECTION9_MANDATORY_REASON,
});

// Phase 104 review (WR-04) — GET /section9?status=
// The value was cast straight into the Prisma where clause (`status as never`). Any value
// outside the enum made Prisma throw a PrismaClientValidationError, which the global handler
// turns into a 500 echoing the full Prisma text (model name, field list, expected enum
// members) back to the caller. Every other route in this file validates its query with Zod.
// Issue #468 (D-04/A-3): a manager can list overholt Vorgänge for audit traceability
// (GET /section9?status=<value>), same as every other status value below.
const section9StatusQuerySchema = z.object({
  status: z.enum(["AU_PENDING", "CONFIRMED", "REJECTED", "SUPERSEDED"]).optional(),
  salonId: z.string().uuid().optional(), // Issue #558 (D-01) — validated by resolveSalonInReach
});

// Issue #595 (D-04) — GET /sick-days?year=: a bounded calendar year, one query per call.
const sickDaysQuerySchema = z.object({ year: z.coerce.number().int().min(2000).max(2100) });

// Issue #558 (D-01): the optional salon choice of the leave reads the team pages use. It narrows a
// list, it is never an access boundary — every handler validates it with `resolveSalonInReach`
// against its own ZUGEWIESEN reach before any row read.
const leaveSalonQuerySchema = z.object({ salonId: z.string().uuid().optional() });

// Issue #840 (D-840-18/25): the calendar read alone also takes a day range. `from`/`to` are calendar
// days, both or neither, `from <= to`, at most 366 days inclusive (one year plus a leap day); any
// violation is a ZodError, i.e. a 400 through the global handler. `leaveSalonQuerySchema` stays
// untouched because the other leave reads share it.
const CALENDAR_RANGE_MAX_DAYS = 366;
const calendarDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => new Date(`${v}T00:00:00.000Z`).toISOString().slice(0, 10) === v, {
    message: "Ungültiges Datum",
  });
const leaveCalendarQuerySchema = z
  .object({
    salonId: z.string().uuid().optional(),
    from: calendarDaySchema.optional(),
    to: calendarDaySchema.optional(),
  })
  .superRefine((q, ctx) => {
    if ((q.from === undefined) !== (q.to === undefined)) {
      ctx.addIssue({ code: "custom", message: "from und to nur gemeinsam", path: ["from"] });
      return;
    }
    if (q.from === undefined || q.to === undefined) return;
    if (q.from > q.to) {
      ctx.addIssue({ code: "custom", message: "from darf nicht nach to liegen", path: ["from"] });
      return;
    }
    const days =
      (Date.parse(`${q.to}T00:00:00.000Z`) - Date.parse(`${q.from}T00:00:00.000Z`)) / 86_400_000 +
      1;
    if (days > CALENDAR_RANGE_MAX_DAYS) {
      ctx.addIssue({
        code: "custom",
        message: `Zeitraum höchstens ${CALENDAR_RANGE_MAX_DAYS} Tage`,
        path: ["to"],
      });
    }
  });

// Issue #558 (T-100-09): one body for every rejection cause — a foreign tenant's salon, an unknown
// id, an inactive salon, a salon outside the reach and a caller without the ZUGEWIESEN reach are
// indistinguishable (byte-identical with the dashboard's and the people list's body).
const SALON_NOT_FOUND = { error: "Salon nicht gefunden" } as const;

/**
 * Resolves the target employeeId for a read that defaults to the caller's own employeeId when
 * `requestedEmployeeId` is omitted, and otherwise authorizes reading a DIFFERENT employee within
 * the caller's `leave-entitlement:read:ZUGEWIESEN` reach. Phase 415 (#415): the unified
 * leave-request dialog needs GET /hours-preview and GET /overtime-balance — both previously
 * hardcoded to `req.user.employeeId` — to answer for a manager's SELECTED employee too. Mirrors
 * GET /entitlements/:employeeId's authorization shape (Phase 91b Plan 04, D-10/D-14): same reach
 * check, same tenant isolation, same T-100-09-conformant 404 for a foreign-tenant OR unknown id
 * (byte-identical status + body, so a caller cannot distinguish the two) — copied rather than
 * reinvented.
 *
 * The omitted/self path is a plain passthrough with NO permission check at all — byte-identical
 * to the code it replaces, so no existing self-only caller can regress.
 */
async function resolveScopedEmployeeIdForRead(
  app: FastifyInstance,
  req: FastifyRequest,
  requestedEmployeeId: string | undefined,
): Promise<
  { ok: true; employeeId: string } | { ok: false; status: 403 | 404; body: { error: string } }
> {
  const selfEmployeeId = req.user.employeeId;
  if (!requestedEmployeeId || requestedEmployeeId === selfEmployeeId) {
    return { ok: true, employeeId: selfEmployeeId ?? "" };
  }

  const employeeId = requestedEmployeeId;
  const tenantId = req.user.tenantId;

  const employee = await app.prisma.employee.findUnique({
    where: { id: employeeId },
    select: { tenantId: true },
  });
  if (!employee || employee.tenantId !== tenantId) {
    if (employee) {
      // Same tenant-isolation check as /entitlements/:employeeId — only audited when a row
      // genuinely exists in a foreign tenant, never for a wholly unknown id.
      await app.audit({
        userId: req.user.sub,
        action: "CROSS_TENANT_ACCESS_DENIED",
        entity: "Employee",
        entityId: employeeId,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });
    }
    return { ok: false, status: 404, body: { error: "Mitarbeiter nicht gefunden" } };
  }

  const reach = await permissionReach(req, "leave-entitlement:read");
  if (reach !== "ZUGEWIESEN") {
    return { ok: false, status: 403, body: { error: "Forbidden" } };
  }

  const access = accessContextFromRequest(req);
  const scopeReach = await resolveAccessReach(
    app.prisma,
    access,
    "leave-entitlement:read:ZUGEWIESEN",
  );
  const stichtag = req.testNow ?? new Date();
  if (!(await isStammsalonScopeMatch(app.prisma, tenantId, scopeReach, employeeId, stichtag))) {
    await app.audit({
      userId: req.user.sub,
      action: "SCOPE_ACCESS_DENIED",
      entity: "LeaveEntitlement",
      entityId: employeeId,
      request: { ip: req.ip, headers: req.headers as Record<string, string> },
    });
    return { ok: false, status: 404, body: { error: "Mitarbeiter nicht gefunden" } };
  }

  return { ok: true, employeeId };
}

/**
 * Issue #85 (Phase 85b Plan 16, owner decision 2026-08-27): may this caller learn the TOTAL saldo
 * of `employeeId`? Yes for the person themself, and for a caller whose `overtime:read` reach
 * covers the person (whole tenant, or the Stammsalon rule of `GET /overtime/:employeeId`). A
 * Salonmanager holds `leave-entitlement:read:ZUGEWIESEN` (which lets the leave dialog address a
 * selected employee) but no `overtime:read`, so the saldo-derived numbers of
 * `GET /overtime-balance` are masked for them. The server-side OVERTIME_COMP limit check never
 * asks this question: it reads the balance itself and is unaffected.
 */
async function callerMaySeeSaldoOf(
  app: FastifyInstance,
  req: FastifyRequest,
  employeeId: string,
): Promise<boolean> {
  if (employeeId === req.user.employeeId) return true;
  const overtimeReach = await permissionReach(req, "overtime:read");
  if (overtimeReach !== "ZUGEWIESEN") return false;
  const scopeReach = await resolveAccessReach(
    app.prisma,
    accessContextFromRequest(req),
    "overtime:read:ZUGEWIESEN",
  );
  const stichtag = req.testNow ?? new Date();
  return isStammsalonScopeMatch(app.prisma, req.user.tenantId, scopeReach, employeeId, stichtag);
}

/**
 * Issue #836 (AC-12, D-836-12): the reach within which the caller may be told the NAMES of the other
 * persons behind a limit exceedance (`leave-request:read:ZUGEWIESEN`; the rest is a count). Resolved
 * only when there is an exceedance, so a request under every limit (or a tenant without rules)
 * costs no extra query.
 */
function limitReaderReach(app: FastifyInstance, req: FastifyRequest) {
  return resolveAccessReach(
    app.prisma,
    accessContextFromRequest(req),
    "leave-request:read:ZUGEWIESEN",
  );
}

export async function leaveRoutes(app: FastifyInstance) {
  // ── POST /requests  – Antrag stellen ────────────────────────────────────
  app.post("/requests", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const body = createSchema.parse(req.body);

      // Manager-on-behalf-of: caller must be MANAGER or ADMIN, target employee must
      // belong to the caller's tenant. Otherwise fall back to self-create.
      let employeeId: string | null | undefined;
      let isOnBehalfOf = false;
      if (body.employeeId && body.employeeId !== req.user.employeeId) {
        if (!(await hasPermission(req, "leave-request:create:ZUGEWIESEN"))) {
          return reply.code(403).send({ error: "Nur Manager dürfen Anträge für andere stellen" });
        }
        const target = await app.prisma.employee.findFirst({
          where: { id: body.employeeId, tenantId: req.user.tenantId },
          select: { id: true },
        });
        if (!target) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
        employeeId = body.employeeId;
        isOnBehalfOf = true;
      } else {
        // Issue #359: the self-create path never checked leave-request:create:EIGENE at all — a
        // caller with neither reach fell straight through to creating their own request.
        if (!(await hasPermission(req, "leave-request:create:EIGENE"))) {
          return reply.code(403).send({ error: "Forbidden" });
        }
        employeeId = req.user.employeeId;
      }
      if (!employeeId) return reply.code(400).send({ error: "Kein Mitarbeiter-Profil" });

      const start = new Date(body.startDate);
      const end = new Date(body.endDate);
      if (start > end)
        return reply.code(400).send({ error: "Startdatum muss vor Enddatum liegen" });

      const tenantId = req.user.tenantId;

      // Issue #835 (D-835-12): the create logic lives once, in `createLeaveRequestCore`; the route
      // above authorised the caller and the target, the core validates, prices and stores.
      const outcome = await createLeaveRequestCore(app, {
        tenantId,
        employeeId,
        actorUserId: req.user.sub,
        body,
        isOnBehalfOf,
      });
      if (!outcome.ok) return reply.code(outcome.statusCode).send(outcome.body);
      const request = outcome.request;

      // Issue #836 (D-836-08, D-836-19): a non-blocking salon-limit warning. The request already
      // exists, so a failing check is logged and the key simply stays absent (fail-open).
      let leaveLimitWarnings: ReturnType<typeof toLeaveLimitWarnings> = [];
      try {
        const limitResult = await evaluateLeaveLimits(app.prisma, tenantId, {
          candidates: [
            {
              requestId: request.id,
              employeeId,
              typeCode: body.type,
              startDay: body.startDate,
              endDay: body.endDate,
            },
          ],
          excludeRequestIds: [request.id],
        });
        leaveLimitWarnings = toLeaveLimitWarnings(
          limitResult.exceedances,
          limitResult.exceedances.length > 0
            ? {
                visibility: readerVisibilityFrom(
                  await limitReaderReach(app, req),
                  req.user.employeeId ?? null,
                ),
                personNames: limitResult.personNames,
              }
            : undefined,
        );
      } catch (err) {
        app.log.warn({ err, requestId: request.id }, "leave limit check failed on request create");
      }

      return reply.code(201).send({
        ...request,
        typeCode: body.type,
        startDate: request.startDate.toISOString().split("T")[0],
        endDate: request.endDate.toISOString().split("T")[0],
        ...(leaveLimitWarnings.length > 0 && { leaveLimitWarnings }),
      });
    },
  });

  // ── GET /requests  – Anträge abrufen ────────────────────────────────────
  app.get("/requests", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const user = req.user;
      // Issue #368: a caller holding NEITHER `leave-request:read:ZUGEWIESEN` NOR
      // `leave-request:read:EIGENE` used to fall into the own-requests branch below and get 200
      // with (empty) own data — same error form P-02 (Phase 76b, #76) already closed for
      // `GET /time-entries`. Reused here verbatim.
      const readReach = await permissionReach(req, "leave-request:read");
      if (readReach === null) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      const isManager = readReach === "ZUGEWIESEN";
      const { status, employeeId, year, upcoming } = req.query as {
        status?: string;
        employeeId?: string;
        year?: string;
        upcoming?: string;
      };
      // Issue #409: an EIGENE-only caller naming a foreign `?employeeId=` used to get the own
      // (usually empty) list with 200, because the own-requests branch below ignores the param.
      // `leave-request:read:EIGENE` excludes foreign requests, so this is a 403 — same form as
      // #368 finding 4 for `GET /time-entries`. Own id or no id stays unchanged.
      if (!isManager && employeeId && employeeId !== user.employeeId) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      const { salonId } = leaveSalonQuerySchema.parse(req.query);

      // Für Manager: PENDING-Filter schließt CANCELLATION_REQUESTED immer ein
      const statusFilter: Prisma.LeaveRequestWhereInput["status"] = status
        ? isManager && status === "PENDING"
          ? { in: ["PENDING", "CANCELLATION_REQUESTED"] }
          : (status as LeaveRequestStatus)
        : undefined;

      // Phase 91b Plan 04 (Issue #91), D-10 — narrow a ZUGEWIESEN manager to Stammsalon-scoped
      // employees. This is a general list with no single natural period (unlike a period-bound
      // read, D-10's own Stichtag case), so the Stichtag is: tenant-local TODAY for the
      // unfiltered/status-filtered/`upcoming` shapes, or January 1st of `year` (tenant-local) when
      // a `year` param is given — the plan's own explicit decision, not left to guesswork. Skipped
      // entirely for the EMPLOYEE (EIGENE) branch: no new query for the common case.
      let scopedEmployeeIds: "all" | string[] = "all";
      let chosenSalonId: string | null = null;
      if (isManager || salonId !== undefined) {
        const access = accessContextFromRequest(req);
        const reach = await resolveAccessReach(app.prisma, access, "leave-request:read:ZUGEWIESEN");
        if (salonId !== undefined) {
          // Issue #558 (D-01, P-10): validated before any read. A caller without the ZUGEWIESEN
          // reach has a scoped-empty reach, which rejects every salon with the same 404 body.
          const salon = await resolveSalonInReach(app.prisma, user.tenantId, reach, salonId);
          if (!salon.ok) return reply.code(404).send(SALON_NOT_FOUND);
          chosenSalonId = salon.salonId;
        }
        if (isManager && reach.kind !== "wholeTenant") {
          const stichtag = year
            ? new Date(`${year}-01-01T00:00:00Z`)
            : todayInTz(await getTenantTimezone(app.prisma, user.tenantId));
          scopedEmployeeIds = await resolveStammsalonScopedEmployeeIds(
            app.prisma,
            user.tenantId,
            reach,
            stichtag,
          );
        }
      }

      let rows = await app.prisma.leaveRequest.findMany({
        where: {
          deletedAt: null,
          ...(isManager
            ? {
                employee: { tenantId: user.tenantId },
                // Both constraints must combine when a manager supplies an explicit `employeeId`
                // param WHILE being scope-restricted: an out-of-scope named employeeId must yield
                // nothing, not bypass the scope filter. A plain object-literal spread of two
                // `employeeId` keys would let the second silently overwrite the first, so this
                // uses Prisma's own `AND` array to intersect both conditions on the same field.
                ...(employeeId || scopedEmployeeIds !== "all"
                  ? {
                      AND: [
                        ...(employeeId ? [{ employeeId }] : []),
                        ...(scopedEmployeeIds !== "all"
                          ? [{ employeeId: { in: scopedEmployeeIds } }]
                          : []),
                      ],
                    }
                  : {}),
              }
            : { employeeId: user.employeeId ?? "" }),
          ...(statusFilter !== undefined ? { status: statusFilter } : {}),
          ...(upcoming === "true"
            ? {
                endDate: { gte: new Date() },
              }
            : year
              ? {
                  startDate: { gte: new Date(`${year}-01-01`), lte: new Date(`${year}-12-31`) },
                }
              : {}),
        },
        include: {
          leaveType: true,
          employee: { select: { firstName: true, lastName: true, employeeNumber: true } },
        },
        orderBy: upcoming === "true" ? { startDate: "asc" } : { createdAt: "desc" },
      });

      // Issue #558 (D-08/D-09): under a salon choice a row is kept by its OWN range — the
      // Stammsalon per day, a Springer's leave only under the home salon. The pending-approval
      // queue is filtered too; the inbox's own reads stay unfiltered (a work queue never hides a
      // due approval). Runs before the bulk reads below so they only see the kept rows.
      if (chosenSalonId !== null) {
        rows = await filterLeaveRowsToHomeSalon(app.prisma, user.tenantId, rows, chosenSalonId);
      }

      // Phase 104-10 (D-29): bulk-load § 9 status for the returned requests — ONE query,
      // matching on BOTH FKs so a vacation row can also show that a § 9 case touches it.
      const requestIds = rows.map((r) => r.id);
      const section9Credits = requestIds.length
        ? await app.prisma.section9Credit.findMany({
            where: {
              OR: [
                { sickRequestId: { in: requestIds } },
                { vacationRequestId: { in: requestIds } },
              ],
              // Issue #468 (D-04/A-3): a SUPERSEDED credit has no effect and must not surface
              // as a marker on either side of the pair — skipped entirely, not merely ranked
              // lowest, so a request whose ONLY credit is superseded shows `section9Status: null`.
              status: { not: "SUPERSEDED" },
            },
            select: { id: true, sickRequestId: true, vacationRequestId: true, status: true },
          })
        : [];
      const rankSection9Status = (s: string) =>
        s === "CONFIRMED" ? 2 : s === "AU_PENDING" ? 1 : 0;
      const section9StatusByRequestId = new Map<string, { status: string; creditId: string }>();
      for (const c of section9Credits) {
        for (const reqId of [c.sickRequestId, c.vacationRequestId]) {
          const existing = section9StatusByRequestId.get(reqId);
          if (!existing || rankSection9Status(c.status) > rankSection9Status(existing.status)) {
            section9StatusByRequestId.set(reqId, { status: c.status, creditId: c.id });
          }
        }
      }

      // Phase 107-07 (D-19/D-20/D-21, read side): the persistent "Angepasst" marker on a
      // request row. Sourced from the LEAVE_DAYS_ADJUSTED audit trail the shift-leave-recalc
      // resolver writes (apps/api/src/utils/shift-leave-recalc-resolver.ts) — deliberately NOT
      // a new persisted column, so there is exactly one trail (see 107-07-PLAN.md's own
      // <design_decision>). ONE bulk query for the whole response, mirroring the
      // section9Credits query above, reduced below to the latest row per entityId (orderBy
      // desc + first-hit-wins); skipped entirely for an empty list so it costs zero extra
      // queries. `daysProvisional` itself needs no extra query — it is already a plain scalar
      // column on LeaveRequest and this handler's `include` (no `select`) already returns it.
      const daysAdjustments = requestIds.length
        ? await app.prisma.auditLog.findMany({
            where: {
              entity: "LeaveRequest",
              entityId: { in: requestIds },
              action: "LEAVE_DAYS_ADJUSTED",
            },
            orderBy: { createdAt: "desc" },
            select: { entityId: true, oldValue: true, newValue: true, createdAt: true },
          })
        : [];
      const lastDaysAdjustmentByRequestId = new Map<
        string,
        { oldDays: number; newDays: number; direction: "up" | "down"; at: string }
      >();
      for (const row of daysAdjustments) {
        if (!row.entityId || lastDaysAdjustmentByRequestId.has(row.entityId)) continue; // desc order — first hit per id is already the latest
        // Only oldValue.days/newValue.days are ever projected onto the response — never the
        // whole audit JSON, never userId/ipAddress/userAgent (T-107-30).
        const oldValue = row.oldValue as { days?: number } | null;
        const newValue = row.newValue as { days?: number } | null;
        const oldDays = Number(oldValue?.days ?? 0);
        const newDays = Number(newValue?.days ?? 0);
        lastDaysAdjustmentByRequestId.set(row.entityId, {
          oldDays,
          newDays,
          direction: newDays > oldDays ? "up" : "down",
          at: row.createdAt.toISOString(),
        });
      }

      // Issue #448 (D-05, plan 03, T-448-12): ONE batch read for the whole response, scoped via
      // employeeScopeFor(accessContextFromRequest(req), …) over exactly the employees already
      // returned by the query above — never a hand-built scope literal, never a foreign
      // employee's BS rows.
      const vocationalSchoolDatesByRequestId = requestIds.length
        ? await vocationalSchoolDatesForLeaveRequests(
            app.prisma,
            employeeScopeFor(accessContextFromRequest(req), {
              employeeIds: [...new Set(rows.map((r) => r.employeeId))],
            }),
            rows.map((r) => ({
              id: r.id,
              employeeId: r.employeeId,
              startDate: r.startDate,
              endDate: r.endDate,
              leaveTypeCode: r.leaveType.code,
            })),
          )
        : new Map<string, string[]>();

      return rows.map((r) => ({
        ...r,
        typeCode: r.leaveType.code,
        startDate: r.startDate.toISOString().split("T")[0],
        endDate: r.endDate.toISOString().split("T")[0],
        attestValidFrom: r.attestValidFrom?.toISOString().split("T")[0] ?? null,
        attestValidTo: r.attestValidTo?.toISOString().split("T")[0] ?? null,
        section9Status: section9StatusByRequestId.get(r.id)?.status ?? null,
        section9CreditId: section9StatusByRequestId.get(r.id)?.creditId ?? null,
        // Phase 107-07 (D-19): the request's own persistent adjustment marker — the latest
        // roster-triggered recompute only, `null` when the request was never adjusted.
        lastDaysAdjustment: lastDaysAdjustmentByRequestId.get(r.id) ?? null,
        // Issue #448 (D-05): the BS dates inside this request that displace leave — [] for every
        // non-VACATION type and for a VACATION request with no BS day.
        vocationalSchoolDates: vocationalSchoolDatesByRequestId.get(r.id) ?? [],
      }));
    },
  });

  // ── GET /overlap  – wer ist parallel abwesend? ──────────────────────────
  app.get("/overlap", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
      if (!startDate || !endDate) {
        return reply.code(400).send({ error: "startDate und endDate erforderlich" });
      }

      const start = new Date(startDate);
      const end = new Date(endDate);

      const rows = await app.prisma.leaveRequest.findMany({
        where: {
          deletedAt: null,
          employee: { tenantId: req.user.tenantId },
          employeeId: { not: req.user.employeeId ?? "" },
          // Phase 262 (D-05): APPROVED only — a colleague's not-yet-approved request no longer
          // reaches a caller who cannot approve it. All three consumers filtered to APPROVED
          // client-side already, so the unfiltered PENDING rows had no legitimate reader.
          status: { in: ["APPROVED"] },
          startDate: { lte: end },
          endDate: { gte: start },
        },
        include: {
          leaveType: true,
          employee: { select: { firstName: true, lastName: true } },
        },
        orderBy: { startDate: "asc" },
      });

      // Phase 262 (D-01/D-02/D-06): the same visibility decision /calendar uses, asked once per
      // request rather than per row. `isOwn` is hard-coded `false` here — the `where` above
      // already excludes the caller's own entries (`employeeId: { not: ... }`), so the isOwn
      // branch is structurally dead on this endpoint; forcing it to `false` keeps the masking
      // fail-safe (if that exclusion were ever removed, this would over-mask, never under-mask).
      const canSeeType = canSeeLeaveType(
        false,
        await hasPermission(req, "leave-request:read:ZUGEWIESEN"),
      );

      return rows.map((r) => ({
        id: r.id,
        employeeName: `${r.employee.firstName} ${r.employee.lastName}`,
        typeCode: canSeeType ? r.leaveType.code : null,
        typeName: canSeeType ? r.leaveType.name : null,
        startDate: r.startDate.toISOString().split("T")[0],
        endDate: r.endDate.toISOString().split("T")[0],
        status: r.status,
      }));
    },
  });

  // ── PATCH /requests/:id/review  – Genehmigen / Ablehnen ─────────────────
  app.patch("/requests/:id/review", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("leave-request:approve:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = reviewSchema.parse(req.body);

      const existing = await loadLeaveRequestForReview(app, id);
      if (!existing) return reply.code(404).send({ error: "Antrag nicht gefunden" });
      // Tenant isolation check (SEC-V1814-03 / D-02): fetch-then-compare via employee.tenantId
      if (existing.employee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "LeaveRequest",
          entityId: id,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "Antrag nicht gefunden" });
      }
      // Phase 91b Plan 04 (Issue #91), D-10/D-14 — scope check: a ZUGEWIESEN-scoped manager may
      // only decide a request for an employee whose Stammsalon AT THE REQUEST'S OWN startDate is
      // in scope. No entry-salon fallback (D-09) — LeaveRequest has no salonId.
      {
        const access = accessContextFromRequest(req);
        const scopeReach = await resolveAccessReach(
          app.prisma,
          access,
          "leave-request:approve:ZUGEWIESEN",
        );
        if (
          !(await isStammsalonScopeMatch(
            app.prisma,
            req.user.tenantId,
            scopeReach,
            existing.employeeId,
            existing.startDate,
          ))
        ) {
          await app.audit({
            userId: req.user.sub,
            action: "SCOPE_ACCESS_DENIED",
            entity: "LeaveRequest",
            entityId: id,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
          return reply.code(404).send({ error: "Antrag nicht gefunden" });
        }
      }
      // Issue #835 (D-835-12): status decidable, self-approval and the cancellation four-eyes
      // blocks live in `leaveDecisionGuard` (leave-decision.ts), run here in the original order.
      const decisionRefusal = await leaveDecisionGuard(app, {
        existing,
        reviewerUserId: req.user.sub,
      });
      if (decisionRefusal) return reply.code(decisionRefusal.statusCode).send(decisionRefusal.body);

      // ── Stornierungsantrag prüfen ────────────────────────────────────────────
      if (existing.status === "CANCELLATION_REQUESTED") {
        // Issue #294: the OVERTIME_COMP reversal below is computed here but NOT written here —
        // it is issued at the tail, in the SAME $transaction as the balance persist, so a failed
        // persist rolls the reversal back with it instead of leaving an orphan receipt.
        // Issue #468 (A-4/D-02): `minutes`/`source` added — a stored booking is reversed by
        // exactly that value ("stored"); a legacy row with no stored value falls back to
        // today's recomputation ("recomputed").
        let pendingOvertimeReversal: {
          tenantId: string;
          hours: number;
          minutes: number;
          source: "stored" | "recomputed";
          description: string;
        } | null = null;
        if (body.status === "APPROVED") {
          // Issue #446 (D-06(c)/D-10): checked before the write below — a cancellation of a
          // leave touching a closed month may not be approved (dead end otherwise: the
          // CANCELLED state would silently diverge from the snapshot). The rejection branch
          // (else, below) stays unguarded — it is saldo-neutral.
          const closedMonths = await findClosedMonthsInRange(
            app.prisma,
            existing.employeeId,
            existing.employee.tenantId,
            existing.startDate,
            existing.endDate,
          );
          if (closedMonths.length > 0) {
            return reply.code(409).send({
              error: closedMonthLeaveMessage(closedMonths, "change"),
              code: "LEAVE_MONTH_CLOSED",
            });
          }

          // Issue #468 plan 07 (D-10): a declared Elternzeit-Kürzung is changed only by its own
          // correction entry (revocation), never implicitly by cancelling the Elternzeit it
          // anchors on — approving the cancellation here would otherwise leave an ACTIVE
          // reduction referencing a now-CANCELLED request.
          if (existing.leaveType.code === "PARENTAL") {
            const activeReductions = await activeParentalReductions(
              app.prisma,
              existing.id,
              existing.employee.tenantId,
            );
            if (activeReductions.length > 0) {
              return reply.code(409).send({
                error:
                  "Für diese Elternzeit ist eine Kürzung erklärt — bitte die Kürzung zuerst widerrufen.",
              });
            }
          }

          // Stornierung genehmigen → CANCELLED + Rückbuchung. Issue #662: status change, the
          // vacation booking-back and the supersession of the request's § 9 credits are ONE
          // transaction - a failed supersession rolls the cancellation back instead of leaving
          // the days credited twice (cancellation + a standing credit).
          const cancelHolidayMap = await getHolidayMap(
            app.prisma,
            existing.employee.tenantId,
            existing.employeeId,
            existing.startDate,
            existing.endDate,
          );
          const cancelHolidays = new Set(cancelHolidayMap.keys());
          try {
            await app.prisma.$transaction(async (tx) => {
              await tx.leaveRequest.update({
                where: { id, employee: { tenantId: req.user.tenantId } }, // Issue #835: scoped inline, the row was loaded by the decision core
                data: {
                  status: "CANCELLED",
                  reviewedBy: req.user.sub,
                  reviewedAt: new Date(),
                  reviewNote: body.reviewNote,
                },
              });
              if (existing.leaveType.code === "VACATION") {
                // Issue #445 (D-11): reverseVacationDays() splits per year chronologically
                // (D-08/D-09) and recomputes the next year's carry-over - the symmetric
                // counterpart of the deduct at booking time.
                await reverseVacationDays(
                  tx,
                  existing.employeeId,
                  existing.leaveTypeId,
                  existing.startDate,
                  existing.endDate,
                  Number(existing.days),
                  cancelHolidays,
                  existing.employee.tenantId,
                );
              }
              await supersedeSection9CreditsOfCancelledRequest(tx, {
                requestId: existing.id,
                employeeId: existing.employeeId,
                tenantId: existing.employee.tenantId,
                holidays: cancelHolidays,
                audit: async (entry) => {
                  await app.audit({
                    tx,
                    userId: req.user.sub,
                    action: entry.action,
                    entity: entry.entity,
                    entityId: entry.entityId,
                    oldValue: entry.oldValue,
                    newValue: entry.newValue,
                    request: { ip: req.ip, headers: req.headers as Record<string, string> },
                  });
                },
              });
            });
          } catch (err) {
            if (err instanceof Section9ConcurrentCorrectionError) {
              return reply.code(409).send({
                error: "Gleichzeitige Änderung der § 9-Gutschrift — bitte erneut versuchen.",
              });
            }
            throw err;
          }

          // Revalidate time entries that were created during CANCELLATION_REQUESTED
          // Phase 100B Plan 08 — T6, contexts/time-tracking facade (H2 guard unchanged).
          const revalidatedEntries = await revalidateLeaveCancellationEntries(
            app.prisma,
            existing.employeeId,
            existing.employee.tenantId,
            existing.startDate,
            existing.endDate,
          );
          // Issue #370, D-04: one TimeEntry UPDATE audit per revalidated row — no `tx`, matching
          // the sibling LeaveRequest CANCEL/REJECT audit below, which also runs on app.prisma.
          for (const row of revalidatedEntries) {
            await app.audit({
              userId: req.user.sub,
              action: "UPDATE",
              entity: "TimeEntry",
              entityId: row.id,
              oldValue: row.oldValue,
              newValue: row.newValue,
              request: { ip: req.ip, headers: req.headers as Record<string, string> },
            });
          }

          const typeCode = existing.leaveType.code;
          if (typeCode === "OVERTIME_COMP") {
            const empT = await app.prisma.employee.findUnique({
              where: { id: existing.employeeId },
              select: { tenantId: true },
            });
            const tenantIdForReversal = empT?.tenantId ?? "";
            // Issue #468 (A-4/D-02): reverse the STORED booking, never a recomputation — a
            // schedule edited after approval (or the D-01 formula fix itself changing the
            // amount for a still-pending-cancellation request) must not change what gets
            // reversed. Only a legacy row with no stored value falls back to today's
            // recomputation, logged so the fallback stays visible.
            const { minutes: reversalMinutes, source: reversalSource } =
              await overtimeCompReversalMinutes(
                app.prisma,
                tenantIdForReversal,
                existing,
                async () => {
                  const hMap = await getHolidayMap(
                    app.prisma,
                    tenantIdForReversal,
                    existing.employeeId,
                    existing.startDate,
                    existing.endDate,
                  );
                  return {
                    holidays: new Set(hMap.keys()),
                    tz: await getTenantTimezone(app.prisma, tenantIdForReversal),
                  };
                },
              );
            if (reversalSource === "recomputed") {
              app.log.warn(
                { leaveRequestId: existing.id, employeeId: existing.employeeId },
                "OVERTIME_COMP reversal without a stored booking — recomputed (Issue #468 A-4 legacy fallback)",
              );
            }
            pendingOvertimeReversal = {
              tenantId: tenantIdForReversal,
              hours: reversalMinutes / 60,
              minutes: reversalMinutes,
              source: reversalSource,
              description: `Stornierung Überstundenausgleich ${existing.startDate.toISOString().split("T")[0]}`,
            };
          }
        } else {
          // Stornierung ablehnen → zurück auf APPROVED
          // WR-02: do NOT overwrite reviewedBy here — it must keep pointing to the
          // original leave approver so the 4-eyes check (line 608) still blocks that
          // person from approving a subsequent cancellation request.  The rejection
          // reviewer is captured in the AuditLog REJECT entry below.
          await app.prisma.leaveRequest.update({
            where: { id, employee: { tenantId: req.user.tenantId } }, // Issue #835: scoped inline, the row was loaded by the decision core
            data: {
              status: "APPROVED",
              // reviewedBy intentionally NOT updated — preserves original approver identity
              reviewedAt: new Date(),
              reviewNote: body.reviewNote,
            },
          });
        }

        await app.audit({
          userId: req.user.sub,
          action: body.status === "APPROVED" ? "CANCEL" : "REJECT",
          entity: "LeaveRequest",
          entityId: id,
          newValue: { cancellationDecision: body.status, reviewNote: body.reviewNote },
        });

        // Issue #446 (D-05): rejecting a cancellation recalculates rewritable snapshots exactly
        // like the cancellation-approval path below. Saldo-neutral after D-02 (the leave
        // counted while CANCELLATION_REQUESTED and counts again as APPROVED), but heals
        // snapshots written under the old APPROVED-only rule. Locked months are skipped by
        // recalculateSnapshots itself (Phase 99, D-09); like every other caller, the
        // recalculation starts with the snapshot of the month containing startDate (Issue #459).
        if (body.status !== "APPROVED") {
          await recalculateSnapshots(app, existing.employeeId, existing.startDate).catch((err) =>
            app.log.error(
              { err, employeeId: existing.employeeId },
              "Failed to recalculate snapshots after leave cancellation rejection",
            ),
          );
        }

        // Retroactive recalculation: cancellation approved (CANCELLED) affects snapshots
        if (body.status === "APPROVED") {
          await recalculateSnapshots(app, existing.employeeId, existing.startDate).catch((err) =>
            app.log.error(
              { err, employeeId: existing.employeeId },
              "Failed to recalculate snapshots after leave cancellation",
            ),
          );

          // Issue #294: the pure read happens BEFORE the transaction; booking (if any) then
          // persist happen inside ONE `$transaction` — no swallower any more, so a failed
          // persist now answers non-2xx instead of a silent 200 with a stale balance.
          const effectiveBalanceHours = await computeOvertimeBalanceHours(app, existing.employeeId);
          await app.prisma.$transaction(async (tx) => {
            if (pendingOvertimeReversal) {
              await reverseOvertimeCompensation(
                tx,
                existing.employeeId,
                pendingOvertimeReversal.tenantId,
                pendingOvertimeReversal.hours,
                pendingOvertimeReversal.description,
              );
              // Issue #468 (A-4/D-02): audits the reversal next to the journal row, in the SAME
              // transaction — `source` names whether the stored booking or a legacy
              // recomputation was reversed. The stored column itself is never cleared (history).
              await app.audit({
                tx,
                userId: req.user.sub,
                action: "OVERTIME_COMP_REVERSED",
                entity: "LeaveRequest",
                entityId: existing.id,
                newValue: {
                  overtimeCompMinutes: pendingOvertimeReversal.minutes,
                  hours: pendingOvertimeReversal.minutes / 60,
                  source: pendingOvertimeReversal.source,
                },
                request: { ip: req.ip, headers: req.headers as Record<string, string> },
              });
            }
            // null = §18-exempt: persist nothing, the reversal above (if any) still stands as
            // the sole writer for that path.
            if (effectiveBalanceHours !== null) {
              await persistOvertimeBalance(app, tx, existing.employeeId, effectiveBalanceHours);
            }
          });
        }

        // Auto-dismiss manager LEAVE_REQUEST notifications for this request
        try {
          await app.dismissByRelated("LeaveRequest", existing.id);
        } catch (err) {
          app.log.warn(
            { err, leaveRequestId: existing.id },
            "Failed to auto-dismiss LEAVE_REQUEST notifications on cancellation review",
          );
        }

        const refreshed = await app.prisma.leaveRequest.findUnique({
          where: { id, employee: { tenantId: req.user.tenantId } }, // Issue #835: scoped inline, the row was loaded by the decision core
          include: { employee: { select: { firstName: true, lastName: true } }, leaveType: true },
        });
        return {
          ...refreshed,
          typeCode: refreshed!.leaveType.code,
          startDate: refreshed!.startDate.toISOString().split("T")[0],
          endDate: refreshed!.endDate.toISOString().split("T")[0],
        };
      }

      // ── Regular request (PENDING) ────────────────────────────────────────────
      // Issue #835 (D-835-12): the whole PENDING decision lives in `decidePendingLeaveRequest`.
      const outcome = await decidePendingLeaveRequest(app, {
        existing,
        status: body.status,
        reviewerUserId: req.user.sub,
        reviewNote: body.reviewNote,
        limitException: body.limitException,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });
      if (!outcome.ok) {
        if (outcome.reason === "LIMIT_EXCEPTION_REQUIRED" && outcome.limit) {
          return reply.code(409).send(
            leaveLimitExceptionRequiredBody(outcome.limit.exceedances, {
              visibility: readerVisibilityFrom(
                await limitReaderReach(app, req),
                req.user.employeeId ?? null,
              ),
              personNames: outcome.limit.personNames,
            }),
          );
        }
        return reply.code(outcome.statusCode).send(outcome.body);
      }
      const { updated, responseExtras } = outcome;

      return {
        ...updated,
        typeCode: updated.leaveType.code,
        startDate: updated.startDate.toISOString().split("T")[0],
        endDate: updated.endDate.toISOString().split("T")[0],
        ...responseExtras,
      };
    },
  });

  // ── PATCH /requests/:id  – Ausstehenden Antrag bearbeiten ──────────────────
  app.patch("/requests/:id", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = updateSchema.parse(req.body);

      const existing = await app.prisma.leaveRequest.findFirst({
        where: { id, deletedAt: null }, // D-09: soft-deleted requests are not-found
        include: { leaveType: true, employee: { select: { tenantId: true } } },
      });
      if (!existing) return reply.code(404).send({ error: "Antrag nicht gefunden" });

      // T-100-09 cross-tenant existence oracle (Issue #309): tenant isolation MUST run before
      // the ownership check below, or a real id in a foreign tenant answers 403 while an unknown
      // id answers 404 — two distinguishable responses that let any authenticated user of any
      // tenant probe whether an arbitrary id exists anywhere. The audit is nested inside the
      // mismatch branch on purpose: an unknown id must write no AuditLog row, or the row count
      // itself would reopen the oracle this guard just closed. Shape copied verbatim from
      // `PATCH /requests/:id/correct` below in this same file.
      if (existing.employee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "LeaveRequest",
          entityId: id,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "Antrag nicht gefunden" });
      }
      if (existing.employeeId !== req.user.employeeId)
        return reply.code(403).send({ error: "Forbidden" });
      if (existing.status !== "PENDING")
        return reply.code(409).send({ error: "Nur ausstehende Anträge können bearbeitet werden" });

      // ── Half-day sick rejection (legal: teilweise AU gibt es nicht) ──
      const existingTypeCode = existing.leaveType.code;
      if (body.halfDay && (existingTypeCode === "SICK" || existingTypeCode === "SICK_CHILD")) {
        return reply.code(400).send({
          error:
            "Halbe Kranktage sind nicht zulässig — Krankheit wird immer ganztägig gutgeschrieben.",
        });
      }

      const start = new Date(body.startDate);
      const end = new Date(body.endDate);
      if (start > end)
        return reply.code(400).send({ error: "Startdatum muss vor Enddatum liegen" });

      const tenantId = req.user.tenantId;
      const holidayMap = await getHolidayMap(app.prisma, tenantId, existing.employeeId, start, end);
      const holidays = new Set(holidayMap.keys());
      // Phase 107 (D-09): roster-aware recompute of this still-PENDING request's own edit.
      // Issue #436 (D-04/D-09): excludes itself (self-exclusion, Pitfall 1) — the OLD dates of
      // this very request must never shadow its own NEW price.
      const { days, vocationalSchoolOnly: editVocationalSchoolOnly } = await resolveLeaveDays(
        app.prisma,
        existing.employeeId,
        tenantId,
        start,
        end,
        body.halfDay,
        holidays,
        { mode: "request", leaveTypeCode: existingTypeCode, excludeRequestId: id },
      );

      // Issue #448 (D-02): one rule on every write path — before any write, mirroring POST.
      if (editVocationalSchoolOnly) {
        return reply.code(400).send({ error: BS_ONLY_LEAVE_ERROR, code: BS_ONLY_LEAVE_ERROR_CODE });
      }

      // Issue #468 (D-01): the negative-balance gate used to run ONLY on POST — a still-PENDING
      // OVERTIME_COMP request could be widened here past the confirmed carry-over with no check
      // at all. Same shared gate as POST, before any write.
      if (existingTypeCode === "OVERTIME_COMP") {
        const tzForEditGate = await getTenantTimezone(app.prisma, tenantId);
        const editNeededMinutes = await scheduledLeaveMinutes(
          app.prisma,
          existing.employeeId,
          tenantId,
          start,
          end,
          body.halfDay,
          holidays,
          tzForEditGate,
        );
        const editRejection = await overtimeCompBalanceRejection(
          app,
          existing.employeeId,
          tenantId,
          editNeededMinutes,
        );
        if (editRejection) {
          return reply.code(400).send(editRejection);
        }
      }

      // Issue #478: the edit used to be a way around the create-side guards (create on free
      // dates, then move onto an approved or cancellation-requested request). Same shared
      // helpers as POST, the request itself excluded.
      const editBlockingOverlap = await findBlockingLeaveOverlap(app.prisma, {
        employeeId: existing.employeeId,
        start,
        end,
        isSickRequest: existingTypeCode === "SICK" || existingTypeCode === "SICK_CHILD",
        excludeRequestId: id,
      });
      if (editBlockingOverlap) return reply.code(409).send({ error: LEAVE_OVERLAP_ERROR });
      if (existing.leaveType.maxDaysPerYear) {
        const usedByOthers = await leaveDaysUsedInYear(app.prisma, {
          employeeId: existing.employeeId,
          leaveTypeId: existing.leaveTypeId,
          start,
          excludeRequestId: id,
        });
        if (usedByOthers + days > existing.leaveType.maxDaysPerYear) {
          return reply.code(400).send({
            error: `Max. ${existing.leaveType.maxDaysPerYear} Tage/Jahr für diesen Typ (bereits ${usedByOthers} genutzt)`,
          });
        }
      }

      const updated = await app.prisma.leaveRequest.update({
        where: { id },
        data: { startDate: start, endDate: end, halfDay: body.halfDay, days, note: body.note },
        include: {
          leaveType: true,
          employee: { select: { firstName: true, lastName: true, employeeNumber: true } },
        },
      });

      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "LeaveRequest",
        entityId: id,
        oldValue: existing,
        newValue: updated,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return {
        ...updated,
        typeCode: updated.leaveType.code,
        startDate: updated.startDate.toISOString().split("T")[0],
        endDate: updated.endDate.toISOString().split("T")[0],
      };
    },
  });

  // ── PATCH .../correct  – Manager DIRECT-Korrektur eines
  //    bereits GENEHMIGTEN Antrags (EDIT-01/02/03) ─────────────────────────
  // Erlaubt es einer Führungskraft, einen genehmigten Antrag (z.B. eine lange
  // Elternzeit) direkt zu verkürzen/anzupassen — ohne den heutigen Stornierungs-
  // Roundtrip. Guard-Reihenfolge (CONTEXT): tenant(404+Audit) → authz(requireRole)
  // → Status APPROVED(409) → Delta-Lock(409) → Domänen-Validierung(400).
  app.patch("/requests/:id/correct", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("leave-request:correct:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = correctSchema.parse(req.body);

      const existing = await app.prisma.leaveRequest.findFirst({
        where: { id, deletedAt: null }, // D-09: soft-deleted requests are not-found
        include: { leaveType: true, employee: { select: { tenantId: true } } },
      });
      if (!existing) return reply.code(404).send({ error: "Antrag nicht gefunden" });

      // Tenant isolation (SEC-V1814-03 / D-02): fetch-then-compare via employee.tenantId
      if (existing.employee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "LeaveRequest",
          entityId: id,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "Antrag nicht gefunden" });
      }

      // Phase 91b Plan 04 (Issue #91), D-10/D-14 — scope check, same pattern as /review above.
      {
        const access = accessContextFromRequest(req);
        const scopeReach = await resolveAccessReach(
          app.prisma,
          access,
          "leave-request:correct:ZUGEWIESEN",
        );
        if (
          !(await isStammsalonScopeMatch(
            app.prisma,
            req.user.tenantId,
            scopeReach,
            existing.employeeId,
            existing.startDate,
          ))
        ) {
          await app.audit({
            userId: req.user.sub,
            action: "SCOPE_ACCESS_DENIED",
            entity: "LeaveRequest",
            entityId: id,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
          return reply.code(404).send({ error: "Antrag nicht gefunden" });
        }
      }

      // Nur GENEHMIGTE Anträge sind direkt korrigierbar (EDIT-01, per CONTEXT).
      if (existing.status !== "APPROVED") {
        return reply.code(409).send({ error: "Nur genehmigte Anträge können korrigiert werden" });
      }

      // start <= end is already guaranteed by correctSchema.refine (Zod → 400).
      const start = new Date(body.startDate);
      const end = new Date(body.endDate);

      // Issue #614: the domain body of this correction (delta-lock, half-day-sick, overlap,
      // parental reductions, pricing, § 9 plan, closed-month guards — every pre-write refusal, in
      // this order) lives in contexts/absence/leave-correction.ts, shared with the exit-day
      // shortening of the anonymization. This handler keeps tenant, scope and status checks, the
      // transaction, the LEAVE_CORRECTED audit and the response.
      const prepared = await prepareLeaveCorrection(app, {
        existing,
        start,
        end,
        halfDay: body.halfDay,
        type: body.type,
        note: body.note,
        reason: body.reason,
        tenantId: req.user.tenantId,
      });
      if (!prepared.ok) {
        return reply.code(prepared.statusCode).send(prepared.body);
      }
      const { plan } = prepared;
      const { oldTypeCode, newType, oldOtMinutes, newOtMinutes, oldOtSource } = plan;

      // Issue #836 (D-836-19): only the days a correction ADDS (or the whole range when an uncounted
      // type becomes counted) can need a limit exception; a shortening never does. Checked here, in
      // the route, after every pre-write guard and before the transaction — never inside
      // prepareLeaveCorrection, which the employment exit shares and must not be refused by a limit.
      let leaveLimitException: ReturnType<typeof buildLeaveLimitExceptionAudit> | null = null;
      const limitRanges = correctionCandidateRanges({
        oldStart: existing.startDate,
        oldEnd: existing.endDate,
        newStart: start,
        newEnd: end,
        oldTypeCode,
        newTypeCode: newType,
      });
      if (limitRanges.length > 0) {
        const limitResult = await evaluateLeaveLimits(app.prisma, req.user.tenantId, {
          candidates: limitRanges.map((range) => ({
            requestId: existing.id,
            employeeId: existing.employeeId,
            typeCode: newType,
            ...range,
          })),
          excludeRequestIds: [existing.id],
        });
        if (limitResult.exceedances.length > 0) {
          if (!body.limitException) {
            return reply.code(409).send(
              leaveLimitExceptionRequiredBody(limitResult.exceedances, {
                visibility: readerVisibilityFrom(
                  await limitReaderReach(app, req),
                  req.user.employeeId ?? null,
                ),
                personNames: limitResult.personNames,
              }),
            );
          }
          leaveLimitException = buildLeaveLimitExceptionAudit(
            body.limitException.reason,
            limitResult.exceedances,
          );
        }
      }

      // Steps 8-11 run inside ONE interactive transaction (94 CR-01): the correction issues TWO
      // authoritative ledger writes (reverse OLD + apply NEW); without a transaction a
      // mid-sequence failure would leave the OLD booking reversed but the NEW one unapplied. All
      // pre-write guards already ran in prepareLeaveCorrection, so a rejection never opens it.
      let updated;
      try {
        updated = await app.prisma.$transaction(async (tx) =>
          applyLeaveCorrection(tx, plan, {
            actorUserId: req.user.sub,
            audit: async (entry) => {
              await app.audit({
                tx,
                userId: req.user.sub,
                action: entry.action,
                entity: entry.entity,
                entityId: entry.entityId,
                oldValue: entry.oldValue,
                newValue: entry.newValue,
                request: { ip: req.ip, headers: req.headers as Record<string, string> },
              });
            },
          }),
        );
      } catch (err) {
        // WR-02 (Issue #468 review): the § 9 optimistic-lock conflict thrown inside Step 8b —
        // translated into a retry-able 409, same convention as every other conflict in this
        // file (see Section9MissingEntitlementError's own handler further down).
        if (err instanceof Section9ConcurrentCorrectionError) {
          return reply.code(409).send({
            error: "Gleichzeitige Änderung der § 9-Gutschrift — bitte erneut versuchen.",
          });
        }
        throw err;
      }

      // Revisionssicherheit (EDIT-02): jede Korrektur wird LEAVE_CORRECTED-auditiert.
      // Quick 260824-cjd: the mandatory Begründung is persisted verbatim into newValue.
      await app.audit({
        userId: req.user.sub,
        action: "LEAVE_CORRECTED",
        entity: "LeaveRequest",
        entityId: id,
        oldValue: existing,
        newValue: {
          ...updated,
          auditReason: body.reason,
          // Issue #468 (D-02): the net movement of the Überstundenausgleich journal — the
          // journal itself keeps the 94-02 two-entry shape (stored old reversed, new booked);
          // this delta is the documented net, never a recomputed reversal. Only present when
          // either side of the correction is OVERTIME_COMP.
          ...(oldTypeCode === "OVERTIME_COMP" || newType === "OVERTIME_COMP"
            ? {
                overtimeCompDeltaMinutes:
                  (newType === "OVERTIME_COMP" ? newOtMinutes! : 0) -
                  (oldTypeCode === "OVERTIME_COMP" ? oldOtMinutes! : 0),
              }
            : {}),
          // T-468-10: names whether the OLD side's reversal used the stored booking or the A-4
          // legacy recomputation fallback. Only present when the OLD side was OVERTIME_COMP.
          ...(oldTypeCode === "OVERTIME_COMP" ? { overtimeCompReversalSource: oldOtSource } : {}),
          ...(leaveLimitException ? { leaveLimitException } : {}),
        },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      // Snapshot recalculation + overtime balance persist (after commit, Issue #294 semantics).
      await finishLeaveCorrection(app, plan);

      return {
        ...updated,
        typeCode: updated.leaveType.code,
        startDate: updated.startDate.toISOString().split("T")[0],
        endDate: updated.endDate.toISOString().split("T")[0],
      };
    },
  });

  // ── DELETE /requests/:id  – Antrag zurückziehen ──────────────────────────
  app.delete("/requests/:id", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = await app.prisma.leaveRequest.findFirst({
        where: { id, deletedAt: null }, // D-09: soft-deleted requests are not-found
        include: { leaveType: true, employee: { select: { tenantId: true } } },
      });
      if (!existing) return reply.code(404).send({ error: "Antrag nicht gefunden" });
      // Tenant isolation check (SEC-V1814-03 / D-02): tenant BEFORE isOwner/isManager (D-05)
      if (existing.employee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "LeaveRequest",
          entityId: id,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "Antrag nicht gefunden" });
      }

      const isOwner = existing.employeeId === req.user.employeeId;
      const reach = await permissionReach(req, "leave-request:cancel");
      if (reach !== "ZUGEWIESEN" && !isOwner) return reply.code(403).send({ error: "Forbidden" });
      if (reach === null) return reply.code(403).send({ error: "Forbidden" });
      if (!["PENDING", "APPROVED"].includes(existing.status)) {
        return reply.code(409).send({ error: "Antrag kann nicht mehr zurückgezogen werden" });
      }

      // Quick 260824-cjd: parsed AFTER the 404/403/409 guards so a bad-reason 400 never
      // leaks the existence of a foreign-tenant or wrong-status request.
      const { reason } = stornoSchema.parse(req.body);

      if (existing.status === "APPROVED") {
        // Issue #446 (D-06(d)/D-10): checked before the write below — otherwise a request
        // whose approval can never succeed (guard point c) would be created. The PENDING
        // withdrawal path below (status stays unguarded) is saldo-neutral.
        const closedMonths = await findClosedMonthsInRange(
          app.prisma,
          existing.employeeId,
          existing.employee.tenantId,
          existing.startDate,
          existing.endDate,
        );
        if (closedMonths.length > 0) {
          return reply.code(409).send({
            error: closedMonthLeaveMessage(closedMonths, "change"),
            code: "LEAVE_MONTH_CLOSED",
          });
        }

        // Approved leave → request cancellation (needs another manager's approval)
        // Until approved, the leave remains active (blocks time tracking, shown in calendar)
        await app.prisma.leaveRequest.update({
          where: { id },
          data: { status: "CANCELLATION_REQUESTED", cancellationRequestedBy: req.user.sub },
        });
        await app.audit({
          userId: req.user.sub,
          action: "UPDATE",
          entity: "LeaveRequest",
          entityId: id,
          oldValue: { status: existing.status },
          newValue: { status: "CANCELLATION_REQUESTED", auditReason: reason },
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(200).send({ status: "CANCELLATION_REQUESTED" });
      }

      // Ausstehender Antrag → sofort zurückziehen
      await app.prisma.leaveRequest.update({ where: { id }, data: { status: "CANCELLED" } });
      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "LeaveRequest",
        entityId: id,
        oldValue: { status: existing.status },
        newValue: { status: "CANCELLED", auditReason: reason },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });
      return reply.code(204).send();
    },
  });

  // ── PATCH /requests/:id/attest  – Attest-Daten setzen (nur Manager/Admin) ─
  app.patch("/requests/:id/attest", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("leave-request:attest:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = attestSchema.parse(req.body);

      const existing = await app.prisma.leaveRequest.findFirst({
        where: { id, deletedAt: null }, // D-09: soft-deleted requests are not-found
        include: { leaveType: true, employee: { select: { tenantId: true } } },
      });
      if (!existing) return reply.code(404).send({ error: "Antrag nicht gefunden" });
      // Tenant isolation check (SEC-V1814-03 / D-02): fetch-then-compare via employee.tenantId
      if (existing.employee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "LeaveRequest",
          entityId: id,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "Antrag nicht gefunden" });
      }

      // Phase 91b Plan 04 (Issue #91), D-10/D-14 — scope check, same pattern as /review above.
      {
        const access = accessContextFromRequest(req);
        const scopeReach = await resolveAccessReach(
          app.prisma,
          access,
          "leave-request:attest:ZUGEWIESEN",
        );
        if (
          !(await isStammsalonScopeMatch(
            app.prisma,
            req.user.tenantId,
            scopeReach,
            existing.employeeId,
            existing.startDate,
          ))
        ) {
          await app.audit({
            userId: req.user.sub,
            action: "SCOPE_ACCESS_DENIED",
            entity: "LeaveRequest",
            entityId: id,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
          return reply.code(404).send({ error: "Antrag nicht gefunden" });
        }
      }

      const typeCode = existing.leaveType.code;
      if (typeCode !== "SICK" && typeCode !== "SICK_CHILD") {
        return reply.code(400).send({ error: "Attest kann nur für Krankmeldungen gesetzt werden" });
      }

      // ── Why this handler has NO status guard and NO Monatsabschluss (locked-month) guard ──
      // Phase 201 / Issue #201, owner decision 2026-09-14. DELIBERATE, not an oversight.
      //
      // An Attest changes NO booked quantity: not startDate, not endDate, not days, not halfDay,
      // not saldo, not Soll. It records WHETHER a certificate exists for a period that is already
      // recorded either way. CLAUDE.md's "Immutability after lock" protects BOOKINGS; nothing is
      // re-booked here, so the rule is not engaged. Compare the correction handler above, which
      // DOES carry the delta-lock guard — because it moves days.
      //
      // Blocking it would be perverse: an AU normally arrives AFTER the illness, often after the
      // month is closed. A guard here would make such an AU permanently unrecordable and leave the
      // already-issued monthly report ("davon mit Attest: N", utils/pdf.ts) permanently false about
      // a matter with pay consequences.
      //
      // Clokr records only WHETHER an Attest exists and derives NOTHING from it — no wage
      // deduction, no blocking of Entgeltfortzahlung, no deduction amount, no automatic status
      // change, not even as a suggestion. That is a § 7 EFZG decision made OUTSIDE Clokr by the
      // tax advisor or the owner. Do not add one here. The only readers of attestPresent are
      // routes/reports.ts (with/without-Attest split), utils/pdf.ts (the printed line) and
      // utils/find-karenz-overrun-days.ts (the § 5 EFZG nudge) — none touches saldo or Soll.
      //
      // Pinned by apps/api/src/__tests__/leave-attest-late.test.ts.

      const updated = await app.prisma.leaveRequest.update({
        where: { id },
        data: {
          attestPresent: body.attestPresent,
          attestValidFrom:
            body.attestPresent && body.attestValidFrom ? new Date(body.attestValidFrom) : null,
          attestValidTo:
            body.attestPresent && body.attestValidTo ? new Date(body.attestValidTo) : null,
        },
        include: {
          leaveType: true,
          employee: { select: { firstName: true, lastName: true, employeeNumber: true } },
        },
      });

      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "LeaveRequest",
        entityId: id,
        oldValue: {
          attestPresent: existing.attestPresent,
          attestValidFrom: existing.attestValidFrom?.toISOString().split("T")[0] ?? null,
          attestValidTo: existing.attestValidTo?.toISOString().split("T")[0] ?? null,
        },
        newValue: {
          attestPresent: updated.attestPresent,
          attestValidFrom: updated.attestValidFrom?.toISOString().split("T")[0] ?? null,
          attestValidTo: updated.attestValidTo?.toISOString().split("T")[0] ?? null,
        },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return {
        ...updated,
        typeCode: typeCode,
        startDate: updated.startDate.toISOString().split("T")[0],
        endDate: updated.endDate.toISOString().split("T")[0],
        attestValidFrom: updated.attestValidFrom?.toISOString().split("T")[0] ?? null,
        attestValidTo: updated.attestValidTo?.toISOString().split("T")[0] ?? null,
      };
    },
  });

  // ── GET /calendar  – calendar view for one month or a day range ───────
  // Issue #840 (D-840-19): the detail level is decided PER PERSON by the reader's
  // `leave-request:read:ZUGEWIESEN` reach (Stammsalon per day), not by a bare permission check.
  app.get("/calendar", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { year, month } = req.query as { year?: string; month?: string };
      const query = leaveCalendarQuerySchema.parse(req.query);
      const { salonId } = query;
      const rangeForm = query.from !== undefined && query.to !== undefined;
      const y = year ? parseInt(year) : new Date().getFullYear();
      const m = month ? parseInt(month) : new Date().getMonth() + 1;
      const tenantId = req.user.tenantId;

      // Resolved ONCE per request: it validates the chosen salon (Issue #558, D-01 — a caller
      // without the reach gets the same 404 body) and decides the detail level of every row below.
      const reach = await resolveAccessReach(
        app.prisma,
        accessContextFromRequest(req),
        "leave-request:read:ZUGEWIESEN",
      );
      let chosenSalonId: string | null = null;
      if (salonId !== undefined) {
        const salon = await resolveSalonInReach(app.prisma, tenantId, reach, salonId);
        if (!salon.ok) return reply.code(404).send(SALON_NOT_FOUND);
        chosenSalonId = salon.salonId;
      }

      const tz = await getTenantTimezone(app.prisma, tenantId);
      // Issue #493: the leave overlap, the holiday window and the § 9 overlap all hit `@db.Date`
      // columns / date-string windows, so they take calendar-day bounds, not month instants.
      // The range form (Issue #840) names calendar days directly.
      const { firstDay, lastDay } =
        query.from !== undefined && query.to !== undefined
          ? {
              firstDay: new Date(`${query.from}T00:00:00.000Z`),
              lastDay: new Date(`${query.to}T00:00:00.000Z`),
            }
          : monthDateRange(y, m, tz);
      const windowFromDay = firstDay.toISOString().slice(0, 10);
      const windowToDay = lastDay.toISOString().slice(0, 10);

      const [allRows, holidayMap] = await Promise.all([
        app.prisma.leaveRequest.findMany({
          where: {
            deletedAt: null,
            employee: { tenantId },
            status: { in: ["PENDING", ...EFFECTIVE_LEAVE_STATUSES] }, // Issue #446 (D-04): same set, now derived
            startDate: { lte: lastDay },
            endDate: { gte: firstDay },
          },
          include: {
            leaveType: true,
            employee: { select: { id: true, firstName: true, lastName: true, userId: true } },
          },
          orderBy: { startDate: "asc" },
        }),
        // Interim (Phase 71b, issue #71): a tenant-wide calendar has no single employee to
        // resolve a work location for, so it shows the REQUESTER's own work-location holidays
        // (or the tenant's default salon's, for a profile-less admin) until Block D (#82 ff.)
        // designs a salon-aware calendar.
        getHolidayMap(
          app.prisma,
          req.user.tenantId,
          req.user.employeeId ?? null,
          firstDay,
          lastDay,
        ),
      ]);

      // Issue #558: the unfiltered calendar stays tenant-wide by design (type-masked below); a
      // chosen salon only narrows it. A row is kept by its range clipped to the SHOWN month
      // (calendar-day bounds, #493), so a request running into the next month is attributed by
      // the Stammsalon of the days in view. The holiday entries stay the requester's
      // work-location holidays (interim of #71) — the filter does not touch them.
      const rows =
        chosenSalonId === null
          ? allRows
          : await filterLeaveRowsToHomeSalon(app.prisma, tenantId, allRows, chosenSalonId, {
              fromDay: windowFromDay,
              toDay: windowToDay,
            });

      // Phase 104-10 (D-28/D-29): bulk-load § 9 credits overlapping the visible month — ONE
      // query, scoped to the tenant, so the per-row masking below never needs a query inside
      // `.map()`.
      const section9Credits = await app.prisma.section9Credit.findMany({
        where: {
          employee: { tenantId: req.user.tenantId },
          overlapStart: { lte: lastDay },
          overlapEnd: { gte: firstDay },
        },
        select: {
          sickRequestId: true,
          vacationRequestId: true,
          status: true,
          overlapStart: true,
          overlapEnd: true,
          creditedStart: true,
          creditedEnd: true,
        },
      });

      // Per-REQUEST marker: the server decides which entry "wins" on a shared day so the
      // client never re-derives the CONFIRMED > AU_PENDING > null ranking itself.
      //   "AU_PENDING"  → Krankmeldung liegt vor, AU fehlt noch; Urlaubstage stehen auf dem Spiel
      //   "CONFIRMED"   → Gutschrift erfolgt; an diesem Tag gewinnt Krank
      //   "SUPERSEDED"  → dieser Urlaubseintrag ist an diesem Tag durch eine bestätigte
      //                   Krankmeldung überlagert (der Antrag selbst bleibt unverändert, D-05)
      const section9ByEntry = new Map<string, { marker: string; days: Set<string> }>();
      const rankSection9Marker = (m: string) =>
        m === "CONFIRMED" ? 2 : m === "AU_PENDING" ? 1 : 0;
      const addSection9Marker = (id: string, marker: string, days: string[]) => {
        const existing = section9ByEntry.get(id);
        if (!existing) {
          section9ByEntry.set(id, { marker, days: new Set(days) });
          return;
        }
        days.forEach((d) => existing.days.add(d));
        if (rankSection9Marker(marker) > rankSection9Marker(existing.marker)) {
          existing.marker = marker;
        }
      };
      for (const c of section9Credits) {
        if (c.status === "CONFIRMED" && c.creditedStart && c.creditedEnd) {
          const days = daysBetweenInclusiveIso(c.creditedStart, c.creditedEnd);
          addSection9Marker(c.sickRequestId, "CONFIRMED", days);
          addSection9Marker(c.vacationRequestId, "SUPERSEDED", days);
        } else if (c.status === "AU_PENDING") {
          // Vacation entry deliberately left unmarked — the days are still charged.
          const days = daysBetweenInclusiveIso(c.overlapStart, c.overlapEnd);
          addSection9Marker(c.sickRequestId, "AU_PENDING", days);
        }
      }

      // Issue #840 (D-840-19): the per-person decision. A row is detailed iff it is the caller's own
      // or the person is visible on at least one day of the row clipped to the window (Stammsalon
      // per day, ONE `homeSalonsForDays` call; skipped when no day can matter — a whole-tenant
      // reach, or a reach without salons, answers without looking at days).
      const visibility = readerVisibilityFrom(reach, req.user.employeeId ?? null);
      const foreignIds = new Set<string>();
      for (const r of rows) {
        if (r.employee.userId === req.user.sub) continue;
        foreignIds.add(r.employeeId);
      }
      const needHomeDays =
        !visibility.wholeTenant && visibility.salonIds.size > 0 && foreignIds.size > 0;
      const homes = needHomeDays
        ? await homeSalonsForDays(
            app.prisma,
            tenantId,
            Array.from(foreignIds),
            windowFromDay,
            windowToDay,
          )
        : new Map<string, Map<string, string | null>>();

      const candidates = rows.map((r) => ({
        id: r.id,
        isOwn: r.employee.userId === req.user.sub,
        employeeId: r.employeeId,
        firstName: r.employee.firstName,
        lastName: r.employee.lastName,
        typeCode: r.leaveType.code,
        typeName: r.leaveType.name,
        startDate: r.startDate.toISOString().split("T")[0],
        endDate: r.endDate.toISOString().split("T")[0],
        halfDay: r.halfDay,
        status: r.status as string,
        isHoliday: false,
      }));
      const { detailed, masked } = maskCalendarRows(
        candidates,
        (row) =>
          row.isOwn ||
          isPersonVisibleOnSomeDay(
            visibility,
            row.employeeId,
            homes.get(row.employeeId),
            row.startDate > windowFromDay ? row.startDate : windowFromDay,
            row.endDate < windowToDay ? row.endDate : windowToDay,
          ),
        new Set<string>(EFFECTIVE_LEAVE_STATUSES),
      );
      // § 9 markers and days only for detailed rows: whoever may not learn the type must not read
      // the sick-in-vacation marker either (it would reveal the sickness indirectly).
      const leaveEntries = detailed.map((row) => ({
        ...row,
        section9: section9ByEntry.get(row.id)?.marker ?? null,
        section9Days: Array.from(section9ByEntry.get(row.id)?.days ?? []).sort(),
      }));

      // Feiertage als eigene Einträge hinzufügen
      const holidayEntries = Array.from(holidayMap.entries()).map(([date, name]) => ({
        id: `holiday-${date}`,
        isOwn: false,
        firstName: name,
        lastName: "",
        typeCode: "HOLIDAY" as const,
        typeName: name,
        startDate: date,
        endDate: date,
        halfDay: false,
        status: "APPROVED" as const,
        isHoliday: true,
      }));

      const entries = [...leaveEntries, ...masked, ...holidayEntries];
      if (!rangeForm) return entries;

      // Issue #840 (D-840-25): the range form also names the salon in view (opening hours are
      // salon master data, not personal data) so the web can draw closed days from the one rule.
      const salon =
        chosenSalonId === null ? null : await findSalon(app.prisma, tenantId, chosenSalonId);
      return {
        entries,
        salons:
          salon === null
            ? []
            : [{ salonId: salon.id, name: salon.name, openingHours: salon.openingHours }],
      };
    },
  });

  // ── GET /hours-preview  – geplante Stunden für einen Zeitraum ───────────
  app.get("/hours-preview", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const {
        startDate,
        endDate,
        halfDay,
        employeeId: requestedEmployeeId,
        type: previewTypeCode,
        excludeRequestId,
      } = req.query as {
        startDate?: string;
        endDate?: string;
        halfDay?: string;
        employeeId?: string;
        type?: string;
        excludeRequestId?: string;
      };
      if (!startDate || !endDate) {
        return reply.code(400).send({ error: "startDate und endDate erforderlich" });
      }
      // Issue #436 (D-04/D-09): optional — the dialog preview (Task 3) prices exactly like the
      // server by sending the leave type and, in edit mode, the request being edited. Both are
      // used ONLY inside the employee- and tenant-scoped helper in leave-days.ts, so a foreign
      // excludeRequestId behaves exactly like an unknown one (no cross-tenant disclosure).
      if (previewTypeCode != null && previewTypeCode.length > 40) {
        return reply.code(400).send({ error: "Ungültiger Abwesenheitstyp" });
      }
      if (excludeRequestId != null && !z.string().uuid().safeParse(excludeRequestId).success) {
        return reply.code(400).send({ error: "Ungültige Antrags-ID" });
      }
      // Phase 415 (#415): optional employeeId — the unified leave-request dialog reads a
      // manager's SELECTED employee's preview, not only the caller's own. Omitted or self is a
      // byte-identical passthrough (see resolveScopedEmployeeIdForRead's doc comment).
      const scoped = await resolveScopedEmployeeIdForRead(app, req, requestedEmployeeId);
      if (!scoped.ok) return reply.code(scoped.status).send(scoped.body);
      const employeeId = scoped.employeeId;
      if (!employeeId)
        return {
          hours: 0,
          days: 0,
          rosterImported: true,
          vocationalSchoolDates: [],
          vocationalSchoolOnly: false,
        };

      const start = new Date(startDate);
      const end = new Date(endDate);
      const isHalf = halfDay === "true";

      const tenantId = req.user.tenantId;
      const holidayMap = await getHolidayMap(app.prisma, tenantId, employeeId, start, end);
      const holidays = new Set(holidayMap.keys());

      // Phase 107 (D-09): roster-aware live estimate, read-only, no persistence.
      // Issue #436 (D-04/D-09, Task 3): with `type` given, prices exactly like the server would
      // (week-union against the employee's other counted VACATION requests, excluding the
      // request being edited). Without `type`, isolated — byte-identical to every existing
      // caller's old answer (the neutrality recordings send no new params).
      const previewPricing: LeaveDaysPricing =
        previewTypeCode != null
          ? { mode: "request", leaveTypeCode: previewTypeCode, excludeRequestId }
          : { mode: "isolated" };
      // Issue #468 (D-01): the SAME function the POST/PATCH gate, the booking and the saldo
      // use — the preview never computes a second, independent number.
      const tzForPreview = await getTenantTimezone(app.prisma, tenantId);
      const [minutes, leaveDaysPreview] = await Promise.all([
        scheduledLeaveMinutes(
          app.prisma,
          employeeId,
          tenantId,
          start,
          end,
          isHalf,
          holidays,
          tzForPreview,
        ),
        resolveLeaveDays(
          app.prisma,
          employeeId,
          tenantId,
          start,
          end,
          isHalf,
          holidays,
          previewPricing,
        ),
      ]);
      // Issue #448 (D-05, plan 03): the server's own BS classification, not a client formula —
      // additive fields from the already-computed resolveLeaveDays() result.
      const { days, provisional, vocationalSchoolDates, vocationalSchoolOnly } = leaveDaysPreview;

      // Phase 430 Plan 04 (D-15): `rosterImported` — a NEW, independent signal from
      // `provisional` above (Issue #417 hard-wired that one `false`; it must not be
      // repurposed). Meaningful only for SHIFT_BASED employees — every other schedule type
      // reports `true` unconditionally so the leave-dialog hint this field feeds (D-16) can
      // never fire for them. Reuses the exact inline WorkSchedule-lookup idiom this same
      // handler's sibling routes already use (e.g. `wsForApproval` above), not a new query
      // shape, and `mondayOfWeekUtc()` (vacation-calc.ts) — the one shared Monday derivation
      // (Phase 107 D-05: "do not invent a third one") — for the week bounds. Only the week
      // containing `startDate` is checked, even when the request spans multiple weeks — a
      // documented first-cut simplification (see 430-04-SUMMARY.md).
      let rosterImported = true;
      const wsForRoster = await app.prisma.workSchedule.findFirst({
        where: { employeeId },
        orderBy: { validFrom: "desc" },
        select: { type: true },
      });
      if (wsForRoster?.type === "SHIFT_BASED") {
        const weekStart = mondayOfWeekUtc(start);
        const weekEnd = new Date(weekStart);
        weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
        // Multi-Tenancy Convention (CLAUDE.md) / route-employee-scope-literals.test.ts: every
        // route-file EmployeeScope is built via employeeScopeFor(accessContextFromRequest(req),
        // …), never a hand-built literal — `access` mirrors this same file's other call sites
        // (e.g. the approval-reverse-hook above).
        const access = accessContextFromRequest(req);
        const shiftsThisWeek = await getShiftsInRange(
          app.prisma,
          employeeScopeFor(access, { employeeId }),
          weekStart,
          weekEnd,
        );
        rosterImported = shiftsThisWeek.length > 0;
      }

      // WR-03 (code review) — exact integer minutes, the SAME `scheduledLeaveMinutes` value
      // the POST /requests OVERTIME_COMP gate uses for `neededMinutes` above (Issue #468, D-01:
      // now literally the same function call, not a parallel formula). `hours` is rounded to 2
      // decimal PLACES for display; `minutesNeeded` lets the client compare against
      // confirmedMinutes / maxNegativeBalanceMinutes (already exact integer minutes from GET
      // /leave/overtime-balance) without reconstructing the server's exact-minute gate through
      // two different rounding paths.
      // `provisional` (Phase 107, D-09) additive: lets the request form show a
      // "Vorläufig" hint before submission for a SHIFT_BASED period with no roster yet.
      return {
        hours: +(minutes / 60).toFixed(2),
        days,
        provisional,
        rosterImported,
        minutesNeeded: minutes,
        vocationalSchoolDates,
        vocationalSchoolOnly,
      };
    },
  });

  // ── GET /overtime-balance  – eigenes Überstundensaldo ───────────────────
  // Phase 97-06 (SALDO-DISP-01/04) — the Überstundenausgleich request form reads
  // this endpoint to judge affordability. It used to serve the stale, event-driven
  // OvertimeAccount.balanceHours directly (no live recompute at all) — exactly the
  // source 97-CONTEXT names as wrong. Rewired onto computeOvertimeBalanceBreakdown,
  // the SAME live source GET /overtime/:employeeId already uses (v1.8.24 / 97-01),
  // with the identical never-500 fail-safe discipline: a live-compute failure or a
  // § 18 ArbZG-exempt employee (breakdown === null) falls back to the stored
  // balanceHours, re-derives confirmedMinutes/hasClosedMonth from the independent
  // getConfirmedCarryOver query (itself never-500), and reports openMonthMinutes:
  // null — never a fabricated zero, so the UI renders the forecast as unavailable
  // rather than indistinguishable from a genuine zero forecast.
  app.get("/overtime-balance", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      // Phase 415 (#415): optional employeeId — same treatment as GET /hours-preview above.
      const { employeeId: requestedEmployeeId } = req.query as { employeeId?: string };
      const scoped = await resolveScopedEmployeeIdForRead(app, req, requestedEmployeeId);
      if (!scoped.ok) return reply.code(scoped.status).send(scoped.body);
      const employeeId = scoped.employeeId;
      if (!employeeId) {
        return {
          balanceVisible: true,
          balanceHours: 0,
          confirmedMinutes: 0,
          openMonthMinutes: null,
          hasClosedMonth: false,
          // Issue #588 (P-14): additive; the web words the forecast from it
          // ("Laufender Monat" only for exactly one unclosed month).
          unconfirmedMonths: null,
          maxNegativeBalanceMinutes: null,
          isNegativeLimitExceeded: false,
        };
      }

      // Phase 100 (OTC-05, D-15/D-16) — resolved ONCE per request through the SAME shared
      // helper the OVERTIME_COMP gate uses (loadNegativeBalanceTolerance), so this box and the
      // gate can never disagree on the same employee's tolerance. `isNegativeLimitExceeded`
      // below uses the `configuredMinutes != null` guard — the "unbegrenzt"/ALERTING reading,
      // D-00b — NOT a bare "confirmed balance is negative" check, which would fire for every
      // employee with a merely negative confirmed balance and blur D-00b's two readings into a
      // third (100-UI-SPEC.md "API contract feeding surfaces 1 and 4").
      const { configuredMinutes } = await loadNegativeBalanceTolerance(
        app.prisma,
        employeeId,
        req.user.tenantId,
      );

      // Issue #85 (Phase 85b Plan 16): no saldo-derived number leaves this endpoint for a caller
      // without `overtime:read` coverage of the person. `isNegativeLimitExceeded` and
      // `hasClosedMonth` are masked too — the first reveals the sign of the confirmed balance. The
      // tolerance itself is tenant configuration and stays. Nothing is computed for a masked
      // response, so no hidden value can leak through a log or a partial branch.
      if (!(await callerMaySeeSaldoOf(app, req, employeeId))) {
        return {
          balanceVisible: false,
          balanceHours: null,
          confirmedMinutes: null,
          openMonthMinutes: null,
          hasClosedMonth: null,
          maxNegativeBalanceMinutes: configuredMinutes,
          isNegativeLimitExceeded: null,
        };
      }

      let breakdown: OvertimeBalanceBreakdown | null = null;
      try {
        breakdown = await computeOvertimeBalanceBreakdown(app, employeeId);
      } catch (err) {
        app.log.warn(
          { err, employeeId },
          "GET /leave/overtime-balance: live saldo failed, using stored",
        );
        // breakdown stays null (its declared initial value) — never reassigned here.
      }

      if (breakdown !== null) {
        return {
          balanceVisible: true,
          // Same 2-decimal rounding GET /overtime/:employeeId applies, so the two
          // endpoints cannot disagree on the same employee.
          balanceHours: Math.round(breakdown.totalHours * 100) / 100,
          confirmedMinutes: breakdown.confirmedMinutes,
          openMonthMinutes: breakdown.openMonthMinutes,
          hasClosedMonth: breakdown.hasClosedMonth,
          // Issue #588 (P-14): additive; the web words the forecast from it
          // ("Laufender Monat" only for exactly one unclosed month).
          unconfirmedMonths: breakdown.unconfirmedMonths,
          maxNegativeBalanceMinutes: configuredMinutes,
          isNegativeLimitExceeded:
            configuredMinutes != null && breakdown.confirmedMinutes < -configuredMinutes,
          ...(breakdown.rosterIncomplete !== undefined
            ? { rosterIncomplete: breakdown.rosterIncomplete }
            : {}),
        };
      }

      // Fail-safe branch (live compute threw, or § 18 ArbZG-exempt employee).
      const account = await getOvertimeAccount(app.prisma, employeeId, req.user.tenantId);
      const balanceHours = account ? Math.round(Number(account.balanceHours) * 100) / 100 : 0;
      try {
        const confirmed = await getConfirmedCarryOver(app.prisma, employeeId, req.user.tenantId);
        return {
          balanceVisible: true,
          balanceHours,
          confirmedMinutes: confirmed.minutes,
          openMonthMinutes: null,
          hasClosedMonth: confirmed.hasClosedMonth,
          // Issue #588 (P-14): additive; the web words the forecast from it
          // ("Laufender Monat" only for exactly one unclosed month).
          unconfirmedMonths: null,
          maxNegativeBalanceMinutes: configuredMinutes,
          isNegativeLimitExceeded:
            configuredMinutes != null && confirmed.minutes < -configuredMinutes,
        };
      } catch (fallbackErr) {
        app.log.warn(
          { err: fallbackErr, employeeId },
          "GET /leave/overtime-balance: confirmed carry-over fallback failed",
        );
        return {
          balanceVisible: true,
          balanceHours,
          confirmedMinutes: 0,
          openMonthMinutes: null,
          hasClosedMonth: false,
          // Issue #588 (P-14): additive; the web words the forecast from it
          // ("Laufender Monat" only for exactly one unclosed month).
          unconfirmedMonths: null,
          maxNegativeBalanceMinutes: configuredMinutes,
          // IN-01 (code review) — this was `configuredMinutes != null && 0 < -configuredMinutes`,
          // which reads like a real comparison against the (unknown) balance but is tautologically
          // false: configuredMinutes is Zod-bounded to >= 0 (employeeScheduleSchema / the
          // /settings/security schema both enforce `.min(0)`), so `-configuredMinutes` is always
          // <= 0. The balance is genuinely unknown in this deepest fail-safe branch (both the live
          // compute AND the confirmed-carry-over fallback threw) — never claim the limit is
          // exceeded against a value we don't have.
          isNegativeLimitExceeded: false,
        };
      }
    },
  });

  // ── GET /ical/personal  – iCal-Export eigener Abwesenheiten ─────────────
  app.get("/ical/personal", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const employeeId = req.user.employeeId;
      if (!employeeId) return reply.code(400).send({ error: "Kein Mitarbeiter-Profil" });

      const [requests, absences] = await Promise.all([
        app.prisma.leaveRequest.findMany({
          // Issue #446 (D-04): a leave under requested cancellation is still active.
          where: { employeeId, deletedAt: null, status: { in: [...EFFECTIVE_LEAVE_STATUSES] } },
          include: { leaveType: true, employee: { select: { firstName: true, lastName: true } } },
        }),
        app.prisma.absence.findMany({
          where: { employeeId, deletedAt: null },
          include: { employee: { select: { firstName: true, lastName: true } } },
        }),
      ]);

      const events: ICalEvent[] = requests.map((r) => ({
        uid: `leave-${r.id}@clokr`,
        // Phase 97 (AC-2): the row's own display name. Before this phase the canonical name from
        // LEAVE_TYPE_DEFS overrode it, which silently undid a tenant's rename in the calendar feed.
        summary: withHalfDayMarker(r.leaveType.name, r.halfDay),
        dtstart: r.startDate.toISOString().split("T")[0],
        dtend: addOneDay(r.endDate.toISOString().split("T")[0]),
        description: r.note ?? undefined,
        status: "CONFIRMED",
        // No silent default to the vacation code here (D-09): an uncoded type simply has no
        // category — it does not get turned into vacation to fill the field.
        categories: r.leaveType.code ?? undefined,
      }));

      for (const a of absences) {
        events.push({
          uid: `absence-${a.id}@clokr`,
          // Phase 98b (D-04): one display table for all eleven codes. The old six-way ternary
          // could not name VOCATIONAL_SCHOOL or OTHER at all and fell through to the generic
          // word, while the dashboard already said "Berufsschule" — the app contradicted itself.
          // DISPLAY_NAME is exhaustive over LeaveTypeCode, so no fallback branch is needed.
          summary: withHalfDayMarker(DISPLAY_NAME[a.type], a.halfDay),
          dtstart: a.startDate.toISOString().split("T")[0],
          dtend: addOneDay(a.endDate.toISOString().split("T")[0]),
          description: a.note ?? undefined,
          status: "CONFIRMED",
          categories: a.type,
        });
      }

      const ical = generateICal("Clokr – Meine Abwesenheiten", events);
      reply
        .header("Content-Type", "text/calendar; charset=utf-8")
        .header("Content-Disposition", 'attachment; filename="clokr-abwesenheiten.ics"')
        .send(ical);
    },
  });

  // ── GET /ical/team  – iCal-Export aller Team-Abwesenheiten ─────────────
  app.get("/ical/team", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("leave-request:read:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const tenantId = req.user.tenantId;

      // Phase 91b Plan 04 (Issue #91), D-10 — this feed has no date window of its own (it returns
      // every effective-status request + absence, unbounded — Issue #446 D-04: a request under
      // requested cancellation is still active) to use as a Stichtag, unlike the plan's own text
      // assumed; treated the same as GET /requests's own "no single natural period" case:
      // tenant-local today.
      const { salonId } = leaveSalonQuerySchema.parse(req.query);
      const access = accessContextFromRequest(req);
      const reach = await resolveAccessReach(app.prisma, access, "leave-request:read:ZUGEWIESEN");
      // Issue #558 (D-01): validated against the guard's own reach before any row read.
      const salon = await resolveSalonInReach(app.prisma, tenantId, reach, salonId);
      if (!salon.ok) return reply.code(404).send(SALON_NOT_FOUND);
      const chosenSalonId = salon.salonId;
      const scopedEmployeeIds =
        reach.kind === "wholeTenant"
          ? "all"
          : await resolveStammsalonScopedEmployeeIds(
              app.prisma,
              tenantId,
              reach,
              todayInTz(await getTenantTimezone(app.prisma, tenantId)),
            );

      const [allRequests, allAbsences] = await Promise.all([
        app.prisma.leaveRequest.findMany({
          where: {
            deletedAt: null,
            employee: { tenantId },
            status: { in: [...EFFECTIVE_LEAVE_STATUSES] }, // Issue #446 (D-04)
            ...(scopedEmployeeIds !== "all" ? { employeeId: { in: scopedEmployeeIds } } : {}),
          },
          include: { leaveType: true, employee: { select: { firstName: true, lastName: true } } },
        }),
        app.prisma.absence.findMany({
          where: {
            deletedAt: null,
            employee: { tenantId },
            ...(scopedEmployeeIds !== "all" ? { employeeId: { in: scopedEmployeeIds } } : {}),
          },
          include: { employee: { select: { firstName: true, lastName: true } } },
        }),
      ]);

      // Issue #558 (D-08): under a salon choice a request or an imposed absence is kept by its OWN
      // range (the feed has no window) — the Stammsalon per day, never a deployment. The
      // unfiltered feed is unchanged.
      const [requests, absences] =
        chosenSalonId === null
          ? [allRequests, allAbsences]
          : await Promise.all([
              filterLeaveRowsToHomeSalon(app.prisma, tenantId, allRequests, chosenSalonId),
              filterLeaveRowsToHomeSalon(app.prisma, tenantId, allAbsences, chosenSalonId),
            ]);

      const events: ICalEvent[] = requests.map((r) => {
        const name = `${r.employee.firstName} ${r.employee.lastName}`;
        return {
          uid: `leave-${r.id}@clokr`,
          summary: withHalfDayMarker(`${name} \u2014 ${r.leaveType.name}`, r.halfDay),
          dtstart: r.startDate.toISOString().split("T")[0],
          dtend: addOneDay(r.endDate.toISOString().split("T")[0]),
          description: r.note ?? undefined,
          status: "CONFIRMED",
          categories: r.leaveType.code ?? undefined,
        };
      });

      for (const a of absences) {
        const name = `${a.employee.firstName} ${a.employee.lastName}`;
        events.push({
          uid: `absence-${a.id}@clokr`,
          summary: withHalfDayMarker(`${name} \u2014 ${DISPLAY_NAME[a.type]}`, a.halfDay),
          dtstart: a.startDate.toISOString().split("T")[0],
          dtend: addOneDay(a.endDate.toISOString().split("T")[0]),
          description: a.note ?? undefined,
          status: "CONFIRMED",
          categories: a.type,
        });
      }

      const ical = generateICal("Clokr – Team-Abwesenheiten", events);
      reply
        .header("Content-Type", "text/calendar; charset=utf-8")
        .header("Content-Disposition", 'attachment; filename="clokr-team-abwesenheiten.ics"')
        .send(ical);
    },
  });

  // ── GET /entitlements/:employeeId ─────────────────────────────────────────
  app.get("/entitlements/:employeeId", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { employeeId } = req.params as { employeeId: string };
      const { year } = req.query as { year?: string };
      // Plan 74-03 / D-05: respect the test-only X-Test-Now header so the
      // year-boundary E2E flows can pin "now" deterministically. The
      // testBootstrap plugin only registers the hook when
      // ALLOW_TEST_BOOTSTRAP=true; on int + prod `req.testNow` is always
      // undefined and we fall through to the real clock.
      const now = req.testNow ?? new Date();
      const targetYear = year ? parseInt(year) : now.getFullYear();
      const tenantId = req.user.tenantId;

      // Tenant isolation check, mirroring overtime.ts: this used to be a
      // `findUnique({ where: { id: employeeId, tenantId } })` further below that only
      // fed `exitDate` and never rejected a `null` result — a cross-tenant employeeId
      // silently fell through to the (unfiltered) LeaveEntitlement/Section9Credit
      // queries below. Loaded here, before any read or write, and reused for the
      // exitDate the pro-rata calculation further down needs.
      const employee = await app.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { tenantId: true, exitDate: true, firstName: true, lastName: true },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      if (employee.tenantId !== tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "Employee",
          entityId: employeeId,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      }
      // Same-tenant self-scope: an EMPLOYEE may only read their own leave account —
      // mirrors overtime.ts:126 (D-03). Frontend only ever calls this with the
      // caller's own employeeId for EMPLOYEE-role tokens (the admin-facing report
      // paths use ADMIN/MANAGER tokens), so this is not a behaviour change for any
      // existing legitimate caller.
      const entitlementReach = await permissionReach(req, "leave-entitlement:read");
      if (entitlementReach !== "ZUGEWIESEN" && req.user.employeeId !== employeeId) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      if (entitlementReach === null) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      // Phase 91b Plan 10 (Issue #91), D-10/D-14: leave-entitlement is Stammsalon-only, same rule
      // as settings/vacation/:employeeId, Stichtag = Dec 31 of the queried year.
      if (entitlementReach === "ZUGEWIESEN" && req.user.employeeId !== employeeId) {
        const access = accessContextFromRequest(req);
        const scopeReach = await resolveAccessReach(
          app.prisma,
          access,
          "leave-entitlement:read:ZUGEWIESEN",
        );
        if (
          !(await isStammsalonScopeMatch(
            app.prisma,
            tenantId,
            scopeReach,
            employeeId,
            new Date(Date.UTC(targetYear, 11, 31)),
          ))
        ) {
          await app.audit({
            userId: req.user.sub,
            action: "SCOPE_ACCESS_DENIED",
            entity: "LeaveEntitlement",
            entityId: employeeId,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
          return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
        }
      }

      // Resturlaub auto-übertragen falls nötig
      const vacTypeId = await ensureLeaveType(app.prisma, app.log, tenantId, "VACATION");
      await autoCarryOver(app.prisma, tenantId, employeeId, vacTypeId, targetYear);

      // Issue #447 (D-06): this is a read path that may HEAL the exit-year row — when the
      // response covers the employee's exit year (no `?year`, or `?year` equal to it), the row
      // is brought to its § 5 BUrlG value before it is read, same as the booking-time sync via
      // ensureRegularVacationEntitlement. System audit (no acting user on a GET).
      if (employee.exitDate && employee.exitDate.getUTCFullYear() === targetYear) {
        await syncExitYearVacationEntitlement(app.prisma, employeeId, tenantId, targetYear);
      }

      // Issue #173: without `?year` this can return more than one row per LeaveType (e.g. a
      // next-year carry-over projection row created as a side effect of approving a booking
      // — see recalculateCarryOver()). Postgres gives no row order without ORDER BY, so a
      // caller that picks "the" row for a type (rather than filtering by year itself) would
      // get a non-deterministic result. `desc` surfaces the most recent year first, which is
      // the more useful default for such a caller; it is a no-op for the `?year` path, which
      // resolves to at most one row.
      const rows = await app.prisma.leaveEntitlement.findMany({
        where: { employeeId, ...(year ? { year: targetYear } : {}) },
        include: { leaveType: true },
        orderBy: { year: "desc" },
      });

      // Vacation type meta — shared with selfHealUsedDays AND the pro-rata mapping below.
      // healZeroPlaceholder (Issue #445, D-05) and healUsedDays (Issue #445, D-10) are injected
      // here rather than imported statically by leave-self-heal.ts itself — see that file's
      // module docblock for why (the absence/scheduling/time-tracking/working-time-account
      // import-cycle ceiling, Phase 101B, 22).
      const vacMeta = {
        ...(await loadVacationTypeMeta(app.prisma, tenantId)),
        healZeroPlaceholder: (
          prisma: typeof app.prisma,
          employeeId: string,
          empTenantId: string,
          year: number,
          leaveTypeId: string,
        ) =>
          ensureRegularVacationEntitlement(
            prisma,
            employeeId,
            empTenantId,
            year,
            leaveTypeId,
            REGULAR_ENTITLEMENT_REASON_SELF_HEAL,
          ),
        healUsedDays: (
          prisma: typeof app.prisma,
          row: {
            id: string;
            employeeId: string;
            leaveTypeId: string;
            year: number;
            usedDays: unknown;
          },
          leaveTypeIds: string[],
          empTenantId: string,
        ) => healEntitlementUsedDays(prisma, row, leaveTypeIds, empTenantId),
      };

      // Issue #447 (D-08): reuse the `employee` row loaded by the tenant guard above for the
      // exit-year over-use warning built per VACATION row below.
      const employeeExitDate = employee.exitDate ?? null;

      // Self-heal usedDays from Σ approved LeaveRequest.days.
      // Same logic the report endpoint now uses — see apps/api/src/utils/leave-self-heal.ts.
      await selfHealUsedDays(app.prisma, rows, vacMeta);

      // Phase 104-10 (D-31): the credit appears as its own explained movement line in the
      // leave account. ONE bulk query for the whole employee — independent of how many
      // entitlement years are in `rows` — so no query is needed inside the rows.map() below.
      const confirmedSection9Credits = await app.prisma.section9Credit.findMany({
        where: { employeeId, status: "CONFIRMED" },
        select: { id: true, creditedDays: true, creditedStart: true, creditedEnd: true },
      });

      // Phase 107-07 (D-12/D-13, read side): a SHIFT_BASED provisional VACATION request's
      // `days` already counts at full value inside `usedDays` (selfHealUsedDays above sums
      // every APPROVED request regardless of daysProvisional) — this query isolates just the
      // provisional PORTION of that sum so the frontend can render it as its own,
      // separately-labelled "Verbraucht (vorläufig)" row without touching usedDays/available
      // itself. ONE bulk query for the whole employee, mirroring confirmedSection9Credits
      // above — no query inside rows.map() below. `deletedAt: null` per CLAUDE.md's soft-delete
      // rule (LeaveRequest is soft-deletable).
      const provisionalLeaveRequests = await app.prisma.leaveRequest.findMany({
        where: { employeeId, status: "APPROVED", daysProvisional: true, deletedAt: null },
        select: { id: true, days: true, startDate: true, endDate: true, leaveTypeId: true },
      });

      // EuGH C-684/16: batch-fetch which entitlements have a documented warning so
      // effectiveCarryOverDays() below can be called with the hinweisIssued flag.
      // A single query covers all entitlement ids — no N+1 (rows per employee+year are bounded).
      const warnedEntitlementIds = new Set(
        (
          await app.prisma.auditLog.findMany({
            where: {
              action: "CARRYOVER_WARNED",
              entity: "LeaveEntitlement",
              entityId: { in: rows.map((r) => r.id) },
            },
            select: { entityId: true },
            distinct: ["entityId"],
          })
        ).map((al) => al.entityId!),
      );

      // Issue #445 (D-13): effectiveCarryOverDays() is async (it may need to count the days
      // taken before the deadline), so it is resolved here, in a loop, BEFORE the synchronous
      // rows.map() below — the response field's name and meaning are unchanged.
      //
      // Issue #451 (D-07): for the VACATION row(s), the facade's vacationBalanceForRow computes
      // effectiveCarryOverDays internally with the SAME inputs — calling effectiveCarryOverDays
      // a second time here for those rows would re-derive the identical number from two call
      // sites, which is exactly how the pre-#451 duplication this facade replaces could silently
      // diverge. So the VACATION row's `effectiveCarryByRowId` entry is taken FROM the facade
      // result instead; every other (non-VACATION) row is unaffected and keeps calling
      // effectiveCarryOverDays directly, as before.
      const effectiveCarryByRowId = new Map<string, number>();
      const vacationBalanceByRowId = new Map<string, VacationBalance>();
      for (const r of rows) {
        const hinweisIssued = warnedEntitlementIds.has(r.id);
        if (r.leaveType.code === "VACATION") {
          const balance = await vacationBalanceForRow(app.prisma, r, tenantId, now, {
            hinweisIssued,
            employee: {
              firstName: employee.firstName,
              lastName: employee.lastName,
              exitDate: employeeExitDate,
            },
          });
          vacationBalanceByRowId.set(r.id, balance);
          effectiveCarryByRowId.set(r.id, balance.carriedOverEffectiveDays);
        } else {
          effectiveCarryByRowId.set(
            r.id,
            await effectiveCarryOverDays(app.prisma, { ...r, tenantId }, now, hinweisIssued),
          );
        }
      }

      // typeCode + effektiven Resturlaub + anteiligen Urlaubsanspruch im Response markieren
      return rows.map((r) => {
        // Phase 97: the vacation account is the row whose CODE is VACATION. This used to be a
        // lookup against a hard-coded list of German display names, which misclassified any
        // renamed row. Do not name that list here — plan 09 removes its last definition and
        // asserts repo-wide that the identifier is gone.
        const isVacationRow = r.leaveType.code === "VACATION";
        // Issue #447 (D-06): no second exit pro-rata here — the persisted row is already the
        // exit-aware § 5 BUrlG value (synced above / by ensureRegularVacationEntitlement), so
        // this field is simply the row's own totalDays. Kept under its existing name/shape for
        // API stability — leave-provisional-readside.test.ts reads it.
        const effectiveEntitlementDays = Number(r.totalDays);
        // Issue #447 (D-08) — the neutral exit-year over-use hint, VACATION row only.
        const exitOverUseWarning = isVacationRow
          ? (exitVacationOverUseWarning({
              employeeName: `${employee.firstName} ${employee.lastName}`,
              exitDate: employeeExitDate,
              row: r,
            }) ?? null)
          : null;
        // Issue #445 (coordinator deviation from CONTEXT D-05) — selfHealUsedDays above sets
        // needsReview on a row whose zero placeholder was left unhealed because it was
        // ambiguous (see isAmbiguousRegularEntitlement in ../leave-days). Surface it so an
        // admin/manager can act instead of the row silently staying at 0 unexplained. The
        // warning string itself is built by vacationEntitlementWarning() in ../leave-days — the
        // same function composition/reports.ts uses, so the business rule lives in one place.
        const entitlementWarning = vacationEntitlementWarning({
          leaveTypeCode: r.leaveType.code,
          year: r.year,
          needsReview: (r as { needsReview?: boolean }).needsReview,
        });
        // D-31: only the vacation-account row carries movements — a credit only ever
        // touches the VACATION LeaveEntitlement (reverseVacationDays' target), so a
        // same-year non-vacation row (e.g. Sonderurlaub) must not repeat it.
        const creditsForYear = isVacationRow
          ? confirmedSection9Credits.filter((c) => c.creditedStart?.getUTCFullYear() === r.year)
          : [];
        // Phase 107-07: matched on leaveTypeId (not just isVacationRow/year, unlike
        // creditsForYear above) because daysProvisional can in principle be set on a
        // non-VACATION SHIFT_BASED request too (see shift-leave-recalc-resolver.ts's own
        // VACATION_LEAVE_TYPE_NAME docblock) — the exact leaveTypeId match keeps such a
        // request's days out of an unrelated entitlement row's provisional sum.
        const provisionalUsedDays = provisionalLeaveRequests
          .filter((p) => p.leaveTypeId === r.leaveTypeId && p.startDate.getUTCFullYear() === r.year)
          .reduce((sum, p) => sum + Number(p.days), 0);
        return {
          ...r,
          typeCode: r.leaveType.code,
          effectiveCarryOverDays: effectiveCarryByRowId.get(r.id) ?? 0,
          carryOverDeadline: r.carryOverDeadline?.toISOString().split("T")[0] ?? null,
          effectiveEntitlementDays,
          // Issue #445 — null unless this VACATION row is an unhealed ambiguous placeholder.
          entitlementWarning,
          // Issue #447 (D-08) — null unless this VACATION row's used days exceed its exit-year
          // entitlement (totalDays + carriedOverDays); the one exitVacationOverUseWarning helper.
          exitOverUseWarning,
          // Phase 107-07 (D-12): the provisional portion of `usedDays` for this year — see the
          // `provisionalLeaveRequests` query above. Always 0 for an employee/year with no
          // provisional requests; every other field on this response is unchanged.
          provisionalUsedDays,
          // Issue #451 (D-07) — additive: the facade's full Resturlaub breakdown, VACATION row
          // only (null for every other row). `remainingDays` equals the same
          // `totalDays + effectiveCarryOverDays - usedDays` formula the /leave page's own
          // Resturlaub display already computes (apps/web/src/lib/leave/vacation-summary.ts,
          // Phase 114 oracle — unchanged by this plan).
          vacationBalance: isVacationRow ? (vacationBalanceByRowId.get(r.id) ?? null) : null,
          // D-31: die Gutschrift erscheint als eigene, erklärte Bewegungszeile — ein
          // stillschweigend höherer Restanspruch wirkt wie ein Fehler und erzeugt Rückfragen.
          section9Movements: creditsForYear.map((c) => ({
            creditId: c.id,
            days: Number(c.creditedDays ?? 0),
            from: c.creditedStart?.toISOString().split("T")[0] ?? null,
            to: c.creditedEnd?.toISOString().split("T")[0] ?? null,
            label:
              `+${Number(c.creditedDays ?? 0)} Tage gutgeschrieben (§ 9 BUrlG, Krankheit ` +
              `${formatDayMonth(c.creditedStart)}–${formatDayMonth(c.creditedEnd)})`,
          })),
        };
      });
    },
  });

  // ── GET /karenz-overrun — § 5 EFZG: Krankheitstage über die Karenzzeit ohne Attest ──────
  // Phase 104 gap closure (D-21, Mitarbeiter-Seite). Das Gegenstück zum Manager-Hinweis in
  // GET /overtime/close-month/status (dort: karenzOverrunDays[]), der ADMIN/MANAGER-only ist —
  // ein Mitarbeiter hat sonst KEINEN Weg, den Befund zu sehen.
  //
  // STRENG selbstbezogen: kein employeeId-Query-Parameter, keine Manager-Sonderbehandlung.
  // Krankheitstage sind Gesundheitsdaten (Art. 9 DSGVO) — die Manager-Sicht existiert bereits
  // an ihrer eigenen, rollengeschützten Stelle und wird hier nicht dupliziert.
  //
  // D-21: reiner HINWEIS. Dieser Endpunkt blockiert nichts und wird von nichts als Gate gelesen.
  // R5/D-23: die Regel wird NICHT hier neu implementiert, sondern aus find-karenz-overrun-days.ts
  // importiert — dem einzigen Ort, an dem sie lebt.
  app.get("/karenz-overrun", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req) => {
      const tz = await getTenantTimezone(app.prisma, req.user.tenantId);
      const cfg = await app.prisma.tenantConfig.findUnique({
        where: { tenantId: req.user.tenantId },
        select: { sickNoteRequiredAfterDays: true },
      });
      const graceDays = normalizeKarenzDays(cfg?.sickNoteRequiredAfterDays);

      const employeeId = req.user.employeeId;
      if (!employeeId) return { graceDays, overruns: [], totalDays: 0 };

      // Serverseitig abgeleitetes Fenster — kein Request-Feld kann es verschieben.
      // 12 Monate zurück, exakt wie der Phase-92-Pausen-Nudge (BREAK-07): ein abgeschlossener
      // Monat schließt den Nachweis NICHT aus (R7 — die AU darf auch später eintreffen).
      const now = new Date();
      const windowStart = new Date(
        Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1, 0, 0, 0),
      );

      const rows = await app.prisma.leaveRequest.findMany({
        where: {
          employeeId,
          employee: { tenantId: req.user.tenantId },
          deletedAt: null,
          status: "APPROVED",
          endDate: { gte: windowStart },
          startDate: { lte: now },
        },
        include: { leaveType: true },
      });

      const overruns = karenzOverrunFromRequests(rows, tz, graceDays).map((o) => ({
        leaveRequestId: o.leaveRequestId,
        days: [...o.days].sort(),
      }));
      const totalDays = new Set(overruns.flatMap((o) => o.days)).size;
      return { graceDays, overruns, totalDays };
    },
  });

  // ── GET /sick-days — the caller's own sick days of a year, in calendar days ─────────────
  // Issue #595 (D-04): the one meaning of "Krankheitstage" — calendar days, weekends included,
  // counted by `sickLeaveDayCounts()`, the same kernel the monthly report and both PDFs use. The
  // /leave page used to sum the stored (workday-priced) `days` of the requests in the browser.
  //
  // STRICTLY self-referential like /karenz-overrun above: no employee parameter, no manager
  // special case. Sick days are health data (Art. 9 DSGVO); the manager view lives at its own
  // role-guarded places. The total is invariant under the attest split and the § 9 shift, so no
  // credits are fetched; the kernel filters sick codes and effective statuses itself.
  app.get("/sick-days", {
    schema: {
      tags: ["Abwesenheiten"],
      description:
        "The caller's own sick days of a calendar year in calendar days (weekends included).",
      security: [{ bearerAuth: [] }],
    },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      // Issue #368: same refusal as `GET /requests` — no leave-request:read reach, no answer.
      const readReach = await permissionReach(req, "leave-request:read");
      if (readReach === null) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      const { year } = sickDaysQuerySchema.parse(req.query);

      const employeeId = req.user.employeeId;
      if (!employeeId) return { year, sickDays: 0 };

      // Calendar-day bounds for the @db.Date columns (Issue #493), never month instants.
      const tz = await getTenantTimezone(app.prisma, req.user.tenantId);
      const firstDay = monthDateRange(year, 1, tz).firstDay;
      const lastDay = monthDateRange(year, 12, tz).lastDay;

      const rows = await app.prisma.leaveRequest.findMany({
        where: {
          employeeId,
          employee: { tenantId: req.user.tenantId },
          deletedAt: null,
          startDate: { lte: lastDay },
          endDate: { gte: firstDay },
        },
        include: { leaveType: true },
      });

      return { year, sickDays: sickLeaveDayCounts(rows, firstDay, lastDay).sickDays };
    },
  });

  // ── GET /section9 — § 9-BUrlG-Vorgänge (eigene, oder alle des Tenants für Manager) ──
  app.get("/section9", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { status, salonId } = section9StatusQuerySchema.parse(req.query);
      // Issue #368: same error form as `GET /requests` above — a caller holding neither
      // `section9:read:ZUGEWIESEN` nor `section9:read:EIGENE` (e.g. a template without an own
      // Employee record) used to get 200 with an empty list instead of 403.
      const readReach = await permissionReach(req, "section9:read");
      if (readReach === null) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      const isManager = readReach === "ZUGEWIESEN";
      // Issue #644 — a ZUGEWIESEN reach is only whole-tenant when it resolves so. A scoped
      // caller (e.g. a Salonmanager) gets only the cases of people in reach, decided with the
      // same building blocks as `section9:decide` below: the Stammsalon at the credit's own
      // `overlapStart` (sick-leave periods are health data, Art. 9 DSGVO).
      const scopeReach = isManager
        ? await resolveAccessReach(
            app.prisma,
            accessContextFromRequest(req),
            "section9:read:ZUGEWIESEN",
          )
        : null;
      // Issue #558 (D-01, P-10): a chosen salon is validated against the `section9:read:ZUGEWIESEN`
      // reach before any read — the same reach the #644 check below applies. A caller with only
      // the own-data reach has a scoped-empty reach, which rejects every salon with the same 404.
      let chosenSalonId: string | null = null;
      if (salonId !== undefined) {
        const salonReach =
          scopeReach ??
          (await resolveAccessReach(
            app.prisma,
            accessContextFromRequest(req),
            "section9:read:ZUGEWIESEN",
          ));
        const salon = await resolveSalonInReach(app.prisma, req.user.tenantId, salonReach, salonId);
        if (!salon.ok) return reply.code(404).send(SALON_NOT_FOUND);
        chosenSalonId = salon.salonId;
      }
      const allRows = await app.prisma.section9Credit.findMany({
        where: {
          employee: { tenantId: req.user.tenantId },
          ...(isManager ? {} : { employeeId: req.user.employeeId ?? "__none__" }),
          ...(status ? { status } : {}),
        },
        include: {
          employee: { select: { id: true, firstName: true, lastName: true } },
          sickRequest: { select: { id: true, startDate: true, endDate: true, status: true } },
          vacationRequest: {
            select: {
              id: true,
              startDate: true,
              endDate: true,
              halfDay: true,
              days: true,
              leaveType: { select: { name: true } },
            },
          },
        },
        orderBy: [{ status: "asc" }, { overlapStart: "desc" }],
      });
      const reachRows =
        scopeReach === null || scopeReach.kind === "wholeTenant"
          ? allRows
          : (
              await Promise.all(
                allRows.map(async (r) =>
                  (await isStammsalonScopeMatch(
                    app.prisma,
                    req.user.tenantId,
                    scopeReach,
                    r.employeeId,
                    r.overlapStart,
                  ))
                    ? r
                    : null,
                ),
              )
            ).filter((r): r is (typeof allRows)[number] => r !== null);
      // Issue #558 (D-08): the salon filter is INTERSECTED with the `section9:read:ZUGEWIESEN`
      // reach that #644 (PR #646) applied just above — it narrows only, never widens. A case
      // belongs to the salon that is the person's Stammsalon on a day of the case's overlap range.
      const rows =
        chosenSalonId === null
          ? reachRows
          : (
              await filterLeaveRowsToHomeSalon(
                app.prisma,
                req.user.tenantId,
                reachRows.map((row) => ({
                  employeeId: row.employeeId,
                  startDate: row.overlapStart,
                  endDate: row.overlapEnd,
                  row,
                })),
                chosenSalonId,
              )
            ).map((kept) => kept.row);
      return rows.map((r) => ({
        id: r.id,
        employeeId: r.employeeId,
        employeeName: `${r.employee.firstName} ${r.employee.lastName}`,
        status: r.status,
        overlapStart: r.overlapStart.toISOString().split("T")[0],
        overlapEnd: r.overlapEnd.toISOString().split("T")[0],
        creditedStart: r.creditedStart?.toISOString().split("T")[0] ?? null,
        creditedEnd: r.creditedEnd?.toISOString().split("T")[0] ?? null,
        creditedDays: r.creditedDays !== null ? Number(r.creditedDays) : null,
        attestSource: r.attestSource,
        attestValidFrom: r.attestValidFrom?.toISOString().split("T")[0] ?? null,
        attestValidTo: r.attestValidTo?.toISOString().split("T")[0] ?? null,
        reason: r.reason,
        sickRequest: {
          id: r.sickRequest.id,
          startDate: r.sickRequest.startDate.toISOString().split("T")[0],
          endDate: r.sickRequest.endDate.toISOString().split("T")[0],
          status: r.sickRequest.status,
        },
        vacationRequest: {
          id: r.vacationRequest.id,
          startDate: r.vacationRequest.startDate.toISOString().split("T")[0],
          endDate: r.vacationRequest.endDate.toISOString().split("T")[0],
          halfDay: r.vacationRequest.halfDay,
          days: Number(r.vacationRequest.days),
          typeName: r.vacationRequest.leaveType.name,
        },
      }));
    },
  });

  // ── GET /section9/:id — einzelner § 9-Vorgang (Tenant-isoliert) ─────────────
  app.get("/section9/:id", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      // reach === null answered here, BEFORE the lookup below: it is id-independent, so
      // answering it here (rather than alongside the row.employeeId check further down)
      // never creates a 403-vs-404 oracle on the id (Phase 75b, Issue #75, D-13).
      const section9Reach = await permissionReach(req, "section9:read");
      if (section9Reach === null) return reply.code(403).send({ error: "Forbidden" });

      const row = await app.prisma.section9Credit.findFirst({
        where: { id },
        include: {
          employee: { select: { id: true, firstName: true, lastName: true, tenantId: true } },
          sickRequest: { select: { id: true, startDate: true, endDate: true, status: true } },
          vacationRequest: {
            select: {
              id: true,
              startDate: true,
              endDate: true,
              halfDay: true,
              days: true,
              leaveType: { select: { name: true } },
            },
          },
        },
      });
      if (!row) return reply.code(404).send({ error: "Vorgang nicht gefunden" });

      // Tenant isolation check (D-02 idiom): fetch-then-compare via employee.tenantId
      if (row.employee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "Section9Credit",
          entityId: id,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "Vorgang nicht gefunden" });
      }

      if (section9Reach !== "ZUGEWIESEN" && row.employeeId !== req.user.employeeId) {
        return reply.code(404).send({ error: "Vorgang nicht gefunden" });
      }

      // Issue #644 — same reach rule as the list above; out of reach is the identical 404.
      if (section9Reach === "ZUGEWIESEN") {
        const scopeReach = await resolveAccessReach(
          app.prisma,
          accessContextFromRequest(req),
          "section9:read:ZUGEWIESEN",
        );
        if (
          !(await isStammsalonScopeMatch(
            app.prisma,
            req.user.tenantId,
            scopeReach,
            row.employeeId,
            row.overlapStart,
          ))
        ) {
          return reply.code(404).send({ error: "Vorgang nicht gefunden" });
        }
      }

      return {
        id: row.id,
        employeeId: row.employeeId,
        employeeName: `${row.employee.firstName} ${row.employee.lastName}`,
        status: row.status,
        overlapStart: row.overlapStart.toISOString().split("T")[0],
        overlapEnd: row.overlapEnd.toISOString().split("T")[0],
        creditedStart: row.creditedStart?.toISOString().split("T")[0] ?? null,
        creditedEnd: row.creditedEnd?.toISOString().split("T")[0] ?? null,
        creditedDays: row.creditedDays !== null ? Number(row.creditedDays) : null,
        attestSource: row.attestSource,
        attestValidFrom: row.attestValidFrom?.toISOString().split("T")[0] ?? null,
        attestValidTo: row.attestValidTo?.toISOString().split("T")[0] ?? null,
        reason: row.reason,
        sickRequest: {
          id: row.sickRequest.id,
          startDate: row.sickRequest.startDate.toISOString().split("T")[0],
          endDate: row.sickRequest.endDate.toISOString().split("T")[0],
          status: row.sickRequest.status,
        },
        vacationRequest: {
          id: row.vacationRequest.id,
          startDate: row.vacationRequest.startDate.toISOString().split("T")[0],
          endDate: row.vacationRequest.endDate.toISOString().split("T")[0],
          halfDay: row.vacationRequest.halfDay,
          days: Number(row.vacationRequest.days),
          typeName: row.vacationRequest.leaveType.name,
        },
      };
    },
  });

  // § 9 BUrlG (Phase 104). D-10: Es gibt BEWUSST keinen automatischen Verfall eines
  // AU_PENDING-Vorgangs — § 9 kennt keine Vorlagefrist, und nichts wird still geschlossen.
  // Der Vorgang bleibt offen, bis ein Mensch entscheidet. Wer hier später einen Cron-Job
  // ergänzen möchte: das wäre eine Entscheidung gegen eine gesperrte Owner-Vorgabe.

  // ── POST /section9/:id/confirm — „AU liegt vor" (Phase 104-06) ──────────────
  // R3/D-07/D-08/D-13/D-17/D-18/D-19: gutschreiben, ausschließlich der attestierten
  // Schnittmenge, rein entitlement-seitig (D-16 — kein SaldoSnapshot, kein Aufbrechen
  // gesperrter Monate), mit ILLNESS-Übertragsfrist wo der Stichtag bereits verstrichen ist.
  app.post("/section9/:id/confirm", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("section9:decide:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = section9ConfirmSchema.parse(req.body);

      const credit = await app.prisma.section9Credit.findFirst({
        where: { id },
        include: {
          employee: { select: { id: true, tenantId: true, userId: true } },
          sickRequest: { include: { leaveType: true } },
          vacationRequest: { include: { leaveType: true } },
        },
      });
      if (!credit) return reply.code(404).send({ error: "§-9-Vorgang nicht gefunden" });

      // Tenant isolation BEFORE any state check (T-104-06-TENANT idiom, leave.ts:1659) — a
      // cross-tenant probe must not be able to learn the row's status from the response.
      if (credit.employee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "Section9Credit",
          entityId: id,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "§-9-Vorgang nicht gefunden" });
      }

      // Phase 91b Plan 04 (Issue #91), D-10/D-14 — scope check: a ZUGEWIESEN-scoped manager may
      // only decide a § 9 case for an employee whose Stammsalon at the credit's own overlapStart
      // (the credit's own period-start field, D-09-era computed at detection time) is in scope.
      {
        const access = accessContextFromRequest(req);
        const scopeReach = await resolveAccessReach(
          app.prisma,
          access,
          "section9:decide:ZUGEWIESEN",
        );
        if (
          !(await isStammsalonScopeMatch(
            app.prisma,
            req.user.tenantId,
            scopeReach,
            credit.employeeId,
            credit.overlapStart,
          ))
        ) {
          await app.audit({
            userId: req.user.sub,
            action: "SCOPE_ACCESS_DENIED",
            entity: "Section9Credit",
            entityId: id,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
          return reply.code(404).send({ error: "§-9-Vorgang nicht gefunden" });
        }
      }

      // Issue #468 (D-04/A-3, Task 2): a SUPERSEDED credit was overholt by a `/correct` call —
      // before every OTHER state check, so a still-SUPERSEDED-but-otherwise-AU_PENDING-looking
      // row can never be re-activated by confirming or rejecting it (T-468-20).
      if (credit.status === "SUPERSEDED") {
        return reply.code(409).send({ error: "Der Vorgang ist durch eine Korrektur überholt." });
      }

      if (credit.status === "CONFIRMED") {
        return reply.code(409).send({ error: "Vorgang wurde bereits bestätigt" });
      }

      // D-13: die Krankmeldung muss genehmigt sein, bevor die AU bestätigt werden kann —
      // sonst könnte auf eine später abgelehnte Krankmeldung gutgeschrieben werden.
      if (credit.sickRequest.status !== "APPROVED") {
        return reply.code(409).send({ error: "Die Krankmeldung muss zuerst genehmigt werden." });
      }

      // Phase 104 review (WR-01), revised by Issue #478: the credit is detected at SICK-approval
      // time against a vacation in EFFECTIVE_LEAVE_STATUSES (APPROVED or CANCELLATION_REQUESTED).
      // Between then and this confirm the vacation can become CANCELLED (leave.ts cancel path)
      // — and the cancel path already decrements usedDays back. Confirming afterwards would run
      // reverseVacationDays() a SECOND time for the same days (double credit), and would book a
      // § 9 credit against a vacation that legally no longer exists. A vacation still in
      // CANCELLATION_REQUESTED is active leave, so its credit can be confirmed (otherwise the
      // case the sick approval opened could never be acted on); if that cancellation is later
      // approved, supersedeSection9CreditsOfCancelledRequest() (#662) supersedes the credit and
      // takes the ledger give-back out again, so no day is credited twice.
      if (!isEffectiveLeaveStatus(credit.vacationRequest.status)) {
        return reply.code(409).send({
          error:
            "Der betroffene Urlaubsantrag ist nicht mehr genehmigt — keine Gutschrift möglich.",
        });
      }

      // D-12: deliberately NO four-eyes check — bei 1-2 Managern würde das exakt die
      // Storno-Sackgasse reproduzieren, die § 9 umgeht. Derselbe Manager, der die
      // Krankmeldung genehmigt hat, darf auch die AU bestätigen.

      const attestFrom = new Date(body.attestValidFrom);
      const attestTo = new Date(body.attestValidTo);
      if (attestFrom > attestTo) {
        return reply.code(400).send({ error: "AU-Gültigkeit: Von-Datum liegt nach Bis-Datum" });
      }

      // D-07: gutgeschrieben wird ausschließlich die attestierte Schnittmenge mit der
      // Überlappung. Ein Attest kann keine Tage zurückgeben, die nie Urlaub waren.
      const attestOverlap = intersectRanges(
        attestFrom,
        attestTo,
        credit.overlapStart,
        credit.overlapEnd,
      );
      if (!attestOverlap) {
        return reply.code(400).send({
          error:
            "Die AU deckt keinen Tag des betroffenen Urlaubszeitraums ab — keine Gutschrift nach § 9 BUrlG.",
        });
      }
      // Issue #468 (D-04/A-3, Task 2): `/correct` may have narrowed the vacation's range since
      // this credit's overlap was computed at detection time — clip the attested overlap
      // additionally to the vacation's CURRENT [startDate, endDate] so a still-AU_PENDING
      // credit is never confirmed for days the vacation no longer covers.
      const credited = intersectRanges(
        attestOverlap.start,
        attestOverlap.end,
        credit.vacationRequest.startDate,
        credit.vacationRequest.endDate,
      );
      if (!credited) {
        return reply.code(400).send({
          error:
            "Die AU deckt keinen Tag des betroffenen Urlaubszeitraums ab — keine Gutschrift nach § 9 BUrlG.",
        });
      }

      const tenantId = req.user.tenantId;
      const holidayMap = await getHolidayMap(
        app.prisma,
        tenantId,
        credit.employeeId,
        credited.start,
        credited.end,
      );
      const holidays = new Set(holidayMap.keys());
      // D-08: Halber Urlaubstag + ganztägige Krankheit → Gutschrift 0,5. Zurückgegeben wird
      // ausschließlich, was angerechnet war — der halfDay-Flag stammt daher vom URLAUBSantrag,
      // nicht von der Krankmeldung (halbe Kranktage sind systemweit verboten, leave.ts:239).
      // Phase 107 (D-09): the affected vacation can belong to a SHIFT_BASED employee, so the
      // credit-back is routed through the same roster-aware resolver for consistency. `.days`
      // only -- a credit-back is a REDUCTION of a prior deduction, never a new approved
      // consumption, so no daysProvisional is written here.
      // Issue #436 (D-04/D-09): the credited sub-range is priced against the requests that were
      // already there when the vacation was priced (excluding the vacation request itself), so
      // the credit never exceeds what that request actually consumed.
      const { days: creditedDays } = await resolveLeaveDays(
        app.prisma,
        credit.employeeId,
        tenantId,
        credited.start,
        credited.end,
        credit.vacationRequest.halfDay,
        holidays,
        {
          mode: "request",
          leaveTypeCode: credit.vacationRequest.leaveType.code,
          excludeRequestId: credit.vacationRequest.id,
        },
      );
      if (creditedDays <= 0) {
        return reply
          .code(400)
          .send({ error: "Kein anrechenbarer Arbeitstag im attestierten Zeitraum." });
      }

      // Issue #445 (D-08/D-09): reverseVacationDays' cross-year branch now splits `totalDays`
      // chronologically by the REQUEST'S OWN day count (splitLeaveDaysByYear), always called
      // with halfDay=false — the split works on the already-priced total, not on halfDay
      // itself. A half-day credit whose credited range crosses a year boundary therefore still
      // has no unambiguous per-year attribution (0.5 day cannot be chronologically split).
      // Refuse loudly instead of mis-booking silently — behaviour unchanged from before #445.
      // Phase 104 review (WR-09): UTC accessors throughout the § 9 path. Every
      // Section9Credit date column is @db.Date (UTC midnight) and the entitlement endpoint
      // attributes credits to a year with getUTCFullYear(); using the LOCAL accessors here
      // meant a 1 January credit would be attributed to the PREVIOUS year on any host with a
      // negative UTC offset — the movement line would vanish from the entitlement row it was
      // booked against, and the ILLNESS deadline would land on the wrong year's row.
      if (
        credit.vacationRequest.halfDay &&
        credited.start.getUTCFullYear() !== credited.end.getUTCFullYear()
      ) {
        return reply.code(400).send({
          error:
            "Halbtags-Urlaub über einen Jahreswechsel kann nicht automatisch gutgeschrieben werden — bitte manuell korrigieren.",
        });
      }

      // Phase 104 review (IN-05): a credit whose origin year has no LeaveEntitlement row books
      // NOTHING (updateMany affects 0 rows, and selfHealUsedDays does not create the row
      // either) — yet the handler used to answer 200 { status: "CONFIRMED", creditedDays } and
      // notify the employee "+N Tage gutgeschrieben". The transaction is aborted and answered
      // with a 409 naming the year instead, so the Vorgang stays AU_PENDING and re-confirmable
      // once the Urlaubsanspruch for that year exists.
      let missingEntitlementYears: number[] = [];

      await app.prisma
        .$transaction(async (tx) => {
          // D-18: Gutschrift ins URSPRUNGSJAHR des Urlaubstags — § 9 stellt den ursprünglichen
          // Anspruch wieder her, er schafft keinen neuen. reverseVacationDays ist der
          // symmetrische Gegenpart zu deductVacationDays und kann cross-year splitten.
          const reversed = await reverseVacationDays(
            tx,
            credit.employeeId,
            credit.vacationRequest.leaveTypeId,
            credited.start,
            credited.end,
            creditedDays,
            holidays,
            tenantId,
          );
          if (reversed.missingYears.length > 0) {
            missingEntitlementYears = reversed.missingYears;
            throw new Section9MissingEntitlementError();
          }

          await tx.section9Credit.update({
            where: { id: credit.id },
            data: {
              status: "CONFIRMED",
              attestSource: body.attestSource,
              attestValidFrom: attestFrom,
              attestValidTo: attestTo,
              creditedStart: credited.start,
              creditedEnd: credited.end,
              creditedDays,
              reason: body.reason,
              reviewedBy: req.user.sub,
              reviewedAt: new Date(),
            },
          });

          // D-19 / R9: when the origin year's carry-over deadline has already passed, the
          // days do NOT lapse (EuGH KHS C-214/10 — 15 months). We mark the following year's
          // carry-over as illness-related; preserveCarryOverDeadline (Phase 104-04, generalised
          // Issue #445 D-17) protects this deadline from a later, silent overwrite.
          const originYear = credited.start.getUTCFullYear(); // WR-09: @db.Date is UTC midnight
          const carryRow = await tx.leaveEntitlement.findUnique({
            where: {
              employeeId_leaveTypeId_year: {
                employeeId: credit.employeeId,
                leaveTypeId: credit.vacationRequest.leaveTypeId,
                year: originYear + 1,
              },
            },
          });
          const now = new Date();
          if (carryRow?.carryOverDeadline && carryRow.carryOverDeadline < now) {
            await tx.leaveEntitlement.update({
              where: { id: carryRow.id },
              data: {
                carryOverReason: "ILLNESS",
                // 15 Monate nach Ende des Ursprungsjahres = 31.03. des Jahres originYear + 2
                carryOverDeadline: new Date(Date.UTC(originYear + 2, 2, 31, 23, 59, 59)),
                carryOverNote:
                  `§ 9 BUrlG: ${creditedDays} Tag(e) wegen Krankheit im Urlaub gutgeschrieben ` +
                  `(${credited.start.toISOString().split("T")[0]}–${credited.end.toISOString().split("T")[0]}). ` +
                  `Verlängerte Übertragsfrist nach EuGH KHS C-214/10.`,
              },
            });
          }

          await app.audit({
            userId: req.user.sub,
            action: "SECTION9_CREDIT_CONFIRMED",
            entity: "Section9Credit",
            entityId: credit.id,
            oldValue: { status: credit.status },
            newValue: {
              status: "CONFIRMED",
              sickRequestId: credit.sickRequestId,
              vacationRequestId: credit.vacationRequestId,
              creditedStart: credited.start.toISOString().split("T")[0],
              creditedEnd: credited.end.toISOString().split("T")[0],
              creditedDays,
              attestSource: body.attestSource,
              reason: body.reason,
              note: "§ 9 BUrlG, nicht angerechnet",
            },
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
            tx,
          });
        })
        .catch((err: unknown) => {
          if (err instanceof Section9MissingEntitlementError) return "MISSING_ENTITLEMENT" as const;
          throw err;
        });

      if (missingEntitlementYears.length > 0) {
        return reply.code(409).send({
          error:
            `Für ${missingEntitlementYears.join(", ")} existiert kein Urlaubsanspruch — ` +
            `die Gutschrift kann nicht gebucht werden. Bitte zuerst den Urlaubsanspruch anlegen.`,
        });
      }

      // Outside the transaction: clear "AU nachreichen" nudges, notify the employee.
      await app.dismissByRelated("Section9Credit", credit.id);

      if (credit.employee.userId) {
        const rangeLabel = `${formatDateDe(credited.start)} – ${formatDateDe(credited.end)}`;
        await app.notify({
          userId: credit.employee.userId,
          type: "SECTION9_CREDIT_CONFIRMED",
          title: "Urlaubstage gutgeschrieben (§ 9 BUrlG)",
          message: `+${creditedDays} Tage gutgeschrieben (§ 9 BUrlG, Krankheit ${rangeLabel}).`,
          link: "/leave",
          tenantId,
          relatedType: "Section9Credit",
          relatedId: credit.id,
        });
      }

      return reply.send({
        id: credit.id,
        status: "CONFIRMED",
        creditedStart: credited.start.toISOString().split("T")[0],
        creditedEnd: credited.end.toISOString().split("T")[0],
        creditedDays,
      });
    },
  });

  // ── POST /section9/:id/reject — AU-Nachweis abgelehnt (Phase 104-06, D-11) ───
  app.post("/section9/:id/reject", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("section9:decide:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = section9ReasonSchema.parse(req.body);

      const credit = await app.prisma.section9Credit.findFirst({
        where: { id },
        include: { employee: { select: { id: true, tenantId: true, userId: true } } },
      });
      if (!credit) return reply.code(404).send({ error: "§-9-Vorgang nicht gefunden" });

      if (credit.employee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "Section9Credit",
          entityId: id,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "§-9-Vorgang nicht gefunden" });
      }

      // Phase 91b Plan 04 (Issue #91), D-10/D-14 — scope check: a ZUGEWIESEN-scoped manager may
      // only decide a § 9 case for an employee whose Stammsalon at the credit's own overlapStart
      // (the credit's own period-start field, D-09-era computed at detection time) is in scope.
      {
        const access = accessContextFromRequest(req);
        const scopeReach = await resolveAccessReach(
          app.prisma,
          access,
          "section9:decide:ZUGEWIESEN",
        );
        if (
          !(await isStammsalonScopeMatch(
            app.prisma,
            req.user.tenantId,
            scopeReach,
            credit.employeeId,
            credit.overlapStart,
          ))
        ) {
          await app.audit({
            userId: req.user.sub,
            action: "SCOPE_ACCESS_DENIED",
            entity: "Section9Credit",
            entityId: id,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
          return reply.code(404).send({ error: "§-9-Vorgang nicht gefunden" });
        }
      }

      // Issue #468 (D-04/A-3, Task 2): same SUPERSEDED guard as confirm, before every other
      // state check — a `/correct`-overholt Vorgang cannot be rejected either (T-468-20).
      if (credit.status === "SUPERSEDED") {
        return reply.code(409).send({ error: "Der Vorgang ist durch eine Korrektur überholt." });
      }

      // D-11: eine bereits gebuchte Gutschrift kann nicht abgelehnt werden — eine
      // Korrektur wäre ein anderer Vorgang, außerhalb des Umfangs dieser Phase.
      if (credit.status === "CONFIRMED") {
        return reply
          .code(409)
          .send({ error: "Ein bereits gutgeschriebener Vorgang kann nicht abgelehnt werden." });
      }

      await app.prisma.$transaction(async (tx) => {
        await tx.section9Credit.update({
          where: { id: credit.id },
          data: {
            status: "REJECTED",
            reason: body.reason,
            reviewedBy: req.user.sub,
            reviewedAt: new Date(),
          },
        });
        await app.audit({
          userId: req.user.sub,
          action: "SECTION9_CREDIT_REJECTED",
          entity: "Section9Credit",
          entityId: credit.id,
          oldValue: { status: credit.status },
          newValue: { status: "REJECTED", reason: body.reason },
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
          tx,
        });
      });

      // D-11: die Tage bleiben VORERST angerechnet — eine endgültige Ablehnung würde
      // einen Anspruch verwehren, den § 9 kraft Gesetzes gewährt. Der Vorgang kann
      // wieder eröffnet werden, sobald eine gültige AU vorliegt.
      if (credit.employee.userId) {
        await app.notify({
          userId: credit.employee.userId,
          type: "SECTION9_CREDIT_REJECTED",
          title: "AU abgelehnt — Urlaubstage bleiben angerechnet",
          message:
            `Die eingereichte AU wurde abgelehnt: ${body.reason}. Die Urlaubstage bleiben ` +
            `vorerst angerechnet. Sobald eine gültige AU vorliegt, kann der Vorgang erneut ` +
            `geöffnet werden.`,
          link: "/leave",
          tenantId: req.user.tenantId,
          relatedType: "Section9Credit",
          relatedId: credit.id,
        });
      }

      return reply.send({ id: credit.id, status: "REJECTED" });
    },
  });

  // ── POST /section9/:id/reopen — abgelehnten Vorgang wieder eröffnen (D-11) ───
  app.post("/section9/:id/reopen", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("section9:decide:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };

      const credit = await app.prisma.section9Credit.findFirst({
        where: { id },
        include: { employee: { select: { id: true, tenantId: true, userId: true } } },
      });
      if (!credit) return reply.code(404).send({ error: "§-9-Vorgang nicht gefunden" });

      if (credit.employee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "Section9Credit",
          entityId: id,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "§-9-Vorgang nicht gefunden" });
      }

      // Phase 91b Plan 04 (Issue #91), D-10/D-14 — scope check: a ZUGEWIESEN-scoped manager may
      // only decide a § 9 case for an employee whose Stammsalon at the credit's own overlapStart
      // (the credit's own period-start field, D-09-era computed at detection time) is in scope.
      {
        const access = accessContextFromRequest(req);
        const scopeReach = await resolveAccessReach(
          app.prisma,
          access,
          "section9:decide:ZUGEWIESEN",
        );
        if (
          !(await isStammsalonScopeMatch(
            app.prisma,
            req.user.tenantId,
            scopeReach,
            credit.employeeId,
            credit.overlapStart,
          ))
        ) {
          await app.audit({
            userId: req.user.sub,
            action: "SCOPE_ACCESS_DENIED",
            entity: "Section9Credit",
            entityId: id,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
          return reply.code(404).send({ error: "§-9-Vorgang nicht gefunden" });
        }
      }

      if (credit.status !== "REJECTED") {
        return reply
          .code(400)
          .send({ error: "Nur abgelehnte Vorgänge können wieder eröffnet werden." });
      }

      await app.prisma.$transaction(async (tx) => {
        // `reason` bleibt bewusst erhalten (Revisionssicherheit) — die Begründung der
        // früheren Ablehnung bleibt auf dem Datensatz nachvollziehbar, statt überschrieben
        // zu werden.
        await tx.section9Credit.update({
          where: { id: credit.id },
          data: { status: "AU_PENDING", reviewedBy: null, reviewedAt: null },
        });
        await app.audit({
          userId: req.user.sub,
          action: "SECTION9_CREDIT_REOPENED",
          entity: "Section9Credit",
          entityId: credit.id,
          oldValue: { status: credit.status },
          newValue: { status: "AU_PENDING" },
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
          tx,
        });
      });

      // Re-emit the same D-14 notifications the original detection sent — reusing the
      // exact copy from Phase 104-05, not a second wording.
      const rangeLabel = `${formatDateDe(credit.overlapStart)} – ${formatDateDe(credit.overlapEnd)}`;
      if (credit.employee.userId) {
        await app.notify({
          userId: credit.employee.userId,
          type: "SECTION9_AU_PENDING_EMPLOYEE",
          title: "AU nachreichen — Urlaubstage stehen auf dem Spiel",
          message:
            `Für ${rangeLabel} liegt eine Krankmeldung während Ihres genehmigten Urlaubs vor. ` +
            `Ohne ärztliche Bescheinigung bleiben diese Urlaubstage angerechnet (§ 9 BUrlG).`,
          link: "/leave",
          tenantId: credit.employee.tenantId,
          relatedType: "Section9Credit",
          relatedId: credit.id,
        });
      }
      // Phase 75b Plan 10 (#75), D-16: holders of section9:decide replace the legacy A,M role
      // predicate — the recorded recipient set (skipping the acting manager) is unchanged.
      const reopenSection9DecideHolderIds = await userIdsHoldingPermission(
        app.prisma,
        credit.employee.tenantId,
        "section9:decide:ZUGEWIESEN",
      );
      // Phase 91b Plan 09 (Issue #91), D-17: same rule as the detection-time notification above —
      // Stammsalon-only (D-10), Stichtag = the credit's own overlap period start.
      const scopedReopenSection9DecideHolderIds = await resolveScopedHolderIds(
        app.prisma,
        credit.employee.tenantId,
        reopenSection9DecideHolderIds,
        "section9:decide:ZUGEWIESEN",
        (reach) =>
          isStammsalonScopeMatch(
            app.prisma,
            credit.employee.tenantId,
            reach,
            credit.employeeId,
            credit.overlapStart,
          ),
      );
      const section9Managers = await app.prisma.employee.findMany({
        where: {
          tenantId: credit.employee.tenantId,
          user: {
            id: { in: scopedReopenSection9DecideHolderIds, not: req.user.sub },
            isActive: true,
          },
        },
        select: { userId: true },
      });
      for (const mgr of section9Managers) {
        await app.notify({
          userId: mgr.userId,
          type: "SECTION9_AU_PENDING_MANAGER",
          title: "§ 9 BUrlG — AU-Nachweis ausstehend",
          message: `Krankmeldung während genehmigten Urlaubs (${rangeLabel}). Sobald die AU vorliegt, bitte bestätigen.`,
          link: `/team/leave?section9=${credit.id}`,
          tenantId: credit.employee.tenantId,
          relatedType: "Section9Credit",
          relatedId: credit.id,
        });
      }

      return reply.send({ id: credit.id, status: "AU_PENDING" });
    },
  });
}

/**
 * Thrown inside the § 9 confirm transaction to roll it back when the credit would book
 * nothing because the target year has no LeaveEntitlement row (IN-05). Never escapes the
 * handler — it is translated into a 409 with the missing year named.
 */
class Section9MissingEntitlementError extends Error {
  constructor() {
    super("SECTION9_MISSING_ENTITLEMENT");
    this.name = "Section9MissingEntitlementError";
  }
}

// calculateWorkDays moved to ../utils/calculate-work-days (Phase 61).
