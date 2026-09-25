import { FastifyInstance } from "fastify";
import { z } from "zod";
import { LeaveRequestStatus, Prisma } from "@clokr/db";
import { requireAuth } from "../../../middleware/auth";
import { generateICal, addOneDay, type ICalEvent } from "../ical";
import { splitDaysAcrossYears, calculateProRataVacation } from "../vacation-calc"; // Phase 107 (D-04/D-09)
import { selfHealUsedDays, loadVacationTypeMeta } from "../leave-self-heal";
import { computeAffectedMonths } from "../correction-lock";
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
  resolveWorkDays,
  recalculateCarryOver,
} from "../leave-days";
import { formatMinutesHM } from "../format-hm"; // Phase 100
import { flagShiftsConflictingWithLeave } from "../../scheduling"; // Phase 100B Plan 05 — S1/S2
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
  computeOvertimeBalanceBreakdown,
  computeOvertimeBalanceHours, // Issue #294 — pure read, run BEFORE the booking+persist transaction
  persistOvertimeBalance, // Issue #294 — booking + recompute in one $transaction
  calcLeaveAbsenceMinutesTz, // Issue #293 — receipt shares the saldo's own Ø-Methode entry point
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
} from "../../platform"; // Quick 260824-cjd
import { preserveIllnessDeadline } from "../illness-carryover-guard"; // Phase 104
import { findSection9Overlaps, intersectRanges } from "../section9-detect"; // Phase 104-05/06
import { isSickLeaveTypeCode } from "../leave-type"; // Phase 97 (T2) — code-based, replacing the removed section9-detect.ts name helper
import { karenzOverrunFromRequests, normalizeKarenzDays } from "../find-karenz-overrun-days"; // Phase 104 gap closure (D-21)
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
  });

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
  });

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
  });

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
const section9StatusQuerySchema = z.object({
  status: z.enum(["AU_PENDING", "CONFIRMED", "REJECTED"]).optional(),
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
      const holidayMap = await getHolidayMap(app.prisma, tenantId, start, end);
      const holidays = new Set(holidayMap.keys());
      // workDays (the array, not just the count) is still needed below for splitDaysAcrossYears.
      const workDays = await resolveWorkDays(app.prisma, employeeId, tenantId);
      // Phase 107 (D-09): roster-aware estimate from creation onward, so the number does not
      // visibly jump at approval. daysProvisional itself stays null until approval (D-10) --
      // only `.days` is used here, `.provisional` is deliberately discarded.
      const { days } = await resolveLeaveDays(
        app.prisma,
        employeeId,
        tenantId,
        start,
        end,
        body.halfDay,
        holidays,
      );

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
      if (body.type === "VACATION") {
        const year1 = start.getFullYear();
        const year2 = end.getFullYear();
        const isCrossYear = year1 !== year2;

        // Split days across years if cross-year
        const split = isCrossYear
          ? splitDaysAcrossYears(start, end, body.halfDay, workDays, holidays)
          : { year1Days: days, year2Days: 0, year1, year2 };

        // § 5 Abs. 2 BUrlG: fetch exit date once so both year-1 and year-2 blocks can use it.
        // Hoisted out of the year-1 guard so cross-year bookings can apply the H1 cap to year 2.
        const empForExit = await app.prisma.employee.findUnique({
          where: { id: employeeId, tenantId },
          select: { exitDate: true },
        });
        const exitDate = empForExit?.exitDate ?? null;

        // ── Year 1: check entitlement ──
        await autoCarryOver(app.prisma, tenantId, employeeId, leaveTypeId, year1);
        const ent1 = await app.prisma.leaveEntitlement.findUnique({
          where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year: year1 } },
        });
        if (ent1 && split.year1Days > 0) {
          // EuGH C-684/16: pre-fetch whether a warning was issued for this entitlement
          const hinweis1 =
            (await app.prisma.auditLog.count({
              where: { action: "CARRYOVER_WARNED", entity: "LeaveEntitlement", entityId: ent1.id },
            })) > 0;
          const co1 = getEffectiveCarryOver(ent1, start, hinweis1);
          const avail1 = Number(ent1.totalDays) + co1 - Number(ent1.usedDays);

          // § 5 Abs. 2 BUrlG: H1 exits are capped at pro-rata entitlement.
          // Carry-over days are prior-year entitlement already accrued and are not subject to
          // § 5 Abs. 2 BUrlG pro-ration (which applies only to the current-year "Urlaubsanspruch").
          // Therefore only `totalDays` (current-year entitlement) is passed to calculateProRataVacation,
          // and the cap comparison uses `usedDays` directly (carry-over usage already deducted by
          // the normal avail1 path; the H1 path caps new-year days independently).
          if (exitDate && exitDate.getFullYear() === year1 && exitDate.getMonth() < 6) {
            const proRata = calculateProRataVacation(Number(ent1.totalDays), year1, exitDate);
            const used = Number(ent1.usedDays);
            if (split.year1Days > proRata - used) {
              return reply.code(400).send({
                error: `Anteiliger Urlaub bei Austritt in H1 überschritten (${proRata} Tage anteilig)`,
                available: proRata - used,
                requested: split.year1Days,
              });
            }
          } else if (split.year1Days > avail1) {
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

          const ent2 = await app.prisma.leaveEntitlement.findUnique({
            where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year: year2 } },
          });
          if (ent2) {
            // EuGH C-684/16: pre-fetch whether a warning was issued for this entitlement
            const hinweis2 =
              (await app.prisma.auditLog.count({
                where: {
                  action: "CARRYOVER_WARNED",
                  entity: "LeaveEntitlement",
                  entityId: ent2.id,
                },
              })) > 0;
            const co2 = getEffectiveCarryOver(ent2, end, hinweis2);
            let avail2 = Number(ent2.totalDays) + co2 - Number(ent2.usedDays);

            // § 5 Abs. 2 BUrlG: apply H1 cap symmetrically to year 2 when employee exits in H1
            // of year 2 (mirrors the year-1 check above for cross-year bookings).
            // Carry-over is excluded from the cap base for the same reason as year 1.
            if (exitDate && exitDate.getFullYear() === year2 && exitDate.getMonth() < 6) {
              const proRata2 = calculateProRataVacation(Number(ent2.totalDays), year2, exitDate);
              avail2 = Math.min(avail2, proRata2 - Number(ent2.usedDays));
            }

            if (split.year2Days > avail2) {
              return reply.code(400).send({
                error: `Nicht genug Urlaubstage in ${year2}`,
                available: avail2,
                requested: split.year2Days,
              });
            }
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
      // erode. Rewired onto the SAME source: getConfirmedCarryOver (confirmed-saldo.ts),
      // already used by GET /leave/overtime-balance for exactly this reason. This is a WRITE
      // path touching entitlement, so the fail-safe branch intentionally falls back to the
      // PRE-EXISTING stored-balance check (never 500, never silently permits an unbounded
      // request) rather than inventing a new default.
      //
      // Phase 100 (OTC-01/OTC-02, D-00a/D-00b) — availability now also includes the
      // configured `maxNegativeBalanceMinutes` TOLERANCE, resolved through the SAME
      // precedence chain overtime.ts uses (loadNegativeBalanceTolerance,
      // negative-balance-tolerance.ts): per-employee WorkSchedule override > tenant
      // default > null. D-00b: for THIS booking gate, an unconfigured (`null`) value
      // means a tolerance of ZERO — the opposite of the schema comment's "unbegrenzt"
      // ALERTING reading that `isNegativeLimitExceeded` uses elsewhere — so with
      // nothing configured this gate stays byte-identical to pre-Phase-100. D-02: the
      // catch branch below applies ZERO tolerance regardless of what is configured — a
      // read failure must never be MORE generous than the normal path. D-04: the
      // comparison itself happens in MINUTES; hours only appear in the response body
      // and the rejection copy.
      if (body.type === "OVERTIME_COMP") {
        const hoursNeeded = await getScheduledHours(
          app.prisma,
          employeeId,
          start,
          end,
          body.halfDay,
          holidays,
        );
        const neededMinutes = Math.round(hoursNeeded * 60);

        const { toleranceMinutes } = await loadNegativeBalanceTolerance(
          app.prisma,
          employeeId,
          tenantId,
        );

        let availableMinutes: number;
        let appliedToleranceMinutes: number;
        try {
          const confirmed = await getConfirmedCarryOver(app.prisma, employeeId, tenantId);
          appliedToleranceMinutes = toleranceMinutes;
          availableMinutes = confirmed.minutes + appliedToleranceMinutes;
        } catch (err) {
          app.log.warn(
            { err, employeeId },
            "POST /leave/requests: getConfirmedCarryOver failed for OVERTIME_COMP check, falling back to stored OvertimeAccount.balanceHours",
          );
          // D-02: fail-safe applies ZERO tolerance — a broken read path must never
          // be more permissive than the normal path.
          appliedToleranceMinutes = 0;
          const account = await getOvertimeAccount(app.prisma, employeeId, tenantId);
          availableMinutes = account ? Math.round(Number(account.balanceHours) * 60) : 0;
        }

        if (neededMinutes > availableMinutes) {
          // OTC-06 / D-14: names the applied tolerance when one was applied; the
          // "(inkl. … erlaubtem Minus)" clause is omitted entirely at tolerance 0 so
          // an unconfigured tenant sees the plain pre-Phase-100 message (100-UI-SPEC.md
          // "Rejection copy").
          const toleranceClause =
            appliedToleranceMinutes > 0
              ? ` (inkl. ${formatMinutesHM(appliedToleranceMinutes)} Std. erlaubtem Minus)`
              : "";
          return reply.code(400).send({
            error:
              `Nicht genug Überstunden: verfügbar ${formatMinutesHM(availableMinutes)} Std.` +
              `${toleranceClause}, benötigt ${formatMinutesHM(neededMinutes)} Std.`,
            available: +(availableMinutes / 60).toFixed(2),
            requested: +(neededMinutes / 60).toFixed(2),
            tolerance: +(appliedToleranceMinutes / 60).toFixed(2),
          });
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
      const managers = await app.prisma.user.findMany({
        where: {
          id: { in: leaveRequestApproveHolderIds },
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
    handler: async (req) => {
      const user = req.user;
      const isManager = await hasPermission(req, "leave-request:read:ZUGEWIESEN");
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
        let pendingOvertimeReversal: {
          tenantId: string;
          hours: number;
          description: string;
        } | null = null;
        if (body.status === "APPROVED") {
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
          await revalidateLeaveCancellationEntries(
            app.prisma,
            existing.employeeId,
            existing.employee.tenantId,
            existing.startDate,
            existing.endDate,
          );

          const typeCode = existing.leaveType.code;
          if (typeCode === "VACATION") {
            await app.prisma.leaveEntitlement.updateMany({
              where: {
                employeeId: existing.employeeId,
                leaveTypeId: existing.leaveTypeId,
                year: existing.startDate.getFullYear(),
              },
              data: { usedDays: { decrement: Number(existing.days) } },
            });
          }
          if (typeCode === "OVERTIME_COMP") {
            const empT = await app.prisma.employee.findUnique({
              where: { id: existing.employeeId },
              select: { tenantId: true },
            });
            const tenantIdForReversal = empT?.tenantId ?? "";
            const hMap = await getHolidayMap(
              app.prisma,
              tenantIdForReversal,
              existing.startDate,
              existing.endDate,
            );
            const hrs = await getScheduledHours(
              app.prisma,
              existing.employeeId,
              existing.startDate,
              existing.endDate,
              existing.halfDay,
              new Set(hMap.keys()),
            );
            pendingOvertimeReversal = {
              tenantId: tenantIdForReversal,
              hours: hrs,
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
      const reviewTypeCode = existing.leaveType.code;

      // Issue #294: the OVERTIME_COMP booking below is computed but NOT written where it is
      // decided — it is issued at the tail, in the SAME $transaction as the balance persist,
      // so a failed persist rolls the booking back with it instead of leaving an orphan receipt.
      let pendingOvertimeBooking: { tenantId: string; hours: number; description: string } | null =
        null;

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
          existing.startDate,
          existing.endDate,
        );
        const wsForApproval = await app.prisma.workSchedule.findFirst({
          where: { employeeId: existing.employeeId },
          orderBy: { validFrom: "desc" },
          select: { type: true },
        });
        if (wsForApproval?.type === "SHIFT_BASED") {
          shiftBasedApprovalRecompute = await resolveLeaveDays(
            app.prisma,
            existing.employeeId,
            existing.employee.tenantId,
            existing.startDate,
            existing.endDate,
            existing.halfDay,
            new Set(holidayMapForDeduct.keys()),
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
            existing.startDate,
            existing.endDate,
          );
          const hours = await getScheduledHours(
            app.prisma,
            existing.employeeId,
            existing.startDate,
            existing.endDate,
            existing.halfDay,
            new Set(hMap.keys()),
          );
          pendingOvertimeBooking = {
            tenantId: tenantIdForBooking,
            hours,
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
            const section9Managers = await app.prisma.employee.findMany({
              where: {
                tenantId: employeeUser.tenantId,
                user: {
                  id: { in: section9DecideHolderIds, not: req.user.sub }, // Phase-91 idiom: never notify the actor
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
            for (const s of conflictingShifts) {
              await app
                .audit({
                  userId: req.user.sub,
                  action: "SHIFT_MARKED_CONFLICTING",
                  entity: "Shift",
                  entityId: s.id,
                  newValue: {
                    leaveRequestId: existing.id,
                    leaveStart: existing.startDate.toISOString().slice(0, 10),
                    leaveEnd: existing.endDate.toISOString().slice(0, 10),
                    shiftDate: s.date.toISOString().slice(0, 10),
                    shiftLabel: s.label,
                  },
                  request: { ip: req.ip, headers: req.headers as Record<string, string> },
                })
                .catch((err) =>
                  app.log.warn({ err, shiftId: s.id }, "Failed to audit SHIFT_MARKED_CONFLICTING"),
                );
            }

            // Notify managers — find all MANAGER + ADMIN users in the tenant
            try {
              const empName = await app.prisma.employee.findUnique({
                where: { id: existing.employeeId },
                select: { firstName: true, lastName: true, tenantId: true },
              });
              if (empName) {
                // Phase 75b Plan 10 (#75), D-16: holders of shift:plan replace the legacy A,M
                // role predicate — the recorded recipient set is unchanged.
                const shiftPlanHolderIds = await userIdsHoldingPermission(
                  app.prisma,
                  empName.tenantId,
                  "shift:plan:ZUGEWIESEN",
                );
                const managers = await app.prisma.user.findMany({
                  where: {
                    isActive: true,
                    id: { in: shiftPlanHolderIds },
                    employee: { tenantId: empName.tenantId },
                  },
                  select: { id: true },
                });
                const dStart = existing.startDate.toLocaleDateString("de-DE");
                const dEnd = existing.endDate.toLocaleDateString("de-DE");
                for (const mgr of managers) {
                  await app
                    .notify({
                      userId: mgr.id,
                      type: "SHIFT_LEAVE_CONFLICT",
                      title: `Schicht-Konflikt: ${empName.firstName} ${empName.lastName}`,
                      message: `Genehmigter Urlaub vom ${dStart} bis ${dEnd} überschneidet sich mit ${conflictingShifts.length} Schicht(en). Bitte überprüfen Sie /shifts.`,
                      link: "/shifts",
                      tenantId: empName.tenantId,
                      relatedType: "LeaveRequest",
                      relatedId: existing.id,
                    })
                    .catch((err) =>
                      app.log.warn(
                        { err, managerId: mgr.id },
                        "Failed to notify manager of SHIFT_LEAVE_CONFLICT",
                      ),
                    );
                }
              }
            } catch (err) {
              app.log.warn({ err }, "SHIFT_LEAVE_CONFLICT manager-notify pass failed");
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
              select: { exitDate: true, tenantId: true },
            });
            if (empWithExit?.exitDate) {
              const exitYear = empWithExit.exitDate.getFullYear();
              // § 5 Abs. 2 BUrlG: H2 exits (July–December) receive full entitlement — no pro-rata
              // cap applies, so no warning is possible. Guard against false-positive warnings.
              if (empWithExit.exitDate.getMonth() < 6) {
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
                    const proRata = calculateProRataVacation(
                      Number(entitlement.totalDays),
                      exitYear,
                      empWithExit.exitDate,
                    );
                    const used = Number(entitlement.usedDays);
                    if (used > proRata) {
                      proRataWarning = {
                        used,
                        entitlement: proRata,
                        message: `Achtung: Der Mitarbeiter hat mehr Urlaub genommen oder genehmigt (${used} Tage) als ihm anteilig zusteht (${proRata} Tage). Bitte prüfen Sie, ob eine Rückforderung nötig ist.`,
                      };
                    }
                  }
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
      const holidayMap = await getHolidayMap(app.prisma, tenantId, start, end);
      const holidays = new Set(holidayMap.keys());
      // Phase 107 (D-09): roster-aware recompute of this still-PENDING request's own edit.
      const { days } = await resolveLeaveDays(
        app.prisma,
        existing.employeeId,
        tenantId,
        start,
        end,
        body.halfDay,
        holidays,
      );

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
        const overlap = await app.prisma.leaveRequest.findFirst({
          where: {
            employeeId: existing.employeeId,
            deletedAt: null,
            status: { in: ["PENDING", "APPROVED"] },
            startDate: { lte: end },
            endDate: { gte: start },
            id: { not: existing.id },
          },
        });
        if (overlap) {
          return reply.code(409).send({ error: "Überschneidung mit bestehendem Antrag" });
        }
      }

      // Holidays across the UNION of old+new range: the reverse needs the OLD
      // range, the apply + day recompute need the NEW range.
      const unionStart = existing.startDate < start ? existing.startDate : start;
      const unionEnd = existing.endDate > end ? existing.endDate : end;
      const holidayMap = await getHolidayMap(app.prisma, tenantId, unionStart, unionEnd);
      const holidays = new Set(holidayMap.keys());
      // Phase 107 (D-09/D-10): roster-aware recompute of the corrected (NEW) range. Unlike
      // POST /requests and the PENDING edit above, this path produces a new APPROVED value, so
      // daysProvisional is also written below -- but only when the employee is actually
      // SHIFT_BASED (a separate check, since resolveLeaveDays()'s `.provisional` is always
      // `false` for every other type and would otherwise overwrite the column's `null` "not
      // applicable" state with a misleading `false`).
      const { days, provisional: correctionProvisional } = await resolveLeaveDays(
        app.prisma,
        existing.employeeId,
        tenantId,
        start,
        end,
        body.halfDay,
        holidays,
      );
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
          const hrs = await getScheduledHours(
            tx,
            existing.employeeId,
            existing.startDate,
            existing.endDate,
            existing.halfDay,
            holidays,
          );
          await reverseOvertimeCompensation(
            tx,
            existing.employeeId,
            tenantId,
            hrs,
            `Korrektur Überstundenausgleich ${existing.startDate.toISOString().split("T")[0]}`,
          );
        }
        // SICK / SICK_CHILD / PARENTAL / MATERNITY / SPECIAL / UNPAID / EDUCATION:
        // entitlement-neutral on the reverse side (no usedDays / balance booking).

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
          const hrs = await getScheduledHours(
            tx,
            existing.employeeId,
            start,
            end,
            body.halfDay,
            holidays,
          );
          await bookOvertimeCompensation(
            tx,
            existing.employeeId,
            tenantId,
            hrs,
            `Überstundenausgleich ${start.toISOString().split("T")[0]} – ${end.toISOString().split("T")[0]}`,
          );
        }
        // SICK / SICK_CHILD / PARENTAL / MATERNITY / SPECIAL / UNPAID / EDUCATION:
        // entitlement-neutral on the apply side (light).

        // ── Step 11: revalidate removed-day time entries (old range \ new range).
        //    A shortened/moved leave frees days whose leave-caused invalidation must
        //    be cleared. Delta-lock already guarantees these fall in unlocked months;
        //    locked / soft-deleted entries are never touched (Revisionssicherheit).
        // Phase 100B Plan 08 — T6, contexts/time-tracking facade (H2 guard unchanged).
        const revalidateRemoved = async (from: Date, to: Date) => {
          if (from > to) return;
          await revalidateLeaveCancellationEntries(tx, existing.employeeId, tenantId, from, to);
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
        newValue: { ...updated, auditReason: body.reason },
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
            status: { in: ["PENDING", "APPROVED", "CANCELLATION_REQUESTED"] },
            startDate: { lte: end },
            endDate: { gte: start },
          },
          include: {
            leaveType: true,
            employee: { select: { id: true, firstName: true, lastName: true, userId: true } },
          },
          orderBy: { startDate: "asc" },
        }),
        getHolidayMap(app.prisma, req.user.tenantId, start, end),
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
      const { startDate, endDate, halfDay } = req.query as {
        startDate?: string;
        endDate?: string;
        halfDay?: string;
      };
      if (!startDate || !endDate) {
        return reply.code(400).send({ error: "startDate und endDate erforderlich" });
      }
      const employeeId = req.user.employeeId;
      if (!employeeId) return { hours: 0, days: 0 };

      const start = new Date(startDate);
      const end = new Date(endDate);
      const isHalf = halfDay === "true";

      const tenantId = req.user.tenantId;
      const holidayMap = await getHolidayMap(app.prisma, tenantId, start, end);
      const holidays = new Set(holidayMap.keys());

      // Phase 107 (D-09): roster-aware live estimate, read-only, no persistence.
      const [hours, leaveDaysPreview] = await Promise.all([
        getScheduledHours(app.prisma, employeeId, start, end, isHalf, holidays),
        resolveLeaveDays(app.prisma, employeeId, tenantId, start, end, isHalf, holidays),
      ]);
      const { days, provisional } = leaveDaysPreview;

      // WR-03 (code review) — exact integer minutes, computed with the SAME
      // Math.round(hoursNeeded * 60) formula the POST /requests OVERTIME_COMP gate
      // uses for `neededMinutes` above. `hours` is rounded to 2 decimal PLACES for
      // display; `minutesNeeded` lets the client compare against confirmedMinutes /
      // maxNegativeBalanceMinutes (already exact integer minutes from GET
      // /leave/overtime-balance) without reconstructing the server's exact-minute
      // gate through two different rounding paths.
      // `provisional` (Phase 107, D-09) additive: lets the request form show a
      // "Vorläufig" hint before submission for a SHIFT_BASED period with no roster yet.
      return {
        hours: +hours.toFixed(2),
        days,
        provisional,
        minutesNeeded: Math.round(hours * 60),
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
    handler: async (req) => {
      const employeeId = req.user.employeeId;
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
          where: { employeeId, deletedAt: null, status: "APPROVED" },
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

      const [requests, absences] = await Promise.all([
        app.prisma.leaveRequest.findMany({
          where: { deletedAt: null, employee: { tenantId }, status: "APPROVED" },
          include: { leaveType: true, employee: { select: { firstName: true, lastName: true } } },
        }),
        app.prisma.absence.findMany({
          where: { deletedAt: null, employee: { tenantId } },
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
        select: { tenantId: true, exitDate: true },
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

      // Resturlaub auto-übertragen falls nötig
      const vacTypeId = await ensureLeaveType(app.prisma, app.log, tenantId, "VACATION");
      await autoCarryOver(app.prisma, tenantId, employeeId, vacTypeId, targetYear);

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

      // Vacation type meta — shared with selfHealUsedDays AND the pro-rata mapping below
      const vacMeta = await loadVacationTypeMeta(app.prisma, tenantId);

      // exitDate for pro-rata effective entitlement computation (§ 5 Abs. 2 BUrlG) —
      // reuse the `employee` row loaded by the tenant guard above.
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

      // EuGH C-684/16: batch-fetch which entitlements have a documented warning so the
      // synchronous rows.map() can call getEffectiveCarryOver with the hinweisIssued flag.
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

      // typeCode + effektiven Resturlaub + anteiligen Urlaubsanspruch im Response markieren
      return rows.map((r) => {
        // Phase 97: the vacation account is the row whose CODE is VACATION. This used to be a
        // lookup against a hard-coded list of German display names, which misclassified any
        // renamed row. Do not name that list here — plan 09 removes its last definition and
        // asserts repo-wide that the identifier is gone.
        const isVacationRow = r.leaveType.code === "VACATION";
        const effectiveEntitlementDays =
          isVacationRow && employeeExitDate
            ? calculateProRataVacation(Number(r.totalDays), r.year, employeeExitDate)
            : Number(r.totalDays);
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
          effectiveCarryOverDays: getEffectiveCarryOver(r, now, warnedEntitlementIds.has(r.id)),
          carryOverDeadline: r.carryOverDeadline?.toISOString().split("T")[0] ?? null,
          effectiveEntitlementDays,
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
    handler: async (req) => {
      const { status } = section9StatusQuerySchema.parse(req.query);
      const isManager = await hasPermission(req, "section9:read:ZUGEWIESEN");
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
      const credited = intersectRanges(
        attestFrom,
        attestTo,
        credit.overlapStart,
        credit.overlapEnd,
      );
      if (!credited) {
        return reply.code(400).send({
          error:
            "Die AU deckt keinen Tag des betroffenen Urlaubszeitraums ab — keine Gutschrift nach § 9 BUrlG.",
        });
      }

      const tenantId = req.user.tenantId;
      const holidayMap = await getHolidayMap(app.prisma, tenantId, credited.start, credited.end);
      const holidays = new Set(holidayMap.keys());
      // D-08: Halber Urlaubstag + ganztägige Krankheit → Gutschrift 0,5. Zurückgegeben wird
      // ausschließlich, was angerechnet war — der halfDay-Flag stammt daher vom URLAUBSantrag,
      // nicht von der Krankmeldung (halbe Kranktage sind systemweit verboten, leave.ts:239).
      // Phase 107 (D-09): the affected vacation can belong to a SHIFT_BASED employee, so the
      // credit-back is routed through the same roster-aware resolver for consistency. `.days`
      // only -- a credit-back is a REDUCTION of a prior deduction, never a new approved
      // consumption, so no daysProvisional is written here.
      const { days: creditedDays } = await resolveLeaveDays(
        app.prisma,
        credit.employeeId,
        tenantId,
        credited.start,
        credited.end,
        credit.vacationRequest.halfDay,
        holidays,
      );
      if (creditedDays <= 0) {
        return reply
          .code(400)
          .send({ error: "Kein anrechenbarer Arbeitstag im attestierten Zeitraum." });
      }

      // reverseVacationDays IGNORES totalDays in its cross-year branch and recomputes it with
      // halfDay=false. A half-day request whose credited range crosses a year boundary would
      // therefore be over-booked. Refuse loudly instead of mis-booking silently.
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

          // D-19 / R9: Ist die Übertragsfrist des Ursprungsjahres bereits abgelaufen, verfallen
          // die Tage NICHT (EuGH KHS C-214/10 — 15 Monate). Wir markieren den Folgejahres-
          // Übertrag als krankheitsbedingt; preserveIllnessDeadline (Phase 104-04) schützt
          // diese Frist bei späteren Buchungen vor stillem Überschreiben.
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
      const section9Managers = await app.prisma.employee.findMany({
        where: {
          tenantId: credit.employee.tenantId,
          user: {
            id: { in: reopenSection9DecideHolderIds, not: req.user.sub },
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
 * Überträgt automatisch nicht genommene Urlaubstage des Vorjahres als Resturlaub
 * ins aktuelle Jahr — sofern das noch nicht passiert ist.
 * Wird lazy bei jedem Urlaubsantrag und Kontoabruf aufgerufen.
 */
async function autoCarryOver(
  prisma: FastifyInstance["prisma"],
  tenantId: string,
  employeeId: string,
  leaveTypeId: string,
  year: number,
): Promise<void> {
  const prevYear = year - 1;

  // Vorjahres-Entitlement holen
  const prev = await prisma.leaveEntitlement.findUnique({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year: prevYear } },
  });
  if (!prev) return;

  const remaining = Number(prev.totalDays) + Number(prev.carriedOverDays) - Number(prev.usedDays);
  if (remaining <= 0) return;

  // Bereits übertragen? → abbrechen
  const cur = await prisma.leaveEntitlement.findUnique({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
  });
  if (cur && Number(cur.carriedOverDays) > 0) return;

  // Verfallsdatum aus TenantConfig
  const config = await prisma.tenantConfig.findUnique({ where: { tenantId } });
  const deadlineDay = config?.carryOverDeadlineDay ?? 31;
  const deadlineMonth = config?.carryOverDeadlineMonth ?? 3;
  const deadline = new Date(year, deadlineMonth - 1, deadlineDay, 23, 59, 59);

  if (cur) {
    // Phase 104 (D-19): see recalculateCarryOver — same ILLNESS deadline protection.
    const illnessProtected = preserveIllnessDeadline(cur);
    await prisma.leaveEntitlement.update({
      where: { id: cur.id },
      data: illnessProtected
        ? { carriedOverDays: remaining }
        : { carriedOverDays: remaining, carryOverDeadline: deadline },
    });
  } else {
    await prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId,
        year,
        totalDays: 0,
        usedDays: 0,
        carriedOverDays: remaining,
        carryOverDeadline: deadline,
      },
    });
  }
}

/**
 * Gibt den effektiven Resturlaub zurück.
 *
 * EuGH C-684/16 (Hinweispflicht, docs/burlg-carryover.md): Resturlaub verfällt am
 * Stichtag nur dann, wenn der Arbeitgeber den Arbeitnehmer zuvor ausdrücklich auf
 * den bevorstehenden Verfall hingewiesen hat (CARRYOVER_WARNED AuditLog-Eintrag).
 * Ohne dokumentierten Hinweis bleibt der Anspruch erhalten.
 *
 * @param hinweisIssued - true wenn ein CARRYOVER_WARNED-AuditLog für dieses
 *   LeaveEntitlement existiert (vor dem Aufruf per count-Query zu ermitteln).
 */
function getEffectiveCarryOver(
  entitlement: { carriedOverDays: Prisma.Decimal | number; carryOverDeadline: Date | null },
  referenceDate: Date,
  hinweisIssued: boolean,
): number {
  const carryOver = Number(entitlement.carriedOverDays);
  if (carryOver <= 0) return 0;
  if (!entitlement.carryOverDeadline) return carryOver; // kein Verfall konfiguriert
  if (referenceDate <= entitlement.carryOverDeadline) return carryOver; // Stichtag noch nicht erreicht
  if (!hinweisIssued) return carryOver; // EuGH C-684/16: kein Verfall ohne dokumentierten Hinweis
  return 0;
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
 * Berechnet die tatsächlich geplanten Arbeitsstunden für einen Zeitraum
 * basierend auf dem individuellen WorkSchedule des Mitarbeiters (oder den
 * globalen Tenant-Defaults falls kein individueller Plan vorhanden).
 * Halbe Tage = halbe Stunden des ersten Arbeitstages.
 *
 * SHIFT_BASED (owner decision on issue #293, 2026-09-23): this used to sum the rostered
 * `Shift` rows (Phase 100 / OTC-04, D-05..D-08 — superseded by this decision, not just
 * amended). That made the receipt answer a different question than the saldo, which credits
 * an OVERTIME_COMP day via the Ø-Methode (`calcLeaveAbsenceMinutesTz`,
 * `close-employee-month.ts:721`) — the two could and did diverge (issue #293). The decided
 * rule: the day IS the average contract day, full stop. This branch now calls the SAME
 * function the saldo calls, on the SAME schedule row, so the receipt amount and the saldo
 * effect are one number because they are one function call — not two formulas kept in sync by
 * hand. Half-day uses that function's own `halfDay` option (no bespoke first-shift-halved
 * path any more). An employee with no shifts in the range now costs a full Ø-Methode day —
 * an empty roster is no longer free, which is the material behavior change from D-08.
 */
async function getScheduledHours(
  prisma: DbClient,
  employeeId: string,
  start: Date,
  end: Date,
  halfDay: boolean,
  holidays: Set<string> = new Set(),
): Promise<number> {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    include: {
      workSchedules: {
        where: { validFrom: { lte: start } },
        orderBy: { validFrom: "desc" },
        take: 1,
      },
      tenant: { include: { config: true } },
    },
  });

  const ws = employee?.workSchedules[0] ?? null;
  const cfg = employee?.tenant?.config;

  // SHIFT_BASED (issue #293): the receipt follows the account — see the docblock above.
  // Returns BEFORE the FIXED_SCHEDULE / FLEXTIME / MONTHLY_HOURS per-weekday path below, which
  // stays byte-for-byte unchanged for every other schedule type.
  if (ws?.type === "SHIFT_BASED") {
    // `cfg.timezone` (not `getTenantTimezone()`): that helper's signature is
    // `FastifyInstance["prisma"]`, not tx-compatible, and this function is called with a
    // transaction client at the correction site (`:1899`/`:1951`) — same reason
    // `shift-leave-recalc-resolver.ts` avoids it. `cfg` is already loaded above by this
    // function's own employee query, so this needs no extra read at all; "Europe/Berlin" is
    // the same fallback `getTenantTimezone()` itself uses for a tenant with no config row.
    const tz = cfg?.timezone ?? "Europe/Berlin";

    // The `holidays` set is deliberately NOT forwarded here, mirroring
    // `close-employee-month.ts:721-729` exactly: the saldo side passes a cross-row
    // already-claimed-days dedup set on that call, not public holidays, so forwarding this
    // function's own `holidays` argument would apply a set the saldo side never sees.
    const minutes = calcLeaveAbsenceMinutesTz(ws, start, end, tz, { halfDay });
    return minutes / 60;
  }

  // Stunden pro Wochentag (0=So, 1=Mo … 6=Sa)
  const h: Record<number, number> = {
    0: ws ? Number(ws.sundayHours) : Number(cfg?.defaultSundayHours ?? 0), // D-07: was hardcoded 0 (Sunday workers)
    1: ws ? Number(ws.mondayHours) : Number(cfg?.defaultMondayHours ?? 8),
    2: ws ? Number(ws.tuesdayHours) : Number(cfg?.defaultTuesdayHours ?? 8),
    3: ws ? Number(ws.wednesdayHours) : Number(cfg?.defaultWednesdayHours ?? 8),
    4: ws ? Number(ws.thursdayHours) : Number(cfg?.defaultThursdayHours ?? 8),
    5: ws ? Number(ws.fridayHours) : Number(cfg?.defaultFridayHours ?? 8),
    6: ws ? Number(ws.saturdayHours) : Number(cfg?.defaultSaturdayHours ?? 0),
  };

  if (halfDay) {
    // Halber erster Arbeitstag (Feiertage überspringen)
    const cur = new Date(start);
    while (cur <= end) {
      const dow = cur.getDay();
      const ds = cur.toISOString().split("T")[0];
      if (h[dow] > 0 && !holidays.has(ds)) return h[dow] / 2;
      cur.setDate(cur.getDate() + 1);
    }
    return 0;
  }

  let total = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const ds = cur.toISOString().split("T")[0];
    if (!holidays.has(ds)) total += h[cur.getDay()];
    cur.setDate(cur.getDate() + 1);
  }
  return total;
}
