/**
 * Issue #80 (D-02, D-03, D-05, D-06, D-19, D-21) — day-level gap breaks.
 *
 * A break that lies BETWEEN two closed entries of one employee and one day (owner example: 13:00
 * to 14:00 = 30 min drive + 30 min lunch) hangs on the DAY, not on an entry, and is recorded here.
 * `checkArbZG` counts it (D-04); it never reduces working time and never touches a TimeEntry or a
 * Break row (D-05). The acknowledgement of a cross-salon violation (`POST /acks`, `DELETE
 * /acks/:id`, D-08) lives here too; the day check is added by a later plan of the phase. The routes live in their own file so `api/time-entries.ts` keeps its line-pinned
 * tenant-scoping exceptions (D-21).
 *
 * Revisionssicherheit (D-06): create and delete each write their AuditLog row in the SAME
 * transaction as the row write; delete is a soft delete with a mandatory reason; there is no update
 * route — a correction is delete + create (D-19). A closed month answers 403 (the wording of the
 * entry routes), a locked entry of the day 409.
 *
 * Authorization: `time-entry:update`. An EIGENE caller may act only on their own day; a ZUGEWIESEN
 * caller acting on someone else's day needs scope over EVERY closed entry of that day
 * (`dayCoverage`), otherwise the identical 404 plus a SCOPE_ACCESS_DENIED audit.
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DayBreak, DayBreakAck, Prisma } from "@clokr/db";
import { requireAuth } from "../../../middleware/auth";
import {
  permissionReach,
  accessContextFromRequest,
  employeeScopeFor,
  resolveAccessReach,
  requirePermission,
  auditReasonSchema,
} from "../../platform";
import { getTenantTimezone, isMonthClosed, monthRangeUtc } from "../../working-time-account";
import {
  type DayBreakEvaluation,
  type DayBreakRow,
  evaluateDayBreaks,
  findGapForInterval,
  intervalsOverlap,
  isAckSnapshotCurrent,
} from "../day-break-rule";
import {
  closedWorkRowsInRange,
  closedWorkRowsOfDay,
  listAcksOfDay,
  listDayBreaksOfDay,
  loadDayBreakDataForDays,
} from "../day-break-store";
import { dayLimitWarnings } from "../arbzg";
import { dayCoverage } from "../day-scope";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const NOT_ALLOWED_MESSAGE = "Kein Zugriff";
const ENTRY_NOT_FOUND_MESSAGE = "Eintrag nicht gefunden";
const BREAK_NOT_FOUND_MESSAGE = "Pause nicht gefunden";
const EMPLOYEE_NOT_FOUND_MESSAGE = "Mitarbeiter nicht gefunden";
const MONTH_CLOSED_MESSAGE = "Monat ist abgeschlossen und kann nicht bearbeitet werden";
const ENTRY_LOCKED_MESSAGE = "Eintrag ist gesperrt und kann nicht bearbeitet werden";
const INVERTED_INTERVAL_MESSAGE = "Pausenende muss nach Pausenbeginn liegen";
const NO_GAP_MESSAGE =
  "Die Pause muss vollständig in einer Lücke zwischen zwei abgeschlossenen Einträgen dieses Tages liegen.";
const OVERLAP_MESSAGE = "Die Pause überschneidet sich mit einer bereits erfassten Tagespause.";
const ACK_NOT_FOUND_MESSAGE = "Quittung nicht gefunden";
/** D-14: nobody quits (or revokes) the break violation of their own day. */
const SELF_ACK_MESSAGE = "Eigene Pausenverstöße können nicht selbst quittiert werden.";
/** D-18: only a cross-salon day with a § 4 shortfall can be acknowledged. */
const NO_VIOLATION_MESSAGE = "Für diesen Tag liegt kein salonübergreifender Pausenverstoß vor.";
const ALREADY_ACKED_MESSAGE = "Der Pausenverstoß dieses Tages ist bereits quittiert.";

/** A real calendar date in `YYYY-MM-DD` form (rejects 2026-02-30). */
const dateKeySchema = z
  .string()
  .regex(DATE_PATTERN, "Format YYYY-MM-DD erwartet")
  .refine((v) => dayKeyToDate(v).toISOString().slice(0, 10) === v, "Ungültiges Datum");

const createDayBreakSchema = z.object({
  employeeId: z.string().uuid(),
  date: dateKeySchema,
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
});

const createAckSchema = z.object({
  employeeId: z.string().uuid(),
  date: dateKeySchema,
  reason: auditReasonSchema,
});

const checksQuerySchema = z.object({
  employeeId: z.string().uuid("Ungültige Mitarbeiter-ID"),
  from: dateKeySchema,
  to: dateKeySchema,
});

/** Cap of the day-check window in inclusive days (D-20, T-80-31). */
const CHECKS_MAX_RANGE_DAYS = 62;

const idParamSchema = z.object({ id: z.string().uuid() });
const deleteBodySchema = z.object({ reason: auditReasonSchema });

/** UTC midnight of a `YYYY-MM-DD` key — the equality contract of the `@db.Date` column. */
function dayKeyToDate(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

/**
 * The caller's reach for acting on `employeeId`'s day, or null after the 403 reply: no
 * `time-entry:update` at all, or an EIGENE-only caller naming another employee. The ONE call of
 * `permissionReach` in this file, shared by create and delete.
 */
async function resolveActingReach(
  req: FastifyRequest,
  reply: FastifyReply,
  employeeId: string,
): Promise<"ZUGEWIESEN" | "EIGENE" | null> {
  const reach = await permissionReach(req, "time-entry:update");
  if (reach === null || (reach !== "ZUGEWIESEN" && employeeId !== req.user.employeeId)) {
    reply.code(403).send({ error: NOT_ALLOWED_MESSAGE });
    return null;
  }
  return reach;
}

/**
 * The shared guard of both routes after the permission and the tenant checks: loads the day's
 * closed entries, enforces day-wide scope for a caller acting on someone else's day, then the month
 * lock and the entry lock. Writes the reply and returns null when a guard fails; returns the day's
 * rows otherwise. Callers MUST `return` immediately on null.
 *
 * `notFoundMessage` is the 404 wording of the calling route, so an out-of-scope day is
 * byte-identical to a non-existent target of that route (T-100-09).
 */
async function authorizeDayAction(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  params: {
    employeeId: string;
    dateKey: string;
    notFoundMessage: string;
  },
) {
  const tenantId = req.user.tenantId;
  const { employeeId, dateKey } = params;
  const date = dayKeyToDate(dateKey);
  const rows = await closedWorkRowsOfDay(app.prisma, { tenantId, employeeId, date });

  const actsOnOwnDay = employeeId === req.user.employeeId;
  if (!actsOnOwnDay) {
    // Only a ZUGEWIESEN caller reaches this point (resolveActingReach). Scope over EVERY closed
    // entry of the day, or the day is invisible to the caller (D-08).
    const scopeReach = await resolveAccessReach(
      app.prisma,
      accessContextFromRequest(req),
      "time-entry:update:ZUGEWIESEN",
    );
    const coverage = await dayCoverage(
      app.prisma,
      tenantId,
      scopeReach,
      rows.map((r) => ({ salonId: r.salonId, employeeId, date })),
    );
    if (coverage !== "all") {
      // An empty day writes no audit row: it answers the same 404 as an out-of-scope day, and an
      // audit row would reveal that the day has entries (T-80-15).
      if (rows.length > 0) {
        await app.audit({
          userId: req.user.sub,
          action: "SCOPE_ACCESS_DENIED",
          entity: "EmployeeDay",
          entityId: `${employeeId}:${dateKey}`,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
      }
      reply.code(404).send({ error: params.notFoundMessage });
      return null;
    }
  }

  const tz = await getTenantTimezone(app.prisma, tenantId);
  const [year, month] = dateKey.split("-").map(Number);
  const { start: monthStart } = monthRangeUtc(year, month, tz);
  if (await isMonthClosed(app.prisma, employeeId, tenantId, monthStart)) {
    reply.code(403).send({ error: MONTH_CLOSED_MESSAGE });
    return null;
  }
  if (rows.some((r) => r.isLocked)) {
    reply.code(409).send({ error: ENTRY_LOCKED_MESSAGE });
    return null;
  }
  return rows;
}

/** The facts of a day break that an audit row records (the row has no free text). */
function dayBreakFacts(row: Pick<DayBreak, "employeeId" | "date" | "startTime" | "endTime">) {
  return {
    employeeId: row.employeeId,
    date: row.date.toISOString().slice(0, 10),
    startTime: row.startTime,
    endTime: row.endTime,
  };
}

/**
 * The facts of an acknowledgement that an audit row records. The reason is part of the "why" the
 * trail must carry (Revisionssicherheit), exactly like every other audited reason; whether audit
 * free text is redacted on anonymization is one system-wide rule (#512), not decided per entity.
 */
function ackFacts(
  row: Pick<DayBreakAck, "employeeId" | "date" | "reason" | "snapshot">,
): Record<string, unknown> {
  return {
    employeeId: row.employeeId,
    date: row.date.toISOString().slice(0, 10),
    reason: row.reason,
    snapshot: row.snapshot,
  };
}

/** The figures every detail level of a day check carries - totals and the finding, no entry data. */
function dayCheckTotals(evaluation: DayBreakEvaluation, dateKey: string, locked: boolean) {
  return {
    date: dateKey,
    crossSalon: evaluation.crossSalon,
    netWorkedMinutes: Math.round(evaluation.netWorkedMin),
    totalBreakMinutes: Math.round(evaluation.totalBreakMin),
    requiredBreakMinutes: evaluation.requiredBreakMin,
    breakShortfall: evaluation.breakShortfall,
    // The § 3 cap is the finding builder's rule (`dayLimitWarnings`); no second copy of it here.
    maxDailyExceeded: dayLimitWarnings(evaluation, 0).some((w) => w.code === "MAX_DAILY_EXCEEDED"),
    acknowledged: evaluation.acknowledged,
    locked,
  };
}

/**
 * A day as a caller whose scope covers only part of its entries may see it (D-11): the day totals
 * and the finding. Built from an explicit whitelist - the entry list, gaps, day breaks,
 * acknowledgement and every id are fixed to null/false here, never removed from a fuller object,
 * so a field added to the full shape can never leak into this one by omission.
 */
function redactedDayCheck(dateKey: string, evaluation: DayBreakEvaluation, locked: boolean) {
  return {
    detail: "redacted" as const,
    ...dayCheckTotals(evaluation, dateKey, locked),
    mayAcknowledge: false,
    mayRecordDayBreak: false,
    acknowledgement: null,
    entries: null,
    gaps: null,
    dayBreaks: null,
  };
}

/** A day with its complete detail: entries with salon, kernel gaps, day breaks, acknowledgement. */
function fullDayCheck(params: {
  dateKey: string;
  evaluation: DayBreakEvaluation;
  locked: boolean;
  mayAcknowledge: boolean;
  mayRecordDayBreak: boolean;
  currentAck: DayBreakAck | undefined;
  dayRows: ReadonlyArray<DayBreakRow>;
  dayBreaksOfDay: ReadonlyArray<DayBreak>;
}) {
  const { evaluation, currentAck } = params;
  return {
    detail: "full" as const,
    ...dayCheckTotals(evaluation, params.dateKey, params.locked),
    mayAcknowledge: params.mayAcknowledge,
    mayRecordDayBreak: params.mayRecordDayBreak,
    acknowledgement: currentAck
      ? { id: currentAck.id, createdAt: currentAck.createdAt, reason: currentAck.reason }
      : null,
    entries: params.dayRows.map((r) => ({
      id: r.id,
      startTime: r.startTime,
      endTime: r.endTime,
      salonId: r.salonId,
    })),
    // D-22: the gaps are the kernel's own list, never recomputed here.
    gaps: evaluation.gaps.map((g) => ({
      startTime: g.startTime,
      endTime: g.endTime,
      crossSalon: g.crossSalon,
      countsAsBreak: g.countsAsBreak,
    })),
    dayBreaks: params.dayBreaksOfDay.map((b) => ({
      id: b.id,
      startTime: b.startTime,
      endTime: b.endTime,
    })),
  };
}

export async function dayBreakRoutes(app: FastifyInstance) {
  // POST /api/v1/day-breaks — record a break that lies in a gap between two entries of a day.
  app.post("/", {
    schema: {
      tags: ["Zeiterfassung"],
      summary: "Record a break that lies in a gap between two entries of a day",
      description:
        "Creates a day-level break (Issue #80). The interval must lie completely inside the gap " +
        "between two closed entries of the employee's day and must not overlap another day " +
        "break. Never writes a time entry. Requires time-entry:update; a caller acting on " +
        "someone else's day needs scope over every closed entry of that day.",
      security: [{ bearerAuth: [] }],
    },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const body = createDayBreakSchema.parse(req.body);
      const tenantId = req.user.tenantId;
      const startTime = new Date(body.startTime);
      const endTime = new Date(body.endTime);
      if (!(startTime < endTime)) {
        return reply.code(400).send({ error: INVERTED_INTERVAL_MESSAGE });
      }

      if (!(await resolveActingReach(req, reply, body.employeeId))) return;

      // A foreign tenant's employee and an unknown id answer identically.
      const employee = await app.prisma.employee.findFirst({
        where: { id: body.employeeId, tenantId },
        select: { id: true },
      });
      if (!employee) {
        return reply.code(404).send({ error: EMPLOYEE_NOT_FOUND_MESSAGE });
      }

      const rows = await authorizeDayAction(app, req, reply, {
        employeeId: body.employeeId,
        dateKey: body.date,
        notFoundMessage: ENTRY_NOT_FOUND_MESSAGE,
      });
      if (!rows) return;

      const interval = { startTime, endTime };
      if (!findGapForInterval(rows, interval)) {
        return reply.code(409).send({ error: NO_GAP_MESSAGE });
      }

      const date = dayKeyToDate(body.date);
      const created = await app.prisma.$transaction(async (tx) => {
        // Serialise concurrent writes for the same employee and day so two overlapping requests
        // cannot both pass the overlap check below.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`day-break:${body.employeeId}:${body.date}`}))`;
        const existing = await listDayBreaksOfDay(tx, {
          tenantId,
          employeeId: body.employeeId,
          date,
        });
        if (existing.some((b) => intervalsOverlap(b, interval))) return null;

        const row = await tx.dayBreak.create({
          data: {
            employeeId: body.employeeId,
            date,
            startTime,
            endTime,
            createdBy: req.user.sub,
          },
        });
        await app.audit({
          userId: req.user.sub,
          action: "DAY_BREAK_CREATE",
          entity: "DayBreak",
          entityId: row.id,
          newValue: dayBreakFacts(row),
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
          tx,
        });
        return row;
      });
      if (!created) {
        return reply.code(409).send({ error: OVERLAP_MESSAGE });
      }
      return reply.code(201).send({ dayBreak: created });
    },
  });

  // DELETE /api/v1/day-breaks/:id — soft delete with a mandatory reason. A correction of a day
  // break is delete + create (D-19); there is no update route.
  app.delete("/:id", {
    schema: {
      tags: ["Zeiterfassung"],
      summary: "Delete a day break with a mandatory reason (soft delete)",
      description:
        "Marks a day-level break as deleted (Issue #80). The row is kept; the audit log records " +
        "the before-values and the reason. Requires time-entry:update; a caller acting on " +
        "someone else's day needs scope over every closed entry of that day.",
      security: [{ bearerAuth: [] }],
    },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      // T-100-09: the body is parsed BEFORE the lookup so a minimal valid body reaches the tenant
      // guard for a foreign or unknown id instead of 400-ing differently.
      const { reason } = deleteBodySchema.parse(req.body);
      const tenantId = req.user.tenantId;

      const existing = await app.prisma.dayBreak.findFirst({
        where: { id, deletedAt: null },
        include: { employee: { select: { tenantId: true } } },
      });
      // Folded fetch-then-compare (T-100-09): a foreign tenant's real id and an unknown id answer
      // byte-identically. The audit is nested so it fires only when the row exists — an audit row
      // for an unknown id would reopen the oracle this guard closes.
      if (!existing || existing.employee.tenantId !== tenantId) {
        if (existing) {
          await app.audit({
            userId: req.user.sub,
            action: "CROSS_TENANT_ACCESS_DENIED",
            entity: "DayBreak",
            entityId: id,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
        }
        return reply.code(404).send({ error: BREAK_NOT_FOUND_MESSAGE });
      }

      if (!(await resolveActingReach(req, reply, existing.employeeId))) return;

      const dateKey = existing.date.toISOString().slice(0, 10);
      const rows = await authorizeDayAction(app, req, reply, {
        employeeId: existing.employeeId,
        dateKey,
        notFoundMessage: BREAK_NOT_FOUND_MESSAGE,
      });
      if (!rows) return;

      const deletedAt = new Date();
      await app.prisma.$transaction(async (tx) => {
        await tx.dayBreak.update({
          where: { id },
          data: { deletedAt, deletedBy: req.user.sub },
        });
        await app.audit({
          userId: req.user.sub,
          action: "DAY_BREAK_DELETE",
          entity: "DayBreak",
          entityId: id,
          oldValue: dayBreakFacts(existing),
          newValue: { deletedAt, auditReason: reason },
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
          tx,
        });
      });
      return reply.code(204).send();
    },
  });

  // POST /api/v1/day-breaks/acks — a manager who sees the WHOLE day documents that the break of a
  // cross-salon day was "worked through" (D-08). Valid for exactly the day state it was given for:
  // the day's snapshot is stored and a changed day makes the acknowledgement stale (D-17).
  app.post("/acks", {
    schema: {
      tags: ["Zeiterfassung"],
      summary: "Acknowledge a cross-salon break violation of a day",
      description:
        "Documents that the § 4 ArbZG break of a cross-salon day was worked through (Issue #80). " +
        "Only a day with entries in several salons and a break shortfall can be acknowledged; the " +
        "§ 3 daily maximum is never downgraded. The caller needs time-entry:update with scope over " +
        "every closed entry of the day and cannot acknowledge their own day. The day's snapshot is " +
        "stored; once the day changes the acknowledgement is stale. Never writes a time entry.",
      security: [{ bearerAuth: [] }],
    },
    preHandler: requirePermission("time-entry:update:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const body = createAckSchema.parse(req.body);
      const tenantId = req.user.tenantId;

      // A foreign tenant's employee and an unknown id answer identically.
      const employee = await app.prisma.employee.findFirst({
        where: { id: body.employeeId, tenantId },
        select: { id: true },
      });
      if (!employee) {
        return reply.code(404).send({ error: EMPLOYEE_NOT_FOUND_MESSAGE });
      }

      if (body.employeeId === req.user.employeeId) {
        return reply.code(403).send({ error: SELF_ACK_MESSAGE });
      }

      const rows = await authorizeDayAction(app, req, reply, {
        employeeId: body.employeeId,
        dateKey: body.date,
        notFoundMessage: ENTRY_NOT_FOUND_MESSAGE,
      });
      if (!rows) return;

      const date = dayKeyToDate(body.date);
      const dayParams = { tenantId, employeeId: body.employeeId, date };
      const [dayBreaks, acks] = await Promise.all([
        listDayBreaksOfDay(app.prisma, dayParams),
        listAcksOfDay(app.prisma, dayParams),
      ]);
      const evaluation = evaluateDayBreaks({
        rows,
        dayBreaks,
        acks: acks.map((a) => ({ snapshot: a.snapshot })),
      });
      // D-18: a same-salon day, a day without a § 4 shortfall and a pure § 3 day are not
      // acknowledgeable. The § 3 finding is built from the day sum alone and never waived.
      if (!evaluation.crossSalon || !evaluation.breakShortfall) {
        return reply.code(409).send({ error: NO_VIOLATION_MESSAGE });
      }
      if (evaluation.acknowledged) {
        return reply.code(409).send({ error: ALREADY_ACKED_MESSAGE });
      }

      const created = await app.prisma.$transaction(async (tx) => {
        // Serialise concurrent acknowledgements of the same employee and day so two requests
        // cannot both store a current acknowledgement.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`day-break-ack:${body.employeeId}:${body.date}`}))`;
        const stored = await listAcksOfDay(tx, dayParams);
        if (stored.some((a) => isAckSnapshotCurrent(a.snapshot, evaluation.snapshot))) return null;

        const row = await tx.dayBreakAck.create({
          data: {
            employeeId: body.employeeId,
            date,
            reason: body.reason,
            snapshot: evaluation.snapshot as unknown as Prisma.InputJsonValue,
            acknowledgedBy: req.user.sub,
          },
        });
        await app.audit({
          userId: req.user.sub,
          action: "DAY_BREAK_ACK",
          entity: "DayBreakAck",
          entityId: row.id,
          newValue: ackFacts(row),
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
          tx,
        });
        return row;
      });
      if (!created) {
        return reply.code(409).send({ error: ALREADY_ACKED_MESSAGE });
      }
      return reply.code(201).send({ acknowledgement: created });
    },
  });

  // DELETE /api/v1/day-breaks/acks/:id — revoke an acknowledgement: soft delete with a mandatory
  // reason. Once revoked the violation counts again. There is no update route.
  app.delete("/acks/:id", {
    schema: {
      tags: ["Zeiterfassung"],
      summary: "Revoke an acknowledgement of a cross-salon break violation (soft delete)",
      description:
        "Marks an acknowledgement as revoked (Issue #80). The row is kept; the audit log records " +
        "the before-values and the reason, and the day's § 4 finding counts again. Requires " +
        "time-entry:update with scope over every closed entry of the day; the acknowledgement of " +
        "one's own day cannot be revoked by oneself.",
      security: [{ bearerAuth: [] }],
    },
    preHandler: requirePermission("time-entry:update:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      // T-100-09: the body is parsed BEFORE the lookup so a minimal valid body reaches the tenant
      // guard for a foreign or unknown id instead of 400-ing differently.
      const { reason } = deleteBodySchema.parse(req.body);
      const tenantId = req.user.tenantId;

      const existing = await app.prisma.dayBreakAck.findFirst({
        where: { id, deletedAt: null },
        include: { employee: { select: { tenantId: true } } },
      });
      // Folded fetch-then-compare (T-100-09): a foreign tenant's real id and an unknown id answer
      // byte-identically. The audit is nested so it fires only when the row exists — an audit row
      // for an unknown id would reopen the oracle this guard closes.
      if (!existing || existing.employee.tenantId !== tenantId) {
        if (existing) {
          await app.audit({
            userId: req.user.sub,
            action: "CROSS_TENANT_ACCESS_DENIED",
            entity: "DayBreakAck",
            entityId: id,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
        }
        return reply.code(404).send({ error: ACK_NOT_FOUND_MESSAGE });
      }

      if (existing.employeeId === req.user.employeeId) {
        return reply.code(403).send({ error: SELF_ACK_MESSAGE });
      }

      // An acknowledgement outside the caller's day-wide scope answers the SAME 404 as an unknown
      // id, so scope does not become an existence oracle for acknowledgements (T-100-09).
      const rows = await authorizeDayAction(app, req, reply, {
        employeeId: existing.employeeId,
        dateKey: existing.date.toISOString().slice(0, 10),
        notFoundMessage: ACK_NOT_FOUND_MESSAGE,
      });
      if (!rows) return;

      const deletedAt = new Date();
      await app.prisma.$transaction(async (tx) => {
        await tx.dayBreakAck.update({
          where: { id },
          data: { deletedAt, deletedBy: req.user.sub },
        });
        await app.audit({
          userId: req.user.sub,
          action: "DAY_BREAK_ACK_REVOKE",
          entity: "DayBreakAck",
          entityId: id,
          oldValue: ackFacts(existing),
          newValue: { deletedAt, auditReason: reason },
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
          tx,
        });
      });
      return reply.code(204).send();
    },
  });

  // GET /api/v1/day-breaks/checks — the server-computed day check of one employee over a period,
  // redacted by the caller's reach (D-11, D-20). The ONE read endpoint of every UI place: a
  // salon-scoped manager's own entry list is partial, so a client-side sum would under-report the
  // day.
  app.get("/checks", {
    schema: {
      tags: ["Zeiterfassung"],
      summary: "Day-level break checks of one employee over a period",
      description:
        "Returns the server-computed check of every day with two or more closed WORK entries of " +
        "the employee (Issue #80); at most 62 days per request, read only. The employee and a " +
        "caller whose read scope covers every entry of the day receive the full detail (entries " +
        "with salon, gaps, day breaks, acknowledgement). A caller whose scope covers only part of " +
        "the day receives the day totals and the finding only - never a time, salon or id of an " +
        "entry outside their scope; a day none of whose entries is in scope is omitted. The gaps " +
        "are the day-break kernel's own gap list. maxDailyExceeded compares the day's net working " +
        "time of these entries only (no Berufsschule credit) against the § 3 ArbZG cap of 10 h.",
      security: [{ bearerAuth: [] }],
    },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      // Authorization mirrors GET /time-entries/summary: no time-entry:read reach at all is a 403
      // before anything else is looked at.
      const readReach = await permissionReach(req, "time-entry:read");
      if (readReach === null) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const q = checksQuerySchema.parse(req.query);

      // #368 rule: an EIGENE caller naming another employee is a 403.
      const isOwnDay = q.employeeId === req.user.employeeId;
      if (readReach !== "ZUGEWIESEN" && !isOwnDay) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const fromDate = dayKeyToDate(q.from);
      const toDate = dayKeyToDate(q.to);
      if (fromDate.getTime() > toDate.getTime()) {
        return reply.code(400).send({ error: "Startdatum darf nicht nach dem Enddatum liegen" });
      }
      const inclusiveDays = (toDate.getTime() - fromDate.getTime()) / 86_400_000 + 1;
      if (inclusiveDays > CHECKS_MAX_RANGE_DAYS) {
        return reply.code(400).send({ error: "Der Zeitraum darf höchstens 62 Tage umfassen" });
      }

      // A foreign tenant's employee and an unknown id answer identically.
      const tenantId = req.user.tenantId;
      const employeeId = q.employeeId;
      const employee = await app.prisma.employee.findFirst({
        where: { id: employeeId, tenantId },
        select: { id: true },
      });
      if (!employee) {
        return reply.code(404).send({ error: EMPLOYEE_NOT_FOUND_MESSAGE });
      }

      const access = accessContextFromRequest(req);
      const rows = await closedWorkRowsInRange(
        app.prisma,
        employeeScopeFor(access, { employeeId }),
        fromDate,
        toDate,
      );

      // Group by calendar day (the @db.Date column is the UTC-midnight key) and keep the days with
      // two or more closed WORK entries; a single-entry range stops here without a further query
      // (80-AC6).
      type CheckRow = DayBreakRow & { date: Date; employeeId: string; isLocked: boolean };
      const byDay = new Map<string, CheckRow[]>();
      for (const r of rows) {
        // The range read selects closed entries only; the guard narrows the nullable column.
        if (r.endTime === null) continue;
        const key = r.date.toISOString().slice(0, 10);
        const checkRow: CheckRow = { ...r, endTime: r.endTime };
        const list = byDay.get(key);
        if (list) list.push(checkRow);
        else byDay.set(key, [checkRow]);
      }
      const multiEntryDays = [...byDay.entries()]
        .filter(([, dayRows]) => dayRows.length >= 2)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const result = { employeeId, from: q.from, to: q.to };
      if (multiEntryDays.length === 0) {
        return { ...result, days: [] };
      }

      const { dayBreaks, acks } = await loadDayBreakDataForDays(app.prisma, {
        tenantId,
        employeeIds: [employeeId],
        from: fromDate,
        to: toDate,
      });

      const tz = await getTenantTimezone(app.prisma, tenantId);
      const monthClosed = new Map<string, boolean>();

      // What the caller may do to a day, in the terms of the write routes (T-80-54): the same
      // permission and the same day-wide coverage those routes enforce. The routes decide
      // independently; these flags only stop the UI from offering an action that would be refused.
      const updateReach = await permissionReach(req, "time-entry:update");
      // The read reach decides how much of someone else's day the caller sees (D-11); the update
      // reach decides whether they may write to it (D-13).
      const readScope = isOwnDay
        ? null
        : await resolveAccessReach(app.prisma, access, "time-entry:read:ZUGEWIESEN");
      const updateScope =
        !isOwnDay && updateReach === "ZUGEWIESEN"
          ? await resolveAccessReach(app.prisma, access, "time-entry:update:ZUGEWIESEN")
          : null;

      const days: Array<ReturnType<typeof fullDayCheck> | ReturnType<typeof redactedDayCheck>> = [];
      for (const [dateKey, unsortedRows] of multiEntryDays) {
        const dayDate = dayKeyToDate(dateKey);
        const coverageFacts = unsortedRows.map((r) => ({
          salonId: r.salonId,
          employeeId,
          date: r.date,
        }));
        // The employee sees the own day completely; for anyone else the day is as visible as the
        // read scope covers its entries: all -> full, part of them -> redacted, none -> absent.
        const readCoverage = readScope
          ? await dayCoverage(app.prisma, tenantId, readScope, coverageFacts)
          : "all";
        if (readCoverage === "none") continue;

        const dayRows = [...unsortedRows].sort(
          (a, b) => a.startTime.getTime() - b.startTime.getTime() || a.id.localeCompare(b.id),
        );
        const dayBreaksOfDay = dayBreaks.filter((b) => b.date.getTime() === dayDate.getTime());
        const acksOfDay = acks.filter((a) => a.date.getTime() === dayDate.getTime());
        const evaluation = evaluateDayBreaks({
          rows: dayRows,
          dayBreaks: dayBreaksOfDay,
          acks: acksOfDay.map((a) => ({ snapshot: a.snapshot })),
        });

        const monthKey = dateKey.slice(0, 7);
        let closed = monthClosed.get(monthKey);
        if (closed === undefined) {
          const [year, month] = dateKey.split("-").map(Number);
          const { start: monthStart } = monthRangeUtc(year, month, tz);
          closed = await isMonthClosed(app.prisma, employeeId, tenantId, monthStart);
          monthClosed.set(monthKey, closed);
        }
        const locked = closed || dayRows.some((r) => r.isLocked);

        if (readCoverage === "partial") {
          days.push(redactedDayCheck(dateKey, evaluation, locked));
          continue;
        }

        // Write offers (full detail only). The own day is never acknowledged (D-14); another
        // employee's day needs the update reach over EVERY entry of the day (D-13), the rule
        // `authorizeDayAction` applies on the write routes.
        const hasGap = evaluation.gaps.length > 0;
        let mayAcknowledge = false;
        let mayRecordDayBreak = false;
        if (!locked) {
          if (isOwnDay) {
            mayRecordDayBreak = updateReach !== null && hasGap;
          } else if (updateScope) {
            const updateCoverage = await dayCoverage(
              app.prisma,
              tenantId,
              updateScope,
              coverageFacts,
            );
            if (updateCoverage === "all") {
              mayRecordDayBreak = hasGap;
              // D-18: only a cross-salon day with a § 4 shortfall can be acknowledged (and an
              // acknowledged day stays revocable - its shortfall does not go away).
              mayAcknowledge = evaluation.crossSalon && evaluation.breakShortfall;
            }
          }
        }

        const currentAck = evaluation.acknowledged
          ? acksOfDay.filter((a) => isAckSnapshotCurrent(a.snapshot, evaluation.snapshot)).at(-1)
          : undefined;
        days.push(
          fullDayCheck({
            dateKey,
            evaluation,
            locked,
            mayAcknowledge,
            mayRecordDayBreak,
            currentAck,
            dayRows,
            dayBreaksOfDay,
          }),
        );
      }
      return { ...result, days };
    },
  });
}
