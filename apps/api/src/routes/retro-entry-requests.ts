import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import { getTenantTimezone, dateStrInTz, todayInTz } from "../utils/timezone";
import { computeEntryAgeInDays } from "../utils/retro-config";

// ── Zod schemas ───────────────────────────────────────────────────────────────

const HHMM_REGEX = /^\d{2}:\d{2}$/;

/** Convert an "HH:MM" string to minutes since midnight. */
function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

const createRetroRequestSchema = z
  .object({
    employeeId: z.string().uuid().optional(), // optional: falls back to req.user.employeeId
    targetDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Ungültiges Datum")
      .refine((s) => !isNaN(new Date(s).getTime()), "Ungültiges Datum"),
    reason: z.string().min(1, "Begründung ist erforderlich (revisionssicherheitspflichtig)."),
    // Proposed worked times — required so the approver can review them.
    startTime: z.string().regex(HHMM_REGEX, "Ungültige Uhrzeit (Format HH:MM)."),
    endTime: z.string().regex(HHMM_REGEX, "Ungültige Uhrzeit (Format HH:MM)."),
    breakMinutes: z.number().int().min(0).optional(),
  })
  .superRefine((data, ctx) => {
    // Same-day: end must be strictly after start.
    if (hhmmToMinutes(data.endTime) <= hhmmToMinutes(data.startTime)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endTime"],
        message: "Ende muss nach dem Beginn liegen.",
      });
    }
  });

const reviewRetroRequestSchema = z
  .object({
    status: z.enum(["APPROVED", "REJECTED"]),
    // Optional on APPROVE, mandatory (min 1) on REJECT — enforced in superRefine.
    reviewNote: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.status === "REJECTED" && !data.reviewNote?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reviewNote"],
        message: "Bitte gib eine Begründung an (revisionssicherheitspflichtig).",
      });
    }
  });

const idParamSchema = z.object({ id: z.string().uuid() });

// ── Routes ────────────────────────────────────────────────────────────────────

export async function retroEntryRequestRoutes(app: FastifyInstance) {
  // ── POST /  — create a RetroEntryRequest ─────────────────────────────────
  app.post("/", {
    schema: { tags: ["Retro-Anfragen"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const body = createRetroRequestSchema.parse(req.body);
      const user = req.user;
      const isManager = ["ADMIN", "MANAGER"].includes(user.role);

      // Resolve target employee: managers may submit for themselves (own empId);
      // employees always submit for themselves.
      const employeeId =
        body.employeeId && isManager ? body.employeeId : (user.employeeId ?? undefined);

      if (!employeeId) {
        return reply.code(400).send({ error: "Mitarbeiter nicht ermittelbar" });
      }

      // Verify employee belongs to this tenant
      const targetEmployee = await app.prisma.employee.findFirst({
        where: { id: employeeId, tenantId: user.tenantId },
        select: { id: true, tenantId: true },
      });
      if (!targetEmployee) {
        return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      }

      const tz = await getTenantTimezone(app.prisma, user.tenantId);
      const todayStr = dateStrInTz(todayInTz(tz), tz);
      const ageInDays = computeEntryAgeInDays(todayStr, body.targetDate);

      // Duplicate-grant guard: reject if PENDING or APPROVED grant already exists
      // for the same (employeeId, targetDate).
      const existing = await app.prisma.retroEntryRequest.findFirst({
        where: {
          employeeId,
          targetDate: new Date(body.targetDate),
          status: { in: ["PENDING", "APPROVED"] },
          deletedAt: null,
        },
        select: { id: true, status: true },
      });
      if (existing) {
        return reply
          .code(409)
          .send({ error: "Es existiert bereits ein offener Antrag für dieses Datum." });
      }

      const request = await app.prisma.retroEntryRequest.create({
        data: {
          employeeId,
          targetDate: new Date(body.targetDate),
          reason: body.reason,
          startTime: body.startTime,
          endTime: body.endTime,
          breakMinutes: body.breakMinutes ?? null,
          status: "PENDING",
        },
      });

      await app.audit({
        userId: user.sub,
        action: "RETRO_ENTRY_REQUESTED",
        entity: "RetroEntryRequest",
        entityId: request.id,
        newValue: {
          employeeId,
          targetDate: body.targetDate,
          ageInDays,
          reason: body.reason,
          startTime: body.startTime,
          endTime: body.endTime,
          breakMinutes: body.breakMinutes ?? null,
          requesterId: user.sub,
        },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return reply.code(201).send({
        ...request,
        targetDate: request.targetDate.toISOString().split("T")[0],
        requesterId: user.sub,
      });
    },
  });

  // ── GET /  — list (manager-scoped, tenant-isolated) ──────────────────────
  app.get("/", {
    schema: { tags: ["Retro-Anfragen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req) => {
      const user = req.user;
      const { status } = req.query as { status?: string };

      const rows = await app.prisma.retroEntryRequest.findMany({
        where: {
          deletedAt: null,
          employee: { tenantId: user.tenantId },
          ...(status ? { status: status as "PENDING" | "APPROVED" | "REJECTED" | "USED" } : {}),
        },
        include: {
          employee: { select: { firstName: true, lastName: true } },
        },
        orderBy: { createdAt: "desc" },
      });

      // Compute the age of the backdated day (targetDate → today) per row so the
      // inbox can render "X Tage" instead of "?". Tenant-TZ, DST-safe (same as
      // POST/review). One TZ lookup for the whole list.
      const tz = await getTenantTimezone(app.prisma, user.tenantId);
      const todayStr = dateStrInTz(todayInTz(tz), tz);

      return rows.map((r) => {
        const targetDateStr = r.targetDate.toISOString().split("T")[0];
        return {
          ...r,
          targetDate: targetDateStr,
          entryAgeInDays: computeEntryAgeInDays(todayStr, targetDateStr),
        };
      });
    },
  });

  // ── PATCH /:id/review  — approve or reject ────────────────────────────────
  // Uses requireAuth (not requireRole) so the self-approval block fires with the
  // correct German error message even when an EMPLOYEE attempts to approve their
  // own request — mirrors the pattern tested by retro-approval-flow.test.ts.
  // Role check is enforced inside the handler after self-approval is evaluated.
  app.patch("/:id/review", {
    schema: { tags: ["Retro-Anfragen"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const body = reviewRetroRequestSchema.parse(req.body);
      const user = req.user;

      const existing = await app.prisma.retroEntryRequest.findFirst({
        where: { id, deletedAt: null },
        include: {
          employee: { select: { tenantId: true, userId: true } },
          timeEntry: true, // Phase 96 (RETRO-11) — coupled entry-first pending entry, if any
        },
      });
      if (!existing) {
        return reply.code(404).send({ error: "Antrag nicht gefunden" });
      }

      // Tenant isolation
      if (existing.employee.tenantId !== user.tenantId) {
        return reply.code(404).send({ error: "Antrag nicht gefunden" });
      }

      // Only PENDING requests can be reviewed
      if (existing.status !== "PENDING") {
        return reply.code(409).send({ error: "Antrag kann nicht mehr geändert werden" });
      }

      // ── 4-eyes: self-approval block — mirror leave.ts:591-612 verbatim ──────
      // C3-a: block if the reviewer IS the requesting employee (by employeeId)
      const reviewerEmployee = await app.prisma.employee.findFirst({
        where: { userId: req.user.sub },
        select: { id: true },
      });
      if (reviewerEmployee && existing.employeeId === reviewerEmployee.id) {
        return reply
          .code(403)
          .send({ error: "Eigene Anträge können nicht selbst genehmigt werden" });
      }

      // C3-b: block if the reviewer IS the target employee's user (second distinctness axis)
      if (existing.employee.userId && req.user.sub === existing.employee.userId) {
        return reply
          .code(403)
          .send({ error: "Eigene Anträge können nicht selbst genehmigt werden" });
      }

      // Role check: only ADMIN and MANAGER may approve/reject
      if (!["ADMIN", "MANAGER"].includes(user.role)) {
        return reply.code(403).send({ error: "Nur Manager oder Admins können Anträge genehmigen" });
      }

      // ── Phase 96 (RETRO-11) — coupled entry-first release ─────────────────────
      // Only applies when this request has a coupled TimeEntry (entry-first flow,
      // 96-02 Task 1) that is not itself soft-deleted. Legacy grant-first requests
      // (no coupled entry, D-12) and REJECT decisions fall through to the
      // unchanged behavior below — reject-side entry cleanup (D-08) is out of
      // scope for this tracer and lands in a later plan. Inserted strictly AFTER
      // the C3-a/C3-b self-approval block + role check above (never before —
      // Elevation-of-Privilege guard, RETRO-13).
      const coupledEntry =
        existing.timeEntry && !existing.timeEntry.deletedAt ? existing.timeEntry : null;

      if (coupledEntry && body.status === "APPROVED" && coupledEntry.isLocked) {
        // D-09: locked months stay immutable — explicit 403 (mirrors
        // time-entries.ts's `if (existing.isLocked) return reply.code(403)...`
        // idiom), NOT leave.ts's silent isLocked:false-in-WHERE updateMany, which
        // would silently no-op instead of surfacing an error.
        return reply
          .code(403)
          .send({ error: "Eintrag ist gesperrt und kann nicht bearbeitet werden" });
      }

      const tz = await getTenantTimezone(app.prisma, user.tenantId);
      const todayStr = dateStrInTz(todayInTz(tz), tz);
      const targetDateStr = existing.targetDate.toISOString().split("T")[0];
      const ageInDays = computeEntryAgeInDays(todayStr, targetDateStr);

      // reviewNote is optional on APPROVE (Zod enforces it on REJECT). Store null
      // when empty/absent so the audit trail records the true absence of a note.
      const reviewNote = body.reviewNote?.trim() ? body.reviewNote : null;

      let updated: Awaited<ReturnType<typeof app.prisma.retroEntryRequest.update>>;

      if (coupledEntry && body.status === "APPROVED") {
        // Release the coupled entry atomically with the approval: isInvalid flips
        // false (retroRequestId stays — the audit link is preserved), both
        // mutations audited with before/after values in one transaction.
        const entryIdToRelease = coupledEntry.id;
        updated = await app.prisma.$transaction(async (tx) => {
          const reqAfter = await tx.retroEntryRequest.update({
            where: { id },
            data: {
              status: body.status,
              reviewedBy: user.sub,
              reviewedAt: new Date(),
              reviewNote,
            },
          });
          const entryAfter = await tx.timeEntry.update({
            where: { id: entryIdToRelease },
            data: { isInvalid: false, invalidReason: null },
          });

          await app.audit({
            tx,
            userId: user.sub,
            action: "RETRO_ENTRY_APPROVED",
            entity: "RetroEntryRequest",
            entityId: id,
            oldValue: existing,
            newValue: {
              ...reqAfter,
              requesterId: existing.employee.userId ?? existing.employeeId,
              approverId: user.sub,
              targetDate: targetDateStr,
              ageInDays,
            },
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
          await app.audit({
            tx,
            userId: user.sub,
            action: "UPDATE",
            entity: "TimeEntry",
            entityId: entryIdToRelease,
            oldValue: coupledEntry,
            newValue: entryAfter,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });

          return reqAfter;
        });
      } else {
        updated = await app.prisma.retroEntryRequest.update({
          where: { id },
          data: {
            status: body.status,
            reviewedBy: user.sub,
            reviewedAt: new Date(),
            reviewNote,
          },
        });

        const action = body.status === "APPROVED" ? "RETRO_ENTRY_APPROVED" : "RETRO_ENTRY_REJECTED";

        await app.audit({
          userId: user.sub,
          action,
          entity: "RetroEntryRequest",
          entityId: id,
          newValue: {
            requesterId: existing.employee.userId ?? existing.employeeId,
            approverId: user.sub,
            targetDate: targetDateStr,
            ageInDays,
            reason: existing.reason,
            reviewNote,
            status: body.status,
          },
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
      }

      return reply.code(200).send({
        ...updated,
        targetDate: updated.targetDate.toISOString().split("T")[0],
      });
    },
  });
}
