import { FastifyInstance } from "fastify";
import { z } from "zod";
import { fromZonedTime } from "date-fns-tz";
import { requireAuth, requireRole } from "../middleware/auth";
import { checkArbZG, ArbZGWarning } from "../utils/arbzg";
import { checkJArbSchG } from "../utils/jarbschg";
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
    // `.nullable()` matches leave.ts:108's equivalent field: the review modal
    // sends explicit `reviewNote: null` (not an omitted key) when the comment
    // textarea is empty — see submitRetroReview() in
    // apps/web/src/routes/(app)/inbox/+page.svelte.
    reviewNote: z.string().optional().nullable(),
    // Phase 96 (RETRO-16/D-10) — manager edit-on-approve: optional corrected times,
    // written onto the coupled entry when supplied on an APPROVED coupled (entry-first)
    // request. Ignored for REJECTED and for legacy (uncoupled/grant-first) requests.
    startTime: z.string().regex(HHMM_REGEX, "Ungültige Uhrzeit (Format HH:MM).").optional(),
    endTime: z.string().regex(HHMM_REGEX, "Ungültige Uhrzeit (Format HH:MM).").optional(),
    breakMinutes: z.number().int().min(0).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.status === "REJECTED" && !data.reviewNote?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reviewNote"],
        message: "Bitte gib eine Begründung an (revisionssicherheitspflichtig).",
      });
    }
    if (
      data.startTime &&
      data.endTime &&
      hhmmToMinutes(data.endTime) <= hhmmToMinutes(data.startTime)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endTime"],
        message: "Ende muss nach dem Beginn liegen.",
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

      // ── Phase 96 (RETRO-11/12) — coupled entry-first release/reject ───────────
      // Only applies when this request has a coupled TimeEntry (entry-first flow,
      // 96-02 Task 1) that is not itself soft-deleted. Legacy grant-first requests
      // (no coupled entry, D-12) fall through to the unchanged behavior below.
      // Inserted strictly AFTER the C3-a/C3-b self-approval block + role check
      // above (never before — Elevation-of-Privilege guard, RETRO-13).
      const coupledEntry =
        existing.timeEntry && !existing.timeEntry.deletedAt ? existing.timeEntry : null;

      if (coupledEntry && coupledEntry.isLocked) {
        // D-09: locked months stay immutable — explicit 403 for BOTH approve AND
        // reject decisions on a coupled entry (mirrors time-entries.ts's
        // `if (existing.isLocked) return reply.code(403)...` idiom), NOT leave.ts's
        // silent isLocked:false-in-WHERE updateMany, which would silently no-op
        // instead of surfacing an error. Runs before any write (RETRO-18).
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
      // Phase 96-review (WR-02) — populated only on the manager-corrected-times
      // approve branch below; folded into the response so the manager sees the
      // same §3/§4/§5 ArbZG feedback a PUT with these times would surface.
      let approveWarnings: ArbZGWarning[] | undefined;

      if (coupledEntry && body.status === "APPROVED") {
        // Phase 96 (RETRO-16/D-10) — manager edit-on-approve: when the reviewer
        // supplies corrected times, they are written onto the coupled entry in the
        // SAME transaction as the release. Audited against the entry's AS-SUBMITTED
        // values (research Open Q3), mirroring PUT's existing MANAGER_CORRECTION
        // pattern. The request's own proposed-times fields are left untouched — they
        // remain the historical record of what the employee originally asked for.
        // "HH:MM" -> Date uses the same tz-derivation as the CSV import path
        // (imports.ts:214-215): fromZonedTime(`${dateStr}T${hhmm}:00`, tz).
        const hasManagerCorrection =
          body.startTime !== undefined ||
          body.endTime !== undefined ||
          body.breakMinutes !== undefined;
        let correctedFields: { startTime?: Date; endTime?: Date | null; breakMinutes?: number } =
          {};
        // Phase 96-review (WR-02) — carries the JArbSchG soft-warn (if any) out of the
        // block below so it can be folded into checkArbZG's warnings after the tx commits.
        let correctionSoftWarn:
          | NonNullable<Awaited<ReturnType<typeof checkJArbSchG>>["softWarn"]>
          | undefined;
        if (hasManagerCorrection) {
          const correctedStart = body.startTime
            ? fromZonedTime(`${targetDateStr}T${body.startTime}:00`, tz)
            : coupledEntry.startTime;
          const correctedEnd = body.endTime
            ? fromZonedTime(`${targetDateStr}T${body.endTime}:00`, tz)
            : coupledEntry.endTime;
          if (correctedEnd && correctedEnd <= correctedStart) {
            return reply.code(400).send({ error: "Endzeit muss nach der Startzeit liegen" });
          }
          correctedFields = {
            startTime: correctedStart,
            endTime: correctedEnd,
            breakMinutes: body.breakMinutes ?? coupledEntry.breakMinutes,
          };

          // Phase 96-review (WR-02) — manager edit-on-approve writes corrected times
          // straight onto the coupled TimeEntry; it must pass the SAME §9 JArbSchG
          // minor-protection gate POST/PUT enforce on every other time write
          // (time-entries.ts:1167-1176 / :1688-1697) — hard-block BEFORE the
          // $transaction so an illegal correction never reaches the DB.
          const correctedNetWorkMin = correctedEnd
            ? Math.max(
                0,
                Math.round((correctedEnd.getTime() - correctedStart.getTime()) / 60_000) -
                  (correctedFields.breakMinutes ?? 0),
              )
            : 0;
          const jarbSchgApprove = await checkJArbSchG(app.prisma, {
            employeeId: existing.employeeId,
            date: existing.targetDate,
            plannedNetWorkMin: correctedNetWorkMin,
          });
          if (jarbSchgApprove.blocked) {
            return reply
              .code(400)
              .send({ error: "JARBSCHG_MINOR_LIMIT", message: jarbSchgApprove.message });
          }
          correctionSoftWarn = jarbSchgApprove.softWarn;
        }

        // Release the coupled entry atomically with the approval: isInvalid flips
        // false (retroRequestId stays — the audit link is preserved), both
        // mutations audited with before/after values in one transaction.
        const entryIdToRelease = coupledEntry.id;
        try {
          updated = await app.prisma.$transaction(async (tx) => {
            // Phase 96-review (WR-01) — race-safe status guard (mirrors the
            // grant-consumption pattern at time-entries.ts:1197-1203): updateMany
            // with status="PENDING" AND deletedAt=null in the WHERE ensures only
            // ONE concurrent decision — or a race against a concurrent withdraw
            // (DELETE /:id below, which sets deletedAt but leaves status
            // "PENDING" — deletedAt:null must be guarded too, not status alone) —
            // can ever flip this row. The loser's count is 0 and the whole tx
            // rolls back before any TimeEntry write is attempted.
            const decided = await tx.retroEntryRequest.updateMany({
              where: { id, status: "PENDING", deletedAt: null },
              data: {
                status: body.status,
                reviewedBy: user.sub,
                reviewedAt: new Date(),
                reviewNote,
              },
            });
            if (decided.count !== 1) {
              throw new Error("RETRO_REQUEST_ALREADY_DECIDED");
            }
            const reqAfter = await tx.retroEntryRequest.findUniqueOrThrow({ where: { id } });
            const entryAfter = await tx.timeEntry.update({
              where: { id: entryIdToRelease },
              data: { isInvalid: false, invalidReason: null, ...correctedFields },
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
              action: hasManagerCorrection ? "MANAGER_CORRECTION" : "UPDATE",
              entity: "TimeEntry",
              entityId: entryIdToRelease,
              oldValue: coupledEntry,
              newValue: entryAfter,
              request: { ip: req.ip, headers: req.headers as Record<string, string> },
            });

            return reqAfter;
          });
        } catch (err) {
          if (err instanceof Error && err.message === "RETRO_REQUEST_ALREADY_DECIDED") {
            return reply.code(409).send({ error: "Antrag kann nicht mehr geändert werden" });
          }
          throw err;
        }

        // Phase 96-review (WR-02) — surface the same §3/§4/§5 ArbZG feedback a PUT
        // with these times would return, now that the correction is committed.
        if (hasManagerCorrection) {
          approveWarnings = await checkArbZG(app.prisma, existing.employeeId, existing.targetDate);
          if (correctionSoftWarn) {
            approveWarnings.push(correctionSoftWarn);
          }
        }

        // Phase 96 (RETRO-16/D-10) — notify the requesting employee of the decision
        // (net-new call site, Pitfall 3: no prior notify wiring existed for
        // RetroEntryRequest).
        // Phase 96-review (WR-03) — wrapped in try/catch (matches the other three
        // notify() sites in this file, e.g. the withdraw-notify loop below): the
        // approve already committed successfully, so a transient notify failure
        // must not surface as a false 500 to the manager.
        if (existing.employee.userId) {
          try {
            await app.notify({
              userId: existing.employee.userId,
              type: "RETRO_ENTRY_DECIDED",
              title: "Zeitnachtrag genehmigt",
              message: `Dein Zeitnachtrag für den ${targetDateStr} wurde genehmigt.`,
              link: `/time-entries?highlight=${entryIdToRelease}`,
              tenantId: user.tenantId,
              relatedType: "TimeEntry",
              relatedId: entryIdToRelease,
            });
          } catch (err) {
            app.log.warn(
              { err, requestId: id },
              "Failed to notify employee of retro-entry approve decision",
            );
          }
        }
      } else if (coupledEntry && body.status === "REJECTED") {
        // Reject: soft-delete the coupled entry (deletedAt set — NEVER
        // prisma.delete(), Revisionssicherheit) + REJECTED + audit, in one
        // transaction. retroRequestId stays set (the audit link is preserved);
        // deletedAt alone drops the row out of every deletedAt:null query
        // (checkArbZG, saldo, the partial unique index), freeing the day for a
        // corrected resubmission. No new enum value — reuses the existing
        // deletedAt soft-delete convention (D-11).
        const entryIdToReject = coupledEntry.id;
        try {
          updated = await app.prisma.$transaction(async (tx) => {
            // Phase 96-review (WR-01) — race-safe status guard, symmetric to the
            // approve branch above: only ONE concurrent decision (or a race against
            // a concurrent withdraw, which sets deletedAt but leaves status
            // "PENDING" — guard both columns) can ever flip this row.
            const decided = await tx.retroEntryRequest.updateMany({
              where: { id, status: "PENDING", deletedAt: null },
              data: {
                status: body.status,
                reviewedBy: user.sub,
                reviewedAt: new Date(),
                reviewNote,
              },
            });
            if (decided.count !== 1) {
              throw new Error("RETRO_REQUEST_ALREADY_DECIDED");
            }
            const reqAfter = await tx.retroEntryRequest.findUniqueOrThrow({ where: { id } });
            const entryAfter = await tx.timeEntry.update({
              where: { id: entryIdToReject },
              data: { deletedAt: new Date() },
            });

            await app.audit({
              tx,
              userId: user.sub,
              action: "RETRO_ENTRY_REJECTED",
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
              action: "DELETE",
              entity: "TimeEntry",
              entityId: entryIdToReject,
              oldValue: coupledEntry,
              newValue: entryAfter,
              request: { ip: req.ip, headers: req.headers as Record<string, string> },
            });

            return reqAfter;
          });
        } catch (err) {
          if (err instanceof Error && err.message === "RETRO_REQUEST_ALREADY_DECIDED") {
            return reply.code(409).send({ error: "Antrag kann nicht mehr geändert werden" });
          }
          throw err;
        }

        // Phase 96 (RETRO-16/D-10) — notify the requesting employee of the decision
        // (net-new call site, Pitfall 3: no prior notify wiring existed for
        // RetroEntryRequest).
        // Phase 96-review (WR-03) — wrapped in try/catch, symmetric to the approve
        // branch above: the reject already committed successfully, so a transient
        // notify failure must not surface as a false 500 to the manager.
        if (existing.employee.userId) {
          try {
            await app.notify({
              userId: existing.employee.userId,
              type: "RETRO_ENTRY_DECIDED",
              title: "Zeitnachtrag abgelehnt",
              message: `Dein Zeitnachtrag für den ${targetDateStr} wurde abgelehnt.`,
              link: `/time-entries?highlight=${entryIdToReject}`,
              tenantId: user.tenantId,
              relatedType: "TimeEntry",
              relatedId: entryIdToReject,
            });
          } catch (err) {
            app.log.warn(
              { err, requestId: id },
              "Failed to notify employee of retro-entry reject decision",
            );
          }
        }
      } else {
        // Phase 96-review (WR-01) — race-safe status guard for the legacy
        // (uncoupled/grant-first) review path too: two concurrent reviewers must
        // not both be able to decide the same request, and a concurrent withdraw
        // (which sets deletedAt but leaves status "PENDING") must also be caught.
        const decidedLegacy = await app.prisma.retroEntryRequest.updateMany({
          where: { id, status: "PENDING", deletedAt: null },
          data: {
            status: body.status,
            reviewedBy: user.sub,
            reviewedAt: new Date(),
            reviewNote,
          },
        });
        if (decidedLegacy.count !== 1) {
          return reply.code(409).send({ error: "Antrag kann nicht mehr geändert werden" });
        }
        updated = await app.prisma.retroEntryRequest.findUniqueOrThrow({ where: { id } });

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
        // Phase 96-review (WR-02) — only present when a manager correction ran
        // checkArbZG (approve-with-corrected-times branch above).
        ...(approveWarnings ? { warnings: approveWarnings } : {}),
      });
    },
  });

  // ── DELETE /:id  — withdraw own PENDING request (RETRO-16 / D-11) ───────────
  // A dedicated endpoint, NOT a reuse of DELETE /time-entries/:id (which would
  // incorrectly re-run the retro-window guard on the coupled entry). Soft-deletes
  // BOTH the request and its coupled TimeEntry — no new RetroEntryStatus enum
  // value; `deletedAt` alone is the withdrawn signal (D-11). Guard order mirrors
  // leave.ts:1501-1521 — tenant (with CROSS_TENANT_ACCESS_DENIED audit) BEFORE
  // ownership BEFORE status BEFORE the locked-month check.
  app.delete("/:id", {
    schema: { tags: ["Retro-Anfragen"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const user = req.user;

      const existing = await app.prisma.retroEntryRequest.findFirst({
        where: { id, deletedAt: null }, // already-withdrawn requests are not-found
        include: {
          employee: { select: { tenantId: true, userId: true, firstName: true, lastName: true } },
          timeEntry: true,
        },
      });
      if (!existing) return reply.code(404).send({ error: "Antrag nicht gefunden" });

      // Tenant isolation — BEFORE ownership (T-96-14), mirrors leave.ts:1511-1521.
      if (existing.employee.tenantId !== user.tenantId) {
        await app.audit({
          userId: user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "RetroEntryRequest",
          entityId: id,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "Antrag nicht gefunden" });
      }

      // Ownership: only the REQUESTING EMPLOYEE may withdraw their own request —
      // managers act via approve/reject, never withdraw (unconditional, no
      // isManager bypass — this is employee self-service, not a correction path).
      if (existing.employeeId !== user.employeeId) {
        return reply.code(403).send({ error: "Kein Zugriff" });
      }

      // Only a PENDING request can be withdrawn.
      if (existing.status !== "PENDING") {
        return reply.code(409).send({ error: "Antrag kann nicht mehr zurückgezogen werden" });
      }

      const coupledEntry =
        existing.timeEntry && !existing.timeEntry.deletedAt ? existing.timeEntry : null;

      // D-09: a locked coupled entry stays immutable — explicit 403 before any write.
      if (coupledEntry?.isLocked) {
        return reply
          .code(403)
          .send({ error: "Eintrag ist gesperrt und kann nicht bearbeitet werden" });
      }

      const now = new Date();
      let reqAfter: Awaited<ReturnType<typeof app.prisma.retroEntryRequest.findUniqueOrThrow>>;
      try {
        reqAfter = await app.prisma.$transaction(async (tx) => {
          // Phase 96-review (WR-01) — race-safe status guard (mirrors PATCH
          // /:id/review above / time-entries.ts:1197-1203): only succeeds if the
          // request is STILL PENDING, so a withdraw racing a concurrent
          // approve/reject can never re-mutate a request the other actor already
          // decided. deletedAt:null is also guarded here (not just status) so two
          // concurrent withdraws on the same request (which never touch status)
          // cannot both "succeed" — only one is the true first mover.
          const withdrawn = await tx.retroEntryRequest.updateMany({
            where: { id, status: "PENDING", deletedAt: null },
            data: { deletedAt: now },
          });
          if (withdrawn.count !== 1) {
            throw new Error("RETRO_REQUEST_ALREADY_DECIDED");
          }
          const updatedRequest = await tx.retroEntryRequest.findUniqueOrThrow({ where: { id } });
          await app.audit({
            tx,
            userId: user.sub,
            action: "RETRO_ENTRY_WITHDRAWN",
            entity: "RetroEntryRequest",
            entityId: id,
            oldValue: existing,
            newValue: updatedRequest,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });

          if (coupledEntry) {
            // Phase 96-review (WR-01) — defense-in-depth: only re-soft-delete the
            // coupled TimeEntry if it is STILL the pre-decision pending row
            // (isInvalid=true, deletedAt=null). The request-status guard above
            // already closes the primary race (a concurrent approve/reject flips
            // status away from PENDING first, so this withdraw would already have
            // thrown above) — this second guard ensures a stale pre-tx
            // `coupledEntry` reference can never silently re-mutate a row a
            // concurrent decision already changed, so an already-released,
            // saldo-counting entry can never vanish behind a stale withdraw.
            const entryWithdrawn = await tx.timeEntry.updateMany({
              where: { id: coupledEntry.id, deletedAt: null, isInvalid: true },
              data: { deletedAt: now },
            });
            if (entryWithdrawn.count !== 1) {
              throw new Error("RETRO_ENTRY_ALREADY_DECIDED");
            }
            const entryAfter = await tx.timeEntry.findUniqueOrThrow({
              where: { id: coupledEntry.id },
            });
            await app.audit({
              tx,
              userId: user.sub,
              action: "DELETE",
              entity: "TimeEntry",
              entityId: coupledEntry.id,
              oldValue: coupledEntry,
              newValue: entryAfter,
              request: { ip: req.ip, headers: req.headers as Record<string, string> },
            });
          }

          return updatedRequest;
        });
      } catch (err) {
        if (
          err instanceof Error &&
          (err.message === "RETRO_REQUEST_ALREADY_DECIDED" ||
            err.message === "RETRO_ENTRY_ALREADY_DECIDED")
        ) {
          return reply.code(409).send({ error: "Antrag kann nicht mehr zurückgezogen werden" });
        }
        throw err;
      }

      // Discretionary: let managers know a pending item is no longer waiting on
      // them (net-new call site, mirrors the BREAK_COMPLIANCE_ALERT manager
      // iteration — skip the actor).
      try {
        const managers = await app.prisma.employee.findMany({
          where: {
            tenantId: user.tenantId,
            user: { isActive: true, role: { in: ["ADMIN", "MANAGER"] } },
          },
          include: { user: { select: { id: true } } },
        });
        for (const mgr of managers) {
          if (mgr.user.id === user.sub) continue; // don't self-notify
          await app.notify({
            userId: mgr.user.id,
            type: "RETRO_ENTRY_WITHDRAWN",
            title: "Zeitnachtrag zurückgezogen",
            message: `${existing.employee.firstName} ${existing.employee.lastName} hat einen Zeitnachtrag-Antrag zurückgezogen.`,
            link: "/inbox",
            tenantId: user.tenantId,
            relatedType: "RetroEntryRequest",
            relatedId: id,
          });
        }
      } catch (err) {
        app.log.warn({ err, requestId: id }, "Failed to notify managers on retro-entry withdraw");
      }

      return reply.code(200).send({
        ...reqAfter,
        targetDate: reqAfter.targetDate.toISOString().split("T")[0],
      });
    },
  });
}
