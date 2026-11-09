/**
 * Issue #599 — „Korrektur abgeschlossener Monat“ (owner decisions 19.10. and 09.11.2026).
 *
 * A person asks for a correction of a day of a CLOSED month; a different person with
 * `month-correction:approve:ZUGEWIESEN` over them decides it. The closed month, its entries and its
 * `SaldoSnapshot` are never touched. An approval books the decided minutes as a correction in the
 * RUNNING month, in one transaction:
 *   - the journal row (`OvertimeTransaction`, type CORRECTION, referencing the request and the day),
 *   - `correctionMinutes` + `bookingDate` (tenant-local approval day) on the request, which the saldo
 *     core folds in as an account movement (`closeEmployeeMonth`, `accountCorrections`,
 *     `booked-month-corrections.ts`).
 * Like every booking of a day it enters the live saldo from the next day on (#438: today never
 * counts). Open months use the Zeitnachtrag (`RetroEntryRequest`, Zeiterfassung) instead.
 *
 * Rules, each in this file only:
 *   - four eyes: the requester and the person concerned never decide (403, a lock, not a permission);
 *   - reach: Stammsalon at the request's target day (as the Zeitnachtrag); outside → the identical 404;
 *   - no silent booking: a closed running month (409 MONTH_LOCKED) or a contract without a saldo
 *     today — track-only (#494), none (#780) or employment ended (409 CORRECTION_NO_SALDO) — refuses.
 * The suggested minutes (proposed times minus the recorded working time of the day) are a help only,
 * shown within the reader's day-detail reach (#86); the decider sets the booked minutes.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../../middleware/auth";
import {
  hasPermission,
  permissionReach,
  accessContextFromRequest,
  employeeScopeFor,
  resolveAccessReach,
  isStammsalonScopeMatch,
  userIdsHoldingPermission,
  resolveScopedHolderIds,
} from "../../platform";
import {
  getValidWorkedEntriesInRange,
  addWorkingMinutes,
  entryDurations,
} from "../../time-tracking";
import { getTenantTimezone, monthRangeUtc, todayInTz } from "../timezone";
import { getClosedMonthsForDates } from "../facade/saldo-snapshot";
import { resolveMonthContract } from "../close-employee-month";
import { isNoContractSchedule } from "../month-contract";
import { isTrackOnlySchedule } from "../track-only-schedule";
import { updateOvertimeAccount } from "../overtime-balance";
import { dayDetailVisibility } from "./day-detail-visibility";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const NOT_FOUND = { error: "Korrekturanfrage nicht gefunden" } as const;
const MAX_CORRECTION_MINUTES = 24 * 60;

const idParamSchema = z.object({ id: z.string().uuid() });

const createSchema = z
  .object({
    // Only with `month-correction:create:ZUGEWIESEN` (filing on behalf of a person in reach);
    // everyone else always files for themselves.
    employeeId: z.string().uuid().optional(),
    targetDate: z.string().date(),
    startTime: z.string().regex(HHMM).optional(),
    endTime: z.string().regex(HHMM).optional(),
    breakMinutes: z.number().int().min(0).max(720).optional(),
    reason: z.string().trim().min(10).max(1000),
  })
  .strict();

const listQuerySchema = z.object({
  scope: z.enum(["own", "team"]).default("own"),
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"]).optional(),
});

const approveSchema = z
  .object({
    correctionMinutes: z
      .number()
      .int()
      .min(-MAX_CORRECTION_MINUTES)
      .max(MAX_CORRECTION_MINUTES)
      .refine((v) => v !== 0, { message: "Die Korrektur darf nicht 0 Minuten betragen." }),
    reviewNote: z.string().trim().min(3).max(1000),
  })
  .strict();

const rejectSchema = z.object({ reviewNote: z.string().trim().min(3).max(1000) }).strict();

type RequestRow = {
  id: string;
  employeeId: string;
  targetDate: Date;
  startTime: string | null;
  endTime: string | null;
  breakMinutes: number | null;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN";
  requestedByUserId: string;
  reviewedByUserId: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  correctionMinutes: number | null;
  bookingDate: Date | null;
  overtimeTransactionId: string | null;
  createdAt: Date;
  updatedAt: Date;
  employee: { tenantId: string; userId: string; firstName: string; lastName: string };
};

const EMPLOYEE_SELECT = {
  select: { tenantId: true, userId: true, firstName: true, lastName: true },
} as const;

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

function minutesOf(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/** Proposed working minutes from the request's times, `null` without times. */
function proposedWorkingMinutes(r: Pick<RequestRow, "startTime" | "endTime" | "breakMinutes">) {
  if (!r.startTime || !r.endTime) return null;
  // The one working-time kernel (#79), fed with the proposed times on a neutral day.
  return entryDurations({
    startTime: new Date(`1970-01-01T${r.startTime}:00Z`),
    endTime: new Date(`1970-01-01T${r.endTime}:00Z`),
    breakMinutes: r.breakMinutes ?? 0,
  }).workingMinutes;
}

function requestMeta(req: FastifyRequest) {
  return { ip: req.ip, headers: req.headers as Record<string, string> };
}

function auditValue(r: Omit<RequestRow, "employee">) {
  return {
    employeeId: r.employeeId,
    targetDate: day(r.targetDate),
    startTime: r.startTime,
    endTime: r.endTime,
    breakMinutes: r.breakMinutes,
    reason: r.reason,
    status: r.status,
    requestedByUserId: r.requestedByUserId,
    reviewedByUserId: r.reviewedByUserId,
    reviewNote: r.reviewNote,
    correctionMinutes: r.correctionMinutes,
    bookingDate: day(r.bookingDate),
    overtimeTransactionId: r.overtimeTransactionId,
  };
}

/** Is the caller the person concerned or the requester (the four-eyes axes)? */
function isSelf(req: FastifyRequest, r: RequestRow): boolean {
  return (
    req.user.sub === r.employee.userId ||
    req.user.sub === r.requestedByUserId ||
    (req.user.employeeId != null && req.user.employeeId === r.employeeId)
  );
}

export async function monthCorrectionRoutes(app: FastifyInstance) {
  /** Approve reach over the person at the request's target day. */
  async function inApproveReach(req: FastifyRequest, r: RequestRow): Promise<boolean> {
    if (!(await hasPermission(req, "month-correction:approve:ZUGEWIESEN"))) return false;
    const reach = await resolveAccessReach(
      app.prisma,
      accessContextFromRequest(req),
      "month-correction:approve:ZUGEWIESEN",
    );
    return isStammsalonScopeMatch(app.prisma, req.user.tenantId, reach, r.employeeId, r.targetDate);
  }

  /** Read visibility: the own request (EIGENE) or a request in the ZUGEWIESEN read reach. */
  async function canRead(req: FastifyRequest, r: RequestRow): Promise<boolean> {
    if (r.employee.tenantId !== req.user.tenantId) return false;
    if (
      (req.user.sub === r.employee.userId || req.user.sub === r.requestedByUserId) &&
      (await hasPermission(req, "month-correction:read:EIGENE"))
    ) {
      return true;
    }
    if (!(await hasPermission(req, "month-correction:read:ZUGEWIESEN"))) return false;
    const reach = await resolveAccessReach(
      app.prisma,
      accessContextFromRequest(req),
      "month-correction:read:ZUGEWIESEN",
    );
    return isStammsalonScopeMatch(app.prisma, req.user.tenantId, reach, r.employeeId, r.targetDate);
  }

  async function loadRow(req: FastifyRequest, id: string): Promise<RequestRow | null> {
    const row = await app.prisma.monthCorrectionRequest.findFirst({
      where: { id, employee: { tenantId: req.user.tenantId } },
      include: { employee: EMPLOYEE_SELECT },
    });
    return row as RequestRow | null;
  }

  async function serialize(req: FastifyRequest, r: RequestRow, detailed: boolean) {
    const base = {
      id: r.id,
      employeeId: r.employeeId,
      employeeName: `${r.employee.firstName} ${r.employee.lastName}`,
      targetDate: day(r.targetDate),
      startTime: r.startTime,
      endTime: r.endTime,
      breakMinutes: r.breakMinutes,
      reason: r.reason,
      status: r.status,
      isOwn: req.user.sub === r.employee.userId || req.user.sub === r.requestedByUserId,
      reviewedAt: r.reviewedAt,
      reviewNote: r.reviewNote,
      correctionMinutes: r.correctionMinutes,
      bookingDate: day(r.bookingDate),
      overtimeTransactionId: r.overtimeTransactionId,
      createdAt: r.createdAt,
      proposedWorkingMinutes: proposedWorkingMinutes(r),
      canDecide: r.status === "PENDING" && !isSelf(req, r) && (await inApproveReach(req, r)),
      canWithdraw: r.status === "PENDING" && req.user.sub === r.requestedByUserId,
    };
    if (!detailed) return base;
    // #86 — the recorded working time of the day is a day detail: only within the reader's
    // time-entry read reach; counts and the request itself stay visible.
    const covered = await dayDetailVisibility(app, req).coveredAmong([r.employeeId], r.targetDate);
    if (!covered.has(r.employeeId)) {
      return {
        ...base,
        recordedWorkingMinutes: null,
        suggestedCorrectionMinutes: null,
        dayDetailsWithheld: true,
      };
    }
    const entries = await getValidWorkedEntriesInRange(
      app.prisma,
      employeeScopeFor(accessContextFromRequest(req), { employeeId: r.employeeId }),
      r.targetDate,
      r.targetDate,
    );
    const recorded = Math.round(entries.reduce((sum, e) => addWorkingMinutes(sum, e), 0));
    const proposed = base.proposedWorkingMinutes;
    return {
      ...base,
      recordedWorkingMinutes: recorded,
      suggestedCorrectionMinutes: proposed === null ? null : proposed - recorded,
      dayDetailsWithheld: false,
    };
  }

  async function isMonthClosed(employeeId: string, tenantId: string, d: Date, tz: string) {
    const monthStart = monthRangeUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, tz).start;
    const closed = await getClosedMonthsForDates(app.prisma, [employeeId], tenantId, [monthStart]);
    return closed.size > 0;
  }

  // ── POST / — file a request for a day of a closed month ──────────────────────────────────
  app.post("/", {
    schema: { tags: ["Arbeitszeitkonto"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const body = createSchema.parse(req.body);
      const createReach = await permissionReach(req, "month-correction:create");
      if (createReach === null) return reply.code(403).send({ error: "Forbidden" });
      if ((body.startTime === undefined) !== (body.endTime === undefined)) {
        return reply.code(400).send({ error: "Bitte gib Beginn und Ende gemeinsam an." });
      }
      if (body.startTime && body.endTime && minutesOf(body.endTime) <= minutesOf(body.startTime)) {
        return reply.code(400).send({ error: "Das Ende muss nach dem Beginn liegen." });
      }
      const proposed = proposedWorkingMinutes({
        startTime: body.startTime ?? null,
        endTime: body.endTime ?? null,
        breakMinutes: body.breakMinutes ?? null,
      });
      if (proposed !== null && proposed <= 0) {
        return reply.code(400).send({ error: "Die Pause ist länger als die Arbeitszeit." });
      }
      const tenantId = req.user.tenantId;
      const onBehalf =
        body.employeeId !== undefined &&
        createReach === "ZUGEWIESEN" &&
        body.employeeId !== req.user.employeeId;
      const employee = await app.prisma.employee.findFirst({
        where: {
          tenantId,
          ...(onBehalf ? { id: body.employeeId } : { userId: req.user.sub }),
        },
        select: { id: true, hireDate: true, exitDate: true, firstName: true, lastName: true },
      });
      if (!employee) {
        return onBehalf
          ? reply.code(404).send({ error: "Mitarbeiter nicht gefunden" })
          : reply.code(400).send({ error: "Zu deinem Zugang gehört kein Mitarbeiterprofil." });
      }
      if (onBehalf) {
        // Out of reach answers byte-identical to an unknown id, before any other check (#658 rule).
        const reach = await resolveAccessReach(
          app.prisma,
          accessContextFromRequest(req),
          "month-correction:create:ZUGEWIESEN",
        );
        const day0 = new Date(`${body.targetDate}T00:00:00Z`);
        if (!(await isStammsalonScopeMatch(app.prisma, tenantId, reach, employee.id, day0))) {
          return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
        }
      }
      const tz = await getTenantTimezone(app.prisma, tenantId);
      const targetDate = new Date(`${body.targetDate}T00:00:00Z`);
      if (targetDate >= todayInTz(tz)) {
        return reply.code(400).send({ error: "Der Tag muss in der Vergangenheit liegen." });
      }
      const hireDay = new Date(`${employee.hireDate.toISOString().slice(0, 10)}T00:00:00Z`);
      if (targetDate < hireDay || (employee.exitDate && targetDate > employee.exitDate)) {
        return reply.code(400).send({
          error: onBehalf
            ? "An diesem Tag war die Person nicht beschäftigt."
            : "An diesem Tag warst du nicht beschäftigt.",
        });
      }
      if (!(await isMonthClosed(employee.id, tenantId, targetDate, tz))) {
        return reply.code(409).send({
          error:
            "Dieser Monat ist noch nicht abgeschlossen. Nutze dafür einen Zeitnachtrag oder trage die Zeit direkt ein.",
          code: "MONTH_NOT_CLOSED",
        });
      }
      const pending = await app.prisma.monthCorrectionRequest.findFirst({
        where: { employeeId: employee.id, targetDate, status: "PENDING" },
        select: { id: true },
      });
      if (pending) {
        return reply.code(409).send({
          error: "Für diesen Tag wartet schon eine Korrekturanfrage auf Entscheidung.",
          code: "MONTH_CORRECTION_PENDING_EXISTS",
        });
      }

      const created = await app.prisma.$transaction(async (tx) => {
        const row = await tx.monthCorrectionRequest.create({
          data: {
            employeeId: employee.id,
            targetDate,
            startTime: body.startTime ?? null,
            endTime: body.endTime ?? null,
            breakMinutes: body.breakMinutes ?? null,
            reason: body.reason,
            requestedByUserId: req.user.sub,
          },
          include: { employee: EMPLOYEE_SELECT },
        });
        await app.audit({
          tx,
          userId: req.user.sub,
          action: "CREATE",
          entity: "MonthCorrectionRequest",
          entityId: row.id,
          newValue: auditValue(row as RequestRow),
          request: requestMeta(req),
        });
        return row as RequestRow;
      });

      // Reactive (after commit): the deciders within reach of the person at the target day.
      try {
        const holders = await userIdsHoldingPermission(
          app.prisma,
          tenantId,
          "month-correction:approve:ZUGEWIESEN",
        );
        const inScope = await resolveScopedHolderIds(
          app.prisma,
          tenantId,
          holders,
          "month-correction:approve:ZUGEWIESEN",
          (reach) => isStammsalonScopeMatch(app.prisma, tenantId, reach, employee.id, targetDate),
        );
        const recipients = await app.prisma.user.findMany({
          where: { id: { in: inScope }, isActive: true, employee: { tenantId } },
          select: { id: true },
        });
        for (const r of recipients) {
          if (r.id === req.user.sub) continue;
          await app.notify({
            userId: r.id,
            type: "MONTH_CORRECTION_REQUESTED",
            title: "Korrektur für einen abgeschlossenen Monat angefragt",
            message: `${employee.firstName} ${employee.lastName} bittet um eine Korrektur für den ${body.targetDate}.`,
            link: "/inbox",
            tenantId,
            relatedType: "MonthCorrectionRequest",
            relatedId: created.id,
          });
        }
      } catch (err) {
        app.log.warn({ err, requestId: created.id }, "Failed to notify month-correction deciders");
      }

      return reply.code(201).send(await serialize(req, created, true));
    },
  });

  // ── GET / — own requests, or the requests within the read reach ──────────────────────────
  app.get("/", {
    schema: { tags: ["Arbeitszeitkonto"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const query = listQuerySchema.parse(req.query ?? {});
      const tenantId = req.user.tenantId;
      if (query.scope === "own") {
        if (!(await hasPermission(req, "month-correction:read:EIGENE"))) {
          return reply.code(403).send({ error: "Keine Berechtigung" });
        }
        const rows = await app.prisma.monthCorrectionRequest.findMany({
          where: {
            employee: { tenantId, userId: req.user.sub },
            ...(query.status ? { status: query.status } : {}),
          },
          include: { employee: EMPLOYEE_SELECT },
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
          take: 200,
        });
        return Promise.all(rows.map((r) => serialize(req, r as RequestRow, false)));
      }
      if (!(await hasPermission(req, "month-correction:read:ZUGEWIESEN"))) {
        return reply.code(403).send({ error: "Keine Berechtigung" });
      }
      const reach = await resolveAccessReach(
        app.prisma,
        accessContextFromRequest(req),
        "month-correction:read:ZUGEWIESEN",
      );
      const rows = await app.prisma.monthCorrectionRequest.findMany({
        where: { employee: { tenantId }, ...(query.status ? { status: query.status } : {}) },
        include: { employee: EMPLOYEE_SELECT },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: 500,
      });
      const visible: RequestRow[] = [];
      for (const r of rows as RequestRow[]) {
        if (await isStammsalonScopeMatch(app.prisma, tenantId, reach, r.employeeId, r.targetDate)) {
          visible.push(r);
        }
      }
      return Promise.all(visible.map((r) => serialize(req, r, false)));
    },
  });

  // ── GET /:id ──────────────────────────────────────────────────────────────────────────────
  app.get("/:id", {
    schema: { tags: ["Arbeitszeitkonto"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const row = await loadRow(req, id);
      if (!row || !(await canRead(req, row))) return reply.code(404).send(NOT_FOUND);
      return serialize(req, row, true);
    },
  });

  /** The shared gate of approve and reject: 404 / 403 / 409 in the documented order. */
  async function decisionGate(
    req: FastifyRequest,
    id: string,
  ): Promise<{ ok: false; status: 403 | 404 | 409; body: object } | { ok: true; row: RequestRow }> {
    const row = await loadRow(req, id);
    if (!row)
      return {
        ok: false,
        status: 404,
        body: NOT_FOUND,
      };
    if (isSelf(req, row)) {
      return {
        ok: false,
        status: 403,
        body: {
          error: "Eigene Korrekturanfragen kann nur jemand anderes entscheiden.",
          code: "SELF_DECISION_FORBIDDEN",
        },
      };
    }
    if (!(await hasPermission(req, "month-correction:approve:ZUGEWIESEN"))) {
      return {
        ok: false,
        status: 403,
        body: { error: "Keine Berechtigung" },
      };
    }
    if (!(await inApproveReach(req, row))) {
      await app.audit({
        userId: req.user.sub,
        action: "SCOPE_ACCESS_DENIED",
        entity: "MonthCorrectionRequest",
        entityId: id,
        request: requestMeta(req),
      });
      return {
        ok: false,
        status: 404,
        body: NOT_FOUND,
      };
    }
    if (row.status !== "PENDING")
      return {
        ok: false,
        status: 409,
        body: NOT_PENDING,
      };
    return { ok: true, row };
  }

  // ── POST /:id/approve — book the correction in the running month ─────────────────────────
  app.post("/:id/approve", {
    schema: { tags: ["Arbeitszeitkonto"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const body = approveSchema.parse(req.body);
      const gate = await decisionGate(req, id);
      if (!gate.ok) return reply.code(gate.status).send(gate.body);
      const row = gate.row;
      const tenantId = req.user.tenantId;
      const tz = await getTenantTimezone(app.prisma, tenantId);
      const bookingDate = todayInTz(tz);

      if (await isMonthClosed(row.employeeId, tenantId, bookingDate, tz)) {
        return reply.code(409).send({
          error:
            "Der laufende Monat ist schon abgeschlossen. Die Korrektur kann nicht gebucht werden.",
          code: "MONTH_LOCKED",
        });
      }
      const employee = await app.prisma.employee.findFirstOrThrow({
        where: { id: row.employeeId, tenantId },
        select: { exitDate: true },
      });
      const monthEnd = monthRangeUtc(
        bookingDate.getUTCFullYear(),
        bookingDate.getUTCMonth() + 1,
        tz,
      ).end;
      const contract = await resolveMonthContract(app, row.employeeId, monthEnd);
      const noSaldo =
        isNoContractSchedule(contract) ||
        isTrackOnlySchedule({
          type: contract.type,
          overtimeMode: (contract as { overtimeMode?: unknown }).overtimeMode,
          monthlyHours: (contract as { monthlyHours?: unknown }).monthlyHours,
        }) ||
        (employee.exitDate !== null && employee.exitDate < bookingDate);
      if (noSaldo) {
        return reply.code(409).send({
          error:
            "Für diese Person wird im laufenden Monat kein Saldo geführt. Die Korrektur würde nicht wirken; lehne die Anfrage mit einer Begründung ab.",
          code: "CORRECTION_NO_SALDO",
        });
      }

      const hours = Math.round((body.correctionMinutes / 60) * 100) / 100;
      const result = await app.prisma.$transaction(async (tx) => {
        // Row lock: two concurrent decisions on the same request have exactly one winner.
        const [locked] = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT "status"::text AS status FROM "MonthCorrectionRequest" WHERE "id" = ${id} FOR UPDATE
        `;
        if (!locked || locked.status !== "PENDING") return null;
        const account = await tx.overtimeAccount.upsert({
          where: { employeeId: row.employeeId },
          create: { employeeId: row.employeeId, balanceHours: 0 },
          update: {},
          select: { id: true },
        });
        const txn = await tx.overtimeTransaction.create({
          data: {
            overtimeAccountId: account.id,
            hours, // |minutes| >= 1, so at least 0.02 h; the exact minutes live on the request
            type: "CORRECTION",
            description: `Korrektur abgeschlossener Monat: Tag ${day(row.targetDate)}, ${body.correctionMinutes} Minuten (Anfrage ${id})`,
            referenceMonth: day(row.targetDate)!.slice(0, 7),
            createdBy: req.user.sub,
          },
        });
        const updated = await tx.monthCorrectionRequest.update({
          where: { id, employee: { tenantId: req.user.tenantId } },
          data: {
            status: "APPROVED",
            reviewedByUserId: req.user.sub,
            reviewedAt: new Date(),
            reviewNote: body.reviewNote,
            correctionMinutes: body.correctionMinutes,
            bookingDate,
            overtimeTransactionId: txn.id,
          },
          include: { employee: EMPLOYEE_SELECT },
        });
        await app.audit({
          tx,
          userId: req.user.sub,
          action: "UPDATE",
          entity: "MonthCorrectionRequest",
          entityId: id,
          oldValue: auditValue(row),
          newValue: { ...auditValue(updated as RequestRow), decision: "APPROVED" },
          request: requestMeta(req),
        });
        await app.audit({
          tx,
          userId: req.user.sub,
          action: "CREATE",
          entity: "OvertimeTransaction",
          entityId: txn.id,
          newValue: {
            type: "CORRECTION",
            hours: Number(txn.hours),
            minutes: body.correctionMinutes,
            bookingDate: day(bookingDate),
            targetDate: day(row.targetDate),
            monthCorrectionRequestId: id,
          },
          request: requestMeta(req),
        });
        return updated as RequestRow;
      });
      if (!result) return reply.code(409).send(NOT_PENDING);

      // Reactive: refresh the stored balance and tell the person.
      try {
        await updateOvertimeAccount(app, row.employeeId);
      } catch (err) {
        app.log.warn({ err, requestId: id }, "month correction: stored balance refresh failed");
      }
      await notifyDecision(row, "genehmigt");
      return serialize(req, result, true);
    },
  });

  // ── POST /:id/reject ─────────────────────────────────────────────────────────────────────
  app.post("/:id/reject", {
    schema: { tags: ["Arbeitszeitkonto"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const body = rejectSchema.parse(req.body);
      const gate = await decisionGate(req, id);
      if (!gate.ok) return reply.code(gate.status).send(gate.body);
      const row = gate.row;
      const result = await app.prisma.$transaction(async (tx) => {
        const changed = await tx.monthCorrectionRequest.updateMany({
          where: { id, status: "PENDING", employee: { tenantId: req.user.tenantId } },
          data: {
            status: "REJECTED",
            reviewedByUserId: req.user.sub,
            reviewedAt: new Date(),
            reviewNote: body.reviewNote,
          },
        });
        if (changed.count === 0) return null;
        const updated = (await tx.monthCorrectionRequest.findUniqueOrThrow({
          where: { id, employee: { tenantId: req.user.tenantId } },
          include: { employee: EMPLOYEE_SELECT },
        })) as RequestRow;
        await app.audit({
          tx,
          userId: req.user.sub,
          action: "UPDATE",
          entity: "MonthCorrectionRequest",
          entityId: id,
          oldValue: auditValue(row),
          newValue: { ...auditValue(updated), decision: "REJECTED" },
          request: requestMeta(req),
        });
        return updated;
      });
      if (!result) return reply.code(409).send(NOT_PENDING);
      await notifyDecision(row, "abgelehnt");
      return serialize(req, result, true);
    },
  });

  // ── POST /:id/withdraw — the requester takes back an open request ────────────────────────
  app.post("/:id/withdraw", {
    schema: { tags: ["Arbeitszeitkonto"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      if ((await permissionReach(req, "month-correction:create")) === null) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      const row = await loadRow(req, id);
      if (!row || row.requestedByUserId !== req.user.sub) return reply.code(404).send(NOT_FOUND);
      const result = await app.prisma.$transaction(async (tx) => {
        const changed = await tx.monthCorrectionRequest.updateMany({
          where: { id, status: "PENDING", employee: { tenantId: req.user.tenantId } },
          data: { status: "WITHDRAWN" },
        });
        if (changed.count === 0) return null;
        const updated = (await tx.monthCorrectionRequest.findUniqueOrThrow({
          where: { id, employee: { tenantId: req.user.tenantId } },
          include: { employee: EMPLOYEE_SELECT },
        })) as RequestRow;
        await app.audit({
          tx,
          userId: req.user.sub,
          action: "UPDATE",
          entity: "MonthCorrectionRequest",
          entityId: id,
          oldValue: auditValue(row),
          newValue: { ...auditValue(updated), decision: "WITHDRAWN" },
          request: requestMeta(req),
        });
        return updated;
      });
      if (!result) return reply.code(409).send(NOT_PENDING);
      return serialize(req, result, false);
    },
  });

  async function notifyDecision(row: RequestRow, word: "genehmigt" | "abgelehnt") {
    try {
      await app.notify({
        userId: row.employee.userId,
        type: "MONTH_CORRECTION_DECIDED",
        title: `Korrekturanfrage ${word}`,
        message: `Deine Korrekturanfrage für den ${day(row.targetDate)} wurde ${word}.`,
        link: "/time-entries",
        tenantId: row.employee.tenantId,
        relatedType: "MonthCorrectionRequest",
        relatedId: row.id,
      });
    } catch (err) {
      app.log.warn({ err, requestId: row.id }, "Failed to notify month-correction decision");
    }
  }
}

const NOT_PENDING = {
  error: "Diese Korrekturanfrage ist schon entschieden oder zurückgezogen.",
  code: "MONTH_CORRECTION_NOT_PENDING",
} as const;
