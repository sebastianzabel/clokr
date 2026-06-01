import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import { isAvailabilityEnabled } from "../utils/tenant-availability";
import { getVocationalSchoolMinutesForDate } from "../utils/vocational-school-saldo";
// ARBZG_MARKER_47_4_01

const templateSchema = z.object({
  name: z.string().min(1),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  color: z.string().default("#3B82F6"),
});

const shiftSchema = z.object({
  employeeId: z.string(),
  templateId: z.string().optional(),
  date: z.string(), // YYYY-MM-DD
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  label: z.string().optional(),
  note: z.string().optional(),
});

const bulkShiftSchema = z.object({
  shifts: z.array(shiftSchema),
});

// Phase 43 — Auto-Gen
const generateWeekSchema = z.object({
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "weekStart muss YYYY-MM-DD sein"),
  commit: z.boolean().default(false),
});

// Phase 43-05 — Copy-Week
const copyWeekSchema = z.object({
  sourceWeekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "sourceWeekStart muss YYYY-MM-DD sein"),
  targetWeekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "targetWeekStart muss YYYY-MM-DD sein"),
  commit: z.boolean().default(false),
});

const coverageRuleSchema = z.object({
  templateId: z.string().uuid().nullable().optional(),
  dayOfWeek: z.number().int().min(-1).max(6),
  minStaff: z.number().min(0).max(99),
  requiresNonSupervised: z.boolean().default(false),
});

// Per-day coverage status
type CoverageStatus = "ok" | "under" | "supervision-missing";

interface CoverageInfo {
  effectiveStaff: number;
  minStaff: number;
  hasSupervisor: boolean;
  unsupervisedAzubis: number;
  coverageStatus: CoverageStatus;
}

// Availability classification per employee × day
// Phase 63 D-20 — added "vocational_school" for VOCATIONAL_SCHOOL absences. Sits
// between "special" (rank 4, tie) and "other" semantically; rank function below
// places it at 4 alongside "special" so sick (6) and vacation (5) still win ties.
type Availability =
  | "available"
  | "vacation"
  | "sick"
  | "special"
  | "vocational_school"
  | "other"
  | "unavailable"
  | "preferred";

/**
 * Classify a leave-type name into one of our availability buckets.
 * Names are German strings (e.g. "Urlaub", "Krankmeldung", "Sonderurlaub").
 */
function classifyLeaveTypeName(name: string): Availability {
  const n = name.toLowerCase();
  if (n.includes("urlaub") && !n.includes("sonder") && !n.includes("unbezahlt")) return "vacation";
  if (n.includes("krank")) return "sick";
  if (n.includes("sonder")) return "special";
  return "other";
}

/**
 * Classify an AbsenceType enum value into our availability bucket.
 */
function classifyAbsenceType(type: string): Availability {
  switch (type) {
    case "SICK":
    case "SICK_CHILD":
      return "sick";
    case "SPECIAL_LEAVE":
      return "special";
    // Phase 63 D-20 — VOCATIONAL_SCHOOL routes to its own bucket. Without this case
    // it would fall through to "other" (rank 3), losing the lock-icon semantic in
    // the shift planner and the dedicated badge in the frontend (Plan 05).
    case "VOCATIONAL_SCHOOL":
      return "vocational_school";
    case "MATERNITY":
    case "PARENTAL":
    case "UNPAID_LEAVE":
    case "OTHER":
    default:
      return "other";
  }
}

/**
 * Find the most specific CoverageRule for a (template, dayOfWeek) combination.
 * Match order:
 *   1. templateId match AND dayOfWeek match
 *   2. templateId null AND dayOfWeek match
 *   3. templateId match AND dayOfWeek = -1
 *   4. templateId null AND dayOfWeek = -1
 * If no rule matches, returns default { minStaff: 2, requiresNonSupervised: false }.
 */
function pickRule(
  rules: Array<{
    templateId: string | null;
    dayOfWeek: number;
    minStaff: number;
    requiresNonSupervised: boolean;
  }>,
  templateId: string | null,
  dayOfWeek: number,
): { minStaff: number; requiresNonSupervised: boolean } {
  if (templateId) {
    const exact = rules.find((r) => r.templateId === templateId && r.dayOfWeek === dayOfWeek);
    if (exact)
      return { minStaff: exact.minStaff, requiresNonSupervised: exact.requiresNonSupervised };
  }
  const tplNullDow = rules.find((r) => r.templateId === null && r.dayOfWeek === dayOfWeek);
  if (tplNullDow)
    return {
      minStaff: tplNullDow.minStaff,
      requiresNonSupervised: tplNullDow.requiresNonSupervised,
    };
  if (templateId) {
    const tplAllDays = rules.find((r) => r.templateId === templateId && r.dayOfWeek === -1);
    if (tplAllDays)
      return {
        minStaff: tplAllDays.minStaff,
        requiresNonSupervised: tplAllDays.requiresNonSupervised,
      };
  }
  const fallback = rules.find((r) => r.templateId === null && r.dayOfWeek === -1);
  if (fallback)
    return { minStaff: fallback.minStaff, requiresNonSupervised: fallback.requiresNonSupervised };
  // Default — matches legacy hardcoded MIN_COVERAGE = 2
  return { minStaff: 2, requiresNonSupervised: false };
}

// Phase 43 — Conflict-check result shape used by write-path validation & generate-week
type ConflictKind = "leave" | "absence";
// Phase 63 D-20 — "vocational_school" added so the absence-conflict path can carry
// the BS type through to the API response without an unsafe cast. The frontend
// already renders unknown bucket strings as "other" (no UI changes required here).
type ConflictType = "vacation" | "sick" | "special" | "vocational_school" | "other";

interface ShiftConflict {
  kind: ConflictKind;
  conflictType: ConflictType;
  leaveRequestId?: string;
  absenceId?: string;
}

/**
 * Check whether an employee has an APPROVED LeaveRequest or non-deleted Absence
 * covering the given date. Returns the first conflict found (leave takes precedence).
 */
async function findShiftConflict(
  prisma: import("@clokr/db").PrismaClient,
  employeeId: string,
  isoDate: string,
): Promise<ShiftConflict | null> {
  const day = new Date(isoDate + "T00:00:00Z");

  // Check APPROVED LeaveRequest first (vacation/sonder)
  const leave = await prisma.leaveRequest.findFirst({
    where: {
      employeeId,
      status: "APPROVED",
      deletedAt: null,
      startDate: { lte: day },
      endDate: { gte: day },
    },
    include: { leaveType: { select: { name: true } } },
  });
  if (leave) {
    return {
      kind: "leave",
      conflictType: classifyLeaveTypeName(leave.leaveType.name) as ConflictType,
      leaveRequestId: leave.id,
    };
  }

  // Then check Absence
  const absence = await prisma.absence.findFirst({
    where: {
      employeeId,
      deletedAt: null,
      startDate: { lte: day },
      endDate: { gte: day },
    },
  });
  if (absence) {
    return {
      kind: "absence",
      conflictType: classifyAbsenceType(absence.type) as ConflictType,
      absenceId: absence.id,
    };
  }

  return null;
}

/**
 * Phase 47.1 — Verify an employee is eligible for shift assignment.
 * Eligible = has an active WorkSchedule (most recent validFrom <= today) with type === SHIFT_BASED.
 * Returns null if eligible, otherwise a {code, message} payload for the 422 response.
 */
async function assertEmployeeShiftEligible(
  prisma: import("@clokr/db").PrismaClient,
  employeeId: string,
): Promise<{ code: "SHIFT_INVALID_EMPLOYEE_TYPE"; message: string } | null> {
  const sched = await prisma.workSchedule.findFirst({
    where: { employeeId, validFrom: { lte: new Date() } },
    orderBy: { validFrom: "desc" },
    select: { type: true },
  });
  if (sched?.type === "SHIFT_BASED") return null;
  return {
    code: "SHIFT_INVALID_EMPLOYEE_TYPE",
    message: "Mitarbeiter ist nicht im Schichtsystem (SHIFT_BASED erforderlich).",
  };
}

/** Format a YYYY-MM-DD ISO string to DD.MM.YYYY for German user-facing messages. */
function formatDateDe(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

/**
 * Phase 47.2 — Schichten in der Vergangenheit sind audit-proof immutable.
 * Compares the shift date (YYYY-MM-DD) against today; returns a 422 payload
 * when the date is strictly before today. Today is OK (in-day correction).
 */
function assertShiftNotPast(iso: string): { code: "SHIFT_PAST_IMMUTABLE"; message: string } | null {
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  if (iso < todayIso) {
    return {
      code: "SHIFT_PAST_IMMUTABLE",
      message: "Schicht in der Vergangenheit ist nicht änderbar (Revisionssicherheit).",
    };
  }
  return null;
}

/**
 * Phase 47.5 — Verify a shift falls inside the tenant's configured store hours.
 * Reads TenantConfig.storeHours (JSON array, one entry per weekday 0=Mo..6=So).
 * Returns null if inside or no config; otherwise a 409 payload for soft-warn override.
 * Cross-midnight shifts (end < start) are NOT supported by this check — they always
 * fail because they leave the day's open/close window; users override via force=true.
 */
async function assertWithinStoreHours(
  prisma: import("@clokr/db").PrismaClient,
  tenantId: string,
  isoDate: string,
  startTime: string,
  endTime: string,
): Promise<{ code: "SHIFT_OUTSIDE_STORE_HOURS"; message: string } | null> {
  const cfg = await prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: { storeHours: true, shiftStoreHoursMode: true },
  });
  if (!cfg?.storeHours) return null;
  const mode = cfg.shiftStoreHoursMode ?? "DAY_ONLY";
  if (mode === "OFF") return null;
  const rows = cfg.storeHours as Array<{
    day: number;
    open: string;
    close: string;
    closed?: boolean;
  }>;
  // dayOfWeek: 0=Mo..6=So (matches schema comment)
  const d = new Date(isoDate + "T00:00:00Z");
  const jsDow = d.getUTCDay();
  const dow = jsDow === 0 ? 6 : jsDow - 1;
  const entry = rows.find((r) => r.day === dow);
  if (!entry) return null;
  if (entry.closed) {
    return {
      code: "SHIFT_OUTSIDE_STORE_HOURS",
      message: `Schicht am ${formatDateDe(isoDate)} außerhalb der Öffnungszeiten — Geschäft geschlossen.`,
    };
  }
  // DAY_ONLY: closed-day check above is sufficient; pre/post-hour shifts (Vorbereitung/Aufräumen) allowed.
  if (mode === "DAY_ONLY") return null;
  // STRICT: string compare on HH:MM works because zero-padded.
  if (startTime < entry.open || endTime > entry.close) {
    return {
      code: "SHIFT_OUTSIDE_STORE_HOURS",
      message: `Schicht ${startTime}–${endTime} außerhalb der Öffnungszeiten (${entry.open}–${entry.close}).`,
    };
  }
  return null;
}

// Phase 46 — Map EmployeeAvailability.status (DB enum) to the lowercase Availability union.
function statusToAvail(s: "AVAILABLE" | "UNAVAILABLE" | "PREFERRED"): Availability {
  return s === "UNAVAILABLE" ? "unavailable" : s === "PREFERRED" ? "preferred" : "available";
}

// Phase 46 — Does an EmployeeAvailability row apply on the given ISO day?
// Inclusive bounds on validFrom/validUntil (iso < validFromIso → not yet; iso > validUntilIso → expired).
// Date-specific rows match by exact iso; dayOfWeek rows match by isoToDow().
function appliesOnDay(
  av: { dayOfWeek: number | null; date: Date | null; validFrom: Date; validUntil: Date | null },
  iso: string,
  isoToDow: (iso: string) => number,
): boolean {
  const validFromIso = av.validFrom.toISOString().slice(0, 10);
  const validUntilIso = av.validUntil ? av.validUntil.toISOString().slice(0, 10) : null;
  if (iso < validFromIso) return false;
  if (validUntilIso && iso > validUntilIso) return false;
  if (av.date) return av.date.toISOString().slice(0, 10) === iso;
  if (av.dayOfWeek !== null) return isoToDow(iso) === av.dayOfWeek;
  return false;
}

/**
 * Phase 47.3 — Look up an UNAVAILABLE EmployeeAvailability marker for the given
 * employee on the given ISO date. Date-specific rows beat recurring dayOfWeek rows
 * at equal rank (matches the resolver pattern in GET /week). PREFERRED is ignored.
 * Returns the matching row or null.
 *
 * Caller must guard with isAvailabilityEnabled() — this helper does not check the
 * tenant feature flag itself.
 */
async function findUnavailability(
  prisma: import("@clokr/db").PrismaClient,
  employeeId: string,
  isoDate: string,
): Promise<{ id: string } | null> {
  const dayDate = new Date(isoDate + "T00:00:00Z");
  const rows = await prisma.employeeAvailability.findMany({
    where: {
      employeeId,
      status: "UNAVAILABLE",
      validFrom: { lte: dayDate },
      OR: [{ validUntil: null }, { validUntil: { gte: dayDate } }],
      AND: [{ OR: [{ dayOfWeek: { not: null } }, { date: dayDate }] }],
    },
    select: {
      id: true,
      dayOfWeek: true,
      date: true,
      validFrom: true,
      validUntil: true,
    },
  });

  function isoToDow(iso: string): number {
    const d = new Date(iso + "T00:00:00Z");
    const jsDow = d.getUTCDay();
    return jsDow === 0 ? 6 : jsDow - 1;
  }

  // Date-specific beats recurring; otherwise first match wins.
  const dateMatch = rows.find((r) => r.date && appliesOnDay(r, isoDate, isoToDow));
  if (dateMatch) return { id: dateMatch.id };
  const dowMatch = rows.find((r) => r.dayOfWeek !== null && appliesOnDay(r, isoDate, isoToDow));
  if (dowMatch) return { id: dowMatch.id };
  return null;
}

/**
 * Phase 47.4-01 — ArbZG § 3 (Tägliche Höchstarbeitszeit).
 *
 * Computes gross shift duration in hours (handles cross-midnight via +24h).
 * Returns a violation payload if grossHours > 10 (strict); otherwise null.
 * Exactly 10.0h is legal (boundary OK).
 *
 * No DB access — pure HH:MM math.
 */
function assertArbZGDailyMax(start: string, end: string): { violationHours: number } | null {
  const toMin = (s: string): number => {
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m;
  };
  const startMin = toMin(start);
  const endMin = toMin(end);
  let grossMin = endMin - startMin;
  if (grossMin <= 0) grossMin += 24 * 60; // cross-midnight
  const grossHours = grossMin / 60;
  // ArbZG § 3 limits ARBEITSZEIT (net), not Anwesenheit (gross).
  // Subtract the § 4 mandatory break: >9h → 45 min, >6h → 30 min, else 0.
  let breakHours = 0;
  if (grossHours > 9) breakHours = 0.75;
  else if (grossHours > 6) breakHours = 0.5;
  const netHours = grossHours - breakHours;
  if (netHours > 10) return { violationHours: netHours };
  return null;
}

/**
 * Phase 47.4-01 — ArbZG § 5 (Mindestruhezeit).
 *
 * Checks whether the rest gap between the previous calendar day's last shift
 * end and the new shift's start is < 11 hours. Returns a violation payload if
 * so; otherwise null. Exactly 11.0h gap is legal (boundary OK).
 *
 * - `excludeShiftId` skips a specific shift (used by PUT so a self-move doesn't
 *   collide with its own existing record).
 * - If multiple shifts exist on the previous day, the SMALLEST gap wins (worst-case).
 * - Cross-midnight prev shifts (end ≤ start) end on the new shift's day at HH:MM.
 */
async function assertArbZGRestPeriod(
  prisma: import("@clokr/db").PrismaClient,
  employeeId: string,
  isoDate: string,
  startTime: string,
  excludeShiftId?: string,
): Promise<{ restHours: number; prevShiftId: string; prevEndIso: string } | null> {
  // Compute previous calendar day in UTC
  const target = new Date(isoDate + "T00:00:00Z");
  if (Number.isNaN(target.getTime())) return null;
  const prev = new Date(target);
  prev.setUTCDate(prev.getUTCDate() - 1);
  const prevIso = prev.toISOString().slice(0, 10);

  const prevShifts = await prisma.shift.findMany({
    where: {
      employeeId,
      date: new Date(prevIso + "T00:00:00Z"),
      ...(excludeShiftId ? { NOT: { id: excludeShiftId } } : {}),
    },
    select: { id: true, startTime: true, endTime: true },
  });

  if (prevShifts.length === 0) return null;

  const toMin = (s: string): number => {
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m;
  };

  // Compute prev gross-end timestamp (ms) for each candidate; pick worst gap.
  const prevDayBaseMs = new Date(prevIso + "T00:00:00Z").getTime();
  const newStartMs = target.getTime() + toMin(startTime) * 60_000;

  let worst: { restHours: number; prevShiftId: string; prevEndIso: string } | null = null;
  for (const ps of prevShifts) {
    const psStartMin = toMin(ps.startTime);
    const psEndMin = toMin(ps.endTime);
    let endOffsetMin = psEndMin;
    if (psEndMin <= psStartMin) endOffsetMin += 24 * 60; // cross-midnight
    const prevEndMs = prevDayBaseMs + endOffsetMin * 60_000;
    const restMs = newStartMs - prevEndMs;
    const restHours = restMs / 3_600_000;
    if (restHours < 11) {
      const prevEndIso = new Date(prevEndMs).toISOString();
      if (!worst || restHours < worst.restHours) {
        worst = { restHours, prevShiftId: ps.id, prevEndIso };
      }
    }
  }
  return worst;
}

export async function shiftRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // ── Templates ──────────────────────────────────────────────

  // GET /templates — any authenticated user (read-only)
  app.get("/templates", {
    schema: { tags: ["Schichtplanung"], security: [{ bearerAuth: [] }] },
    handler: async (req) => {
      return app.prisma.shiftTemplate.findMany({
        where: { tenantId: req.user.tenantId },
        orderBy: { startTime: "asc" },
      });
    },
  });

  // POST /templates — ADMIN only (config)
  app.post("/templates", {
    schema: { tags: ["Schichtplanung"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const body = templateSchema.parse(req.body);
      const template = await app.prisma.shiftTemplate.create({
        data: { ...body, tenantId: req.user.tenantId },
      });
      await app.audit({
        userId: req.user.sub,
        action: "CREATE",
        entity: "ShiftTemplate",
        entityId: template.id,
        newValue: template,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });
      return reply.code(201).send(template);
    },
  });

  // PUT /templates/:id — ADMIN only — edit name/start/end/color
  app.put("/templates/:id", {
    schema: { tags: ["Schichtplanung"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = templateSchema.partial().parse(req.body);
      const existing = await app.prisma.shiftTemplate.findFirst({
        where: { id, tenantId: req.user.tenantId },
      });
      if (!existing) return reply.code(404).send({ error: "Vorlage nicht gefunden" });
      const updated = await app.prisma.shiftTemplate.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.startTime !== undefined ? { startTime: body.startTime } : {}),
          ...(body.endTime !== undefined ? { endTime: body.endTime } : {}),
          ...(body.color !== undefined ? { color: body.color } : {}),
        },
      });
      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "ShiftTemplate",
        entityId: id,
        oldValue: existing,
        newValue: updated,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });
      return updated;
    },
  });

  // DELETE /templates/:id — ADMIN only
  app.delete("/templates/:id", {
    schema: { tags: ["Schichtplanung"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = await app.prisma.shiftTemplate.findFirst({
        where: { id, tenantId: req.user.tenantId },
      });
      if (!existing) return reply.code(404).send({ error: "Vorlage nicht gefunden" });
      await app.prisma.shiftTemplate.delete({ where: { id } });
      await app.audit({
        userId: req.user.sub,
        action: "DELETE",
        entity: "ShiftTemplate",
        entityId: id,
        oldValue: existing,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });
      return reply.code(204).send();
    },
  });

  // ── Coverage Rules (Phase 42) ──────────────────────────────

  // GET /coverage-rules
  app.get("/coverage-rules", {
    schema: { tags: ["Schichtplanung"], security: [{ bearerAuth: [] }] },
    handler: async (req) => {
      return app.prisma.coverageRule.findMany({
        where: { tenantId: req.user.tenantId },
        orderBy: [{ templateId: "asc" }, { dayOfWeek: "asc" }],
      });
    },
  });

  // POST /coverage-rules — ADMIN only
  app.post("/coverage-rules", {
    schema: { tags: ["Schichtplanung"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const body = coverageRuleSchema.parse(req.body);
      // If templateId is provided, ensure it belongs to the tenant
      if (body.templateId) {
        const tpl = await app.prisma.shiftTemplate.findFirst({
          where: { id: body.templateId, tenantId: req.user.tenantId },
        });
        if (!tpl) return reply.code(404).send({ error: "Vorlage nicht gefunden" });
      }
      const rule = await app.prisma.coverageRule.create({
        data: {
          tenantId: req.user.tenantId,
          templateId: body.templateId ?? null,
          dayOfWeek: body.dayOfWeek,
          minStaff: body.minStaff,
          requiresNonSupervised: body.requiresNonSupervised,
        },
      });
      await app.audit({
        userId: req.user.sub,
        action: "CREATE",
        entity: "CoverageRule",
        entityId: rule.id,
        newValue: rule,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });
      return reply.code(201).send(rule);
    },
  });

  // PUT /coverage-rules/:id — ADMIN only
  app.put("/coverage-rules/:id", {
    schema: { tags: ["Schichtplanung"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = coverageRuleSchema.partial().parse(req.body);
      const existing = await app.prisma.coverageRule.findFirst({
        where: { id, tenantId: req.user.tenantId },
      });
      if (!existing) return reply.code(404).send({ error: "Bedarfsregel nicht gefunden" });

      const updated = await app.prisma.coverageRule.update({
        where: { id },
        data: {
          ...(body.templateId !== undefined ? { templateId: body.templateId ?? null } : {}),
          ...(body.dayOfWeek !== undefined ? { dayOfWeek: body.dayOfWeek } : {}),
          ...(body.minStaff !== undefined ? { minStaff: body.minStaff } : {}),
          ...(body.requiresNonSupervised !== undefined
            ? { requiresNonSupervised: body.requiresNonSupervised }
            : {}),
        },
      });
      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "CoverageRule",
        entityId: id,
        oldValue: existing,
        newValue: updated,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });
      return updated;
    },
  });

  // DELETE /coverage-rules/:id — ADMIN only
  app.delete("/coverage-rules/:id", {
    schema: { tags: ["Schichtplanung"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = await app.prisma.coverageRule.findFirst({
        where: { id, tenantId: req.user.tenantId },
      });
      if (!existing) return reply.code(404).send({ error: "Bedarfsregel nicht gefunden" });
      await app.prisma.coverageRule.delete({ where: { id } });
      await app.audit({
        userId: req.user.sub,
        action: "DELETE",
        entity: "CoverageRule",
        entityId: id,
        oldValue: existing,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });
      return reply.code(204).send();
    },
  });

  // ── Shifts ─────────────────────────────────────────────────

  // GET /week?date=YYYY-MM-DD — get all shifts for the week containing the date,
  // enriched with per-(employee × day) availability and per-day coverage stats.
  app.get("/week", {
    schema: { tags: ["Schichtplanung"], security: [{ bearerAuth: [] }] },
    handler: async (req) => {
      // Phase 47.1 verify-check (2026-05-20): GET /week resolver merges APPROVED LeaveRequest
      // (deletedAt: null) + non-deleted Absence + EmployeeAvailability into availability map.
      // See Phase 46-02 SUMMARY for the resolver design.
      const { date } = req.query as { date?: string };
      const refDate = date ? new Date(date + "T00:00:00Z") : new Date();

      // Calculate Monday of the week
      const dow = refDate.getUTCDay();
      const mondayOffset = dow === 0 ? -6 : 1 - dow;
      const monday = new Date(refDate);
      monday.setUTCDate(monday.getUTCDate() + mondayOffset);
      monday.setUTCHours(0, 0, 0, 0);

      const sunday = new Date(monday);
      sunday.setUTCDate(sunday.getUTCDate() + 6);
      sunday.setUTCHours(23, 59, 59, 999);

      const tenantId = req.user.tenantId;

      // Phase 47.3 — Verfügbarkeits-System toggle. When false, the EmployeeAvailability
      // merge passes are skipped (Leave + Absence still apply).
      const availabilityOn = await isAvailabilityEnabled(app.prisma, tenantId);

      const [shifts, employees, leaveTypes, leaveRequests, absences, rulesRaw, availabilityRows] =
        await Promise.all([
          app.prisma.shift.findMany({
            where: {
              employee: { tenantId },
              date: { gte: monday, lte: sunday },
            },
            include: {
              employee: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  employeeNumber: true,
                  coverageWeight: true,
                  requiresSupervision: true,
                  classification: true,
                },
              },
              template: { select: { name: true, color: true } },
            },
            orderBy: [{ date: "asc" }, { startTime: "asc" }],
          }),
          app.prisma.employee.findMany({
            where: { tenantId },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              employeeNumber: true,
              classification: true,
              coverageWeight: true,
              requiresSupervision: true,
              workSchedules: {
                where: { validFrom: { lte: new Date() } },
                orderBy: { validFrom: "desc" as const },
                take: 1,
                select: { type: true, weeklyHours: true },
              },
            },
            orderBy: { lastName: "asc" },
          }),
          app.prisma.leaveType.findMany({
            where: { tenantId },
            select: { id: true, name: true },
          }),
          app.prisma.leaveRequest.findMany({
            where: {
              employee: { tenantId },
              status: "APPROVED",
              deletedAt: null,
              startDate: { lte: sunday },
              endDate: { gte: monday },
            },
            select: {
              employeeId: true,
              leaveTypeId: true,
              startDate: true,
              endDate: true,
            },
          }),
          app.prisma.absence.findMany({
            where: {
              employee: { tenantId },
              deletedAt: null,
              startDate: { lte: sunday },
              endDate: { gte: monday },
            },
            select: {
              employeeId: true,
              type: true,
              startDate: true,
              endDate: true,
            },
          }),
          app.prisma.coverageRule.findMany({
            where: { tenantId },
            select: {
              templateId: true,
              dayOfWeek: true,
              minStaff: true,
              requiresNonSupervised: true,
            },
          }),
          // Phase 46 — EmployeeAvailability rows that overlap this week.
          // Tenant scope via Employee join. Validity overlap via validFrom <= sunday AND
          // (validUntil IS NULL OR validUntil >= monday). dayOfWeek rows are always
          // candidates; date rows must fall within [monday, sunday].
          app.prisma.employeeAvailability.findMany({
            where: {
              employee: { tenantId },
              AND: [
                { validFrom: { lte: sunday } },
                { OR: [{ validUntil: null }, { validUntil: { gte: monday } }] },
              ],
              OR: [{ dayOfWeek: { not: null } }, { date: { gte: monday, lte: sunday } }],
            },
          }),
        ]);

      // Phase 47.3 — Narrow availability rows to [] when the feature is disabled.
      // The query above always runs (cheap when there are no rows) but the merge
      // passes below operate on this empty array so UNAVAILABLE/PREFERRED never
      // surface in the response.
      const effectiveAvailabilityRows = availabilityOn ? availabilityRows : [];

      // Normalize rules to plain numbers (Decimal → number)
      const rules = rulesRaw.map((r) => ({
        templateId: r.templateId,
        dayOfWeek: r.dayOfWeek,
        minStaff: Number(r.minStaff),
        requiresNonSupervised: r.requiresNonSupervised,
      }));

      // Build leaveType name lookup
      const leaveTypeNameById = new Map(leaveTypes.map((lt) => [lt.id, lt.name]));

      // Generate weekDays array
      const weekDays: string[] = [];
      const cur = new Date(monday);
      for (let i = 0; i < 7; i++) {
        weekDays.push(cur.toISOString().split("T")[0]);
        cur.setUTCDate(cur.getUTCDate() + 1);
      }

      // Helper: does a [start..end] range cover the given iso day?
      function coversDay(startDate: Date, endDate: Date, iso: string): boolean {
        const s = startDate.toISOString().slice(0, 10);
        const e = endDate.toISOString().slice(0, 10);
        return iso >= s && iso <= e;
      }

      // Build availability map: employeeId × isoDate → Availability
      type AvailabilityEntry = { availability: Availability };
      const availabilityMap = new Map<string, AvailabilityEntry>();
      const keyOf = (empId: string, iso: string) => `${empId}::${iso}`;

      for (const lr of leaveRequests) {
        const typeName = leaveTypeNameById.get(lr.leaveTypeId) ?? "";
        const cls = classifyLeaveTypeName(typeName);
        for (const iso of weekDays) {
          if (coversDay(lr.startDate, lr.endDate, iso)) {
            const k = keyOf(lr.employeeId, iso);
            // Sick beats other types; vacation beats special/other; etc.
            const prev = availabilityMap.get(k)?.availability;
            if (!prev || rankAvailability(cls) > rankAvailability(prev)) {
              availabilityMap.set(k, { availability: cls });
            }
          }
        }
      }
      for (const ab of absences) {
        const cls = classifyAbsenceType(ab.type);
        for (const iso of weekDays) {
          if (coversDay(ab.startDate, ab.endDate, iso)) {
            const k = keyOf(ab.employeeId, iso);
            const prev = availabilityMap.get(k)?.availability;
            if (!prev || rankAvailability(cls) > rankAvailability(prev)) {
              availabilityMap.set(k, { availability: cls });
            }
          }
        }
      }

      // Phase 46 — EmployeeAvailability merge. Runs AFTER leave/absence loops so vacation/sick
      // beat explicit availability (rankAvailability puts leave/absence > unavailable/preferred).
      // Two passes: recurring dayOfWeek first, then date-specific (date overrides recurring at
      // equal rank — Pitfall #2 in 46-RESEARCH.md).
      // Pass 1: recurring dayOfWeek rows
      for (const av of effectiveAvailabilityRows.filter((r) => r.dayOfWeek !== null)) {
        for (const iso of weekDays) {
          if (!appliesOnDay(av, iso, isoToDow)) continue;
          const cls = statusToAvail(av.status);
          const k = keyOf(av.employeeId, iso);
          const prev = availabilityMap.get(k)?.availability;
          if (!prev || rankAvailability(cls) > rankAvailability(prev)) {
            availabilityMap.set(k, { availability: cls });
          }
        }
      }

      // Pass 2: date-specific rows — overwrite recurring of equal rank, but still lose to
      // leave/absence (those have higher rank already)
      for (const av of effectiveAvailabilityRows.filter((r) => r.date !== null)) {
        for (const iso of weekDays) {
          if (!appliesOnDay(av, iso, isoToDow)) continue;
          const cls = statusToAvail(av.status);
          const k = keyOf(av.employeeId, iso);
          const prev = availabilityMap.get(k)?.availability;
          if (!prev || rankAvailability(cls) >= rankAvailability(prev)) {
            availabilityMap.set(k, { availability: cls });
          }
        }
      }

      // Build availability for every (employee × day) — default "available"
      const availability: Array<{ employeeId: string; date: string; availability: Availability }> =
        [];
      for (const emp of employees) {
        for (const iso of weekDays) {
          const entry = availabilityMap.get(keyOf(emp.id, iso));
          availability.push({
            employeeId: emp.id,
            date: iso,
            availability: entry?.availability ?? "available",
          });
        }
      }

      // Compute coverage per day
      // weekday lookup: iso → 0..6 (Mo=0..So=6) — note JS getUTCDay returns 0=Sun..6=Sat
      function isoToDow(iso: string): number {
        const d = new Date(iso + "T00:00:00Z");
        const jsDow = d.getUTCDay(); // 0=Sun..6=Sat
        return jsDow === 0 ? 6 : jsDow - 1; // Mo=0..So=6
      }

      const empById = new Map(employees.map((e) => [e.id, e]));

      const coverage: Array<{ date: string } & CoverageInfo> = [];
      for (const iso of weekDays) {
        const dow = isoToDow(iso);
        // Shifts on this day, grouped by their template (or "no-template" bucket)
        const dayShifts = shifts.filter((s) => s.date.toISOString().slice(0, 10) === iso);

        // For now we compute one coverage row per day using the most-permissive
        // rule scope (templateId = null) when shifts span multiple templates.
        // If all shifts on the day share one template, use that template's rule.
        // (More granular per-template-per-day coverage is exposed via the rules array.)
        const templateIds = Array.from(
          new Set(dayShifts.map((s) => s.templateId).filter((t): t is string => !!t)),
        );
        const ruleScopeTemplateId = templateIds.length === 1 ? templateIds[0] : null;
        const rule = pickRule(rules, ruleScopeTemplateId, dow);

        let effectiveStaff = 0;
        let hasSupervisor = false;
        let unsupervisedAzubis = 0;

        for (const s of dayShifts) {
          const emp = empById.get(s.employeeId);
          if (!emp) continue;
          // If the employee is on vacation/sick/etc that day, they don't count.
          // Phase 46 — PREFERRED counts as effective staff (they want to work).
          // UNAVAILABLE / vacation / sick / special / other do NOT count.
          const av = availabilityMap.get(keyOf(emp.id, iso))?.availability ?? "available";
          if (av !== "available" && av !== "preferred") continue;
          effectiveStaff += Number(emp.coverageWeight);
          if (!emp.requiresSupervision) hasSupervisor = true;
          else unsupervisedAzubis += 1;
        }

        let status: CoverageStatus = "ok";
        if (effectiveStaff < rule.minStaff) status = "under";
        else if (rule.requiresNonSupervised && !hasSupervisor && unsupervisedAzubis > 0)
          status = "supervision-missing";
        else if (unsupervisedAzubis > 0 && !hasSupervisor) status = "supervision-missing";

        coverage.push({
          date: iso,
          effectiveStaff: Math.round(effectiveStaff * 100) / 100,
          minStaff: rule.minStaff,
          hasSupervisor,
          unsupervisedAzubis,
          coverageStatus: status,
        });
      }

      // Phase 63 follow-up (post-v1.7) — Soll-Korrelation must count BS days as
      // worked minutes (D-01..D-04). The /shifts/week Soll-Korrelation row was
      // missed in Plan 03 (which patched overtime, auto-close, arbzg, time-entries
      // but not shifts.ts). Aggregate per employee using the same
      // `getVocationalSchoolMinutesForDate` helper so block-week cap (D-02) and
      // tenant-config (vocationalSchoolMinutesPerDay) semantics stay in lockstep
      // with the saldo math. CLAUDE.md soft-delete rule is enforced inside the
      // helper (deletedAt: null).
      const tenantConfig = await app.prisma.tenantConfig.findUnique({
        where: { tenantId },
        select: {
          vocationalSchoolMinutesPerDay: true,
          vocationalSchoolBlockMinutesPerWeek: true,
        },
      });
      const vocationalSchoolMinutesByEmp: Record<string, number> = {};
      for (const emp of employees) {
        let total = 0;
        for (const iso of weekDays) {
          // Only call the helper for cells the availability resolver flagged as
          // vocational_school — cheap short-circuit avoids N×7 unconditional DB
          // round-trips on weeks without any BS data.
          const av = availabilityMap.get(keyOf(emp.id, iso))?.availability;
          if (av !== "vocational_school") continue;
          const min = await getVocationalSchoolMinutesForDate(
            app.prisma,
            emp.id,
            new Date(iso + "T00:00:00Z"),
            tenantConfig,
          );
          total += min;
        }
        if (total > 0) vocationalSchoolMinutesByEmp[emp.id] = total;
      }

      return {
        weekDays,
        employees,
        shifts,
        availability,
        coverage,
        vocationalSchoolMinutesByEmp,
      };
    },
  });

  // GET /my-week?date=YYYY-MM-DD — Phase 49 — employee self-view
  // Returns own shifts + anonymized colleague list (firstName only) for the week
  // containing `date` (default: today). 410 Gone for non-SHIFT_BASED or no-employeeId users.
  app.get("/my-week", {
    schema: { tags: ["Schichtplanung"], security: [{ bearerAuth: [] }] },
    handler: async (req, reply) => {
      const employeeId = req.user.employeeId;
      if (!employeeId) {
        return reply.code(410).send({ error: "Kein Mitarbeiter-Profil verknüpft" });
      }

      // Verify caller is SHIFT_BASED (latest active WorkSchedule)
      const me = await app.prisma.employee.findFirst({
        where: { id: employeeId, tenantId: req.user.tenantId },
        select: {
          id: true,
          workSchedules: {
            where: { validFrom: { lte: new Date() } },
            orderBy: { validFrom: "desc" as const },
            take: 1,
            select: { type: true },
          },
        },
      });
      if (!me) {
        return reply.code(410).send({ error: "Mitarbeiter nicht gefunden" });
      }
      if (me.workSchedules[0]?.type !== "SHIFT_BASED") {
        return reply.code(410).send({ error: "Nicht im Schichtsystem" });
      }

      // Week math — mirror GET /week
      const { date } = req.query as { date?: string };
      const refDate = date ? new Date(date + "T00:00:00Z") : new Date();
      const dow = refDate.getUTCDay();
      const mondayOffset = dow === 0 ? -6 : 1 - dow;
      const monday = new Date(refDate);
      monday.setUTCDate(monday.getUTCDate() + mondayOffset);
      monday.setUTCHours(0, 0, 0, 0);
      const sunday = new Date(monday);
      sunday.setUTCDate(sunday.getUTCDate() + 6);
      sunday.setUTCHours(23, 59, 59, 999);

      const weekShifts = await app.prisma.shift.findMany({
        where: {
          employee: { tenantId: req.user.tenantId },
          date: { gte: monday, lte: sunday },
        },
        include: {
          employee: { select: { id: true, firstName: true } },
          template: { select: { name: true, color: true } },
        },
        orderBy: [{ date: "asc" }, { startTime: "asc" }],
      });

      const weekDays: string[] = [];
      const cur = new Date(monday);
      for (let i = 0; i < 7; i++) {
        weekDays.push(cur.toISOString().split("T")[0]);
        cur.setUTCDate(cur.getUTCDate() + 1);
      }

      const days = weekDays.map((iso) => {
        const dayShifts = weekShifts.filter((s) => s.date.toISOString().slice(0, 10) === iso);
        const ownShifts = dayShifts
          .filter((s) => s.employeeId === employeeId)
          .map((s) => ({
            id: s.id,
            templateName: s.template?.name ?? null,
            templateColor: s.template?.color ?? null,
            startTime: s.startTime,
            endTime: s.endTime,
            label: s.label,
            note: s.note,
          }));
        const colleagues = dayShifts
          .filter((s) => s.employeeId !== employeeId)
          .map((s) => ({
            firstName: s.employee.firstName,
            templateName: s.template?.name ?? null,
            templateColor: s.template?.color ?? null,
            startTime: s.startTime,
            endTime: s.endTime,
          }));
        return { date: iso, ownShifts, colleagues };
      });

      return {
        weekStart: weekDays[0],
        weekEnd: weekDays[6],
        days,
      };
    },
  });

  // POST / — create single shift (MANAGER/ADMIN)
  // Phase 43-03: returns 409 with conflict info when the employee has APPROVED
  // leave / non-deleted Absence on the shift's date. Pass ?force=true to override
  // (still writes the shift but emits a SHIFT_FORCED_OVER_LEAVE audit entry).
  app.post("/", {
    schema: { tags: ["Schichtplanung"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const body = shiftSchema.parse(req.body);
      const force = (req.query as { force?: string }).force === "true";

      // Verify the target employee belongs to the tenant (defence in depth)
      const targetEmp = await app.prisma.employee.findFirst({
        where: { id: body.employeeId, tenantId: req.user.tenantId },
        select: { id: true },
      });
      if (!targetEmp) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      // Phase 47.1 — Eligibility gate: only SHIFT_BASED employees may receive shift assignments.
      const eligibility = await assertEmployeeShiftEligible(app.prisma, body.employeeId);
      if (eligibility) {
        return reply.code(422).send({
          error: "Schicht-Zuweisung nicht erlaubt",
          code: "SHIFT_INVALID_EMPLOYEE_TYPE",
          message: eligibility.message,
        });
      }

      // Phase 47.2 — Past-immutable: no creation of shifts dated before today.
      const pastGuard = assertShiftNotPast(body.date);
      if (pastGuard) {
        return reply.code(422).send({
          error: "Schicht-Anlage in der Vergangenheit nicht erlaubt",
          code: "SHIFT_PAST_IMMUTABLE",
          message: pastGuard.message,
        });
      }

      // Phase 47.5 — Store-Hours Soft-Warn: outside Ladenöffnungszeiten requires force.
      if (!force) {
        const storeHit = await assertWithinStoreHours(
          app.prisma,
          req.user.tenantId,
          body.date,
          body.startTime,
          body.endTime,
        );
        if (storeHit) {
          return reply.code(409).send({
            error: "Schicht außerhalb Öffnungszeiten",
            code: "SHIFT_OUTSIDE_STORE_HOURS",
            message: storeHit.message,
            canForce: true,
          });
        }
      }

      // Phase 47.4 — ArbZG § 3 Hart-Block: max 10h Tagesarbeitszeit.
      // Not overridable — force flag is ignored here.
      const dailyMaxHit = assertArbZGDailyMax(body.startTime, body.endTime);
      if (dailyMaxHit) {
        return reply.code(422).send({
          error: "ArbZG-Verstoß",
          code: "ARBZG_VIOLATION_DAILY_MAX",
          message:
            "Schicht überschreitet die zulässige Tageshöchstarbeitszeit (§ 3 ArbZG: 10 Stunden).",
          canForce: false,
        });
      }

      // Phase 47.4 — ArbZG § 5 Soft-Warn: mindestens 11h Ruhezeit zur Vorschicht.
      // Overridable via ?force=true (writes SHIFT_FORCED_OVER_ARBZG audit on success).
      const arbzgRestHit = await assertArbZGRestPeriod(
        app.prisma,
        body.employeeId,
        body.date,
        body.startTime,
      );
      if (arbzgRestHit && !force) {
        const prevDayDate = new Date(body.date + "T00:00:00Z");
        prevDayDate.setUTCDate(prevDayDate.getUTCDate() - 1);
        const prevDayIso = prevDayDate.toISOString().slice(0, 10);
        return reply.code(409).send({
          error: "ArbZG-Verstoß",
          code: "ARBZG_VIOLATION_REST_PERIOD",
          message: `Verstoß gegen § 5 ArbZG: zwischen Schichtende am ${formatDateDe(prevDayIso)} und neuem Beginn liegen nur ${arbzgRestHit.restHours.toFixed(1)}h (mindestens 11h erforderlich).`,
          canForce: true,
        });
      }

      // Conflict-check unless force=true
      const conflict = await findShiftConflict(app.prisma, body.employeeId, body.date);
      if (conflict && !force) {
        const isLeave = conflict.kind === "leave";
        return reply.code(409).send({
          error: "Schicht-Konflikt",
          message: `Mitarbeiter ist am ${formatDateDe(body.date)} ${isLeave ? "im Urlaub" : "krank/abwesend"} — Schicht nicht zuweisbar.`,
          code: isLeave ? "SHIFT_CONFLICT_LEAVE" : "SHIFT_CONFLICT_ABSENCE",
          conflictType: conflict.conflictType,
          canForce: true,
        });
      }

      // Phase 47.3 — Unavailability soft-enforcement gate.
      // Only when feature is enabled AND no leave/absence conflict already fired.
      // PREFERRED is intentionally ignored — only UNAVAILABLE triggers the 409.
      let unavailabilityHit: { id: string } | null = null;
      if (!conflict) {
        const availabilityOn = await isAvailabilityEnabled(app.prisma, req.user.tenantId);
        if (availabilityOn) {
          unavailabilityHit = await findUnavailability(app.prisma, body.employeeId, body.date);
          if (unavailabilityHit && !force) {
            return reply.code(409).send({
              error: "Schicht-Konflikt",
              message: `Mitarbeiter hat am ${formatDateDe(body.date)} „Nicht verfügbar" markiert — Schicht trotzdem zuweisen?`,
              code: "SHIFT_CONFLICT_UNAVAILABILITY",
              canForce: true,
            });
          }
        }
      }

      // If templateId provided, get template defaults
      let label = body.label;
      if (body.templateId && !label) {
        const tpl = await app.prisma.shiftTemplate.findUnique({ where: { id: body.templateId } });
        if (tpl) label = tpl.name;
      }

      const shift = await app.prisma.shift.create({
        data: {
          employeeId: body.employeeId,
          templateId: body.templateId,
          date: new Date(body.date),
          startTime: body.startTime,
          endTime: body.endTime,
          label,
          note: body.note,
          createdBy: req.user.sub,
        },
        include: {
          employee: { select: { id: true, firstName: true, lastName: true } },
          template: { select: { name: true, color: true } },
        },
      });

      // Standard create audit + special force-override audit
      await app.audit({
        userId: req.user.sub,
        action: "CREATE",
        entity: "Shift",
        entityId: shift.id,
        newValue: shift,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });
      if (conflict && force) {
        await app.audit({
          userId: req.user.sub,
          action: "SHIFT_FORCED_OVER_LEAVE",
          entity: "Shift",
          entityId: shift.id,
          newValue: {
            employeeId: body.employeeId,
            date: body.date,
            leaveRequestId: conflict.leaveRequestId,
            absenceId: conflict.absenceId,
            conflictType: conflict.conflictType,
            forcedByUserId: req.user.sub,
          },
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
      }
      if (unavailabilityHit && force) {
        await app.audit({
          userId: req.user.sub,
          action: "SHIFT_FORCED_OVER_UNAVAILABILITY",
          entity: "Shift",
          entityId: shift.id,
          newValue: {
            employeeId: body.employeeId,
            date: body.date,
            availabilityId: unavailabilityHit.id,
            forcedByUserId: req.user.sub,
          },
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
      }
      if (arbzgRestHit && force) {
        await app.audit({
          userId: req.user.sub,
          action: "SHIFT_FORCED_OVER_ARBZG",
          entity: "Shift",
          entityId: shift.id,
          newValue: {
            employeeId: body.employeeId,
            date: body.date,
            startTime: body.startTime,
            endTime: body.endTime,
            restGapHours: arbzgRestHit.restHours,
            prevShiftId: arbzgRestHit.prevShiftId,
            forcedByUserId: req.user.sub,
          },
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
      }
      // Phase 47.5 — Force-audit when store-hours override used (re-check for the audit signal).
      if (force) {
        const storeHitForAudit = await assertWithinStoreHours(
          app.prisma,
          req.user.tenantId,
          body.date,
          body.startTime,
          body.endTime,
        );
        if (storeHitForAudit) {
          await app.audit({
            userId: req.user.sub,
            action: "SHIFT_FORCED_OUTSIDE_HOURS",
            entity: "Shift",
            entityId: shift.id,
            newValue: {
              employeeId: body.employeeId,
              date: body.date,
              startTime: body.startTime,
              endTime: body.endTime,
              reason: storeHitForAudit.message,
              forcedByUserId: req.user.sub,
            },
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
        }
      }

      return reply.code(201).send(shift);
    },
  });

  // PUT /:id — update existing shift
  // Phase 43-03: same conflict gating as POST when date/employee changes onto an
  // approved leave or absence day. Pass ?force=true to override with audit trail.
  app.put("/:id", {
    schema: { tags: ["Schichtplanung"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = shiftSchema.partial().parse(req.body);
      const force = (req.query as { force?: string }).force === "true";

      const existing = await app.prisma.shift.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ error: "Schicht nicht gefunden" });

      // Determine the effective (employeeId, date, startTime, endTime) after the update
      const effEmployeeId = body.employeeId ?? existing.employeeId;
      const effDateIso = body.date ?? existing.date.toISOString().slice(0, 10);
      const effStartTime = body.startTime ?? existing.startTime;
      const effEndTime = body.endTime ?? existing.endTime;

      // Phase 47.1 — Eligibility gate: post-update employee must be SHIFT_BASED.
      // Even when employeeId is unchanged, re-check defensively (schedule may have changed).
      const eligibility = await assertEmployeeShiftEligible(app.prisma, effEmployeeId);
      if (eligibility) {
        return reply.code(422).send({
          error: "Schicht-Verschiebung nicht erlaubt",
          code: "SHIFT_INVALID_EMPLOYEE_TYPE",
          message: eligibility.message,
        });
      }

      // Phase 47.2 — Past-immutable: existing date AND new date must both be today or later.
      const existingIso = existing.date.toISOString().slice(0, 10);
      const pastGuardExisting = assertShiftNotPast(existingIso);
      const pastGuardNew = assertShiftNotPast(effDateIso);
      if (pastGuardExisting || pastGuardNew) {
        return reply.code(422).send({
          error: "Schicht-Änderung in der Vergangenheit nicht erlaubt",
          code: "SHIFT_PAST_IMMUTABLE",
          message: (pastGuardExisting ?? pastGuardNew)!.message,
        });
      }

      // Phase 47.5 — Store-Hours Soft-Warn (effective values).
      if (!force) {
        const storeHit = await assertWithinStoreHours(
          app.prisma,
          req.user.tenantId,
          effDateIso,
          effStartTime,
          effEndTime,
        );
        if (storeHit) {
          return reply.code(409).send({
            error: "Schicht außerhalb Öffnungszeiten",
            code: "SHIFT_OUTSIDE_STORE_HOURS",
            message: storeHit.message,
            canForce: true,
          });
        }
      }

      // Phase 47.4 — ArbZG § 3 Hart-Block: max 10h Tagesarbeitszeit (effective values).
      const dailyMaxHit = assertArbZGDailyMax(effStartTime, effEndTime);
      if (dailyMaxHit) {
        return reply.code(422).send({
          error: "ArbZG-Verstoß",
          code: "ARBZG_VIOLATION_DAILY_MAX",
          message:
            "Schicht überschreitet die zulässige Tageshöchstarbeitszeit (§ 3 ArbZG: 10 Stunden).",
          canForce: false,
        });
      }

      // Phase 47.4 — ArbZG § 5 Soft-Warn: 11h Ruhezeit (excludeShiftId so a self-move
      // does not trigger a phantom conflict against its own previous-day record).
      const arbzgRestHit = await assertArbZGRestPeriod(
        app.prisma,
        effEmployeeId,
        effDateIso,
        effStartTime,
        id,
      );
      if (arbzgRestHit && !force) {
        const prevDayDate = new Date(effDateIso + "T00:00:00Z");
        prevDayDate.setUTCDate(prevDayDate.getUTCDate() - 1);
        const prevDayIso = prevDayDate.toISOString().slice(0, 10);
        return reply.code(409).send({
          error: "ArbZG-Verstoß",
          code: "ARBZG_VIOLATION_REST_PERIOD",
          message: `Verstoß gegen § 5 ArbZG: zwischen Schichtende am ${formatDateDe(prevDayIso)} und neuem Beginn liegen nur ${arbzgRestHit.restHours.toFixed(1)}h (mindestens 11h erforderlich).`,
          canForce: true,
        });
      }

      const conflict = await findShiftConflict(app.prisma, effEmployeeId, effDateIso);
      if (conflict && !force) {
        const isLeave = conflict.kind === "leave";
        return reply.code(409).send({
          error: "Schicht-Konflikt",
          message: `Mitarbeiter ist am ${formatDateDe(effDateIso)} ${isLeave ? "im Urlaub" : "krank/abwesend"} — Schicht nicht zuweisbar.`,
          code: isLeave ? "SHIFT_CONFLICT_LEAVE" : "SHIFT_CONFLICT_ABSENCE",
          conflictType: conflict.conflictType,
          canForce: true,
        });
      }

      // Phase 47.3 — Unavailability soft-enforcement gate (same as POST).
      let unavailabilityHit: { id: string } | null = null;
      if (!conflict) {
        const availabilityOn = await isAvailabilityEnabled(app.prisma, req.user.tenantId);
        if (availabilityOn) {
          unavailabilityHit = await findUnavailability(app.prisma, effEmployeeId, effDateIso);
          if (unavailabilityHit && !force) {
            return reply.code(409).send({
              error: "Schicht-Konflikt",
              message: `Mitarbeiter hat am ${formatDateDe(effDateIso)} „Nicht verfügbar" markiert — Schicht trotzdem zuweisen?`,
              code: "SHIFT_CONFLICT_UNAVAILABILITY",
              canForce: true,
            });
          }
        }
      }

      const updated = await app.prisma.shift.update({
        where: { id },
        data: {
          ...(body.employeeId !== undefined ? { employeeId: body.employeeId } : {}),
          ...(body.templateId !== undefined ? { templateId: body.templateId || null } : {}),
          ...(body.date ? { date: new Date(body.date) } : {}),
          ...(body.startTime ? { startTime: body.startTime } : {}),
          ...(body.endTime ? { endTime: body.endTime } : {}),
          ...(body.label !== undefined ? { label: body.label || null } : {}),
          ...(body.note !== undefined ? { note: body.note || null } : {}),
          // If the user is force-saving on top of a conflict, clear any stale flag
          // (a manager has actively decided this shift stays).
          ...(force && conflict ? { conflictsWithLeave: false } : {}),
        },
        include: {
          employee: { select: { id: true, firstName: true, lastName: true, employeeNumber: true } },
          template: { select: { name: true, color: true } },
        },
      });

      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "Shift",
        entityId: id,
        oldValue: existing,
        newValue: updated,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });
      if (conflict && force) {
        await app.audit({
          userId: req.user.sub,
          action: "SHIFT_FORCED_OVER_LEAVE",
          entity: "Shift",
          entityId: id,
          newValue: {
            employeeId: effEmployeeId,
            date: effDateIso,
            leaveRequestId: conflict.leaveRequestId,
            absenceId: conflict.absenceId,
            conflictType: conflict.conflictType,
            forcedByUserId: req.user.sub,
          },
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
      }
      if (unavailabilityHit && force) {
        await app.audit({
          userId: req.user.sub,
          action: "SHIFT_FORCED_OVER_UNAVAILABILITY",
          entity: "Shift",
          entityId: id,
          newValue: {
            employeeId: effEmployeeId,
            date: effDateIso,
            availabilityId: unavailabilityHit.id,
            forcedByUserId: req.user.sub,
          },
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
      }
      if (arbzgRestHit && force) {
        await app.audit({
          userId: req.user.sub,
          action: "SHIFT_FORCED_OVER_ARBZG",
          entity: "Shift",
          entityId: id,
          newValue: {
            employeeId: effEmployeeId,
            date: effDateIso,
            startTime: effStartTime,
            endTime: effEndTime,
            restGapHours: arbzgRestHit.restHours,
            prevShiftId: arbzgRestHit.prevShiftId,
            forcedByUserId: req.user.sub,
          },
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
      }
      // Phase 47.5 — Force-audit when store-hours override used.
      if (force) {
        const storeHitForAudit = await assertWithinStoreHours(
          app.prisma,
          req.user.tenantId,
          effDateIso,
          effStartTime,
          effEndTime,
        );
        if (storeHitForAudit) {
          await app.audit({
            userId: req.user.sub,
            action: "SHIFT_FORCED_OUTSIDE_HOURS",
            entity: "Shift",
            entityId: id,
            newValue: {
              employeeId: effEmployeeId,
              date: effDateIso,
              startTime: effStartTime,
              endTime: effEndTime,
              reason: storeHitForAudit.message,
              forcedByUserId: req.user.sub,
            },
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
        }
      }

      return updated;
    },
  });

  // POST /generate-week — Auto-generate shifts for a target week from employee
  // recurring patterns (Phase 43-02). Skips employees with APPROVED leave / Absence /
  // existing shift on each day. Returns a diff; only commits when commit=true.
  app.post("/generate-week", {
    schema: { tags: ["Schichtplanung"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const body = generateWeekSchema.parse(req.body);

      // Parse weekStart (Mo) and produce Mo-So ISO list
      const monday = new Date(body.weekStart + "T00:00:00Z");
      if (Number.isNaN(monday.getTime())) {
        return reply.code(400).send({ error: "Ungültiges weekStart-Datum" });
      }
      // Sanity: must actually be a Monday (UTC). 1=Mon..0=Sun
      // (We accept any date and align silently if needed.)
      const jsDow = monday.getUTCDay();
      const offset = jsDow === 0 ? -6 : 1 - jsDow;
      monday.setUTCDate(monday.getUTCDate() + offset);

      const weekDays: string[] = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(monday);
        d.setUTCDate(d.getUTCDate() + i);
        weekDays.push(d.toISOString().slice(0, 10));
      }
      const weekStartIso = weekDays[0];
      const weekEndIso = weekDays[6];
      const weekStartDate = new Date(weekStartIso + "T00:00:00Z");
      const weekEndDate = new Date(weekEndIso + "T23:59:59Z");

      const tenantId = req.user.tenantId;

      // Phase 47.3 — Verfügbarkeits-System toggle. When disabled, UNAVAILABLE rows
      // do NOT skip the auto-gen (no `availability-unavailable` skip entries).
      const availabilityOn = await isAvailabilityEnabled(app.prisma, tenantId);

      // Load everything we need in parallel
      const [employees, patterns, leaveRequests, absences, existingShifts, unavailableRowsRaw] =
        await Promise.all([
          app.prisma.employee.findMany({
            where: {
              tenantId,
              OR: [{ exitDate: null }, { exitDate: { gt: weekStartDate } }],
            },
            select: { id: true, hireDate: true, exitDate: true },
          }),
          app.prisma.employeeShiftPattern.findMany({
            where: {
              employee: { tenantId },
              isActive: true,
              validFrom: { lte: weekEndDate },
              OR: [{ validUntil: null }, { validUntil: { gte: weekStartDate } }],
            },
            include: {
              template: { select: { id: true, name: true, startTime: true, endTime: true } },
            },
          }),
          app.prisma.leaveRequest.findMany({
            where: {
              employee: { tenantId },
              status: "APPROVED",
              deletedAt: null,
              startDate: { lte: weekEndDate },
              endDate: { gte: weekStartDate },
            },
            select: {
              id: true,
              employeeId: true,
              startDate: true,
              endDate: true,
              leaveTypeId: true,
            },
          }),
          app.prisma.absence.findMany({
            where: {
              employee: { tenantId },
              deletedAt: null,
              startDate: { lte: weekEndDate },
              endDate: { gte: weekStartDate },
            },
            select: { id: true, employeeId: true, startDate: true, endDate: true, type: true },
          }),
          app.prisma.shift.findMany({
            where: {
              employee: { tenantId },
              date: { gte: weekStartDate, lte: weekEndDate },
            },
            select: { id: true, employeeId: true, date: true },
          }),
          // Phase 46 — UNAVAILABLE EmployeeAvailability rows for the target week.
          // PREFERRED is a soft hint and does NOT block auto-generation; only UNAVAILABLE skips.
          app.prisma.employeeAvailability.findMany({
            where: {
              employee: { tenantId },
              status: "UNAVAILABLE",
              AND: [
                { validFrom: { lte: weekEndDate } },
                { OR: [{ validUntil: null }, { validUntil: { gte: weekStartDate } }] },
              ],
              OR: [
                { dayOfWeek: { not: null } },
                { date: { gte: weekStartDate, lte: weekEndDate } },
              ],
            },
            select: {
              id: true,
              employeeId: true,
              dayOfWeek: true,
              date: true,
              validFrom: true,
              validUntil: true,
            },
          }),
        ]);

      // Phase 47.3 — Narrow to [] when feature is off so `hasUnavailable` can never match.
      const unavailableRows = availabilityOn ? unavailableRowsRaw : [];

      // Index helpers
      function isoToDow(iso: string): number {
        const d = new Date(iso + "T00:00:00Z");
        const jsDow = d.getUTCDay();
        return jsDow === 0 ? 6 : jsDow - 1;
      }
      function rangeCovers(startDate: Date, endDate: Date, iso: string): boolean {
        const s = startDate.toISOString().slice(0, 10);
        const e = endDate.toISOString().slice(0, 10);
        return iso >= s && iso <= e;
      }

      // Build pattern lookup: employeeId × dayOfWeek → pattern row (the latest validFrom wins)
      type PatternRow = (typeof patterns)[number];
      const patternByEmpDow = new Map<string, PatternRow>();
      // patterns ordered by validFrom desc inside the loop:
      const patternsSorted = [...patterns].sort(
        (a, b) => b.validFrom.getTime() - a.validFrom.getTime(),
      );
      for (const p of patternsSorted) {
        const key = `${p.employeeId}::${p.dayOfWeek}`;
        if (!patternByEmpDow.has(key)) patternByEmpDow.set(key, p);
      }

      // Existing-shift set (employeeId × iso)
      const existingByKey = new Set(
        existingShifts.map((s) => `${s.employeeId}::${s.date.toISOString().slice(0, 10)}`),
      );

      // Diff containers
      const toCreate: Array<{
        employeeId: string;
        date: string;
        templateId: string;
        startTime: string;
        endTime: string;
        label: string;
      }> = [];
      const skip: Array<{
        employeeId: string;
        date: string;
        reason:
          | "leave"
          | "absence"
          | "existing"
          | "no-pattern"
          | "open-day"
          | "availability-unavailable";
      }> = [];

      for (const emp of employees) {
        // Skip pre-hire and post-exit dates
        const hireIso = emp.hireDate.toISOString().slice(0, 10);
        const exitIso = emp.exitDate ? emp.exitDate.toISOString().slice(0, 10) : null;

        for (const iso of weekDays) {
          if (iso < hireIso) {
            skip.push({ employeeId: emp.id, date: iso, reason: "no-pattern" });
            continue;
          }
          if (exitIso && iso > exitIso) {
            skip.push({ employeeId: emp.id, date: iso, reason: "no-pattern" });
            continue;
          }

          const dow = isoToDow(iso);
          const key = `${emp.id}::${dow}`;
          const pat = patternByEmpDow.get(key);

          // Pattern must be active on this date
          if (
            !pat ||
            pat.validFrom.toISOString().slice(0, 10) > iso ||
            (pat.validUntil && pat.validUntil.toISOString().slice(0, 10) < iso)
          ) {
            skip.push({ employeeId: emp.id, date: iso, reason: "no-pattern" });
            continue;
          }

          // Pattern with no templateId = "day off" — intentionally generate nothing
          if (!pat.templateId || !pat.template) {
            skip.push({ employeeId: emp.id, date: iso, reason: "open-day" });
            continue;
          }

          // Already exists?
          if (existingByKey.has(`${emp.id}::${iso}`)) {
            skip.push({ employeeId: emp.id, date: iso, reason: "existing" });
            continue;
          }

          // Leave on this day?
          const hasLeave = leaveRequests.some(
            (lr) => lr.employeeId === emp.id && rangeCovers(lr.startDate, lr.endDate, iso),
          );
          if (hasLeave) {
            skip.push({ employeeId: emp.id, date: iso, reason: "leave" });
            continue;
          }

          // Absence on this day?
          const hasAbsence = absences.some(
            (ab) => ab.employeeId === emp.id && rangeCovers(ab.startDate, ab.endDate, iso),
          );
          if (hasAbsence) {
            skip.push({ employeeId: emp.id, date: iso, reason: "absence" });
            continue;
          }

          // Phase 46 — EmployeeAvailability UNAVAILABLE on this day?
          // PREFERRED is a soft hint and does NOT block auto-gen (only UNAVAILABLE skips).
          const hasUnavailable = unavailableRows.some(
            (av) => av.employeeId === emp.id && appliesOnDay(av, iso, isoToDow),
          );
          if (hasUnavailable) {
            skip.push({
              employeeId: emp.id,
              date: iso,
              reason: "availability-unavailable",
            });
            continue;
          }

          toCreate.push({
            employeeId: emp.id,
            date: iso,
            templateId: pat.template.id,
            startTime: pat.template.startTime,
            endTime: pat.template.endTime,
            label: pat.template.name,
          });
        }
      }

      // Preview mode — return the diff without persisting
      if (!body.commit) {
        return { weekStart: weekStartIso, create: toCreate, skip, committed: false };
      }

      // Commit mode — write everything in one transaction
      const created = await app.prisma.$transaction(async (tx) => {
        const rows = [];
        for (const c of toCreate) {
          const row = await tx.shift.create({
            data: {
              employeeId: c.employeeId,
              templateId: c.templateId,
              date: new Date(c.date),
              startTime: c.startTime,
              endTime: c.endTime,
              label: c.label,
              createdBy: req.user.sub,
            },
          });
          rows.push(row);
        }
        return rows;
      });

      // Audit log per created shift
      for (const row of created) {
        await app.audit({
          userId: req.user.sub,
          action: "CREATE",
          entity: "Shift",
          entityId: row.id,
          newValue: { ...row, source: "GENERATE_WEEK", weekStart: weekStartIso },
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
      }

      return {
        weekStart: weekStartIso,
        create: created.map((c) => ({
          id: c.id,
          employeeId: c.employeeId,
          date: c.date.toISOString().slice(0, 10),
          templateId: c.templateId,
          startTime: c.startTime,
          endTime: c.endTime,
          label: c.label,
        })),
        skip,
        committed: true,
      };
    },
  });

  // POST /copy-week — Copy all shifts from one week to another (Phase 43-05).
  // The "Letzte Woche kopieren" primary UX: pick a source week (default = current −7d),
  // pick a target week (current displayed week), preview, commit. Skips employees with
  // APPROVED leave / Absence / existing shift on the target date. Reuses the same
  // skip-logic as generate-week. Each created shift gets a SHIFT_COPIED audit entry
  // (distinct from CREATE so the audit trail records the copy provenance).
  app.post("/copy-week", {
    schema: { tags: ["Schichtplanung"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const body = copyWeekSchema.parse(req.body);

      // Align both weeks to Monday (UTC) for safety
      function alignMonday(iso: string): Date {
        const d = new Date(iso + "T00:00:00Z");
        if (Number.isNaN(d.getTime())) return d;
        const jsDow = d.getUTCDay();
        const offset = jsDow === 0 ? -6 : 1 - jsDow;
        d.setUTCDate(d.getUTCDate() + offset);
        return d;
      }

      const sourceMonday = alignMonday(body.sourceWeekStart);
      const targetMonday = alignMonday(body.targetWeekStart);
      if (Number.isNaN(sourceMonday.getTime()) || Number.isNaN(targetMonday.getTime())) {
        return reply.code(400).send({ error: "Ungültiges Datum" });
      }

      // Build source/target ISO week-day arrays (Mo..So)
      const sourceWeekDays: string[] = [];
      const targetWeekDays: string[] = [];
      for (let i = 0; i < 7; i++) {
        const s = new Date(sourceMonday);
        s.setUTCDate(s.getUTCDate() + i);
        sourceWeekDays.push(s.toISOString().slice(0, 10));
        const t = new Date(targetMonday);
        t.setUTCDate(t.getUTCDate() + i);
        targetWeekDays.push(t.toISOString().slice(0, 10));
      }

      const sourceStartIso = sourceWeekDays[0];
      const sourceEndIso = sourceWeekDays[6];
      const targetStartIso = targetWeekDays[0];
      const targetEndIso = targetWeekDays[6];

      const sourceStartDate = new Date(sourceStartIso + "T00:00:00Z");
      const sourceEndDate = new Date(sourceEndIso + "T23:59:59Z");
      const targetStartDate = new Date(targetStartIso + "T00:00:00Z");
      const targetEndDate = new Date(targetEndIso + "T23:59:59Z");

      const tenantId = req.user.tenantId;

      // Phase 47.3 — Verfügbarkeits-System toggle. When disabled, UNAVAILABLE rows
      // do NOT skip copy-week.
      const availabilityOn = await isAvailabilityEnabled(app.prisma, tenantId);

      // Load source shifts + target-week skip-context in parallel
      const [sourceShifts, leaveRequests, absences, existingShifts, unavailableRowsRaw] =
        await Promise.all([
          app.prisma.shift.findMany({
            where: {
              employee: { tenantId },
              date: { gte: sourceStartDate, lte: sourceEndDate },
            },
            include: {
              template: { select: { id: true, name: true } },
            },
            orderBy: [{ date: "asc" }, { startTime: "asc" }],
          }),
          app.prisma.leaveRequest.findMany({
            where: {
              employee: { tenantId },
              status: "APPROVED",
              deletedAt: null,
              startDate: { lte: targetEndDate },
              endDate: { gte: targetStartDate },
            },
            select: { id: true, employeeId: true, startDate: true, endDate: true },
          }),
          app.prisma.absence.findMany({
            where: {
              employee: { tenantId },
              deletedAt: null,
              startDate: { lte: targetEndDate },
              endDate: { gte: targetStartDate },
            },
            select: { id: true, employeeId: true, startDate: true, endDate: true },
          }),
          app.prisma.shift.findMany({
            where: {
              employee: { tenantId },
              date: { gte: targetStartDate, lte: targetEndDate },
            },
            select: { id: true, employeeId: true, date: true },
          }),
          // Phase 46 — UNAVAILABLE EmployeeAvailability rows for the TARGET week.
          // PREFERRED does NOT block copy-week (soft hint only); only UNAVAILABLE skips.
          app.prisma.employeeAvailability.findMany({
            where: {
              employee: { tenantId },
              status: "UNAVAILABLE",
              AND: [
                { validFrom: { lte: targetEndDate } },
                { OR: [{ validUntil: null }, { validUntil: { gte: targetStartDate } }] },
              ],
              OR: [
                { dayOfWeek: { not: null } },
                { date: { gte: targetStartDate, lte: targetEndDate } },
              ],
            },
            select: {
              id: true,
              employeeId: true,
              dayOfWeek: true,
              date: true,
              validFrom: true,
              validUntil: true,
            },
          }),
        ]);

      // Phase 47.3 — Narrow to [] when feature is off so `hasUnavailable` can never match.
      const unavailableRows = availabilityOn ? unavailableRowsRaw : [];

      function rangeCovers(startDate: Date, endDate: Date, iso: string): boolean {
        const s = startDate.toISOString().slice(0, 10);
        const e = endDate.toISOString().slice(0, 10);
        return iso >= s && iso <= e;
      }
      // Phase 46 — Mo=0..So=6 weekday derivation (matches the rest of shifts.ts).
      function isoToDow(iso: string): number {
        const d = new Date(iso + "T00:00:00Z");
        const jsDow = d.getUTCDay();
        return jsDow === 0 ? 6 : jsDow - 1;
      }

      // Map source iso → index in sourceWeekDays for the day-of-week offset
      const sourceIsoToIndex = new Map<string, number>();
      for (let i = 0; i < sourceWeekDays.length; i++) {
        sourceIsoToIndex.set(sourceWeekDays[i], i);
      }

      // Existing-shift set (employeeId × targetIso) for fast "already exists" lookup
      const existingByKey = new Set(
        existingShifts.map((s) => `${s.employeeId}::${s.date.toISOString().slice(0, 10)}`),
      );

      type CopyCreate = {
        employeeId: string;
        date: string;
        templateId: string | null;
        startTime: string;
        endTime: string;
        label: string | null;
        note: string | null;
        sourceShiftId: string;
      };
      type CopySkip = {
        employeeId: string;
        date: string;
        reason: "leave" | "absence" | "existing" | "availability-unavailable";
      };

      const toCreate: CopyCreate[] = [];
      const skip: CopySkip[] = [];

      for (const src of sourceShifts) {
        const sourceIso = src.date.toISOString().slice(0, 10);
        const idx = sourceIsoToIndex.get(sourceIso);
        if (idx === undefined) continue; // safety — shouldn't happen
        const targetIso = targetWeekDays[idx];

        // Already a shift for this employee on the target date?
        if (existingByKey.has(`${src.employeeId}::${targetIso}`)) {
          skip.push({ employeeId: src.employeeId, date: targetIso, reason: "existing" });
          continue;
        }

        // Leave on target date?
        const hasLeave = leaveRequests.some(
          (lr) =>
            lr.employeeId === src.employeeId && rangeCovers(lr.startDate, lr.endDate, targetIso),
        );
        if (hasLeave) {
          skip.push({ employeeId: src.employeeId, date: targetIso, reason: "leave" });
          continue;
        }

        // Absence on target date?
        const hasAbsence = absences.some(
          (ab) =>
            ab.employeeId === src.employeeId && rangeCovers(ab.startDate, ab.endDate, targetIso),
        );
        if (hasAbsence) {
          skip.push({ employeeId: src.employeeId, date: targetIso, reason: "absence" });
          continue;
        }

        // Phase 46 — EmployeeAvailability UNAVAILABLE on the target date?
        // PREFERRED is a soft hint and does NOT block copy-week.
        const hasUnavailable = unavailableRows.some(
          (av) => av.employeeId === src.employeeId && appliesOnDay(av, targetIso, isoToDow),
        );
        if (hasUnavailable) {
          skip.push({
            employeeId: src.employeeId,
            date: targetIso,
            reason: "availability-unavailable",
          });
          continue;
        }

        toCreate.push({
          employeeId: src.employeeId,
          date: targetIso,
          templateId: src.templateId ?? null,
          startTime: src.startTime,
          endTime: src.endTime,
          label: src.label ?? null,
          note: src.note ?? null,
          sourceShiftId: src.id,
        });
      }

      // Preview mode — return the diff without persisting
      if (!body.commit) {
        return {
          sourceWeekStart: sourceStartIso,
          targetWeekStart: targetStartIso,
          create: toCreate,
          skip,
          committed: false,
        };
      }

      // Commit mode — write everything in one transaction
      const created = await app.prisma.$transaction(async (tx) => {
        const rows: Array<Awaited<ReturnType<typeof tx.shift.create>> & { sourceShiftId: string }> =
          [];
        for (const c of toCreate) {
          const row = await tx.shift.create({
            data: {
              employeeId: c.employeeId,
              templateId: c.templateId,
              date: new Date(c.date),
              startTime: c.startTime,
              endTime: c.endTime,
              label: c.label,
              note: c.note,
              createdBy: req.user.sub,
            },
          });
          rows.push({ ...row, sourceShiftId: c.sourceShiftId });
        }
        return rows;
      });

      // Audit log per copied shift (SHIFT_COPIED is distinct from CREATE so the
      // audit trail records the copy provenance — see Phase 43-05 spec).
      for (const row of created) {
        await app.audit({
          userId: req.user.sub,
          action: "SHIFT_COPIED",
          entity: "Shift",
          entityId: row.id,
          newValue: {
            employeeId: row.employeeId,
            date: row.date.toISOString().slice(0, 10),
            templateId: row.templateId,
            startTime: row.startTime,
            endTime: row.endTime,
            label: row.label,
            sourceShiftId: row.sourceShiftId,
            sourceWeekStart: sourceStartIso,
            targetWeekStart: targetStartIso,
          },
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
      }

      return {
        sourceWeekStart: sourceStartIso,
        targetWeekStart: targetStartIso,
        create: created.map((c) => ({
          id: c.id,
          employeeId: c.employeeId,
          date: c.date.toISOString().slice(0, 10),
          templateId: c.templateId,
          startTime: c.startTime,
          endTime: c.endTime,
          label: c.label,
          note: c.note,
          sourceShiftId: c.sourceShiftId,
        })),
        skip,
        committed: true,
      };
    },
  });

  // POST /bulk — create multiple shifts at once
  app.post("/bulk", {
    schema: { tags: ["Schichtplanung"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { shifts: shiftDefs } = bulkShiftSchema.parse(req.body);

      const created = await app.prisma.$transaction(
        shiftDefs.map((s) =>
          app.prisma.shift.create({
            data: {
              employeeId: s.employeeId,
              templateId: s.templateId,
              date: new Date(s.date),
              startTime: s.startTime,
              endTime: s.endTime,
              label: s.label,
              note: s.note,
              createdBy: req.user.sub,
            },
          }),
        ),
      );

      return reply.code(201).send({ created: created.length });
    },
  });

  // DELETE /:id
  app.delete("/:id", {
    schema: { tags: ["Schichtplanung"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = await app.prisma.shift.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ error: "Schicht nicht gefunden" });

      // Phase 47.2 — Past-immutable: no deletion of shifts dated before today.
      const pastGuard = assertShiftNotPast(existing.date.toISOString().slice(0, 10));
      if (pastGuard) {
        return reply.code(422).send({
          error: "Schicht-Löschung in der Vergangenheit nicht erlaubt",
          code: "SHIFT_PAST_IMMUTABLE",
          message: pastGuard.message,
        });
      }

      await app.prisma.shift.delete({ where: { id } });
      await app.audit({
        userId: req.user.sub,
        action: "DELETE",
        entity: "Shift",
        entityId: id,
        oldValue: existing,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });
      return reply.code(204).send();
    },
  });
}

// Severity ranking for combining availability sources (higher wins).
// Phase 46 — extended to 7 values: explicit UNAVAILABLE/PREFERRED EmployeeAvailability rows
// rank BELOW any leave/absence source (vacation/sick/special/other) so leave wins ties.
function rankAvailability(a: Availability): number {
  switch (a) {
    case "sick":
      return 6;
    case "vacation":
      return 5;
    case "special":
      return 4;
    // Phase 63 D-20 + Open Question 5 — tie with "special" (rank 4). BS is a
    // legally-required commitment but semantically closer to Sonderurlaub than to
    // Urlaub/Krank; sick (6) and vacation (5) still beat it on multi-source days.
    case "vocational_school":
      return 4;
    case "other":
      return 3;
    case "unavailable":
      return 2;
    case "preferred":
      return 1;
    case "available":
    default:
      return 0;
  }
}
