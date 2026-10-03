import { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { LeaveRequestStatus, Prisma } from "@clokr/db";
import { requireAuth } from "../../../middleware/auth";
import { generateICal, addOneDay, type ICalEvent } from "../ical";
import {
  shiftBasedLeaveMinutesForRequest, // Issue #429, D-13 — receipt shares the saldo's per-week formula
  mondayOfWeekUtc, // Phase 430 Plan 04 (D-15) — the one shared Monday derivation
} from "../vacation-calc"; // Phase 107 (D-04/D-09)
import { selfHealUsedDays, loadVacationTypeMeta } from "../leave-self-heal";
import { computeAffectedMonths, closedMonthLeaveMessage } from "../correction-lock"; // Issue #446 (D-07/D-08)
import { findClosedMonthsInRange } from "../closed-month-guard"; // Issue #446 (D-07)
import { EFFECTIVE_LEAVE_STATUSES } from "../effective-leave-statuses"; // Issue #446 (D-04)
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
  recalculateCarryOver,
  contractWorkDaysPerWeekFrom, // Issue #429, D-13 — the scheduledLeaveMinutes SHIFT_BASED branch below
  usualWorkDaysFrom, // Issue #436, D-03 — the same branch, threading the Angabe into the receipt
  type LeaveDaysPricing, // Issue #436, D-04/D-09
} from "../leave-days";
import { BS_ONLY_LEAVE_ERROR, BS_ONLY_LEAVE_ERROR_CODE } from "../bs-leave-days"; // Issue #448 (D-02)
import { vocationalSchoolDatesForLeaveRequests } from "../bs-leave-days"; // Issue #448 (D-05, plan 03)
import { vocationalSchoolDateSet } from "../bs-leave-days"; // Issue #468 (D-01) — same BS exclusion the saldo uses
import { formatMinutesHM } from "../format-hm"; // Phase 100
import {
  flagShiftsConflictingWithLeave,
  notifyShiftLeaveConflicts, // Phase 100B Plan 05 — S1/S2; Phase 430 (D-02) — shared audit+notify helper
  getShiftsInRange, // Phase 430 Plan 04 (D-15) — rosterImported on GET /hours-preview
} from "../../scheduling";
import {
  getOvertimeAccount,
  bookOvertimeCompensation,
  reverseOvertimeCompensation,
  isMonthClosed,
  getTenantTimezone,
  monthRangeUtc,
  recalculateSnapshots,
  getConfirmedCarryOver,
  loadNegativeBalanceTolerance,
  calcLeaveAbsenceMinutesTz, // Issue #468 (D-01) — the saldo's own per-row credit/withdrawal
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
} from "../../platform"; // Quick 260824-cjd
import { preserveCarryOverDeadline } from "../illness-carryover-guard"; // Phase 104, Issue #445 (D-17)
import {
  findSection9Overlaps,
  intersectRanges,
  planSection9CreditsForCorrection,
} from "../section9-detect"; // Phase 104-05/06, Issue #468 (D-04/A-3)
import { isSickLeaveTypeCode } from "../leave-type"; // Phase 97 (T2) — code-based, replacing the removed section9-detect.ts name helper
import { karenzOverrunFromRequests, normalizeKarenzDays } from "../find-karenz-overrun-days"; // Phase 104 gap closure (D-21)
import {
  ensureRegularVacationEntitlement,
  daysDiffer,
  CARRY_OVER_RECALC_REASON,
  REGULAR_ENTITLEMENT_REASON_LEAVE_REQUEST,
  REGULAR_ENTITLEMENT_REASON_ROLLOVER,
  REGULAR_ENTITLEMENT_REASON_SELF_HEAL,
  vacationEntitlementWarning, // Issue #445 — one function builds the warning string (no business rule in composition/reports.ts)
  splitLeaveDaysByYear, // Issue #445 (D-08/D-09) — chronological cross-year attribution
  healEntitlementUsedDays, // Issue #445 (D-10) — injected into leave-self-heal.ts's ctx below
  effectiveCarryOverDays, // Issue #445 (D-13) — the FIFO expiry check (replaces the removed local helper)
  carryOverRemainder, // Issue #445 (D-14) — replaces the raw totalDays+carriedOverDays-usedDays sum
  syncExitYearVacationEntitlement, // Issue #447 (D-06/D-07) — exit-year row sync, GET-time heal
  exitVacationOverUseWarning, // Issue #447 (D-08) — the one over-use warning string (approval + GET)
} from "../leave-days"; // Issue #445 — own statement: PR #437 edits the block above
import { writeEntitlementAudit } from "../entitlement-audit"; // Issue #445
import { revalidateLeaveCancellationEntries } from "../../time-tracking"; // Phase 100B Plan 08 — T6
import {
  REQUESTABLE_CODES as TYPE_CODES,
  LEAVE_TYPE_DEFS,
  LEAVE_REQUEST_EMAIL_SUBJECT,
  leaveTypeFields,
  DISPLAY_NAME,
} from "../leave-type"; // Phase 97 (T2, D-04) — the one mapping; DISPLAY_NAME added Phase 98b (D-04)
import type { RequestableCode } from "../leave-type"; // Phase 98b (D-01) — request-side type

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
type DbClient = FastifyInstance["prisma"] | Prisma.TransactionClient;

// ── Feste Abwesenheitstypen ──────────────────────────────────────────────────
// Phase 97 (T2, D-04): the nine codes, their German display names and the legacy seed aliases
// now live in ONE place, `utils/leave-type.ts`. `TYPE_CODES` is a transitional import alias so
// that move touched no call site. `LEAVE_TYPE_LEGACY_ALIASES` (formerly imported here as
// `LEGACY_ALIASES`) was removed with issue #206 once `ensureLeaveType()`'s legacy-name self-heal
// step — its only caller in this file — was removed; the name-to-code mapping still lives in
// `leave-type.ts` for its other caller.
//
// `RequestableCode`, not `LeaveTypeCode` (Phase 98b, D-01): `ensureLeaveType()` resolves a
// `LeaveType` row, and a `LeaveType` row never exists for an imposed absence — every one of its
// call sites only ever passes a requestable code.
type TypeCode = RequestableCode;

/**
 * Resolves the LeaveType row for `tenantId` / `code`, creating it when absent. Returns its id.
 *
 * Phase 97 (T2, AC-1): the CODE is the identity. `name` is display text a tenant may rename
 * freely (AC-2), so this function never rewrites the name of a row that already has a code.
 *
 * Two steps: an identity lookup by `{ tenantId, code }`, then a P2002-guarded create for the
 * first request of a given code. Issue #206 made `LeaveType.code` NOT NULL in the database, so
 * a row with no code can no longer exist; the self-heal step that used to repair one (a one-time
 * migration path for rows written before the phase-97 backfill, or by the OLD image during a
 * rolling-deploy window, D-21) is gone — its target row is unreachable by construction, not
 * merely unused, and the six preconditions measured against int/prod on 2026-09-23 (recorded on
 * issue #206) confirm no such row survived to this point.
 *
 * Auditing: unchanged from the pre-phase-97 implementation — this find-or-create writes no
 * AuditLog row and did not before either. Not a regression introduced here; tracked as the
 * pre-existing gap it is.
 *
 * Review WR-01 (phase 97): step 2's create is P2002-guarded — step 1 above is a
 * check-then-create race, so two concurrent first-time requests for the same code can both
 * reach the create. The loser re-reads by `{ tenantId, code }` and resolves to the winner's
 * row instead of surfacing a bare 500. If that re-read comes up empty, the P2002 did not come
 * from `@@unique([tenantId, code])` (the model also carries `@@unique([tenantId, name])`) and
 * is rethrown unchanged rather than guessed at.
 */
async function ensureLeaveType(
  prisma: FastifyInstance["prisma"],
  log: FastifyInstance["log"],
  tenantId: string,
  code: TypeCode,
): Promise<string> {
  // 1. Identity path.
  const byCode = await prisma.leaveType.findFirst({ where: { tenantId, code } });
  if (byCode) return byCode.id;

  // 2. Create. leaveTypeFields() makes code and name structurally inseparable.
  //
  // Review WR-01 (phase 97): step 1 above is a check-then-create race. Two concurrent
  // first-time requests for the same (tenantId, code) both pass them and both arrive here;
  // @@unique([tenantId, code]) lets exactly one win and raises P2002 on the loser, which
  // used to surface as a bare HTTP 500 for an operation that had in fact succeeded. Same
  // race class, same shape as the Section9Credit create below ("§ 9: concurrent detection
  // lost the race"). Not a phase-97 regression — the name-keyed version had the same gap.
  try {
    const created = await prisma.leaveType.create({ data: { tenantId, ...leaveTypeFields(code) } });
    return created.id;
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: unknown }).code === "P2002"
    ) {
      // The winner committed between our step-1 read and this create — re-read and use it.
      const winner = await prisma.leaveType.findFirst({ where: { tenantId, code } });
      if (winner) {
        log.info(
          { tenantId, code },
          "LeaveType: concurrent create lost the race, row already exists",
        );
        return winner.id;
      }
      // No row for this code, so the P2002 did NOT come from @@unique([tenantId, code]) —
      // LeaveType also carries @@unique([tenantId, name]), which a tenant-renamed row can
      // violate. There is no id to return here, and returning any other type's id would
      // book the request onto the WRONG absence type. Fall through and rethrow unchanged.
    }
    throw err;
  }
}

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
});

/**
 * German date label for USER-FACING § 9 notification texts: "16.09.2026".
 *
 * Phase 104 follow-up (not in REVIEW.md, owner-reported): the § 9 notification bodies rendered
 * dates ISO-style ("2026-09-16 – 2026-09-17") while everything else user-facing in this app
 * uses DD.MM.YYYY. UTC accessors on purpose — every date fed in here is a @db.Date column
 * (UTC midnight), so a local-time formatter would shift the label by a day on any host with a
 * negative UTC offset (the same class of bug as WR-09). API payloads and AuditLog values keep
 * their ISO form; only the human-readable message text changes.
 */
function formatDateDe(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

/**
 * The ONE visibility decision behind an absence TYPE, shared by GET /overlap and GET /calendar
 * (Phase 262, GitHub issue #262, D-06): may this viewer learn `typeCode`/`typeName` (and, for
 * /calendar, `section9`/`section9Days`) for this entry, or must it be masked to `null`?
 *
 * `canSeeAll` is `hasPermission(req, "leave-request:read:ZUGEWIESEN")`, computed once per request
 * by the caller (Phase 75b, Issue #75, D-13) rather than re-derived per row — mirrors the
 * reasoning in `apps/web/src/lib/leave/team-calendar-visibility.ts`'s `canSeeLeaveType` (Phase
 * 257, D-06 in 262-CONTEXT.md): the masking decision must not silently widen for an unexpected
 * value on the PERMISSIVE side — the side that leaks.
 *
 * Deliberately module-private, NOT exported via `contexts/absence/index.ts`: no caller outside
 * this file exists yet (D-15b). GitHub issue #267 (`GET /shifts/week`'s ungated "sick" bucket)
 * is the case that would change that — making it public is issue #267's first task, not this
 * one's, per "no generalization on spec" (ADR 0001).
 */
function canSeeLeaveType(isOwn: boolean, canSeeAll: boolean): boolean {
  return isOwn === true || canSeeAll;
}

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

      // Issue #446 (D-06(a)/D-09/D-10): checked before any read-dependent computation and
      // before every write — a range touching a closed month is rejected as a whole, naming
      // every closed month it spans (never just the first one found).
      const closedMonths = await findClosedMonthsInRange(
        app.prisma,
        employeeId,
        tenantId,
        start,
        end,
      );
      if (closedMonths.length > 0) {
        return reply.code(409).send({
          error: closedMonthLeaveMessage(closedMonths, "request"),
          code: "LEAVE_MONTH_CLOSED",
        });
      }

      const holidayMap = await getHolidayMap(app.prisma, tenantId, employeeId, start, end);
      const holidays = new Set(holidayMap.keys());
      // Phase 107 (D-09): roster-aware estimate from creation onward, so the number does not
      // visibly jump at approval. daysProvisional itself stays null until approval (D-10) --
      // only `.days` is used here, `.provisional` is deliberately discarded.
      // Issue #436 (D-04): priced against the employee's other counted VACATION requests
      // sharing an ISO week — no id yet, so there is nothing to exclude.
      const { days, vocationalSchoolOnly } = await resolveLeaveDays(
        app.prisma,
        employeeId,
        tenantId,
        start,
        end,
        body.halfDay,
        holidays,
        { mode: "request", leaveTypeCode: body.type },
      );

      // Issue #448 (D-02): a request whose every chargeable day is a Berufsschultag is
      // rejected before any write — the owner's binding text (01.10.2026), no LeaveRequest row
      // is ever created.
      if (vocationalSchoolOnly) {
        return reply.code(400).send({ error: BS_ONLY_LEAVE_ERROR, code: BS_ONLY_LEAVE_ERROR_CODE });
      }

      // Überschneidung mit eigenem Antrag prüfen.
      //
      // Phase 104 / R1: § 9 BUrlG — wird ein Mitarbeiter während genehmigten Urlaubs krank,
      // dürfen die attestierten Tage nicht auf den Jahresurlaub angerechnet werden. Bis
      // Phase 104 blockte dieser Guard genau diesen Fall mit 409, weshalb Manager ersatzweise
      // stornierten und in der Vier-Augen-Sackgasse landeten.
      //
      // Die Ausnahme ist BEWUSST eng und gerichtet (Pitfall 4): erlaubt ist ausschließlich
      // eine SICK/SICK_CHILD-Meldung über einem bereits GENEHMIGTEN Nicht-Krank-Antrag.
      // Gleichartige Überschneidungen (Urlaub/Urlaub, Krank/Krank) und Überschneidungen mit
      // noch PENDING-Anträgen bleiben unverändert gesperrt — ein Blanko-Entfernen des Guards
      // würde die Doppelbuchung wieder öffnen, gegen die er existiert.
      const isSickRequest = body.type === "SICK" || body.type === "SICK_CHILD";
      const overlaps = await app.prisma.leaveRequest.findMany({
        where: {
          employeeId,
          deletedAt: null,
          status: { in: ["PENDING", "APPROVED"] },
          startDate: { lte: end },
          endDate: { gte: start },
        },
        include: { leaveType: true },
      });
      const blockingOverlap = overlaps.find((o) => {
        if (!isSickRequest) return true; // non-sick: unchanged behaviour
        if (o.status !== "APPROVED") return true; // sick vs PENDING: still blocked
        if (isSickLeaveTypeCode(o.leaveType.code)) return true; // sick vs sick: still blocked
        return false; // § 9 case — permitted
      });
      if (blockingOverlap)
        return reply.code(409).send({ error: "Überschneidung mit bestehendem Antrag" });

      // Load tenant config for leave rules
      const tenantConfig = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });

      const leaveTypeId = await ensureLeaveType(app.prisma, app.log, tenantId, body.type);
      const leaveType = await app.prisma.leaveType.findUnique({ where: { id: leaveTypeId } });

      // ── Half-day sick rejection ──
      // Legal: teilweise Arbeitsunfähigkeit gibt es nicht; Krankheit wird immer
      // ganztägig gutgeschrieben (EFZG §3/§4). Half-day only applies to vacation.
      if (body.halfDay && ["SICK", "SICK_CHILD"].includes(body.type)) {
        return reply.code(400).send({
          error:
            "Halbe Kranktage sind nicht zulässig — Krankheit wird immer ganztägig gutgeschrieben.",
        });
      }

      // ── Half-day check ──
      if (body.halfDay) {
        const globalHalfDay = tenantConfig?.halfDayAllowed ?? true;
        const typeHalfDay = leaveType?.allowHalfDay ?? true;
        if (!globalHalfDay || !typeHalfDay) {
          return reply
            .code(400)
            .send({ error: "Halbe Tage sind für diesen Abwesenheitstyp nicht erlaubt" });
        }
      }

      // ── Lead time check (not for sick types) ──
      const isSickType = ["SICK", "SICK_CHILD"].includes(body.type);
      if (!isSickType) {
        const leadTimeDays = leaveType?.leadTimeDays ?? tenantConfig?.vacationLeadTimeDays ?? 0;
        if (leadTimeDays > 0) {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const diffMs = start.getTime() - today.getTime();
          const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
          if (diffDays < leadTimeDays) {
            return reply.code(400).send({
              error: `Abwesenheit muss mindestens ${leadTimeDays} Tage im Voraus beantragt werden`,
            });
          }
        }

        // ── Max advance months check ──
        const maxAdvanceMonths = tenantConfig?.vacationMaxAdvanceMonths ?? 0;
        if (maxAdvanceMonths > 0) {
          const maxDate = new Date();
          maxDate.setMonth(maxDate.getMonth() + maxAdvanceMonths);
          if (end > maxDate) {
            return reply.code(400).send({
              error: `Abwesenheit darf maximal ${maxAdvanceMonths} Monate im Voraus beantragt werden`,
            });
          }
        }
      }

      // ── Max days per year check ──
      if (leaveType?.maxDaysPerYear) {
        const yearStart = new Date(start.getFullYear(), 0, 1);
        const yearEnd = new Date(start.getFullYear(), 11, 31);
        const usedThisYear = await app.prisma.leaveRequest.aggregate({
          where: {
            employeeId,
            leaveTypeId,
            deletedAt: null,
            status: { in: ["PENDING", "APPROVED"] },
            startDate: { gte: yearStart, lte: yearEnd },
          },
          _sum: { days: true },
        });
        const used = Number(usedThisYear._sum.days ?? 0);
        if (used + days > leaveType.maxDaysPerYear) {
          return reply.code(400).send({
            error: `Max. ${leaveType.maxDaysPerYear} Tage/Jahr für diesen Typ (bereits ${used} genutzt)`,
          });
        }
      }

      // Für VACATION: Resturlaub auto-übertragen (lazy) + verfügbare Tage prüfen
      //
      // Issue #445 (D-08/D-09/P-15): UTC year boundaries, symmetric with deductVacationDays()/
      // reverseVacationDays(). A cross-year request is split chronologically through
      // splitLeaveDaysByYear() — the SAME day count the request itself was priced with above
      // (resolveLeaveDays) — instead of re-deriving each year's count from the placeholder
      // workDays array via splitDaysAcrossYears (a missing row used to also skip this entirely,
      // see the ensureRegularVacationEntitlement calls below, D-04).
      if (body.type === "VACATION") {
        const year1 = start.getUTCFullYear();
        const year2 = end.getUTCFullYear();
        const isCrossYear = year1 !== year2;

        const split = isCrossYear
          ? await splitLeaveDaysByYear(app.prisma, employeeId, tenantId, start, end, days, holidays)
          : { year1Days: days, year2Days: 0, year1, year2 };

        // ── Year 1: check entitlement ──
        await autoCarryOver(app.prisma, tenantId, employeeId, leaveTypeId, year1);
        // Issue #445 D-04: a missing row used to skip the availability check entirely —
        // ensureRegularVacationEntitlement() creates it (with the regular entitlement, never a
        // hard-coded zero) before the check below ever runs.
        const { entitlement: ent1 } = await ensureRegularVacationEntitlement(
          app.prisma,
          employeeId,
          tenantId,
          year1,
          leaveTypeId,
          REGULAR_ENTITLEMENT_REASON_LEAVE_REQUEST,
        );
        if (split.year1Days > 0) {
          // EuGH C-684/16: pre-fetch whether a warning was issued for this entitlement
          const hinweis1 =
            (await app.prisma.auditLog.count({
              where: { action: "CARRYOVER_WARNED", entity: "LeaveEntitlement", entityId: ent1.id },
            })) > 0;
          const co1 = await effectiveCarryOverDays(
            app.prisma,
            { ...ent1, tenantId },
            start,
            hinweis1,
          );
          // Issue #447 (D-06) — the row is exit-aware (ensureRegularVacationEntitlement synced
          // it just above) and carry-over is never pro-rated (§ 7 Abs. 3 BUrlG), so totalDays +
          // effective carry − used is the whole rule. No second exit-pro-rata reduction is
          // applied on top (the old H1-exit branch double-reduced an already-exit-prorated row).
          const avail1 = Number(ent1.totalDays) + co1 - Number(ent1.usedDays);

          if (split.year1Days > avail1) {
            return reply.code(400).send({
              error: `Nicht genug Urlaubstage in ${year1}`,
              available: avail1,
              requested: split.year1Days,
            });
          }
        }

        // ── Year 2: check entitlement (cross-year only) ──
        if (isCrossYear && split.year2Days > 0) {
          await autoCarryOver(app.prisma, tenantId, employeeId, leaveTypeId, year2);

          // Recalculate projected carry-over for year 2
          // (remaining from year 1 after this booking)
          await recalculateCarryOver(app.prisma, tenantId, employeeId, leaveTypeId, year2);

          // Issue #445 D-04: same reasoning as year 1 — a missing row used to skip this check
          // entirely.
          const { entitlement: ent2 } = await ensureRegularVacationEntitlement(
            app.prisma,
            employeeId,
            tenantId,
            year2,
            leaveTypeId,
            REGULAR_ENTITLEMENT_REASON_LEAVE_REQUEST,
          );
          // EuGH C-684/16: pre-fetch whether a warning was issued for this entitlement
          const hinweis2 =
            (await app.prisma.auditLog.count({
              where: {
                action: "CARRYOVER_WARNED",
                entity: "LeaveEntitlement",
                entityId: ent2.id,
              },
            })) > 0;
          const co2 = await effectiveCarryOverDays(
            app.prisma,
            { ...ent2, tenantId },
            end,
            hinweis2,
          );
          // Issue #447 (D-06) — same rule as year 1: ent2 is already exit-aware, no second
          // exit-pro-rata cap on top.
          const avail2 = Number(ent2.totalDays) + co2 - Number(ent2.usedDays);

          if (split.year2Days > avail2) {
            return reply.code(400).send({
              error: `Nicht genug Urlaubstage in ${year2}`,
              available: avail2,
              requested: split.year2Days,
            });
          }
        }
      }

      // Für OVERTIME_COMP: Überstundensaldo prüfen (basierend auf echtem Stundenplan)
      //
      // Code review (owner) — this used to read OvertimeAccount.balanceHours directly, the
      // SAME stale event-driven source 97-CONTEXT names as wrong (v1.8.24 already overrides it
      // at read time everywhere else) and, worse, the LIVE total (confirmed + open-month
      // forecast), while the leave form's own affordability UI (97-06) validates against the
      // CONFIRMED (closed-month) carry-over only — never against a forecast that can still
      // erode. This is a WRITE path touching entitlement, so {@link overtimeCompBalanceRejection}'s
      // fail-safe branch intentionally falls back to the PRE-EXISTING stored-balance check (never
      // 500, never silently permits an unbounded request) rather than inventing a new default.
      // Issue #468 (D-01): the needed amount comes from `scheduledLeaveMinutes` — the SAME
      // function the saldo and the booking/reversal use — not a `{day}Hours` placeholder sum.
      if (body.type === "OVERTIME_COMP") {
        const tzForGate = await getTenantTimezone(app.prisma, tenantId);
        const neededMinutes = await scheduledLeaveMinutes(
          app.prisma,
          employeeId,
          tenantId,
          start,
          end,
          body.halfDay,
          holidays,
          tzForGate,
        );
        const rejection = await overtimeCompBalanceRejection(
          app,
          employeeId,
          tenantId,
          neededMinutes,
        );
        if (rejection) {
          return reply.code(400).send(rejection);
        }
      }

      // Für SPECIAL: specialLeaveRuleId required, validate days against rule
      if (body.type === "SPECIAL") {
        if (!body.specialLeaveRuleId) {
          return reply
            .code(400)
            .send({ error: "Sonderurlaub erfordert einen Anlass (specialLeaveRuleId)" });
        }
        // #223: SpecialLeaveRule has its own tenantId — a client-supplied
        // specialLeaveRuleId must be scoped to the caller's tenant, otherwise a
        // tenant could reference (and consume) another tenant's rule. findUnique
        // cannot take a second field, hence findFirst.
        const rule = await app.prisma.specialLeaveRule.findFirst({
          where: { id: body.specialLeaveRuleId, tenantId },
        });
        if (!rule || !rule.isActive) {
          return reply
            .code(400)
            .send({ error: "Ungültiger oder deaktivierter Sonderurlaubs-Anlass" });
        }
        if (days > Number(rule.defaultDays)) {
          return reply.code(400).send({
            error: `Max. ${Number(rule.defaultDays)} Tage für "${rule.name}" (beantragt: ${days})`,
          });
        }
      }

      const request = await app.prisma.leaveRequest.create({
        data: {
          employeeId,
          leaveTypeId,
          specialLeaveRuleId: body.specialLeaveRuleId ?? null,
          startDate: start,
          endDate: end,
          days,
          halfDay: body.halfDay,
          note: body.note,
        },
        include: {
          leaveType: true,
          employee: { select: { firstName: true, lastName: true } },
        },
      });

      await app.audit({
        userId: req.user.sub,
        action: "CREATE",
        entity: "LeaveRequest",
        entityId: request.id,
        newValue: {
          type: body.type,
          startDate: body.startDate,
          endDate: body.endDate,
          days,
          ...(isOnBehalfOf && {
            source: "MANAGER_CREATED",
            actorRole: req.user.role,
            targetEmployeeId: employeeId,
          }),
        },
      });

      // ── Benachrichtigung: Manager über neuen Antrag informieren ──
      // Issue #200: title and phrase both come from the single LEAVE_TYPE_DEFS mapping and are
      // display text only (ADR 0001, never compared). The mail subject is deliberately neutral
      // while the in-app title is type-specific (owner decision 2026-09-15).
      const typeDef = LEAVE_TYPE_DEFS[body.type];
      // Phase 75b Plan 10 (#75), D-16: holders of leave-request:approve replace the legacy A,M
      // role predicate — the recorded recipient set is unchanged (docs/permissions.md §
      // Empfängersuchen).
      const leaveRequestApproveHolderIds = await userIdsHoldingPermission(
        app.prisma,
        req.user.tenantId,
        "leave-request:approve:ZUGEWIESEN",
      );
      // Phase 91b Plan 09 (Issue #91), D-17: narrow the tenant-wide holder list to holders whose
      // OWN reach covers the request's own employee — Stammsalon-only (D-10), Stichtag = the
      // request's own startDate (the affected period, not "today").
      const scopedLeaveRequestApproveHolderIds = await resolveScopedHolderIds(
        app.prisma,
        req.user.tenantId,
        leaveRequestApproveHolderIds,
        "leave-request:approve:ZUGEWIESEN",
        (reach) =>
          isStammsalonScopeMatch(
            app.prisma,
            req.user.tenantId,
            reach,
            request.employeeId,
            request.startDate,
          ),
      );
      const managers = await app.prisma.user.findMany({
        where: {
          id: { in: scopedLeaveRequestApproveHolderIds },
          isActive: true,
          employee: { tenantId: req.user.tenantId },
        },
        select: { id: true },
      });
      for (const mgr of managers) {
        await app.notify({
          userId: mgr.id,
          type: "LEAVE_REQUEST",
          title: typeDef.notificationTitle,
          message: `${request.employee.firstName} ${request.employee.lastName} ${typeDef.requestPhrase} (${body.startDate} – ${body.endDate})`,
          // Manager-facing: link to the approval surface (/team/leave honors ?request=),
          // NOT /leave (which only shows the recipient's OWN requests).
          link: `/team/leave?request=${request.id}`,
          tenantId,
          relatedType: "LeaveRequest",
          relatedId: request.id,
          emailSubject: LEAVE_REQUEST_EMAIL_SUBJECT,
        });
      }

      return reply.code(201).send({
        ...request,
        typeCode: body.type,
        startDate: request.startDate.toISOString().split("T")[0],
        endDate: request.endDate.toISOString().split("T")[0],
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
      if (isManager) {
        const access = accessContextFromRequest(req);
        const reach = await resolveAccessReach(app.prisma, access, "leave-request:read:ZUGEWIESEN");
        if (reach.kind !== "wholeTenant") {
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

      const rows = await app.prisma.leaveRequest.findMany({
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
      if (!["PENDING", "CANCELLATION_REQUESTED"].includes(existing.status)) {
        return reply.code(409).send({ error: "Antrag kann nicht mehr geändert werden" });
      }

      // Block self-approval — managers cannot approve their own requests
      const reviewerEmployee = await app.prisma.employee.findFirst({
        where: { userId: req.user.sub },
        select: { id: true },
      });
      if (reviewerEmployee && existing.employeeId === reviewerEmployee.id) {
        return reply
          .code(403)
          .send({ error: "Eigene Anträge können nicht selbst genehmigt werden" });
      }

      // 4-eyes: block cancellation-approval by the person who requested the cancellation (COMP-V1814-02)
      if (existing.cancellationRequestedBy && req.user.sub === existing.cancellationRequestedBy) {
        return reply
          .code(403)
          .send({ error: "Stornierung kann nicht vom Antragsteller genehmigt werden" });
      }
      // 4-eyes: block cancellation-approval by the manager who originally approved the leave (COMP-V1814-02)
      if (existing.reviewedBy && req.user.sub === existing.reviewedBy) {
        return reply
          .code(403)
          .send({ error: "Stornierung kann nicht vom ursprünglichen Genehmiger genehmigt werden" });
      }

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

          // Stornierung genehmigen → CANCELLED + Rückbuchung
          await app.prisma.leaveRequest.update({
            where: { id },
            data: {
              status: "CANCELLED",
              reviewedBy: req.user.sub,
              reviewedAt: new Date(),
              reviewNote: body.reviewNote,
            },
          });

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
          if (typeCode === "VACATION") {
            // Issue #445 (D-11): a single-year decrement on existing.startDate's year used to
            // silently drop a cross-year request's year-2 portion and never recompute the next
            // year's carry-over. reverseVacationDays() splits per year chronologically
            // (D-08/D-09) and recomputes the next year's carry-over — the symmetric
            // counterpart of the deduct at booking time.
            const cancelHolidayMap = await getHolidayMap(
              app.prisma,
              existing.employee.tenantId,
              existing.employeeId,
              existing.startDate,
              existing.endDate,
            );
            await reverseVacationDays(
              app.prisma,
              existing.employeeId,
              existing.leaveTypeId,
              existing.startDate,
              existing.endDate,
              Number(existing.days),
              new Set(cancelHolidayMap.keys()),
              existing.employee.tenantId,
            );
          }
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
            let reversalMinutes: number;
            let reversalSource: "stored" | "recomputed";
            if (existing.overtimeCompMinutes != null) {
              reversalMinutes = existing.overtimeCompMinutes;
              reversalSource = "stored";
            } else {
              const hMap = await getHolidayMap(
                app.prisma,
                tenantIdForReversal,
                existing.employeeId,
                existing.startDate,
                existing.endDate,
              );
              const tzForReversal = await getTenantTimezone(app.prisma, tenantIdForReversal);
              reversalMinutes = await scheduledLeaveMinutes(
                app.prisma,
                existing.employeeId,
                tenantIdForReversal,
                existing.startDate,
                existing.endDate,
                existing.halfDay,
                new Set(hMap.keys()),
                tzForReversal,
              );
              reversalSource = "recomputed";
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
            where: { id },
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
        // recalculation starts at the first snapshot whose periodStart >= startDate.
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
          where: { id },
          include: { employee: { select: { firstName: true, lastName: true } }, leaveType: true },
        });
        return {
          ...refreshed,
          typeCode: refreshed!.leaveType.code,
          startDate: refreshed!.startDate.toISOString().split("T")[0],
          endDate: refreshed!.endDate.toISOString().split("T")[0],
        };
      }

      // ── Normaler Antrag (PENDING) ────────────────────────────────────────────
      // Issue #446 (D-06(b)/D-10): gated on APPROVED only — a PENDING -> REJECTED review
      // stays allowed (saldo-neutral), checked before any read-dependent computation and
      // before the write below.
      if (body.status === "APPROVED") {
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
      }

      const reviewTypeCode = existing.leaveType.code;

      // Issue #294: the OVERTIME_COMP booking below is computed but NOT written where it is
      // decided — it is issued at the tail, in the SAME $transaction as the balance persist,
      // so a failed persist rolls the booking back with it instead of leaving an orphan receipt.
      // Issue #468 (A-4/D-02): `minutes` carried alongside `hours` — the exact integer value
      // stored on LeaveRequest.overtimeCompMinutes, written in the SAME transaction as the
      // REDUCTION journal row below.
      let pendingOvertimeBooking: {
        tenantId: string;
        hours: number;
        minutes: number;
        description: string;
      } | null = null;

      // Phase 107 (D-07/D-10, T-107-20): for an APPROVED SHIFT_BASED vacation request, recompute
      // `days` from the roster and determine `daysProvisional` BEFORE the update() call below, so
      // both land in the SAME write as the status flip — a second update() would leave a crash
      // window where a request is APPROVED with stale days and no flag. Builds the holiday map
      // once here and reuses it for deductVacationDays() further down. Every other type/branch
      // is untouched: `daysProvisional` stays `null`.
      let holidayMapForDeduct: Map<string, string> | null = null;
      let shiftBasedApprovalRecompute: { days: number; provisional: boolean } | null = null;
      if (body.status === "APPROVED" && reviewTypeCode === "VACATION") {
        holidayMapForDeduct = await getHolidayMap(
          app.prisma,
          existing.employee.tenantId,
          existing.employeeId,
          existing.startDate,
          existing.endDate,
        );
        const wsForApproval = await app.prisma.workSchedule.findFirst({
          where: { employeeId: existing.employeeId },
          orderBy: { validFrom: "desc" },
          select: { type: true },
        });
        if (wsForApproval?.type === "SHIFT_BASED") {
          // Issue #436 (D-04): approval recomputes against the other counted VACATION requests,
          // excluding this one — the ordering rule (createdAt, ties by id) keeps this request's
          // price stable whether it is approved before or after a sibling.
          shiftBasedApprovalRecompute = await resolveLeaveDays(
            app.prisma,
            existing.employeeId,
            existing.employee.tenantId,
            existing.startDate,
            existing.endDate,
            existing.halfDay,
            new Set(holidayMapForDeduct.keys()),
            { mode: "request", leaveTypeCode: reviewTypeCode, excludeRequestId: existing.id },
          );
        }
      }

      // Phase 120 (D-01/D-04): snapshot the pre-decision state BEFORE the update() below overwrites
      // `days`/`daysProvisional` (Phase 107 writes both in the same call that flips `status`). Reading
      // these values again after the write would return the NEW ones and silently produce an audit row
      // whose oldValue equals its newValue — the exact failure this phase exists to prevent.
      // `days` is a Prisma Decimal; JSON.stringify() would serialise it as a string, so Number() is
      // load-bearing, not cosmetic (it matches the LEAVE_DAYS_ADJUSTED row's numeric `days`).
      const auditOldValue = {
        status: existing.status,
        days: Number(existing.days),
        daysProvisional: existing.daysProvisional,
      };

      const updated = await app.prisma.leaveRequest.update({
        where: { id },
        data: {
          status: body.status,
          reviewedBy: req.user.sub,
          reviewedAt: new Date(),
          reviewNote: body.reviewNote,
          ...(shiftBasedApprovalRecompute
            ? {
                days: shiftBasedApprovalRecompute.days,
                daysProvisional: shiftBasedApprovalRecompute.provisional,
              }
            : {}),
        },
        include: {
          employee: { select: { firstName: true, lastName: true } },
          leaveType: true,
        },
      });

      if (body.status === "APPROVED") {
        const typeCode = reviewTypeCode;

        if (typeCode === "VACATION") {
          const empForDeduct = await app.prisma.employee.findUnique({
            where: { id: existing.employeeId },
          });
          await deductVacationDays(
            app.prisma,
            existing.employeeId,
            existing.leaveTypeId,
            existing.startDate,
            existing.endDate,
            Number(updated.days),
            new Set(holidayMapForDeduct!.keys()),
            empForDeduct?.tenantId ?? "",
          );
        }

        if (typeCode === "OVERTIME_COMP") {
          const empTenant = await app.prisma.employee.findUnique({
            where: { id: existing.employeeId },
            select: { tenantId: true },
          });
          const tenantIdForBooking = empTenant?.tenantId ?? "";
          const hMap = await getHolidayMap(
            app.prisma,
            tenantIdForBooking,
            existing.employeeId,
            existing.startDate,
            existing.endDate,
          );
          const tzForBooking = await getTenantTimezone(app.prisma, tenantIdForBooking);
          const bookingMinutes = await scheduledLeaveMinutes(
            app.prisma,
            existing.employeeId,
            tenantIdForBooking,
            existing.startDate,
            existing.endDate,
            existing.halfDay,
            new Set(hMap.keys()),
            tzForBooking,
          );
          pendingOvertimeBooking = {
            tenantId: tenantIdForBooking,
            hours: bookingMinutes / 60,
            minutes: bookingMinutes,
            description: `Überstundenausgleich ${existing.startDate.toISOString().split("T")[0]} – ${existing.endDate.toISOString().split("T")[0]}`,
          };
        }

        // ── § 9 BUrlG (Phase 104, D-09): Krank-im-Urlaub-Vorgang anlegen ──────────
        // Der Datensatz entsteht SOFORT bei Genehmigung der Krankmeldung, im wirkungslosen
        // Zustand AU_PENDING — die Urlaubstage bleiben angerechnet, bis ein Manager die AU
        // bestätigt (Plan 104-06). Nie gutschreiben und später zurückdrehen.
        // D-13: genau deshalb hängt die Erkennung am Approve-Pfad und nicht an POST /requests —
        // eine noch nicht genehmigte Krankmeldung darf keinen Vorgang erzeugen.
        if (typeCode === "SICK" || typeCode === "SICK_CHILD") {
          const candidates = await app.prisma.leaveRequest.findMany({
            where: {
              employeeId: existing.employeeId,
              deletedAt: null,
              status: "APPROVED",
              id: { not: existing.id },
              startDate: { lte: existing.endDate },
              endDate: { gte: existing.startDate },
            },
            include: { leaveType: true },
          });
          const overlaps = findSection9Overlaps(existing.startDate, existing.endDate, candidates);
          for (const ov of overlaps) {
            // Idempotent: re-running approve must not fan out duplicate Vorgänge.
            const dupe = await app.prisma.section9Credit.findFirst({
              where: { sickRequestId: existing.id, vacationRequestId: ov.vacationRequestId },
            });
            if (dupe) continue;
            // Phase 104 review (WR-03): the findFirst/create pair above is NOT in a
            // transaction, so it is a check-then-create race — two concurrent approvals
            // (double click, retry, a manager racing a cron path) both pass the guard.
            // @@unique([sickRequestId, vacationRequestId]) now closes it in the DB; the
            // loser of the race lands here as P2002 and is treated exactly like `dupe`:
            // the Vorgang already exists, so skip it silently rather than 500 the whole
            // approve. Without the constraint a second CONFIRMED row would double-credit
            // the vacation, and the double credit SURVIVES selfHealUsedDays() because the
            // self-heal trusts the credit sum.
            let credit;
            try {
              credit = await app.prisma.section9Credit.create({
                data: {
                  employeeId: existing.employeeId,
                  sickRequestId: existing.id,
                  vacationRequestId: ov.vacationRequestId,
                  overlapStart: ov.overlapStart,
                  overlapEnd: ov.overlapEnd,
                  // status defaults to AU_PENDING
                },
              });
            } catch (err: unknown) {
              if (
                err &&
                typeof err === "object" &&
                "code" in err &&
                (err as { code: unknown }).code === "P2002"
              ) {
                app.log.info(
                  { sickRequestId: existing.id, vacationRequestId: ov.vacationRequestId },
                  "§ 9: concurrent detection lost the race, Vorgang already exists",
                );
                continue;
              }
              throw err;
            }
            await app.audit({
              userId: req.user.sub,
              action: "SECTION9_CREDIT_DETECTED",
              entity: "Section9Credit",
              entityId: credit.id,
              newValue: {
                sickRequestId: existing.id,
                vacationRequestId: ov.vacationRequestId,
                overlapStart: ov.overlapStart.toISOString().split("T")[0],
                overlapEnd: ov.overlapEnd.toISOString().split("T")[0],
                note: "§ 9 BUrlG — Vorgang erkannt, AU ausstehend",
              },
              request: { ip: req.ip, headers: req.headers as Record<string, string> },
            });

            // ── D-14: beide Seiten benachrichtigen, über die bestehende Bell-Mechanik ──
            const employeeUser = await app.prisma.employee.findUnique({
              where: { id: existing.employeeId },
              select: { userId: true, tenantId: true },
            });
            // Phase 104 review (WR-05): in Prisma an `undefined` filter value means "omit
            // this filter", not "match nothing". Passing employeeUser?.tenantId into the
            // manager fan-out below would, if the row were ever missing, return EVERY
            // ADMIN/MANAGER across ALL tenants and notify each of them about a foreign
            // tenant's sickness period (plus a deep link into it). The FK is Restrict so
            // this should be unreachable — but the failure mode is a silent cross-tenant
            // broadcast, so it must not depend on that. The Vorgang itself is already
            // created and audited; only the notification fan-out is skipped.
            if (!employeeUser) {
              app.log.error(
                { employeeId: existing.employeeId, creditId: credit.id },
                "§ 9: employee row missing, skipping notification fan-out",
              );
              continue;
            }
            const rangeLabel = `${formatDateDe(ov.overlapStart)} – ${formatDateDe(ov.overlapEnd)}`;
            if (employeeUser.userId) {
              await app.notify({
                userId: employeeUser.userId,
                type: "SECTION9_AU_PENDING_EMPLOYEE",
                title: "AU nachreichen — Urlaubstage stehen auf dem Spiel",
                message:
                  `Für ${rangeLabel} liegt eine Krankmeldung während Ihres genehmigten Urlaubs vor. ` +
                  `Ohne ärztliche Bescheinigung bleiben diese Urlaubstage angerechnet (§ 9 BUrlG).`,
                link: "/leave",
                tenantId: employeeUser.tenantId,
                relatedType: "Section9Credit",
                relatedId: credit.id,
              });
            }
            // User has no tenantId column — tenant scoping goes through Employee.
            // Phase 75b Plan 10 (#75), D-16: holders of section9:decide replace the legacy A,M
            // role predicate — the recorded recipient set (skipping the acting manager) is
            // unchanged (docs/permissions.md § Empfängersuchen).
            const section9DecideHolderIds = await userIdsHoldingPermission(
              app.prisma,
              employeeUser.tenantId,
              "section9:decide:ZUGEWIESEN",
            );
            // Phase 91b Plan 09 (Issue #91), D-17: narrow to holders whose OWN reach covers this
            // Section9Credit's employee — Stammsalon-only (D-10), Stichtag = the credit's own
            // overlap period start.
            const scopedSection9DecideHolderIds = await resolveScopedHolderIds(
              app.prisma,
              employeeUser.tenantId,
              section9DecideHolderIds,
              "section9:decide:ZUGEWIESEN",
              (reach) =>
                isStammsalonScopeMatch(
                  app.prisma,
                  employeeUser.tenantId,
                  reach,
                  existing.employeeId,
                  ov.overlapStart,
                ),
            );
            const section9Managers = await app.prisma.employee.findMany({
              where: {
                tenantId: employeeUser.tenantId,
                user: {
                  id: { in: scopedSection9DecideHolderIds, not: req.user.sub }, // Phase-91 idiom: never notify the actor
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
                tenantId: employeeUser.tenantId,
                relatedType: "Section9Credit",
                relatedId: credit.id,
              });
            }
          }
        }
      }

      // Phase 120 (D-01/D-02/D-03): a value-changing operation records before AND after. BOTH actions
      // write the full pair — REJECT does not change `days`, and "unchanged" is a different statement
      // from "not recorded" in a revisionssichere Spur. `status` is part of the pair because only the
      // OLD status answers "was this a first approval or the reversal of a cancellation?".
      await app.audit({
        userId: req.user.sub,
        action: body.status === "APPROVED" ? "APPROVE" : "REJECT",
        entity: "LeaveRequest",
        entityId: id,
        oldValue: auditOldValue,
        newValue: {
          status: updated.status,
          days: Number(updated.days),
          daysProvisional: updated.daysProvisional,
          reviewNote: body.reviewNote,
        },
        // Phase 120 (D-12): CLAUDE.md §Audit-Proof names "userId, timestamp, IP, and before/after
        // values" in ONE sentence — this entry was missing two of those parts, not one. Same call site,
        // same rule, same phase. Verhaltensneutral: `request` is optional on `app.audit`
        // (plugins/audit.ts:13) and feeds nothing but `ipAddress`/`userAgent`.
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      // Retroactive recalculation: leave approval affects snapshots
      if (body.status === "APPROVED") {
        await recalculateSnapshots(app, existing.employeeId, existing.startDate).catch((err) =>
          app.log.error(
            { err, employeeId: existing.employeeId },
            "Failed to recalculate snapshots after leave approval",
          ),
        );

        // Issue #294: pure read BEFORE the transaction; booking (if any) then persist happen
        // inside ONE `$transaction` — no swallower any more, so a failed persist now answers
        // non-2xx instead of a silent 200 with a stale balance.
        const effectiveBalanceHours = await computeOvertimeBalanceHours(app, existing.employeeId);
        await app.prisma.$transaction(async (tx) => {
          if (pendingOvertimeBooking) {
            // Issue #468 (A-4/D-02): the booked minutes, the journal row and the audit commit
            // together or not at all — written BEFORE bookOvertimeCompensation so
            // "overtimeCompMinutes is set" <=> "the booking was written" even if a later
            // statement in this same transaction fails.
            await tx.leaveRequest.update({
              where: { id: existing.id },
              data: { overtimeCompMinutes: pendingOvertimeBooking.minutes },
            });
            await app.audit({
              tx,
              userId: req.user.sub,
              action: "OVERTIME_COMP_BOOKED",
              entity: "LeaveRequest",
              entityId: existing.id,
              newValue: {
                overtimeCompMinutes: pendingOvertimeBooking.minutes,
                hours: pendingOvertimeBooking.hours,
              },
              request: { ip: req.ip, headers: req.headers as Record<string, string> },
            });
            await bookOvertimeCompensation(
              tx,
              existing.employeeId,
              pendingOvertimeBooking.tenantId,
              pendingOvertimeBooking.hours,
              pendingOvertimeBooking.description,
            );
          }
          // null = §18-exempt: persist nothing, the booking above (if any) still stands as the
          // sole writer for that path.
          if (effectiveBalanceHours !== null) {
            await persistOvertimeBalance(app, tx, existing.employeeId, effectiveBalanceHours);
          }
        });

        // Phase 43-04: reverse-hook — when a leave is APPROVED, mark any
        // existing shifts for this employee on overlapping dates as
        // conflictsWithLeave=true (audit-proof: never silent-delete shifts).
        // Best-effort: never roll back the approval if marking fails.
        // Phase 100B Plan 05 — S2, contexts/scheduling facade (find + flag as ONE operation).
        try {
          const conflictingShifts = await flagShiftsConflictingWithLeave(
            app.prisma,
            existing.employeeId,
            existing.employee.tenantId,
            existing.startDate,
            existing.endDate,
          );

          if (conflictingShifts.length > 0) {
            // Phase 430 (D-02): the audit loop + recipient-resolution + notify loop that used to
            // live inline here are now ONE shared helper (`contexts/scheduling`), reused by the
            // Phorest sync and the manual shift-planning routes for the new (inverse) direction —
            // a shift created/updated on an already-approved leave day. Behaviour here is
            // byte-identical: same audit rows, same notification text/link, same recipients.
            const empName = await app.prisma.employee.findUnique({
              where: { id: existing.employeeId },
              select: { firstName: true, lastName: true, tenantId: true },
            });
            if (empName) {
              await notifyShiftLeaveConflicts(app, {
                actorUserId: req.user.sub,
                employeeId: existing.employeeId,
                tenantId: empName.tenantId,
                employeeName: { firstName: empName.firstName, lastName: empName.lastName },
                leaveRequestId: existing.id,
                leaveStart: existing.startDate,
                leaveEnd: existing.endDate,
                conflictingShifts,
                request: { ip: req.ip, headers: req.headers as Record<string, string> },
              });
            }
          }
        } catch (err) {
          // Reverse-hook is best-effort — never undo the approval on failure
          app.log.error(
            { err, leaveRequestId: existing.id },
            "Phase 43-04 reverse-hook (mark-conflicting shifts) failed",
          );
        }
      }

      // ── Pro-rata Urlaubswarnung bei Genehmigung (nur VACATION, nur bei exitDate) ──
      let proRataWarning: { used: number; entitlement: number; message: string } | undefined =
        undefined;
      if (body.status === "APPROVED") {
        const typeCodeForWarning = existing.leaveType.code;
        if (typeCodeForWarning === "VACATION") {
          try {
            const empWithExit = await app.prisma.employee.findUnique({
              where: { id: existing.employeeId },
              select: { exitDate: true, tenantId: true, firstName: true, lastName: true },
            });
            // Issue #447 (D-08): no first-half-year guard any more — § 5 Abs. 1 b BUrlG
            // Teilurlaub can also follow an exit in the second half-year, so a second-half exit
            // can over-use just as well; exitVacationOverUseWarning itself decides, from the
            // (already exit-synced, D-06) persisted row, whether used exceeds entitled.
            if (empWithExit?.exitDate) {
              // Issue #447 WR-01: exitDate is a UTC-midnight @db.Date value — use the UTC
              // accessor to match the sync code (getUTCFullYear()) that keyed the row.
              const exitYear = empWithExit.exitDate.getUTCFullYear();
              const vacLeaveType = await app.prisma.leaveType.findUnique({
                where: {
                  tenantId_code: { tenantId: empWithExit.tenantId, code: "VACATION" },
                },
              });
              if (vacLeaveType) {
                const entitlement = await app.prisma.leaveEntitlement.findFirst({
                  where: {
                    employeeId: existing.employeeId,
                    leaveTypeId: vacLeaveType.id,
                    year: exitYear,
                  },
                });
                if (entitlement) {
                  proRataWarning =
                    exitVacationOverUseWarning({
                      employeeName: `${empWithExit.firstName} ${empWithExit.lastName}`,
                      exitDate: empWithExit.exitDate,
                      row: entitlement,
                    }) ?? undefined;
                }
              }
            }
          } catch (err) {
            app.log.warn({ err }, "Pro-rata warning calculation failed silently in leave review");
          }
        }
      }

      // ── Benachrichtigung: Mitarbeiter über Entscheidung informieren ──
      const requestEmployee = await app.prisma.employee.findUnique({
        where: { id: existing.employeeId },
      });
      if (requestEmployee) {
        await app.notify({
          userId: requestEmployee.userId,
          type: body.status === "APPROVED" ? "LEAVE_APPROVED" : "LEAVE_REJECTED",
          title: body.status === "APPROVED" ? "Antrag genehmigt" : "Antrag abgelehnt",
          message: `Ihr ${existing.leaveType.name}-Antrag wurde ${body.status === "APPROVED" ? "genehmigt" : "abgelehnt"}.`,
          link: `/leave?request=${existing.id}`,
          tenantId: requestEmployee.tenantId,
        });
      }

      // Auto-dismiss manager LEAVE_REQUEST notifications for this request
      try {
        await app.dismissByRelated("LeaveRequest", existing.id);
      } catch (err) {
        app.log.warn(
          { err, leaveRequestId: existing.id },
          "Failed to auto-dismiss LEAVE_REQUEST notifications on review",
        );
      }

      return {
        ...updated,
        typeCode: updated.leaveType.code,
        startDate: updated.startDate.toISOString().split("T")[0],
        endDate: updated.endDate.toISOString().split("T")[0],
        // Issue #468 (A-4/D-02): `updated` was read BEFORE the tail transaction wrote
        // overtimeCompMinutes — reflect the just-booked value in the response without a
        // second round-trip.
        ...(pendingOvertimeBooking ? { overtimeCompMinutes: pendingOvertimeBooking.minutes } : {}),
        ...(proRataWarning ? { proRataWarning } : {}),
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

      // start <= end ist bereits durch correctSchema.refine (Zod → 400) garantiert.
      const start = new Date(body.startDate);
      const end = new Date(body.endDate);

      // ── Delta-Lock guard (EDIT-03 / T-94-01) ───────────────────────────────
      // Blocks (409) any correction whose CHANGED days (symmetric date diff; plus
      // retained days when type/halfDay changed) touch a finalized (locked) month.
      // The retained overlap of a shortened leave stays untouched, so shortening a
      // long Elternzeit at its unlocked tail is allowed even if early months closed.
      const existingTypeCode = existing.leaveType.code;
      const typeChanged = body.type != null && body.type !== existingTypeCode;
      const halfDayChanged = body.halfDay !== existing.halfDay;
      const affectedMonths = computeAffectedMonths({
        oldStart: existing.startDate,
        oldEnd: existing.endDate,
        newStart: start,
        newEnd: end,
        typeChanged,
        halfDayChanged,
      });

      // WR-94-01: a day-invariant metadata edit (note-only — identical dates, type
      // and halfDay) produces zero affected days, so the day-based delta-lock above
      // would wave it through. But Revisionssicherheit forbids editing an entry that
      // lies in a finalized (locked) month — even a note change fires a net-zero
      // reverse/apply pair against the locked year's entitlement ledger. When nothing
      // day-related changed but the note did, lock-check the FULL retained range.
      const noteChanged = (body.note ?? null) !== (existing.note ?? null);
      const monthsToCheck =
        affectedMonths.length === 0 && noteChanged
          ? computeAffectedMonths({
              oldStart: existing.startDate,
              oldEnd: existing.endDate,
              newStart: start,
              newEnd: end,
              typeChanged: true, // force the retained intersection into the affected set
              halfDayChanged: false,
            })
          : affectedMonths;

      if (monthsToCheck.length > 0) {
        const tz = await getTenantTimezone(app.prisma, existing.employee.tenantId);
        for (const { year, month } of monthsToCheck) {
          const { start: monthStart } = monthRangeUtc(year, month, tz);
          // Phase 100B Plan 07 (W1, isMonthClosed) — THE canonical Monatsabschluss signal.
          const locked = await isMonthClosed(
            app.prisma,
            existing.employeeId,
            existing.employee.tenantId,
            monthStart,
          );
          if (locked) {
            return reply.code(409).send({ error: "Gesperrter Monat — Korrektur nicht möglich" });
          }
        }
      }

      // ── Recalc model (94-02): REVERSE the OLD booking (by the OLD leaveType),
      //    then APPLY the NEW booking (by the NEW leaveType). Never branches on
      //    the effective type alone — that would leave a VACATION/OVERTIME_COMP
      //    day consumed when corrected INTO a sick type. All domain guards run
      //    PRE-WRITE so a rejected correction never leaves a partial saldo write.
      const tenantId = req.user.tenantId;
      const oldTypeCode = existingTypeCode; // from existing.leaveType.code (delta-lock step)
      const newType = body.type ?? oldTypeCode;

      // IN-94-01 (Phase 97, D-21) used to guard here: a LeaveType row whose `code` was NULL
      // (pre-backfill, or written by the old image during a rolling deploy) left oldTypeCode
      // undefined, and the reverse/apply dispatch below would silently fall through to a no-op —
      // updating dates/days WITHOUT adjusting the entitlement ledger (a stranded Kontingent).
      // Issue #206's migration (20260923090815_leave_type_code_not_null) tightened that column to
      // required, making that state impossible to construct: `existing.leaveType.code` is a
      // required `LeaveTypeCode` now, so `oldTypeCode` (and therefore `newType`) can never be
      // falsy for a real row. The assertion moved from this application guard into the database
      // constraint — it did not disappear.

      // ── Step 7a: half-day-sick reject (pre-write) — Krankheit ist immer ganztägig.
      if (body.halfDay && (newType === "SICK" || newType === "SICK_CHILD")) {
        return reply.code(400).send({
          error:
            "Halbe Kranktage sind nicht zulässig — Krankheit wird immer ganztägig gutgeschrieben.",
        });
      }

      // ── Step 7b: overlap guard (pre-write) for a CHANGED date range. Excludes
      //    the request itself (id:{not}). An identical-range correction (type/
      //    halfDay-only) introduces no new collision, so it is not re-checked.
      const dateChanged =
        start.getTime() !== existing.startDate.getTime() ||
        end.getTime() !== existing.endDate.getTime();
      if (dateChanged) {
        const overlaps = await app.prisma.leaveRequest.findMany({
          where: {
            employeeId: existing.employeeId,
            deletedAt: null,
            status: { in: ["PENDING", "APPROVED"] },
            startDate: { lte: end },
            endDate: { gte: start },
            id: { not: existing.id },
          },
          include: { leaveType: true },
        });
        // Issue #468 (Rule 1/3 auto-fix, blocking): the R1 exception from POST /requests
        // (leave.ts above, "§ 9 BUrlG — wird ein Mitarbeiter während genehmigten Urlaubs
        // krank...") was never mirrored here, so correcting EITHER side of an already-APPROVED
        // sick-over-vacation § 9 pair always 409'd — even a trivial shortening of the vacation's
        // tail that leaves the sick days fully inside the new range. Without this, the § 9
        // credit-aware correction this plan adds (Steps 8b/10b above) could never actually be
        // exercised through PATCH /correct for the "credit stays inside" shape central to this
        // phase. Mirrored bidirectionally: /correct can be called on either side of the pair.
        const correctedIsSick = isSickLeaveTypeCode(newType);
        const blockingOverlap = overlaps.find((o) => {
          if (o.status !== "APPROVED") return true; // § 9 exception never applies vs PENDING
          const otherIsSick = isSickLeaveTypeCode(o.leaveType.code);
          if (correctedIsSick !== otherIsSick) return false; // § 9 case — permitted either way
          return true; // same-kind overlap (vacation/vacation, sick/sick) — still blocked
        });
        if (blockingOverlap) {
          return reply.code(409).send({ error: "Überschneidung mit bestehendem Antrag" });
        }
      }

      // Holidays across the UNION of old+new range: the reverse needs the OLD
      // range, the apply + day recompute need the NEW range.
      const unionStart = existing.startDate < start ? existing.startDate : start;
      const unionEnd = existing.endDate > end ? existing.endDate : end;
      const holidayMap = await getHolidayMap(
        app.prisma,
        tenantId,
        existing.employeeId,
        unionStart,
        unionEnd,
      );
      const holidays = new Set(holidayMap.keys());
      // Phase 107 (D-09/D-10): roster-aware recompute of the corrected (NEW) range. Unlike
      // POST /requests and the PENDING edit above, this path produces a new APPROVED value, so
      // daysProvisional is also written below -- but only when the employee is actually
      // SHIFT_BASED (a separate check, since resolveLeaveDays()'s `.provisional` is always
      // `false` for every other type and would otherwise overwrite the column's `null` "not
      // applicable" state with a misleading `false`).
      // Issue #436 (D-04/D-09): priced against the corrected (NEW) leave type, excluding this
      // request itself.
      const {
        days,
        provisional: correctionProvisional,
        vocationalSchoolOnly: correctVocationalSchoolOnly,
      } = await resolveLeaveDays(
        app.prisma,
        existing.employeeId,
        tenantId,
        start,
        end,
        body.halfDay,
        holidays,
        { mode: "request", leaveTypeCode: newType, excludeRequestId: existing.id },
      );

      // Issue #448 (D-02): one rule on every write path — before the transaction opens, same
      // guard shape as the delta-lock 409 above.
      if (correctVocationalSchoolOnly) {
        return reply.code(400).send({ error: BS_ONLY_LEAVE_ERROR, code: BS_ONLY_LEAVE_ERROR_CODE });
      }

      const wsForCorrection = await app.prisma.workSchedule.findFirst({
        where: { employeeId: existing.employeeId },
        orderBy: { validFrom: "desc" },
        select: { type: true },
      });
      const daysProvisionalForCorrection =
        wsForCorrection?.type === "SHIFT_BASED" ? correctionProvisional : null;

      // Resolve the NEW leaveTypeId when the type changed (ensureLeaveType migrates
      // legacy names / creates the canonical type on demand).
      const newLeaveTypeId =
        typeChanged && body.type != null
          ? await ensureLeaveType(app.prisma, app.log, tenantId, body.type)
          : existing.leaveTypeId;

      // Issue #468 (D-01): resolved ONCE on app.prisma, BEFORE the transaction opens —
      // getTenantTimezone() is typed against FastifyInstance["prisma"], not a tx client, and
      // its own 5-minute cache makes a second lookup pointless.
      const tzForCorrection = await getTenantTimezone(app.prisma, tenantId);

      // Issue #468 (D-02): the OLD and NEW Überstundenausgleich amounts are resolved HERE — pure
      // reads on app.prisma, before the transaction opens — never inside it. The OLD side reverses
      // the STORED booking (never a recomputation, so a schedule edited after approval cannot
      // change what gets reversed); a legacy row with no stored value falls back to today's
      // recomputation (A-4), logged so the fallback stays visible. The NEW side is always priced
      // fresh against the corrected range.
      let oldOtMinutes: number | null = null;
      let oldOtSource: "stored" | "recomputed" | null = null;
      if (oldTypeCode === "OVERTIME_COMP") {
        if (existing.overtimeCompMinutes != null) {
          oldOtMinutes = existing.overtimeCompMinutes;
          oldOtSource = "stored";
        } else {
          oldOtMinutes = await scheduledLeaveMinutes(
            app.prisma,
            existing.employeeId,
            tenantId,
            existing.startDate,
            existing.endDate,
            existing.halfDay,
            holidays,
            tzForCorrection,
          );
          oldOtSource = "recomputed";
          app.log.warn(
            { leaveRequestId: existing.id, employeeId: existing.employeeId },
            "OVERTIME_COMP correction without a stored booking — recomputed (Issue #468 A-4 legacy fallback)",
          );
        }
      }
      let newOtMinutes: number | null = null;
      if (newType === "OVERTIME_COMP") {
        newOtMinutes = await scheduledLeaveMinutes(
          app.prisma,
          existing.employeeId,
          tenantId,
          start,
          end,
          body.halfDay,
          holidays,
          tzForCorrection,
        );
      }

      // Issue #468 (D-04/A-3, finding 2/G18): pure reads BEFORE the transaction opens — the §
      // 9 credits touching this request (either side), classified against the NEW range by
      // planSection9CreditsForCorrection, then every clipped replacement range re-priced. Only
      // the write (status, ledger undo/re-credit, audit) happens inside the CR-01 transaction
      // below (Steps 8b/10b).
      const touchingSection9Credits = await app.prisma.section9Credit.findMany({
        where: {
          OR: [{ vacationRequestId: existing.id }, { sickRequestId: existing.id }],
          status: { not: "SUPERSEDED" },
          employee: { tenantId },
        },
        include: {
          vacationRequest: {
            select: {
              id: true,
              leaveTypeId: true,
              halfDay: true,
              leaveType: { select: { code: true } },
            },
          },
        },
      });
      const section9CorrectionPlan = planSection9CreditsForCorrection({
        credits: touchingSection9Credits.map((c) => ({
          id: c.id,
          status: c.status,
          creditedStart: c.creditedStart,
          creditedEnd: c.creditedEnd,
          overlapStart: c.overlapStart,
          overlapEnd: c.overlapEnd,
        })),
        newStart: start,
        newEnd: end,
        typeChanged,
      });
      type Section9ClipPricing = {
        id: string;
        start: Date;
        end: Date;
        priced: number;
        vacationTypeCode: string | null;
        vacationLeaveTypeId: string;
      };
      const section9ClipPricings: Section9ClipPricing[] = [];
      for (const clip of section9CorrectionPlan.clip) {
        const credit = touchingSection9Credits.find((c) => c.id === clip.id)!;
        // D-04: the VACATION-side type code never changes on this path (a type change on the
        // vacation side always forces a full supersede above, never a clip) — stable for
        // either side of the correction.
        const isVacationSide = credit.vacationRequestId === existing.id;
        const { days: priced } = await resolveLeaveDays(
          app.prisma,
          existing.employeeId,
          tenantId,
          clip.start,
          clip.end,
          isVacationSide ? body.halfDay : credit.vacationRequest.halfDay,
          holidays,
          {
            mode: "request",
            leaveTypeCode: credit.vacationRequest.leaveType.code,
            excludeRequestId: isVacationSide ? existing.id : credit.vacationRequest.id,
          },
        );
        section9ClipPricings.push({
          id: clip.id,
          start: clip.start,
          end: clip.end,
          priced,
          vacationTypeCode: credit.vacationRequest.leaveType.code,
          vacationLeaveTypeId: credit.vacationRequest.leaveTypeId,
        });
      }

      // ── Steps 8-11 run inside ONE interactive transaction (94 CR-01) ──────────
      //    The correction issues TWO authoritative ledger writes (reverse OLD +
      //    apply NEW). Without a transaction a mid-sequence failure would leave the
      //    OLD booking reversed but the NEW one unapplied — permanently corrupting
      //    the vacation Kontingent (usedDays is never self-healed by the recalc
      //    tail). All pre-write guards (half-day-sick 400, overlap 409, delta-lock
      //    409) already ran ABOVE, so a rejection never opens the transaction.
      const updated = await app.prisma.$transaction(async (tx) => {
        // ── Step 8: REVERSE the OLD booking (dispatch on the OLD typeCode) ──────
        if (oldTypeCode === "VACATION") {
          await reverseVacationDays(
            tx,
            existing.employeeId,
            existing.leaveTypeId,
            existing.startDate,
            existing.endDate,
            Number(existing.days),
            holidays,
            tenantId,
          );
        } else if (oldTypeCode === "OVERTIME_COMP") {
          // Issue #468 (D-02): reverses the STORED/recomputed-fallback amount resolved ABOVE,
          // before the transaction opened — never a fresh recomputation inside the transaction.
          await reverseOvertimeCompensation(
            tx,
            existing.employeeId,
            tenantId,
            (oldOtMinutes ?? 0) / 60,
            `Korrektur Überstundenausgleich ${existing.startDate.toISOString().split("T")[0]}`,
          );
        }
        // SICK / SICK_CHILD / PARENTAL / MATERNITY / SPECIAL / UNPAID / EDUCATION:
        // entitlement-neutral on the reverse side (no usedDays / balance booking).

        // ── Step 8b: SUPERSEDE § 9 credits the new range leaves behind (Issue #468, D-04/A-3,
        //    finding 2/G18) — classified ABOVE (section9CorrectionPlan), written here. A
        //    CONFIRMED credit actually booked a ledger entry at confirm time (reverseVacationDays
        //    — gave the day back); undoing it here is the exact mirror: deductVacationDays takes
        //    the day back out again. AU_PENDING/REJECTED credits never booked anything, so only
        //    their status changes. Worked numbers (see <objective>): approve 10 → 10; confirm 3
        //    → 7; correct to 7 with the credit now outside: reverse 10 → −3, undo (deduct) 3 → 0,
        //    apply 7 → 7.
        for (const sup of section9CorrectionPlan.supersede) {
          const credit = touchingSection9Credits.find((c) => c.id === sup.id)!;
          await tx.section9Credit.update({
            where: { id: sup.id },
            data: { status: "SUPERSEDED" },
          });
          if (sup.ledgerUndo && credit.vacationRequest.leaveType.code === "VACATION") {
            await deductVacationDays(
              tx,
              existing.employeeId,
              credit.vacationRequest.leaveTypeId,
              credit.creditedStart!,
              credit.creditedEnd!,
              Number(credit.creditedDays),
              holidays,
              tenantId,
            );
          }
          await app.audit({
            tx,
            userId: req.user.sub,
            action: "SECTION9_CREDIT_SUPERSEDED",
            entity: "Section9Credit",
            entityId: sup.id,
            oldValue: {
              status: credit.status,
              creditedStart: credit.creditedStart?.toISOString().split("T")[0] ?? null,
              creditedEnd: credit.creditedEnd?.toISOString().split("T")[0] ?? null,
              creditedDays: credit.creditedDays !== null ? Number(credit.creditedDays) : null,
            },
            newValue: {
              status: "SUPERSEDED",
              correctedLeaveRequestId: existing.id,
              newStartDate: start.toISOString().split("T")[0],
              newEndDate: end.toISOString().split("T")[0],
              auditReason: body.reason,
              note: "§ 9 BUrlG — durch Korrektur des Antrags überholt",
            },
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
        }

        // ── Step 9: update the row (94-01 base + NEW leaveTypeId) ───────────────
        const updatedRow = await tx.leaveRequest.update({
          where: { id },
          data: {
            startDate: start,
            endDate: end,
            halfDay: body.halfDay,
            days,
            daysProvisional: daysProvisionalForCorrection, // Phase 107 (D-10)
            note: body.note,
            leaveTypeId: newLeaveTypeId,
            // Issue #468 (D-02): keeps the stored booking current — null when the corrected
            // type is no longer OVERTIME_COMP, so a later correction never reverses a stale
            // amount from a type the request has since moved away from.
            overtimeCompMinutes: newType === "OVERTIME_COMP" ? newOtMinutes : null,
          },
          include: {
            leaveType: true,
            employee: { select: { firstName: true, lastName: true, employeeNumber: true } },
          },
        });

        // ── Step 10: APPLY the NEW booking (dispatch on the NEW typeCode) ───────
        //    "Light" for Krankheit = NO entitlement apply on the new side (it does
        //    NOT skip the OLD-side reversal nor the recalc tail).
        if (newType === "VACATION") {
          await deductVacationDays(
            tx,
            existing.employeeId,
            newLeaveTypeId,
            start,
            end,
            days,
            holidays,
            tenantId,
          );
        } else if (newType === "OVERTIME_COMP") {
          // Issue #468 (D-02): books the amount resolved ABOVE, before the transaction opened —
          // never a fresh recomputation inside the transaction.
          await bookOvertimeCompensation(
            tx,
            existing.employeeId,
            tenantId,
            (newOtMinutes ?? 0) / 60,
            `Überstundenausgleich ${start.toISOString().split("T")[0]} – ${end.toISOString().split("T")[0]}`,
          );
        }
        // SICK / SICK_CHILD / PARENTAL / MATERNITY / SPECIAL / UNPAID / EDUCATION:
        // entitlement-neutral on the apply side (light).

        // ── Step 10b: RE-CREDIT the clipped part of a partially-superseded CONFIRMED credit
        //    (Issue #468, D-04/A-3) — a new revision+1 correction credit for exactly the part
        //    that is still inside the new range, re-priced ABOVE (section9ClipPricings). A clip
        //    priced at 0 days (e.g. the clipped range is a non-workday) becomes a plain
        //    supersede — no replacement row, nothing to re-credit. Worked: partial (2 of 3 days
        //    stay) — reverse 10 → −3, undo (deduct) 3 → 0, apply 7 → 7, re-credit 2 → 5.
        for (const cp of section9ClipPricings) {
          if (cp.priced <= 0) continue;
          const original = touchingSection9Credits.find((c) => c.id === cp.id)!;
          // The sick/vacation overlap is recomputed against the NEW range of whichever side of
          // the pair this correction touches — `start`/`end` are the corrected request's own
          // new range, which is exactly the side `original` references via existing.id.
          const overlapClip = intersectRanges(
            original.overlapStart,
            original.overlapEnd,
            start,
            end,
          )!;
          const created = await tx.section9Credit.create({
            data: {
              employeeId: original.employeeId,
              sickRequestId: original.sickRequestId,
              vacationRequestId: original.vacationRequestId,
              revision: original.revision + 1,
              supersedesId: original.id,
              status: "CONFIRMED",
              overlapStart: overlapClip.start,
              overlapEnd: overlapClip.end,
              creditedStart: cp.start,
              creditedEnd: cp.end,
              creditedDays: cp.priced,
              attestSource: original.attestSource,
              attestValidFrom: original.attestValidFrom,
              attestValidTo: original.attestValidTo,
              documentPath: original.documentPath,
              reason: "Korrektur: Antrag geändert — § 9-Gutschrift angepasst",
              reviewedBy: req.user.sub,
              reviewedAt: new Date(),
            },
          });
          if (cp.vacationTypeCode === "VACATION") {
            await reverseVacationDays(
              tx,
              existing.employeeId,
              cp.vacationLeaveTypeId,
              cp.start,
              cp.end,
              cp.priced,
              holidays,
              tenantId,
            );
          }
          await app.audit({
            tx,
            userId: req.user.sub,
            action: "SECTION9_CREDIT_CORRECTED",
            entity: "Section9Credit",
            entityId: created.id,
            newValue: {
              supersedesId: original.id,
              revision: created.revision,
              creditedStart: cp.start.toISOString().split("T")[0],
              creditedEnd: cp.end.toISOString().split("T")[0],
              creditedDays: cp.priced,
              correctedLeaveRequestId: existing.id,
            },
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
        }

        // ── Step 11: revalidate removed-day time entries (old range \ new range).
        //    A shortened/moved leave frees days whose leave-caused invalidation must
        //    be cleared. Delta-lock already guarantees these fall in unlocked months;
        //    locked / soft-deleted entries are never touched (Revisionssicherheit).
        // Phase 100B Plan 08 — T6, contexts/time-tracking facade (H2 guard unchanged).
        // Issue #370, D-05: accumulate the revalidated rows across both calls below so they
        // can be audited once, inside this same transaction, before it closes.
        const revalidatedEntries: Awaited<ReturnType<typeof revalidateLeaveCancellationEntries>> =
          [];
        const revalidateRemoved = async (from: Date, to: Date) => {
          if (from > to) return;
          revalidatedEntries.push(
            ...(await revalidateLeaveCancellationEntries(
              tx,
              existing.employeeId,
              tenantId,
              from,
              to,
            )),
          );
        };
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;
        if (start > existing.startDate) {
          // head removed: [oldStart .. newStart-1]
          await revalidateRemoved(existing.startDate, new Date(start.getTime() - ONE_DAY_MS));
        }
        if (end < existing.endDate) {
          // tail removed: [newEnd+1 .. oldEnd]
          await revalidateRemoved(new Date(end.getTime() + ONE_DAY_MS), existing.endDate);
        }
        // Issue #370, D-05: one TimeEntry UPDATE audit per revalidated row, inside the tx so a
        // rollback (94 CR-01) never leaves an orphan audit row — same rule as overtime.ts's
        // COMP-V1814-05 comment.
        for (const row of revalidatedEntries) {
          await app.audit({
            tx,
            userId: req.user.sub,
            action: "UPDATE",
            entity: "TimeEntry",
            entityId: row.id,
            oldValue: row.oldValue,
            newValue: row.newValue,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
        }

        return updatedRow;
      });

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
        },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      // Saldo-Recalc: ab dem FRÜHEREN von alt/neu Start, damit ein erweiterter
      // Bereich vom richtigen Monat an neu berechnet wird (EDIT / T-94-05).
      const recalcFrom = existing.startDate < start ? existing.startDate : start;
      await recalculateSnapshots(app, existing.employeeId, recalcFrom).catch((err) =>
        app.log.error(
          { err, employeeId: existing.employeeId },
          "Failed to recalculate snapshots after leave correction",
        ),
      );
      // Issue #294: swallower removed — a failing recompute now answers non-2xx instead of a
      // silent 200 with a stale balance. Full atomicity is NOT available at this site: the
      // booking pair above is already committed inside the CR-01 transaction (`app.prisma.
      // $transaction` earlier in this handler), and this recompute reads the leave row through
      // `app.prisma` — it must run AFTER that transaction commits, or it would read the
      // pre-correction state. Threading a client through computeOvertimeBalanceBreakdown() was
      // ruled out (it performs ~15 separate app.prisma reads plus getEffectiveSchedule(app, …)).
      // Inlined via computeOvertimeBalanceHours + persistOvertimeBalance (rather than the
      // updateOvertimeAccount() wrapper) — byte-identical behaviour, same null-guard for the
      // §18-exempt path, same non-transactional app.prisma write.
      const effectiveBalanceHoursForCorrection = await computeOvertimeBalanceHours(
        app,
        existing.employeeId,
      );
      if (effectiveBalanceHoursForCorrection !== null) {
        await persistOvertimeBalance(
          app,
          app.prisma,
          existing.employeeId,
          effectiveBalanceHoursForCorrection,
        );
      }

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

  // ── GET /calendar  – Kalenderansicht für einen Monat ────────────────────
  app.get("/calendar", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req) => {
      const { year, month } = req.query as { year?: string; month?: string };
      const y = year ? parseInt(year) : new Date().getFullYear();
      const m = month ? parseInt(month) : new Date().getMonth() + 1;

      const tz = await getTenantTimezone(app.prisma, req.user.tenantId);
      const { start, end } = monthRangeUtc(y, m, tz);

      const [rows, holidayMap] = await Promise.all([
        app.prisma.leaveRequest.findMany({
          where: {
            deletedAt: null,
            employee: { tenantId: req.user.tenantId },
            status: { in: ["PENDING", ...EFFECTIVE_LEAVE_STATUSES] }, // Issue #446 (D-04): same set, now derived
            startDate: { lte: end },
            endDate: { gte: start },
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
        getHolidayMap(app.prisma, req.user.tenantId, req.user.employeeId ?? null, start, end),
      ]);

      // Phase 104-10 (D-28/D-29): bulk-load § 9 credits overlapping the visible month — ONE
      // query, scoped to the tenant, so the per-row masking below never needs a query inside
      // `.map()`.
      const section9Credits = await app.prisma.section9Credit.findMany({
        where: {
          employee: { tenantId: req.user.tenantId },
          overlapStart: { lte: end },
          overlapEnd: { gte: start },
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

      // Computed once per request (not per row, Pitfall 10) — hoisted above the loop below.
      const canSeeAll = await hasPermission(req, "leave-request:read:ZUGEWIESEN");
      const leaveEntries = rows.map((r) => {
        const isOwn = r.employee.userId === req.user.sub;
        const showDetails = canSeeLeaveType(isOwn, canSeeAll);
        return {
          id: r.id,
          isOwn,
          employeeId: r.employeeId,
          firstName: r.employee.firstName,
          lastName: r.employee.lastName,
          typeCode: showDetails ? r.leaveType.code : null,
          typeName: showDetails ? r.leaveType.name : null,
          startDate: r.startDate.toISOString().split("T")[0],
          endDate: r.endDate.toISOString().split("T")[0],
          halfDay: r.halfDay,
          status: r.status,
          isHoliday: false,
          // Sichtbarkeit folgt exakt showDetails — wer typeCode nicht sehen darf, sieht auch
          // keine § 9-Markierung (sonst wäre die Krankheit indirekt ablesbar).
          section9: showDetails ? (section9ByEntry.get(r.id)?.marker ?? null) : null,
          section9Days: showDetails ? Array.from(section9ByEntry.get(r.id)?.days ?? []).sort() : [],
        };
      });

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

      return [...leaveEntries, ...holidayEntries];
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
          balanceHours: 0,
          confirmedMinutes: 0,
          openMonthMinutes: null,
          hasClosedMonth: false,
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
          // Same 2-decimal rounding GET /overtime/:employeeId applies, so the two
          // endpoints cannot disagree on the same employee.
          balanceHours: Math.round(breakdown.totalHours * 100) / 100,
          confirmedMinutes: breakdown.confirmedMinutes,
          openMonthMinutes: breakdown.openMonthMinutes,
          hasClosedMonth: breakdown.hasClosedMonth,
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
          balanceHours,
          confirmedMinutes: confirmed.minutes,
          openMonthMinutes: null,
          hasClosedMonth: confirmed.hasClosedMonth,
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
          balanceHours,
          confirmedMinutes: 0,
          openMonthMinutes: null,
          hasClosedMonth: false,
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
        summary: r.leaveType.name,
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
          summary: DISPLAY_NAME[a.type],
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
      const access = accessContextFromRequest(req);
      const reach = await resolveAccessReach(app.prisma, access, "leave-request:read:ZUGEWIESEN");
      const scopedEmployeeIds =
        reach.kind === "wholeTenant"
          ? "all"
          : await resolveStammsalonScopedEmployeeIds(
              app.prisma,
              tenantId,
              reach,
              todayInTz(await getTenantTimezone(app.prisma, tenantId)),
            );

      const [requests, absences] = await Promise.all([
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

      const events: ICalEvent[] = requests.map((r) => {
        const name = `${r.employee.firstName} ${r.employee.lastName}`;
        return {
          uid: `leave-${r.id}@clokr`,
          summary: `${name} \u2014 ${r.leaveType.name}`,
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
          summary: `${name} \u2014 ${DISPLAY_NAME[a.type]}`,
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
      const effectiveCarryByRowId = new Map<string, number>();
      for (const r of rows) {
        effectiveCarryByRowId.set(
          r.id,
          await effectiveCarryOverDays(
            app.prisma,
            { ...r, tenantId },
            now,
            warnedEntitlementIds.has(r.id),
          ),
        );
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

  // ── GET /section9 — § 9-BUrlG-Vorgänge (eigene, oder alle des Tenants für Manager) ──
  app.get("/section9", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { status } = section9StatusQuerySchema.parse(req.query);
      // Issue #368: same error form as `GET /requests` above — a caller holding neither
      // `section9:read:ZUGEWIESEN` nor `section9:read:EIGENE` (e.g. a template without an own
      // Employee record) used to get 200 with an empty list instead of 403.
      const readReach = await permissionReach(req, "section9:read");
      if (readReach === null) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      const isManager = readReach === "ZUGEWIESEN";
      const rows = await app.prisma.section9Credit.findMany({
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

      // Phase 104 review (WR-01): the credit is detected at SICK-approval time, when the
      // vacation was APPROVED. Between then and this confirm the vacation can move to
      // CANCELLATION_REQUESTED or CANCELLED (leave.ts cancel path) — and the cancel path
      // already decrements usedDays back. Confirming afterwards would run
      // reverseVacationDays() a SECOND time for the same days (double credit), and would
      // book a § 9 credit against a vacation that legally no longer exists: nothing was
      // "angerechnet", so nothing can be "nicht angerechnet". selfHealUsedDays() masks the
      // numeric symptom on the next load, but the CONFIRMED row itself stays wrong and
      // feeds section9Movements, the monthly report and the DATEV Krank/Urlaub shift.
      // CANCELLATION_REQUESTED is blocked too: the leave is still active today, but an
      // approval of that cancellation later would decrement the same days again.
      if (credit.vacationRequest.status !== "APPROVED") {
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
 * Automatically carries over the previous year's unused vacation days into the current year as
 * Resturlaub — unless that has already happened. Called lazily on every leave request and
 * account read.
 *
 * Issue #445 (D-04): a missing current-year row used to be created here with a hard-coded
 * `totalDays: 0` — now `ensureRegularVacationEntitlement()` creates (or heals) it with the
 * regular yearly entitlement instead, through the same wrapper `recalculateCarryOver()` uses.
 */
async function autoCarryOver(
  prisma: FastifyInstance["prisma"],
  tenantId: string,
  employeeId: string,
  leaveTypeId: string,
  year: number,
): Promise<void> {
  const prevYear = year - 1;

  // Fetch the previous year's entitlement.
  const prev = await prisma.leaveEntitlement.findUnique({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year: prevYear } },
  });
  if (!prev) return;

  // Issue #445 (D-14): the effective (FIFO) remainder — an expired, untaken carry never
  // returns the following year.
  const remaining = await carryOverRemainder(prisma, prev, tenantId);
  if (remaining <= 0) return;

  // Already carried over? -> abort (idempotent).
  const alreadyCarried = await prisma.leaveEntitlement.findUnique({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
  });
  if (alreadyCarried && Number(alreadyCarried.carriedOverDays) > 0) return;

  // Expiry deadline from TenantConfig.
  const config = await prisma.tenantConfig.findUnique({ where: { tenantId } });
  const deadlineDay = config?.carryOverDeadlineDay ?? 31;
  const deadlineMonth = config?.carryOverDeadlineMonth ?? 3;
  const deadline = new Date(year, deadlineMonth - 1, deadlineDay, 23, 59, 59);

  const { entitlement: cur } = await ensureRegularVacationEntitlement(
    prisma,
    employeeId,
    tenantId,
    year,
    leaveTypeId,
    REGULAR_ENTITLEMENT_REASON_ROLLOVER,
  );

  // Phase 104 (D-19), generalised by Issue #445 (D-16/D-17): see recalculateCarryOver — same
  // documented-reason deadline protection.
  const deadlineProtected = preserveCarryOverDeadline(cur);
  await prisma.leaveEntitlement.update({
    where: { id: cur.id },
    data: deadlineProtected
      ? { carriedOverDays: remaining }
      : { carriedOverDays: remaining, carryOverDeadline: deadline },
  });
  if (daysDiffer(Number(cur.carriedOverDays), remaining)) {
    await writeEntitlementAudit(prisma, {
      action: "UPDATE",
      entityId: cur.id,
      oldValue: { carriedOverDays: Number(cur.carriedOverDays) },
      newValue: { carriedOverDays: remaining, reason: CARRY_OVER_RECALC_REASON },
    });
  }
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

/**
 * Issue #468 (D-01) — the ONE function behind every Überstundenausgleich amount: the POST/PATCH
 * negative-balance gate, the approval booking, the cancellation-reversal legacy fallback, the
 * `/correct` reverse/apply pair, and GET /hours-preview all call this, never a second formula.
 *
 * SHIFT_BASED keeps the #293/#429 "receipt follows the account" branch verbatim — do not route
 * it through `calcLeaveAbsenceMinutesTz` (that function's own SHIFT_BASED branch is a DIFFERENT,
 * already-correct formula per #429, see its own docblock).
 *
 * Every other schedule type calls `calcLeaveAbsenceMinutesTz` below — the Arbeitszeitkonto's own
 * per-row credit/withdrawal function (`close-employee-month.ts` uses the SAME call for the
 * saldo's non-SHIFT leave credit, #220 model B) — reached through the
 * `contexts/working-time-account` facade, never a local `{day}Hours` placeholder read. This is
 * what makes a FLEXTIME day cost the real Ø-Methode average (480 min, not the measured
 * placeholder's 60) and keeps MONTHLY_HOURS following whatever the Arbeitszeitkonto returns
 * (hard 0 until Phase 433 merges, a real rate afterward) rather than a number hardcoded here.
 *
 * Holidays AND Berufsschultage are excluded exactly like the saldo's own `excludeHolidays` set
 * (#448 D-03) — an Azubi's Ausgleichstag on a school day costs nothing, mirroring the saldo,
 * which never withdraws for that day either.
 */
async function scheduledLeaveMinutes(
  db: DbClient,
  employeeId: string,
  tenantId: string,
  start: Date,
  end: Date,
  halfDay: boolean,
  holidays: Set<string>,
  tz: string,
): Promise<number> {
  const employee = await db.employee.findUnique({
    where: { id: employeeId },
    include: {
      workSchedules: {
        where: { validFrom: { lte: start } },
        orderBy: { validFrom: "desc" },
        take: 1,
      },
    },
  });
  const ws = employee?.workSchedules[0] ?? null;
  const cfg = await db.tenantConfig.findUnique({ where: { tenantId } });

  // SHIFT_BASED (issue #293/#429): the receipt follows the account — see the docblock above.
  // Returns BEFORE the saldo-facade path below, which stays untouched for every other type.
  if (ws?.type === "SHIFT_BASED") {
    // Issue #429, D-13: `c` via the SAME fallback chain the saldo uses (Phase 107, D-04) —
    // `contractWorkDaysPerWeek` -> `workDays.length` -> tenant `defaultWorkDays.length` -> 5.
    const c = contractWorkDaysPerWeekFrom(ws, cfg?.defaultWorkDays);

    // `shiftBasedLeaveMinutesForRequest` is timezone-free (it operates on calendar `Date`
    // boundaries via `leaveDaysPerWeek`, like the saldo's `shiftBasedLeaveCreditByDate`) and,
    // mirroring `close-employee-month.ts`'s D-05 decision, is never given a holiday set — a
    // holiday inside a leave range keeps being a Soll-free day via the leave itself. Phase 436
    // (D-03): the Angabe follows the receipt through the same `usualWorkDaysFrom()` reader.
    return shiftBasedLeaveMinutesForRequest(ws, start, end, halfDay, c, usualWorkDaysFrom(ws));
  }

  // Issue #468 (D-01): the WorkSchedule row when present, else the tenant-default
  // FIXED_SCHEDULE shape — mirrors `getEffectiveSchedule()`'s shape (entry-invariants.ts), not
  // imported (that helper takes `app`, a time-tracking module this file does not reach into).
  const schedule =
    ws ??
    ({
      type: "FIXED_SCHEDULE" as const,
      weeklyHours: cfg?.defaultWeeklyHours ?? 40,
      monthlyHours: null,
      mondayHours: cfg?.defaultMondayHours ?? 8,
      tuesdayHours: cfg?.defaultTuesdayHours ?? 8,
      wednesdayHours: cfg?.defaultWednesdayHours ?? 8,
      thursdayHours: cfg?.defaultThursdayHours ?? 8,
      fridayHours: cfg?.defaultFridayHours ?? 8,
      saturdayHours: cfg?.defaultSaturdayHours ?? 0,
      sundayHours: cfg?.defaultSundayHours ?? 0,
    } as const);

  // Issue #468 (D-01, mirrors #448 D-03): a Berufsschultag is excluded exactly like a holiday —
  // the saldo never withdraws Soll for either inside a leave range, so the booking must not
  // either.
  const excluded = new Set<string>([
    ...holidays,
    ...(await vocationalSchoolDateSet(db, employeeId, tenantId, start, end)), // Issue #468 (D-01)
  ]);

  return calcLeaveAbsenceMinutesTz(schedule, start, end, tz, {
    halfDay,
    excludeHolidays: excluded,
  });
}

/**
 * Issue #468 (D-01) — the shared Überstundenausgleich negative-balance gate, lifted out of
 * `POST /requests` so the PENDING edit (`PATCH /requests/:id`) can run the SAME check instead of
 * the gap D-01 found (an employee widening a still-PENDING request could pass the limit the
 * initial POST already enforced). Logic is byte-identical to the original POST-only gate —
 * tolerance chain, confirmed carry-over, zero-tolerance fail-safe fallback — only the needed
 * amount is now a caller-supplied minutes figure (from {@link scheduledLeaveMinutes}) rather than
 * recomputed here.
 *
 * Phase 100 (OTC-01/OTC-02, D-00a/D-00b) — availability also includes the configured
 * `maxNegativeBalanceMinutes` TOLERANCE, resolved through the SAME precedence chain overtime.ts
 * uses (loadNegativeBalanceTolerance, negative-balance-tolerance.ts): per-employee WorkSchedule
 * override > tenant default > null. D-00b: for THIS booking gate, an unconfigured (`null`) value
 * means a tolerance of ZERO — the opposite of the schema comment's "unbegrenzt" ALERTING reading
 * that `isNegativeLimitExceeded` uses elsewhere — so with nothing configured this gate stays
 * byte-identical to pre-Phase-100. D-02: the catch branch below applies ZERO tolerance regardless
 * of what is configured — a read failure must never be MORE generous than the normal path. D-04:
 * the comparison itself happens in MINUTES; hours only appear in the response body/rejection copy.
 *
 * Returns `null` when the request is affordable, otherwise the 400 response body.
 */
async function overtimeCompBalanceRejection(
  app: FastifyInstance,
  employeeId: string,
  tenantId: string,
  neededMinutes: number,
): Promise<{ error: string; available: number; requested: number; tolerance: number } | null> {
  const { toleranceMinutes } = await loadNegativeBalanceTolerance(app.prisma, employeeId, tenantId);

  let availableMinutes: number;
  let appliedToleranceMinutes: number;
  try {
    const confirmed = await getConfirmedCarryOver(app.prisma, employeeId, tenantId);
    appliedToleranceMinutes = toleranceMinutes;
    availableMinutes = confirmed.minutes + appliedToleranceMinutes;
  } catch (err) {
    app.log.warn(
      { err, employeeId },
      "OVERTIME_COMP balance gate: getConfirmedCarryOver failed, falling back to stored OvertimeAccount.balanceHours",
    );
    // D-02: fail-safe applies ZERO tolerance — a broken read path must never be more
    // permissive than the normal path.
    appliedToleranceMinutes = 0;
    const account = await getOvertimeAccount(app.prisma, employeeId, tenantId);
    availableMinutes = account ? Math.round(Number(account.balanceHours) * 60) : 0;
  }

  if (neededMinutes > availableMinutes) {
    // OTC-06 / D-14: names the applied tolerance when one was applied; the
    // "(inkl. … erlaubtem Minus)" clause is omitted entirely at tolerance 0 so an unconfigured
    // tenant sees the plain pre-Phase-100 message (100-UI-SPEC.md "Rejection copy").
    const toleranceClause =
      appliedToleranceMinutes > 0
        ? ` (inkl. ${formatMinutesHM(appliedToleranceMinutes)} Std. erlaubtem Minus)`
        : "";
    return {
      error:
        `Nicht genug Überstunden: verfügbar ${formatMinutesHM(availableMinutes)} Std.` +
        `${toleranceClause}, benötigt ${formatMinutesHM(neededMinutes)} Std.`,
      available: +(availableMinutes / 60).toFixed(2),
      requested: +(neededMinutes / 60).toFixed(2),
      tolerance: +(appliedToleranceMinutes / 60).toFixed(2),
    };
  }
  return null;
}
