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
  resolveAccessReach,
  requirePermission,
  auditReasonSchema,
} from "../../platform";
import { getTenantTimezone, isMonthClosed, monthRangeUtc } from "../../working-time-account";
import {
  evaluateDayBreaks,
  findGapForInterval,
  intervalsOverlap,
  isAckSnapshotCurrent,
} from "../day-break-rule";
import { closedWorkRowsOfDay, listAcksOfDay, listDayBreaksOfDay } from "../day-break-store";
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
}
