import { FastifyInstance } from "fastify";
import { z } from "zod";
import { LeaveRequestStatus, Prisma } from "@clokr/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { getHolidays, STATE_MAP } from "../utils/holidays";
import { getTenantTimezone, monthRangeUtc } from "../utils/timezone";
import { generateICal, addOneDay, type ICalEvent } from "../utils/ical";
import { recalculateSnapshots } from "../utils/recalculate-snapshots";
import { splitDaysAcrossYears, calculateProRataVacation } from "../utils/vacation-calc";
import { selfHealUsedDays, loadVacationTypeMeta } from "../utils/leave-self-heal";
import { calculateWorkDays } from "../utils/calculate-work-days";
import { computeAffectedMonths } from "../utils/correction-lock";
import { periodStartWindow } from "../utils/snapshot-period";
import {
  updateOvertimeAccount,
  computeOvertimeBalanceBreakdown,
  type OvertimeBalanceBreakdown,
} from "./time-entries";
import { getConfirmedCarryOver } from "../utils/confirmed-saldo"; // Phase 97-06
import { loadNegativeBalanceTolerance } from "../utils/negative-balance-tolerance"; // Phase 100
import { formatMinutesHM } from "../utils/format-hm"; // Phase 100
import { shiftNettoMinutes, sumShiftNettoMinutes } from "../utils/shift-netto"; // Phase 100 (OTC-04)
import { auditReasonSchema } from "../utils/audit-reason"; // Quick 260824-cjd
import { preserveIllnessDeadline } from "../utils/illness-carryover-guard"; // Phase 104
import { isSickTypeName, findSection9Overlaps, intersectRanges } from "../utils/section9-detect"; // Phase 104-05/06

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
const TYPE_CODES = [
  "VACATION",
  "OVERTIME_COMP",
  "SPECIAL",
  "UNPAID",
  "SICK",
  "SICK_CHILD",
  "EDUCATION",
  "MATERNITY",
  "PARENTAL",
] as const;
type TypeCode = (typeof TYPE_CODES)[number];

const LEAVE_TYPE_DEFS: Record<
  TypeCode,
  { name: string; isPaid: boolean; requiresApproval: boolean }
> = {
  VACATION: { name: "Urlaub", isPaid: true, requiresApproval: true },
  OVERTIME_COMP: { name: "Überstundenausgleich", isPaid: true, requiresApproval: true },
  SPECIAL: { name: "Sonderurlaub", isPaid: true, requiresApproval: true },
  UNPAID: { name: "Unbezahlter Urlaub", isPaid: false, requiresApproval: true },
  SICK: { name: "Krankmeldung", isPaid: true, requiresApproval: false },
  SICK_CHILD: { name: "Kinderkrank", isPaid: true, requiresApproval: false },
  EDUCATION: { name: "Bildungsurlaub", isPaid: true, requiresApproval: true },
  MATERNITY: { name: "Mutterschutz", isPaid: true, requiresApproval: false },
  PARENTAL: { name: "Elternzeit", isPaid: false, requiresApproval: true },
};

// Legacy-Namen aus alten Seed-Skripten → werden beim ersten Zugriff umbenannt
const LEGACY_ALIASES: Partial<Record<TypeCode, string[]>> = {
  VACATION: ["Jahresurlaub", "Urlaub (Jahresurlaub)"],
};

/** Stellt sicher, dass ein LeaveType-Eintrag für den Tenant existiert – gibt seine ID zurück.
 *  Migriert automatisch alte Seed-Namen (z.B. "Jahresurlaub" → "Urlaub"). */
async function ensureLeaveType(
  prisma: FastifyInstance["prisma"],
  tenantId: string,
  code: TypeCode,
): Promise<string> {
  const def = LEAVE_TYPE_DEFS[code];
  // 1. Kanonischer Name
  const existing = await prisma.leaveType.findFirst({ where: { tenantId, name: def.name } });
  if (existing) return existing.id;
  // 2. Legacy-Alias → umbenennen + zurückgeben
  const aliases = LEGACY_ALIASES[code] ?? [];
  for (const alias of aliases) {
    const legacy = await prisma.leaveType.findFirst({ where: { tenantId, name: alias } });
    if (legacy) {
      await prisma.leaveType.update({ where: { id: legacy.id }, data: { name: def.name } });
      return legacy.id;
    }
  }
  // 3. Neu anlegen
  const created = await prisma.leaveType.create({ data: { tenantId, ...def } });
  return created.id;
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

// Phase 104-06 — POST /section9/:id/confirm ("AU liegt vor").
// D-27: Gültigkeit + Herkunft + Pflichtbegründung. KEINE Arzt-/Diagnoseangaben (Art. 9 DSGVO).
const section9ConfirmSchema = z.object({
  attestSource: z.enum(["EAU", "PAPIER"]),
  attestValidFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  attestValidTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().trim().min(1, "Begründung ist erforderlich"),
});

// Phase 104-06 — POST /section9/:id/reject and /reopen. Pflichtbegründung (D-11).
// Bewusst NICHT .optional() — der Zod-Gotcha aus CLAUDE.md verlangt, dass ein explizit
// gesendetes null als 400 mit klarer Meldung endet, nicht als nacktes "Validierungsfehler".
// min(1) auf einem non-nullable string liefert genau das.
const section9ReasonSchema = z.object({
  reason: z.string().trim().min(1, "Begründung ist erforderlich"),
});

// Phase 104 review (WR-04) — GET /section9?status=
// The value was cast straight into the Prisma where clause (`status as never`). Any value
// outside the enum made Prisma throw a PrismaClientValidationError, which the global handler
// turns into a 500 echoing the full Prisma text (model name, field list, expected enum
// members) back to the caller. Every other route in this file validates its query with Zod.
const section9StatusQuerySchema = z.object({
  status: z.enum(["AU_PENDING", "CONFIRMED", "REJECTED"]).optional(),
});

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
        if (req.user.role !== "MANAGER" && req.user.role !== "ADMIN") {
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
      const workDays = await resolveWorkDays(app.prisma, employeeId, tenantId);
      const days = calculateWorkDays(start, end, body.halfDay, workDays, holidays);

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
        if (isSickTypeName(o.leaveType.name)) return true; // sick vs sick: still blocked
        return false; // § 9 case — permitted
      });
      if (blockingOverlap)
        return reply.code(409).send({ error: "Überschneidung mit bestehendem Antrag" });

      // Load tenant config for leave rules
      const tenantConfig = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });

      const leaveTypeId = await ensureLeaveType(app.prisma, tenantId, body.type);
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
          const confirmed = await getConfirmedCarryOver(app, employeeId);
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
          const account = await app.prisma.overtimeAccount.findUnique({ where: { employeeId } });
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
        const rule = await app.prisma.specialLeaveRule.findUnique({
          where: { id: body.specialLeaveRuleId },
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
      const typeDef = LEAVE_TYPE_DEFS[body.type];
      const managers = await app.prisma.user.findMany({
        where: {
          role: { in: ["ADMIN", "MANAGER"] },
          isActive: true,
          employee: { tenantId: req.user.tenantId },
        },
        select: { id: true },
      });
      for (const mgr of managers) {
        await app.notify({
          userId: mgr.id,
          type: "LEAVE_REQUEST",
          title: "Neuer Urlaubsantrag",
          message: `${request.employee.firstName} ${request.employee.lastName} hat einen ${typeDef.name}-Antrag gestellt (${body.startDate} – ${body.endDate})`,
          // Manager-facing: link to the approval surface (/team/leave honors ?request=),
          // NOT /leave (which only shows the recipient's OWN requests).
          link: `/team/leave?request=${request.id}`,
          tenantId,
          relatedType: "LeaveRequest",
          relatedId: request.id,
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
      const isManager = ["ADMIN", "MANAGER"].includes(user.role);
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

      const rows = await app.prisma.leaveRequest.findMany({
        where: {
          deletedAt: null,
          ...(isManager
            ? {
                employee: { tenantId: user.tenantId },
                ...(employeeId ? { employeeId } : {}),
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

      return rows.map((r) => ({
        ...r,
        typeCode:
          TYPE_CODES.find((c) => LEAVE_TYPE_DEFS[c].name === r.leaveType.name) ?? "VACATION",
        startDate: r.startDate.toISOString().split("T")[0],
        endDate: r.endDate.toISOString().split("T")[0],
        attestValidFrom: r.attestValidFrom?.toISOString().split("T")[0] ?? null,
        attestValidTo: r.attestValidTo?.toISOString().split("T")[0] ?? null,
        section9Status: section9StatusByRequestId.get(r.id)?.status ?? null,
        section9CreditId: section9StatusByRequestId.get(r.id)?.creditId ?? null,
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
          status: { in: ["PENDING", "APPROVED"] },
          startDate: { lte: end },
          endDate: { gte: start },
        },
        include: {
          leaveType: true,
          employee: { select: { firstName: true, lastName: true } },
        },
        orderBy: { startDate: "asc" },
      });

      return rows.map((r) => ({
        id: r.id,
        employeeName: `${r.employee.firstName} ${r.employee.lastName}`,
        typeCode:
          TYPE_CODES.find((c) => LEAVE_TYPE_DEFS[c].name === r.leaveType.name) ?? "VACATION",
        typeName: r.leaveType.name,
        startDate: r.startDate.toISOString().split("T")[0],
        endDate: r.endDate.toISOString().split("T")[0],
        status: r.status,
      }));
    },
  });

  // ── PATCH /requests/:id/review  – Genehmigen / Ablehnen ─────────────────
  app.patch("/requests/:id/review", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
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
          await app.prisma.timeEntry.updateMany({
            where: {
              employeeId: existing.employeeId,
              date: { gte: existing.startDate, lte: existing.endDate },
              isInvalid: true,
              invalidReason: "Urlaubsstornierung ausstehend",
              deletedAt: null, // D-08: never touch soft-deleted entries
              isLocked: false, // D-08: never mutate locked-month entries (Revisionssicherheit)
            },
            data: { isInvalid: false, invalidReason: null },
          });

          const typeCode = TYPE_CODES.find(
            (c) => LEAVE_TYPE_DEFS[c].name === existing.leaveType.name,
          );
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
            const hMap = await getHolidayMap(
              app.prisma,
              empT?.tenantId ?? "",
              existing.startDate,
              existing.endDate,
            );
            const [acct, hrs] = await Promise.all([
              app.prisma.overtimeAccount.findUnique({ where: { employeeId: existing.employeeId } }),
              getScheduledHours(
                app.prisma,
                existing.employeeId,
                existing.startDate,
                existing.endDate,
                existing.halfDay,
                new Set(hMap.keys()),
              ),
            ]);
            if (acct && hrs > 0) {
              await app.prisma.overtimeAccount.update({
                where: { id: acct.id },
                data: { balanceHours: { increment: hrs } },
              });
              await app.prisma.overtimeTransaction.create({
                data: {
                  overtimeAccountId: acct.id,
                  hours: hrs,
                  type: "CORRECTION",
                  description: `Stornierung Überstundenausgleich ${existing.startDate.toISOString().split("T")[0]}`,
                },
              });
            }
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
          await updateOvertimeAccount(app, existing.employeeId).catch((err) =>
            app.log.error(
              { err, employeeId: existing.employeeId },
              "Failed to update overtime account after leave cancellation",
            ),
          );
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
          typeCode:
            TYPE_CODES.find((c) => LEAVE_TYPE_DEFS[c].name === refreshed!.leaveType.name) ??
            "VACATION",
          startDate: refreshed!.startDate.toISOString().split("T")[0],
          endDate: refreshed!.endDate.toISOString().split("T")[0],
        };
      }

      // ── Normaler Antrag (PENDING) ────────────────────────────────────────────
      const updated = await app.prisma.leaveRequest.update({
        where: { id },
        data: {
          status: body.status,
          reviewedBy: req.user.sub,
          reviewedAt: new Date(),
          reviewNote: body.reviewNote,
        },
        include: {
          employee: { select: { firstName: true, lastName: true } },
          leaveType: true,
        },
      });

      if (body.status === "APPROVED") {
        const typeCode = TYPE_CODES.find(
          (c) => LEAVE_TYPE_DEFS[c].name === existing.leaveType.name,
        );

        if (typeCode === "VACATION") {
          const empForDeduct = await app.prisma.employee.findUnique({
            where: { id: existing.employeeId },
          });
          const holidayMapForDeduct = await getHolidayMap(
            app.prisma,
            empForDeduct?.tenantId ?? "",
            existing.startDate,
            existing.endDate,
          );
          await deductVacationDays(
            app.prisma,
            existing.employeeId,
            existing.leaveTypeId,
            existing.startDate,
            existing.endDate,
            Number(existing.days),
            new Set(holidayMapForDeduct.keys()),
            empForDeduct?.tenantId ?? "",
          );
        }

        if (typeCode === "OVERTIME_COMP") {
          const empTenant = await app.prisma.employee.findUnique({
            where: { id: existing.employeeId },
            select: { tenantId: true },
          });
          const hMap = await getHolidayMap(
            app.prisma,
            empTenant?.tenantId ?? "",
            existing.startDate,
            existing.endDate,
          );
          const [account, hours] = await Promise.all([
            app.prisma.overtimeAccount.findUnique({ where: { employeeId: existing.employeeId } }),
            getScheduledHours(
              app.prisma,
              existing.employeeId,
              existing.startDate,
              existing.endDate,
              existing.halfDay,
              new Set(hMap.keys()),
            ),
          ]);
          if (account && hours > 0) {
            await app.prisma.overtimeAccount.update({
              where: { id: account.id },
              data: { balanceHours: { decrement: hours } },
            });
            await app.prisma.overtimeTransaction.create({
              data: {
                overtimeAccountId: account.id,
                hours: -hours,
                type: "REDUCTION",
                description: `Überstundenausgleich ${existing.startDate.toISOString().split("T")[0]} – ${existing.endDate.toISOString().split("T")[0]}`,
              },
            });
          }
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
            const rangeLabel = `${ov.overlapStart.toISOString().split("T")[0]} – ${ov.overlapEnd.toISOString().split("T")[0]}`;
            if (employeeUser?.userId) {
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
            const section9Managers = await app.prisma.employee.findMany({
              where: {
                tenantId: employeeUser?.tenantId,
                user: {
                  role: { in: ["ADMIN", "MANAGER"] },
                  isActive: true,
                  id: { not: req.user.sub }, // Phase-91 idiom: never notify the actor
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
                tenantId: employeeUser?.tenantId,
                relatedType: "Section9Credit",
                relatedId: credit.id,
              });
            }
          }
        }
      }

      await app.audit({
        userId: req.user.sub,
        action: body.status === "APPROVED" ? "APPROVE" : "REJECT",
        entity: "LeaveRequest",
        entityId: id,
        newValue: { status: body.status, reviewNote: body.reviewNote },
      });

      // Retroactive recalculation: leave approval affects snapshots
      if (body.status === "APPROVED") {
        await recalculateSnapshots(app, existing.employeeId, existing.startDate).catch((err) =>
          app.log.error(
            { err, employeeId: existing.employeeId },
            "Failed to recalculate snapshots after leave approval",
          ),
        );
        await updateOvertimeAccount(app, existing.employeeId).catch((err) =>
          app.log.error(
            { err, employeeId: existing.employeeId },
            "Failed to update overtime account after leave approval",
          ),
        );

        // Phase 43-04: reverse-hook — when a leave is APPROVED, mark any
        // existing shifts for this employee on overlapping dates as
        // conflictsWithLeave=true (audit-proof: never silent-delete shifts).
        // Best-effort: never roll back the approval if marking fails.
        try {
          const conflictingShifts = await app.prisma.shift.findMany({
            where: {
              employeeId: existing.employeeId,
              date: { gte: existing.startDate, lte: existing.endDate },
              conflictsWithLeave: false,
              deletedAt: null, // Phase 67.2 — leave-approval hook only flags ACTIVE shifts
            },
            select: { id: true, date: true, startTime: true, endTime: true, label: true },
          });

          if (conflictingShifts.length > 0) {
            await app.prisma.shift.updateMany({
              where: { id: { in: conflictingShifts.map((s) => s.id) } },
              data: { conflictsWithLeave: true },
            });

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
                const managers = await app.prisma.user.findMany({
                  where: {
                    isActive: true,
                    role: { in: ["MANAGER", "ADMIN"] },
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
        const typeCodeForWarning = TYPE_CODES.find(
          (c) => LEAVE_TYPE_DEFS[c].name === existing.leaveType.name,
        );
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
                const vacLeaveType = await app.prisma.leaveType.findFirst({
                  where: { tenantId: empWithExit.tenantId, name: "Urlaub" },
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
        typeCode:
          TYPE_CODES.find((c) => LEAVE_TYPE_DEFS[c].name === updated.leaveType.name) ?? "VACATION",
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
        include: { leaveType: true },
      });
      if (!existing) return reply.code(404).send({ error: "Antrag nicht gefunden" });
      if (existing.employeeId !== req.user.employeeId)
        return reply.code(403).send({ error: "Forbidden" });
      if (existing.status !== "PENDING")
        return reply.code(409).send({ error: "Nur ausstehende Anträge können bearbeitet werden" });

      // ── Half-day sick rejection (legal: teilweise AU gibt es nicht) ──
      const existingTypeCode = TYPE_CODES.find(
        (c) => LEAVE_TYPE_DEFS[c].name === existing.leaveType.name,
      );
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
      const workDays = await resolveWorkDays(app.prisma, existing.employeeId, tenantId);
      const days = calculateWorkDays(start, end, body.halfDay, workDays, holidays);

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
        typeCode:
          TYPE_CODES.find((c) => LEAVE_TYPE_DEFS[c].name === updated.leaveType.name) ?? "VACATION",
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
    preHandler: requireRole("ADMIN", "MANAGER"),
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
      const existingTypeCode = TYPE_CODES.find(
        (c) => LEAVE_TYPE_DEFS[c].name === existing.leaveType.name,
      );
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
          // MONTHLY SaldoSnapshot(superseded:false) = the canonical Monatsabschluss
          // signal (convention-robust window, see utils/snapshot-period.ts).
          const locked = await app.prisma.saldoSnapshot.findFirst({
            where: {
              employeeId: existing.employeeId,
              periodType: "MONTHLY",
              periodStart: periodStartWindow(monthStart),
              superseded: false,
            },
          });
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
      const oldTypeCode = existingTypeCode; // from existing.leaveType.name (delta-lock step)
      const newType = body.type ?? oldTypeCode;

      // IN-94-01: if the existing leaveType.name is neither canonical nor a known
      // alias, existingTypeCode (hence oldTypeCode) is undefined; when the type is
      // also left unchanged, newType is undefined too. The reverse/apply dispatch
      // would then silently fall through to no-op — updating dates/days on the row
      // WITHOUT adjusting the entitlement ledger (a stranded Kontingent). For
      // audit-proof code, fail loud rather than skip the authoritative booking.
      if (!oldTypeCode || !newType) {
        app.log.error(
          { id, name: existing.leaveType.name, oldTypeCode, newType },
          "Unresolved leaveType on leave correction — refusing to skip entitlement booking",
        );
        return reply.code(400).send({ error: "Unbekannter Antragstyp — Korrektur nicht möglich" });
      }

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
      const workDays = await resolveWorkDays(app.prisma, existing.employeeId, tenantId);
      const days = calculateWorkDays(start, end, body.halfDay, workDays, holidays);

      // Resolve the NEW leaveTypeId when the type changed (ensureLeaveType migrates
      // legacy names / creates the canonical type on demand).
      const newLeaveTypeId =
        typeChanged && body.type != null
          ? await ensureLeaveType(app.prisma, tenantId, body.type)
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
          const acct = await tx.overtimeAccount.findUnique({
            where: { employeeId: existing.employeeId },
          });
          const hrs = await getScheduledHours(
            tx,
            existing.employeeId,
            existing.startDate,
            existing.endDate,
            existing.halfDay,
            holidays,
          );
          if (acct && hrs > 0) {
            await tx.overtimeAccount.update({
              where: { id: acct.id },
              data: { balanceHours: { increment: hrs } },
            });
            await tx.overtimeTransaction.create({
              data: {
                overtimeAccountId: acct.id,
                hours: hrs,
                type: "CORRECTION",
                description: `Korrektur Überstundenausgleich ${existing.startDate.toISOString().split("T")[0]}`,
              },
            });
          }
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
          const acct = await tx.overtimeAccount.findUnique({
            where: { employeeId: existing.employeeId },
          });
          const hrs = await getScheduledHours(
            tx,
            existing.employeeId,
            start,
            end,
            body.halfDay,
            holidays,
          );
          if (acct && hrs > 0) {
            await tx.overtimeAccount.update({
              where: { id: acct.id },
              data: { balanceHours: { decrement: hrs } },
            });
            await tx.overtimeTransaction.create({
              data: {
                overtimeAccountId: acct.id,
                hours: -hrs,
                type: "REDUCTION",
                description: `Überstundenausgleich ${start.toISOString().split("T")[0]} – ${end.toISOString().split("T")[0]}`,
              },
            });
          }
        }
        // SICK / SICK_CHILD / PARENTAL / MATERNITY / SPECIAL / UNPAID / EDUCATION:
        // entitlement-neutral on the apply side (light).

        // ── Step 11: revalidate removed-day time entries (old range \ new range).
        //    A shortened/moved leave frees days whose leave-caused invalidation must
        //    be cleared. Delta-lock already guarantees these fall in unlocked months;
        //    locked / soft-deleted entries are never touched (Revisionssicherheit).
        const revalidateRemoved = async (from: Date, to: Date) => {
          if (from > to) return;
          await tx.timeEntry.updateMany({
            where: {
              employeeId: existing.employeeId,
              date: { gte: from, lte: to },
              isInvalid: true,
              invalidReason: "Urlaubsstornierung ausstehend",
              deletedAt: null,
              isLocked: false,
            },
            data: { isInvalid: false, invalidReason: null },
          });
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
      await updateOvertimeAccount(app, existing.employeeId).catch((err) =>
        app.log.error(
          { err, employeeId: existing.employeeId },
          "Failed to update overtime account after leave correction",
        ),
      );

      return {
        ...updated,
        typeCode:
          TYPE_CODES.find((c) => LEAVE_TYPE_DEFS[c].name === updated.leaveType.name) ?? "VACATION",
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
      const isManager = ["ADMIN", "MANAGER"].includes(req.user.role);
      if (!isOwner && !isManager) return reply.code(403).send({ error: "Forbidden" });
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
    preHandler: requireRole("ADMIN", "MANAGER"),
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

      const typeCode = TYPE_CODES.find((c) => LEAVE_TYPE_DEFS[c].name === existing.leaveType.name);
      if (typeCode !== "SICK" && typeCode !== "SICK_CHILD") {
        return reply.code(400).send({ error: "Attest kann nur für Krankmeldungen gesetzt werden" });
      }

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
        newValue: { attest: body },
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

      const isManager = ["ADMIN", "MANAGER"].includes(req.user.role);

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

      const leaveEntries = rows.map((r) => {
        const isOwn = r.employee.userId === req.user.sub;
        const showDetails = isOwn || isManager;
        return {
          id: r.id,
          isOwn,
          employeeId: r.employeeId,
          firstName: r.employee.firstName,
          lastName: r.employee.lastName,
          typeCode: showDetails
            ? (TYPE_CODES.find((c) => LEAVE_TYPE_DEFS[c].name === r.leaveType.name) ?? "VACATION")
            : null,
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
      const workDays = await resolveWorkDays(app.prisma, employeeId, tenantId);

      const [hours, days] = await Promise.all([
        getScheduledHours(app.prisma, employeeId, start, end, isHalf, holidays),
        Promise.resolve(calculateWorkDays(start, end, isHalf, workDays, holidays)),
      ]);

      // WR-03 (code review) — exact integer minutes, computed with the SAME
      // Math.round(hoursNeeded * 60) formula the POST /requests OVERTIME_COMP gate
      // uses for `neededMinutes` above. `hours` is rounded to 2 decimal PLACES for
      // display; `minutesNeeded` lets the client compare against confirmedMinutes /
      // maxNegativeBalanceMinutes (already exact integer minutes from GET
      // /leave/overtime-balance) without reconstructing the server's exact-minute
      // gate through two different rounding paths.
      return { hours: +hours.toFixed(2), days, minutesNeeded: Math.round(hours * 60) };
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
      const account = await app.prisma.overtimeAccount.findUnique({ where: { employeeId } });
      const balanceHours = account ? Math.round(Number(account.balanceHours) * 100) / 100 : 0;
      try {
        const confirmed = await getConfirmedCarryOver(app, employeeId);
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

      const events: ICalEvent[] = requests.map((r) => {
        const typeCode = TYPE_CODES.find((c) => LEAVE_TYPE_DEFS[c].name === r.leaveType.name);
        const summary = LEAVE_TYPE_DEFS[typeCode as TypeCode]?.name ?? r.leaveType.name;
        return {
          uid: `leave-${r.id}@clokr`,
          summary,
          dtstart: r.startDate.toISOString().split("T")[0],
          dtend: addOneDay(r.endDate.toISOString().split("T")[0]),
          description: r.note ?? undefined,
          status: "CONFIRMED",
          categories: typeCode ?? "VACATION",
        };
      });

      for (const a of absences) {
        const summary =
          a.type === "SICK"
            ? "Krankmeldung"
            : a.type === "SICK_CHILD"
              ? "Kinderkrank"
              : a.type === "MATERNITY"
                ? "Mutterschutz"
                : a.type === "PARENTAL"
                  ? "Elternzeit"
                  : a.type === "SPECIAL_LEAVE"
                    ? "Sonderurlaub"
                    : a.type === "UNPAID_LEAVE"
                      ? "Unbezahlter Urlaub"
                      : "Abwesenheit";
        events.push({
          uid: `absence-${a.id}@clokr`,
          summary,
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
    preHandler: requireRole("ADMIN", "MANAGER"),
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
        const typeCode = TYPE_CODES.find((c) => LEAVE_TYPE_DEFS[c].name === r.leaveType.name);
        const typeName = LEAVE_TYPE_DEFS[typeCode as TypeCode]?.name ?? r.leaveType.name;
        return {
          uid: `leave-${r.id}@clokr`,
          summary: `${name} \u2014 ${typeName}`,
          dtstart: r.startDate.toISOString().split("T")[0],
          dtend: addOneDay(r.endDate.toISOString().split("T")[0]),
          description: r.note ?? undefined,
          status: "CONFIRMED",
          categories: typeCode ?? "VACATION",
        };
      });

      for (const a of absences) {
        const name = `${a.employee.firstName} ${a.employee.lastName}`;
        const summary =
          a.type === "SICK"
            ? "Krankmeldung"
            : a.type === "SICK_CHILD"
              ? "Kinderkrank"
              : a.type === "MATERNITY"
                ? "Mutterschutz"
                : a.type === "PARENTAL"
                  ? "Elternzeit"
                  : a.type === "SPECIAL_LEAVE"
                    ? "Sonderurlaub"
                    : a.type === "UNPAID_LEAVE"
                      ? "Unbezahlter Urlaub"
                      : "Abwesenheit";
        events.push({
          uid: `absence-${a.id}@clokr`,
          summary: `${name} \u2014 ${summary}`,
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
    handler: async (req) => {
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

      // Resturlaub auto-übertragen falls nötig
      const vacTypeId = await ensureLeaveType(app.prisma, tenantId, "VACATION");
      await autoCarryOver(app.prisma, tenantId, employeeId, vacTypeId, targetYear);

      const rows = await app.prisma.leaveEntitlement.findMany({
        where: { employeeId, ...(year ? { year: targetYear } : {}) },
        include: { leaveType: true },
      });

      // Vacation type meta — shared with selfHealUsedDays AND the pro-rata mapping below
      const vacMeta = await loadVacationTypeMeta(app.prisma, tenantId);
      const { vacationNames } = vacMeta;

      // Fetch exitDate for pro-rata effective entitlement computation (§ 5 Abs. 2 BUrlG)
      const empForEntitlement = await app.prisma.employee.findUnique({
        where: { id: employeeId, tenantId },
        select: { exitDate: true },
      });
      const employeeExitDate = empForEntitlement?.exitDate ?? null;

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
        const isVacationRow = vacationNames.includes(r.leaveType.name);
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
        return {
          ...r,
          typeCode: (Object.entries(LEAVE_TYPE_DEFS).find(
            ([, d]) => d.name === r.leaveType.name,
          )?.[0] ?? "VACATION") as TypeCode,
          effectiveCarryOverDays: getEffectiveCarryOver(r, now, warnedEntitlementIds.has(r.id)),
          carryOverDeadline: r.carryOverDeadline?.toISOString().split("T")[0] ?? null,
          effectiveEntitlementDays,
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

  // ── GET /section9 — § 9-BUrlG-Vorgänge (eigene, oder alle des Tenants für Manager) ──
  app.get("/section9", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req) => {
      const { status } = section9StatusQuerySchema.parse(req.query);
      const isManager = ["ADMIN", "MANAGER"].includes(req.user.role);
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
      const isManager = ["ADMIN", "MANAGER"].includes(req.user.role);

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

      if (!isManager && row.employeeId !== req.user.employeeId) {
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
    preHandler: requireRole("ADMIN", "MANAGER"),
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
      const workDays = await resolveWorkDays(app.prisma, credit.employeeId, tenantId);
      // D-08: Halber Urlaubstag + ganztägige Krankheit → Gutschrift 0,5. Zurückgegeben wird
      // ausschließlich, was angerechnet war — der halfDay-Flag stammt daher vom URLAUBSantrag,
      // nicht von der Krankmeldung (halbe Kranktage sind systemweit verboten, leave.ts:239).
      const creditedDays = calculateWorkDays(
        credited.start,
        credited.end,
        credit.vacationRequest.halfDay,
        workDays,
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
      if (
        credit.vacationRequest.halfDay &&
        credited.start.getFullYear() !== credited.end.getFullYear()
      ) {
        return reply.code(400).send({
          error:
            "Halbtags-Urlaub über einen Jahreswechsel kann nicht automatisch gutgeschrieben werden — bitte manuell korrigieren.",
        });
      }

      await app.prisma.$transaction(async (tx) => {
        // D-18: Gutschrift ins URSPRUNGSJAHR des Urlaubstags — § 9 stellt den ursprünglichen
        // Anspruch wieder her, er schafft keinen neuen. reverseVacationDays ist der
        // symmetrische Gegenpart zu deductVacationDays und kann cross-year splitten.
        await reverseVacationDays(
          tx,
          credit.employeeId,
          credit.vacationRequest.leaveTypeId,
          credited.start,
          credited.end,
          creditedDays,
          holidays,
          tenantId,
        );

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
        const originYear = credited.start.getFullYear();
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
              carryOverDeadline: new Date(originYear + 2, 2, 31, 23, 59, 59),
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
      });

      // Outside the transaction: clear "AU nachreichen" nudges, notify the employee.
      await app.dismissByRelated("Section9Credit", credit.id);

      if (credit.employee.userId) {
        const rangeLabel = `${credited.start.toISOString().split("T")[0]} – ${credited.end.toISOString().split("T")[0]}`;
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
    preHandler: requireRole("ADMIN", "MANAGER"),
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
    preHandler: requireRole("ADMIN", "MANAGER"),
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
      const rangeLabel = `${credit.overlapStart.toISOString().split("T")[0]} – ${credit.overlapEnd.toISOString().split("T")[0]}`;
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
      const section9Managers = await app.prisma.employee.findMany({
        where: {
          tenantId: credit.employee.tenantId,
          user: {
            role: { in: ["ADMIN", "MANAGER"] },
            isActive: true,
            id: { not: req.user.sub },
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
 * Recalculates carry-over for a given year based on the previous year's current state.
 * Called after every booking/cancellation to keep projected carry-over accurate.
 */
async function recalculateCarryOver(
  prisma: DbClient,
  tenantId: string,
  employeeId: string,
  leaveTypeId: string,
  year: number,
): Promise<void> {
  const prevYear = year - 1;
  const prev = await prisma.leaveEntitlement.findUnique({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year: prevYear } },
  });
  if (!prev) return;

  const remaining = Math.max(
    0,
    Number(prev.totalDays) + Number(prev.carriedOverDays) - Number(prev.usedDays),
  );

  const config = await prisma.tenantConfig.findUnique({ where: { tenantId } });
  const deadlineDay = config?.carryOverDeadlineDay ?? 31;
  const deadlineMonth = config?.carryOverDeadlineMonth ?? 3;
  const deadline = new Date(year, deadlineMonth - 1, deadlineDay, 23, 59, 59);

  const cur = await prisma.leaveEntitlement.findUnique({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
  });

  if (cur) {
    // Phase 104 (D-19 / R9): an ILLNESS carry-over carries the extended EuGH KHS C-214/10
    // deadline (15 months after the end of the accrual year), not the tenant's standard
    // Stichtag. This function runs after EVERY booking and cancellation, so an unconditional
    // deadline write would silently revert that extension on the next unrelated leave
    // request — the days would then appear to lapse on a date the ECJ forbids. Only the
    // DEADLINE is protected: carriedOverDays is still recomputed, because D-20 relies on the
    // existing expiry-warning mechanism reading an accurate, raised remaining entitlement.
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
 * Zieht Urlaubstage vom Entitlement ab: Resturlaub (sofern nicht verfallen) zuerst,
 * danach reguläre Tage.
 */
async function deductVacationDays(
  prisma: DbClient,
  employeeId: string,
  leaveTypeId: string,
  startDate: Date,
  endDate: Date,
  totalDays: number,
  holidays: Set<string>,
  tenantId: string,
): Promise<void> {
  const year1 = startDate.getFullYear();
  const year2 = endDate.getFullYear();
  const isCrossYear = year1 !== year2;

  if (isCrossYear) {
    // Split days across years — using the employee's own workDays
    const workDays = await resolveWorkDays(prisma, employeeId, tenantId);
    const split = splitDaysAcrossYears(startDate, endDate, false, workDays, holidays);

    // Deduct from year 1
    if (split.year1Days > 0) {
      await prisma.leaveEntitlement.updateMany({
        where: { employeeId, leaveTypeId, year: year1 },
        data: { usedDays: { increment: split.year1Days } },
      });
    }

    // Deduct from year 2
    if (split.year2Days > 0) {
      await prisma.leaveEntitlement.updateMany({
        where: { employeeId, leaveTypeId, year: year2 },
        data: { usedDays: { increment: split.year2Days } },
      });
    }

    // Recalculate carry-over for year 2 (year 1 remaining changed)
    await recalculateCarryOver(prisma, tenantId, employeeId, leaveTypeId, year2);
  } else {
    // Single year: increment usedDays
    await prisma.leaveEntitlement.updateMany({
      where: { employeeId, leaveTypeId, year: year1 },
      data: { usedDays: { increment: totalDays } },
    });

    // Recalculate next year's carry-over (current year usage changed)
    await recalculateCarryOver(prisma, tenantId, employeeId, leaveTypeId, year1 + 1);
  }
}

/**
 * Symmetrischer Gegenpart zu deductVacationDays (Phase 94-02): bucht Urlaubstage
 * wieder ZURÜCK, wenn eine genehmigte Urlaubskorrektur den alten Buchungsstand
 * rückgängig macht. DECREMENTIERT usedDays pro Jahr (cross-year via
 * splitDaysAcrossYears) und rechnet den Folgejahres-Übertrag neu — NICHT der naive
 * Single-Year-Decrement, damit ein jahresübergreifender Urlaub korrekt zurückgebucht
 * wird (T-94-07).
 */
async function reverseVacationDays(
  prisma: DbClient,
  employeeId: string,
  leaveTypeId: string,
  startDate: Date,
  endDate: Date,
  totalDays: number,
  holidays: Set<string>,
  tenantId: string,
): Promise<void> {
  const year1 = startDate.getFullYear();
  const year2 = endDate.getFullYear();
  const isCrossYear = year1 !== year2;

  if (isCrossYear) {
    const workDays = await resolveWorkDays(prisma, employeeId, tenantId);
    const split = splitDaysAcrossYears(startDate, endDate, false, workDays, holidays);

    if (split.year1Days > 0) {
      await prisma.leaveEntitlement.updateMany({
        where: { employeeId, leaveTypeId, year: year1 },
        data: { usedDays: { decrement: split.year1Days } },
      });
    }
    if (split.year2Days > 0) {
      await prisma.leaveEntitlement.updateMany({
        where: { employeeId, leaveTypeId, year: year2 },
        data: { usedDays: { decrement: split.year2Days } },
      });
    }

    // Year 1 remaining changed → recompute year 2 carry-over
    await recalculateCarryOver(prisma, tenantId, employeeId, leaveTypeId, year2);
  } else {
    await prisma.leaveEntitlement.updateMany({
      where: { employeeId, leaveTypeId, year: year1 },
      data: { usedDays: { decrement: totalDays } },
    });

    // Current year usage changed → recompute next year's carry-over
    await recalculateCarryOver(prisma, tenantId, employeeId, leaveTypeId, year1 + 1);
  }
}

/**
 * Gibt eine Map<dateStr, holidayName> für den angegebenen Zeitraum zurück.
 * Berücksichtigt das Bundesland des Tenants sowie manuell eingetragene Feiertage.
 */
async function getHolidayMap(
  prisma: FastifyInstance["prisma"],
  tenantId: string,
  start: Date,
  end: Date,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!tenantId) return map;

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  const stateCode = tenant?.federalState ? STATE_MAP[tenant.federalState] : undefined;

  const startStr = start.toISOString().split("T")[0];
  const endStr = end.toISOString().split("T")[0];

  for (let y = start.getFullYear(); y <= end.getFullYear(); y++) {
    for (const h of getHolidays(y, stateCode ?? null)) {
      if (h.date >= startStr && h.date <= endStr) map.set(h.date, h.name);
    }
  }

  // Manuelle Feiertage aus der DB
  const manual = await prisma.publicHoliday.findMany({
    where: { tenantId, date: { gte: start, lte: end } },
  });
  for (const h of manual) map.set(h.date.toISOString().split("T")[0], h.name);

  return map;
}

// calculateWorkDays moved to ../utils/calculate-work-days (Phase 61).

/**
 * Lädt das aktuell gültige workDays-Set für einen Mitarbeiter.
 *
 * Reihenfolge:
 * 1. Für FIXED_SCHEDULE: aus per-Tag-Soll abgeleitet (Stunden > 0 = Arbeitstag).
 *    Das erlaubt individuelle Verteilung wie Frisör Di-Sa ohne separate UI.
 * 2. Sonst: WorkSchedule.workDays (Pro-MA-Override aus /admin/vacation).
 * 3. Sonst: TenantConfig.defaultWorkDays.
 * 4. Sonst: Mo-Fr.
 */
async function resolveWorkDays(
  prisma: DbClient,
  employeeId: string,
  tenantId: string,
): Promise<number[]> {
  const [ws, cfg] = await Promise.all([
    prisma.workSchedule.findFirst({
      where: { employeeId },
      orderBy: { validFrom: "desc" },
    }),
    prisma.tenantConfig.findUnique({
      where: { tenantId },
      select: { defaultWorkDays: true },
    }),
  ]);
  if (ws) {
    // FIXED_SCHEDULE: per-Tag-Soll ist die präziseste Quelle (Frisör Di-Sa wird hier sichtbar)
    if (ws.type === "FIXED_SCHEDULE") {
      const fields: Array<[number, number]> = [
        [0, Number(ws.sundayHours)],
        [1, Number(ws.mondayHours)],
        [2, Number(ws.tuesdayHours)],
        [3, Number(ws.wednesdayHours)],
        [4, Number(ws.thursdayHours)],
        [5, Number(ws.fridayHours)],
        [6, Number(ws.saturdayHours)],
      ];
      const derived = fields
        .filter(([, h]) => h > 0)
        .map(([d]) => d)
        .sort((a, b) => a - b);
      if (derived.length > 0) return derived;
    }
    if (ws.workDays && ws.workDays.length > 0) return ws.workDays;
  }
  if (cfg?.defaultWorkDays && cfg.defaultWorkDays.length > 0) return cfg.defaultWorkDays;
  return [1, 2, 3, 4, 5];
}

/**
 * Berechnet die tatsächlich geplanten Arbeitsstunden für einen Zeitraum
 * basierend auf dem individuellen WorkSchedule des Mitarbeiters (oder den
 * globalen Tenant-Defaults falls kein individueller Plan vorhanden).
 * Halbe Tage = halbe Stunden des ersten Arbeitstages.
 *
 * SHIFT_BASED (Phase 100 / OTC-04, D-05..D-08): the per-Tag-Soll fields
 * (mondayHours…sundayHours) on WorkSchedule are NOT authoritative for this schedule type —
 * the real hours live in the `Shift` table. This function branches on `ws.type ===
 * "SHIFT_BASED"` before the per-weekday path below and instead sums each rostered shift's
 * netto minutes: brutto (endTime − startTime, midnight-crossing corrected) minus the
 * tenant/employee auto-break for that duration (`shift-netto.ts`). `Shift` carries no
 * `breakMinutes` column, so the original Phase-49.5 formula `(endTime - startTime -
 * breakMinutes)` named a field that does not exist — this replaces it. Soft-deleted shifts
 * (`deletedAt != null`) are excluded (D-06) — an employer-cancelled shift is not time the
 * employee has to buy back. Half-day uses the netto of the FIRST rostered shift in the
 * range, halved (D-07). An employee with no shifts in the range costs 0 hours and the
 * request is not rejected for that reason (D-08).
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

  // SHIFT_BASED: netto summed from the Shift table (Phase 100 / OTC-04, D-05..D-08) — see the
  // docblock above. Returns BEFORE the FIXED_SCHEDULE / FLEXTIME / MONTHLY_HOURS per-weekday
  // path below, which stays byte-for-byte unchanged for every other schedule type.
  if (ws?.type === "SHIFT_BASED") {
    const shifts = await prisma.shift.findMany({
      where: { employeeId, date: { gte: start, lte: end }, deletedAt: null },
      select: { startTime: true, endTime: true },
      // D-07 / WR-02 (code review): "first rostered shift" must be deterministic. `date` alone
      // is NOT sufficient — Shift has no unique constraint on (employeeId, date), so same-day
      // split shifts (e.g. a morning + evening shift) tie under `date` ordering, and
      // Postgres/Prisma give no guarantee on row order among ties. `startTime` breaks that tie.
      orderBy: [{ date: "asc" }, { startTime: "asc" }],
    });

    const employeeBreakShape = {
      breakOver6hOverride: employee?.breakOver6hOverride ?? null,
      breakOver9hOverride: employee?.breakOver9hOverride ?? null,
    };
    const tenantBreakShape = {
      defaultBreakOver6h: cfg?.defaultBreakOver6h ?? 30,
      defaultBreakOver9h: cfg?.defaultBreakOver9h ?? 45,
    };

    // The `holidays` set is deliberately NOT applied on this path. For SHIFT_BASED the roster
    // is authoritative — if nobody rostered the employee on a public holiday there is no shift
    // and the day costs nothing on its own; if somebody DID roster them, those hours are real
    // planned work and taking the day off genuinely consumes them. Filtering by holiday here
    // would double-count the exclusion.
    if (halfDay) {
      // D-07: half day = half the netto of the FIRST rostered shift; D-08: empty roster -> 0.
      if (shifts.length === 0) return 0;
      return shiftNettoMinutes(shifts[0], employeeBreakShape, tenantBreakShape) / 2 / 60;
    }
    // D-05: sum of every non-deleted rostered shift's netto; naturally 0 for an empty roster (D-08).
    return sumShiftNettoMinutes(shifts, employeeBreakShape, tenantBreakShape) / 60;
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
