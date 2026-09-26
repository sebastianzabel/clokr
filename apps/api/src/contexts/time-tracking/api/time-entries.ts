import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createHash } from "crypto";
import { requireAuth } from "../../../middleware/auth";
import {
  permissionReach,
  requirePermission,
  userIdsHoldingPermission, // Phase 75b Plan 10 (#75), D-16
  accessContextFromRequest, // Phase 91b Plan 03 (#91), D-09/D-14
  resolveAccessReach, // Phase 91b Plan 03 (#91), D-09/D-14
  isTimeEntryInScope, // Phase 91b Plan 03 (#91), D-09/D-14
  scopedTimeEntryIds, // Phase 91b Plan 03 (#91), D-09
  isStammsalonScopeMatch, // Phase 91b Plan 09 (#91), D-10/D-17
  resolveScopedHolderIds, // Phase 91b Plan 09 (#91), D-17
} from "../../platform";
import type { PermissionKey } from "../../platform";
import { TimeEntrySource, Prisma } from "@clokr/db";
import { checkArbZG } from "../arbzg";
import { getEffectiveBreakDuration } from "../break-effective";
import { invalidReasonFields, CLEARED_INVALID_REASON } from "../invalid-reason";
import { buildClockOutDebounceMessage } from "../clock-out-debounce-message"; // Phase 307 Plan 02 (D-03/D-05)
import { resolveEntrySalon } from "../entry-salon"; // Phase 68b (issue #68), D-08/D-10
import { resolveClockEvent } from "../../../services/clock/resolver";
import { resolveActor } from "../../../services/clock/audit-actor";
import type { ClockEvent } from "../../../services/clock/types";
import {
  hasApprovedLeaveOnDate, // Phase 100B Plan 14 — D-05 (index is the public surface, AC-1)
  checkJArbSchG,
  DISPLAY_NAME, // Phase 100b Plan 14 (D-05) — renders hasApprovedLeaveOnDate's code
} from "../../absence"; // Phase 101B (Issue #101, wave 7) — merged from two deep imports
import {
  getRetroEntryWindowDays,
  computeRetroLimitStr,
  computeEntryAgeInDays,
} from "../retro-config"; // Phase 76.29 — RETRO-01 window guard
import { auditReasonSchema, AUDIT_REASON_REQUIRED } from "../../platform"; // Quick 260824-cjd
import {
  getOvertimeAccount, // Phase 100B Plan 06 — W8/W14; Plan 07 — W3 merge, W1
  getTenantTimezone,
  todayInTz,
  dateStrInTz,
  timeStrInTz,
  monthRangeUtc,
  updateOvertimeAccount,
  computeOvertimeBalanceBreakdown,
  computeOvertimeBalanceHours, // Phase 101B (Issue #101, wave 9) — merged in, closing the loop wave 05 deliberately left open
  type OvertimeBalanceBreakdown,
} from "../../working-time-account"; // Phase 101B
// Phase 101B (Issue #101, D-11 Welle time-tracking): checkOverlap/checkOneEntryPerDay/
// validateTimeEntryInvariants/getEffectiveSchedule lifted out of this file into
// ../entry-invariants.ts; the overtime pair lifted into working-time-account/overtime-balance.ts.
// Re-exported below (unchanged) so external deep-import call sites across other contexts and
// tests (none touched by this plan) keep resolving these names from this same path until a
// later wave converts them to import from the owning context's index.ts.
import {
  checkOverlap,
  checkOneEntryPerDay,
  validateTimeEntryInvariants,
  getEffectiveSchedule,
} from "../entry-invariants";

export { validateTimeEntryInvariants, getEffectiveSchedule };
export { updateOvertimeAccount, computeOvertimeBalanceBreakdown, computeOvertimeBalanceHours };
export type { OvertimeBalanceBreakdown };

const nfcPunchSchema = z.object({
  nfcCardId: z.string().min(1),
});

const clockInSchema = z.object({
  employeeId: z.string().uuid().optional(), // optional: Manager kann für andere stempeln
  nfcCardId: z.string().optional(),
  source: z.nativeEnum(TimeEntrySource).default("MANUAL"),
  note: z.string().optional(),
});

// No `breakMinutes` here on purpose (Phase 129, issue #129): the value is derived from the
// entry's Break rows and nothing else. Zod strips unknown keys, so a caller that still sends
// it gets no error — and no effect.
const clockOutSchema = z.object({
  note: z.string().optional(),
});

const breakSlotSchema = z.object({
  startTime: z.string(),
  endTime: z.string(),
});

const manualEntrySchema = z.object({
  employeeId: z.string().uuid().optional(), // optional: fällt auf eigene ID zurück
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((s) => !isNaN(new Date(s).getTime()), "Ungültiges Datum"),
  startTime: z.string().datetime(),
  endTime: z.string().datetime().optional().nullable(),
  breakMinutes: z.number().int().min(0).default(0),
  note: z.string().optional().nullable(),
  source: z.nativeEnum(TimeEntrySource).default("MANUAL"),
  breaks: z.array(breakSlotSchema).optional(),
  grantId: z.string().uuid().optional(), // Phase 76.29 Plan 03: pre-approved RetroEntryRequest id
  reason: z.string().trim().min(1).optional(), // Phase 96 (RETRO-10): entry-first Nachtrag reason
  // Phase 68b (issue #68), D-07/D-10: the place of work, honoured on all three POST branches
  // (plain manual, grant/CORRECTION, pending Zeitnachtrag). `null` is deliberately not accepted —
  // a caller either names a salon or leaves the field out entirely. Validated tenant-scoped and
  // active-only by `resolveEntrySalon`.
  salonId: z.string().uuid().optional(),
});

const idParamSchema = z.object({ id: z.string().uuid() });

// Phase 91 (BREAK-03) — BAG 12.02.2025, 5 AZR 51/24: an automatically inserted break does not
// prove the break was actually taken. `confirm` lets the employee/manager acknowledge it was
// taken; `waive` ("durchgearbeitet") declares no break was taken — time is really worked and
// therefore payable, so it requires NO manager approval (LOCKED Decision 5).
const breakStatusSchema = z.object({
  action: z.enum(["confirm", "waive"]),
  reason: z.string().max(500).optional(), // only meaningful for waive ("durchgearbeitet")
});

const updateEntrySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((s) => !isNaN(new Date(s).getTime()), "Ungültiges Datum")
    .optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional().nullable(),
  breakMinutes: z.number().int().min(0).optional(),
  note: z.string().optional().nullable(),
  type: z.string().optional(),
  breaks: z.array(breakSlotSchema).optional(),
  grantId: z.string().uuid().optional(), // Phase 76.29.1 Plan 02: pre-approved RetroEntryRequest id (PUT retro-correction)
  // Quick 260824-cjd: optional at the Zod layer on purpose — required ONLY when the
  // handler determines putIsCorrectionByManager, which cannot be decided pre-fetch.
  reason: z.string().optional().nullable(),
  // Phase 68b (issue #68), D-12: an entry's salon may be changed. `null` is deliberately not
  // accepted — a caller either names a (possibly unchanged) salon or leaves the field out.
  salonId: z.string().uuid().optional(),
});

// ── Pausen-Minuten aus Break-Slots berechnen ──────────────────────────────────
function calcBreakMinutes(breaks: { startTime: Date; endTime: Date }[]): number {
  return breaks.reduce((sum, b) => sum + (b.endTime.getTime() - b.startTime.getTime()) / 60000, 0);
}

// ── Range/month helpers used by updateOvertimeAccount (MONTHLY_HOURS multi-month) ─

/** True iff `from` and `to` both fall inside the same calendar month in `tz`. */
function sameCalendarMonth(from: Date, to: Date, tz: string): boolean {
  return dateStrInTz(from, tz).slice(0, 7) === dateStrInTz(to, tz).slice(0, 7);
}

/**
 * Split [from, to] (UTC) into one segment per calendar month in `tz`.
 * Returns an array of `{ start, end }` where each segment is the intersection of
 * `[from, to]` with the bounds of one calendar month. Used to compute MONTHLY_HOURS
 * expected/leave/absence minutes per-month so the proration denominator matches the
 * month each segment falls in.
 */
function splitRangeByMonth(from: Date, to: Date, tz: string): Array<{ start: Date; end: Date }> {
  const out: Array<{ start: Date; end: Date }> = [];
  const cursorStr = dateStrInTz(from, tz);
  const [y0, m0] = cursorStr.split("-").map(Number);
  let y = y0;
  let m = m0; // 1-based
  // Safety bound to avoid infinite loops on malformed input
  for (let i = 0; i < 240; i++) {
    const { start: mStart, end: mEnd } = monthRangeUtc(y, m, tz);
    const segStart = from > mStart ? from : mStart;
    const segEnd = to < mEnd ? to : mEnd;
    if (segStart <= segEnd) out.push({ start: segStart, end: segEnd });
    if (mEnd >= to) break;
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

// ── Break-Slot-Validierung ──────────────────────────────────────────────────
function validateBreakSlots(
  breakSlots: { startTime: Date; endTime: Date }[],
  workStart: Date,
  workEnd: Date | null,
): string | null {
  for (const b of breakSlots) {
    if (b.endTime <= b.startTime) {
      return "Pausenende muss nach Pausenbeginn liegen";
    }
    if (workEnd) {
      if (b.startTime < workStart || b.endTime > workEnd) {
        return "Pausen müssen innerhalb der Arbeitszeit liegen";
      }
    } else {
      if (b.startTime < workStart) {
        return "Pausenbeginn darf nicht vor der Startzeit liegen";
      }
    }
  }
  // Check for overlapping breaks
  const sorted = [...breakSlots].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startTime < sorted[i - 1].endTime) {
      return "Pausen dürfen sich nicht überschneiden";
    }
  }
  return null;
}

/**
 * Phase 91b Plan 03 (Issue #91), D-09/D-14 — the single place every single-`TimeEntry`
 * `isOnBehalfOf && reach === "ZUGEWIESEN"` route site (clock-out, PUT/DELETE/:id, revalidate,
 * breaks, break-status) checks salon/person scope on an already-fetched entry row. Returns
 * `true` when the caller may proceed; on `false` it has ALREADY sent the 404 (byte-identical to
 * a non-existent id, T-100-09) and written the `SCOPE_ACCESS_DENIED` audit entry — the caller
 * must `return` immediately without sending anything else.
 */
async function enforceTimeEntryScope(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  entry: { id: string; salonId: string; employeeId: string; date: Date },
  permission: PermissionKey,
  notFoundMessage: string,
): Promise<boolean> {
  const access = accessContextFromRequest(req);
  const scopeReach = await resolveAccessReach(app.prisma, access, permission);
  const inScope = await isTimeEntryInScope(app.prisma, req.user.tenantId, scopeReach, {
    salonId: entry.salonId,
    employeeId: entry.employeeId,
    date: entry.date,
  });
  if (inScope) return true;
  await app.audit({
    userId: req.user.sub,
    action: "SCOPE_ACCESS_DENIED",
    entity: "TimeEntry",
    entityId: entry.id,
    request: { ip: req.ip, headers: req.headers as Record<string, string> },
  });
  reply.code(404).send({ error: notFoundMessage });
  return false;
}

export async function timeEntryRoutes(app: FastifyInstance) {
  // POST /api/v1/time-entries/nfc-punch  (kein JWT – Terminal-Gerät)
  const isTest = process.env.NODE_ENV === "test";
  app.post("/nfc-punch", {
    schema: { tags: ["Zeiterfassung"] },
    config: { rateLimit: { max: isTest ? 1000 : 10, timeWindow: "1 minute" } },
    handler: async (req, reply) => {
      // Phase 76.2 (ARCH-V19-01) Plan 4 — thin adapter. Resolver owns lock + leave check + state
      // machine + audit + cross-source consolidation. Auto-break stays as post-resolution side effect.
      const body = nfcPunchSchema.parse(req.body);

      // Terminal API key auth (NFC-specific — bypasses requireAuth; firmware uses raw Bearer)
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        return reply.code(401).send({ error: "Terminal API Key erforderlich" });
      }
      const rawKey = authHeader.slice(7);
      const keyHash = createHash("sha256").update(rawKey).digest("hex");
      const apiKey = await app.prisma.terminalApiKey.findUnique({ where: { keyHash } });
      if (!apiKey || apiKey.revokedAt) {
        return reply.code(401).send({ error: "Ungültiger oder widerrufener API Key" });
      }
      app.prisma.terminalApiKey
        .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
        .catch((err) => app.log.error({ err }, "Failed to update NFC API key lastUsedAt"));

      // Employee resolution from nfcCardId
      const employee = await app.prisma.employee.findFirst({
        where: { nfcCardId: body.nfcCardId, tenantId: apiKey.tenantId },
        include: { tenant: true, user: true },
      });
      if (!employee) return reply.code(404).send({ error: "Unbekannte Karte" });
      if (!employee.user.isActive) {
        return reply.code(403).send({ error: "Mitarbeiter ist deaktiviert" });
      }

      // Build ClockEvent { intent: 'AUTO' (toggle), source: 'NFC', actor: TERMINAL }
      //
      // RETRO-05 NFC exemption: NFC/terminal punches always create a todayInTz entry via
      // resolveClockEvent and bypass validateTimeEntryInvariants entirely — naturally exempt
      // from the retro-window guard. The terminal cannot inject a historical date; date is
      // always derived from the server clock (todayInTz(tz) below), not from request body.
      const now = new Date();
      const tz = await getTenantTimezone(app.prisma, employee.tenantId);
      const event: ClockEvent = {
        employeeId: employee.id,
        tenantId: employee.tenantId,
        source: "NFC",
        intent: "AUTO",
        timestamp: now,
        date: todayInTz(tz),
        dateStr: dateStrInTz(now, tz),
        actor: { type: "TERMINAL", terminalApiKeyId: apiKey.id },
        // Phase 307 (D-01): not interactive. A second tap on the terminal within the debounce
        // window is exactly the accidental double-tap the guard exists to swallow — that
        // protection is this route's whole reason to exist and stays (CONTEXT.md phase
        // boundary: "der NFC-Doppeltipp-Schutz selbst" is out of scope).
        interactive: false,
      };

      const resolution = await resolveClockEvent(app, event, req);

      if (resolution.kind === "CONFLICT") {
        if (resolution.reason === "LEAVE_APPROVED") {
          return reply.code(409).send({
            error: "§ 8 BUrlG: Heute ist Urlaub genehmigt. Bitte zuerst stornieren.",
            action: "BLOCKED",
            resolution,
          });
        }
        if (resolution.reason === "MONTH_LOCKED") {
          return reply.code(409).send({
            error: "Eintrag ist gesperrt und kann nicht bearbeitet werden",
            resolution,
          });
        }
        if (resolution.reason === "RETRO_PENDING") {
          return reply.code(409).send({
            error: "Für diesen Tag liegt ein offener Zeitnachtrag zur Genehmigung vor.",
            action: "BLOCKED",
            resolution,
          });
        }
        // Phase 68b (issue #68, D-08): the resolver's START branch could not resolve a salon
        // for this employee/day (no assignment and no active tenant default).
        if (resolution.reason === "NO_ACTIVE_SALON") {
          return reply.code(409).send({
            error: "Kein aktiver Salon vorhanden.",
            code: "NO_ACTIVE_SALON",
            resolution,
          });
        }
        return reply.code(409).send({ error: "Konflikt", resolution });
      }

      const getBalance = async () => {
        const account = await getOvertimeAccount(app.prisma, employee.id, employee.tenantId);
        return account ? Number(account.balanceHours) : 0;
      };

      const employeeBlock = {
        firstName: employee.firstName,
        lastName: employee.lastName,
        employeeNumber: employee.employeeNumber,
      };

      if (resolution.kind === "CLOCKED_IN") {
        const balanceHours = await getBalance();
        return reply.code(200).send({
          action: "IN" as const,
          employee: employeeBlock,
          time: now.toISOString(),
          balanceHours,
          resolution,
        });
      }

      // D-02: DEBOUNCE_NOOP — STOP within 60s of START is a double-tap NO-OP; return 200.
      // Phase 307 Plan 02: deliberately UNCHANGED by the DEBOUNCE_NOOP -> 409 flip on
      // `/:id/clock-out` below. A terminal double-tap is not a user error and must not surface
      // one; this route is the one genuinely non-interactive caller of `resolveClockEvent`
      // (Phase 307 Plan 01 Task 1 proved no NFC-terminal path reaches `/:id/clock-out` at all).
      if (resolution.kind === "DEBOUNCE_NOOP") {
        return reply.code(200).send({
          action: "NOOP" as const,
          employee: employeeBlock,
          time: now.toISOString(),
          resolution,
        });
      }

      if (resolution.kind !== "CLOCKED_OUT" && resolution.kind !== "CONSOLIDATED") {
        app.log.error({ resolution }, "nfc_punch_unexpected_resolution_kind");
        return reply.code(500).send({ error: "Interner Serverfehler" });
      }

      // CLOCKED_OUT or CONSOLIDATED — post-resolution side effects (auto-break — Phase 64 preserved)
      const clockedOutEntryId = resolution.entry.id;
      // D-01 Pitfall 1 guard (aligned with clock-out route): skip auto-break when Break records
      // already exist. A reopened entry carries a gap Break — auto-break must not overwrite it.
      // Use count (not findMany+sum) to match the clock-out route guard at line ~635.
      const existingBreakCount = await app.prisma.break.count({
        where: { timeEntryId: clockedOutEntryId },
      });
      if (existingBreakCount === 0) {
        const tenantConfig = await app.prisma.tenantConfig.findUnique({
          where: { tenantId: employee.tenantId },
        });
        if (tenantConfig?.autoBreakEnabled) {
          const entryForBreak = await app.prisma.timeEntry.findUnique({
            where: { id: clockedOutEntryId },
          });
          if (entryForBreak?.startTime && entryForBreak?.endTime) {
            const workDurationMin =
              (entryForBreak.endTime.getTime() - entryForBreak.startTime.getTime()) / 60000;
            const employeeBreakFields = await app.prisma.employee.findUnique({
              where: { id: entryForBreak.employeeId },
              select: { breakOver6hOverride: true, breakOver9hOverride: true },
            });
            const autoBreakMin = getEffectiveBreakDuration(
              employeeBreakFields ?? { breakOver6hOverride: null, breakOver9hOverride: null },
              tenantConfig,
              workDurationMin,
            );
            if (autoBreakMin > 0) {
              let breakStartTime: Date;
              if (tenantConfig.defaultBreakStart) {
                const [hh, mm] = tenantConfig.defaultBreakStart.split(":").map(Number);
                breakStartTime = new Date(entryForBreak.startTime);
                breakStartTime.setHours(hh, mm, 0, 0);
                if (
                  breakStartTime <= entryForBreak.startTime ||
                  breakStartTime >= entryForBreak.endTime
                ) {
                  const midMs =
                    entryForBreak.startTime.getTime() +
                    (entryForBreak.endTime.getTime() - entryForBreak.startTime.getTime()) / 2;
                  breakStartTime = new Date(midMs - (autoBreakMin / 2) * 60000);
                }
              } else {
                const midMs =
                  entryForBreak.startTime.getTime() +
                  (entryForBreak.endTime.getTime() - entryForBreak.startTime.getTime()) / 2;
                breakStartTime = new Date(midMs - (autoBreakMin / 2) * 60000);
              }
              const breakEndTime = new Date(breakStartTime.getTime() + autoBreakMin * 60000);
              await app.prisma.break.create({
                data: {
                  timeEntryId: clockedOutEntryId,
                  startTime: breakStartTime,
                  endTime: breakEndTime,
                },
              });
              // Phase 91 (BREAK-02): Pflichtpause auto-inserted → mark AUTO for confirmation
              await app.prisma.timeEntry.update({
                where: { id: clockedOutEntryId },
                data: { breakMinutes: autoBreakMin, breakStatus: "AUTO" },
              });
            }
          }
        }
      }

      await updateOvertimeAccount(app, employee.id);
      const balanceHours = await getBalance();
      return reply.code(200).send({
        action: "OUT" as const,
        employee: employeeBlock,
        time: now.toISOString(),
        balanceHours,
        resolution,
      });
    },
  });

  // POST /api/v1/time-entries/clock-in
  app.post("/clock-in", {
    schema: { tags: ["Zeiterfassung"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      // Phase 76.2 (ARCH-V19-01) Plan 2 — thin adapter. Resolver owns lock + BUrlG + state machine + audit + consolidation.
      const body = clockInSchema.parse(req.body);
      const user = req.user;
      let employeeId = body.employeeId ?? user.employeeId;
      if (body.nfcCardId) {
        // #225: nfcCardId is globally @unique, not per tenant. An unscoped lookup here
        // acted as an existence oracle — an unknown card and a foreign tenant's real card
        // produced two distinct error messages ("NFC Karte nicht gefunden" vs. the later
        // cross-tenant "Mitarbeiter nicht gefunden"), letting a caller probe whether a card
        // exists anywhere in the system. Scoping to the caller's tenant collapses both cases
        // to the same "NFC Karte nicht gefunden" response. The later tenantId comparison
        // below stays intact — it still guards the body.employeeId path.
        const emp = await app.prisma.employee.findFirst({
          where: { nfcCardId: body.nfcCardId, tenantId: req.user.tenantId },
        });
        if (!emp) return reply.code(404).send({ error: "NFC Karte nicht gefunden" });
        employeeId = emp.id;
      }
      if (!employeeId) return reply.code(400).send({ error: "Mitarbeiter nicht gefunden" });
      // D-04: only a caller holding time-entry:create:ZUGEWIESEN may clock in on behalf of
      // others; the self path still requires at least time-entry:create:EIGENE (issue #75, D-13).
      // Issue #358: judged on the RESOLVED employeeId, not `body.employeeId` alone — a caller can
      // reach a colleague's record just as well via `body.nfcCardId` (a physically readable UID),
      // and the nfcCardId branch above already overwrote `employeeId` with that colleague's id.
      const isOnBehalfOf = employeeId !== user.employeeId;
      const timeEntryCreateReach = await permissionReach(req, "time-entry:create");
      if (isOnBehalfOf && timeEntryCreateReach !== "ZUGEWIESEN") {
        return reply.code(403).send({ error: "Forbidden" });
      }
      if (timeEntryCreateReach === null) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      const employeeRecord = await app.prisma.employee.findUnique({
        where: { id: employeeId },
        include: { user: true },
      });
      if (!employeeRecord) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      // D-02/D-07: Reject cross-tenant access and emit security audit event (fetch-then-compare per D-02)
      if (employeeRecord.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "Employee",
          entityId: employeeId!,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      }
      if (!employeeRecord.user.isActive) {
        return reply.code(403).send({ error: "Mitarbeiter ist deaktiviert" });
      }
      const now = new Date();
      const tz = await getTenantTimezone(app.prisma, employeeRecord.tenantId);
      const event: ClockEvent = {
        employeeId,
        tenantId: employeeRecord.tenantId,
        source: body.source,
        intent: "IN",
        timestamp: now,
        date: todayInTz(tz),
        dateStr: dateStrInTz(now, tz),
        note: body.note,
        actor: resolveActor(req),
        // Phase 307 (D-01): interactive. Currently inert — `decide()` (state-machine.ts) never
        // returns STOP for `intent: "IN"`, so the debounce guard is never consulted here — but
        // the field names the CALLER'S CHANNEL, not today's effect; a silent construction site
        // here would quietly lie the moment that ever changes.
        interactive: true,
      };
      const resolution = await resolveClockEvent(app, event, req);
      if (resolution.kind === "CLOCKED_IN") {
        return reply.code(200).send({ resolution, audit: resolution.audit });
      }
      if (resolution.kind === "CONFLICT") {
        if (resolution.reason === "ALREADY_CLOCKED_IN") {
          return reply.code(409).send({ error: "Bereits eingestempelt", resolution });
        }
        if (resolution.reason === "LEAVE_APPROVED") {
          return reply.code(409).send({
            error: "§ 8 BUrlG: Heute ist Urlaub genehmigt. Bitte zuerst stornieren.",
            resolution,
          });
        }
        if (resolution.reason === "MONTH_LOCKED") {
          return reply
            .code(409)
            .send({ error: "Eintrag ist gesperrt und kann nicht bearbeitet werden", resolution });
        }
        if (resolution.reason === "RETRO_PENDING") {
          return reply.code(409).send({
            error: "Für diesen Tag liegt ein offener Zeitnachtrag zur Genehmigung vor.",
            resolution,
          });
        }
        // Phase 68b (issue #68, D-08): the resolver's START branch could not resolve a salon
        // for this employee/day (no assignment and no active tenant default).
        if (resolution.reason === "NO_ACTIVE_SALON") {
          return reply.code(409).send({
            error: "Kein aktiver Salon vorhanden.",
            code: "NO_ACTIVE_SALON",
            resolution,
          });
        }
        return reply.code(409).send({ error: "Konflikt", resolution });
      }
      app.log.error({ resolution }, "clock_in_unexpected_resolution_kind");
      return reply.code(500).send({ error: "Interner Serverfehler" });
    },
  });

  // POST /api/v1/time-entries/:id/clock-out
  app.post("/:id/clock-out", {
    schema: { tags: ["Zeiterfassung"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      // Phase 76.2 (ARCH-V19-01) Plan 3 — thin adapter. Resolver owns lock + state machine + audit.
      // Post-resolution side effects (auto-break / ArbZG / dismissByRelated) stay at the adapter.
      const { id } = req.params as { id: string };
      const body = clockOutSchema.parse(req.body);

      // Fetch entry to derive ClockEvent fields (/:id/clock-out is per-entry input — RESEARCH.md Pitfall 8).
      const entry = await app.prisma.timeEntry.findFirst({
        where: { id, deletedAt: null },
        include: { employee: true },
      });
      if (!entry) return reply.code(404).send({ error: "Eintrag nicht gefunden" });
      // D-02/D-07: Reject cross-tenant access and emit security audit event (fetch-then-compare per D-02)
      if (entry.employee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "TimeEntry",
          entityId: id,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "Eintrag nicht gefunden" });
      }

      // Issue #346/#359: this route had NO ownership or permission check at all — any
      // authenticated caller of the tenant, an EMPLOYEE included, could clock out a colleague's
      // open entry, and a caller holding neither reach of `time-entry:update` could clock out
      // even their own. Mirrors PUT/:id and DELETE/:id's ownership pattern (ZUGEWIESEN for a
      // foreign entry, EIGENE otherwise), except the foreign-entry rejection reuses THIS route's
      // own "Eintrag nicht gefunden" 404 (already used above for cross-tenant) instead of a 403 —
      // deliberately indistinguishable from a non-existent id (T-100-09), decided in the PR that
      // closed #346 because this check runs before any state of the entry is revealed.
      const isOnBehalfOf = entry.employeeId !== req.user.employeeId;
      const clockOutUpdateReach = await permissionReach(req, "time-entry:update");
      if (isOnBehalfOf) {
        if (clockOutUpdateReach !== "ZUGEWIESEN") {
          return reply.code(404).send({ error: "Eintrag nicht gefunden" });
        }
        // Phase 91b Plan 03 (#91), D-09/D-14: a ZUGEWIESEN reach may still be scoped to
        // salons/persons — enforce it here, same 404, on the entry already fetched above.
        if (
          !(await enforceTimeEntryScope(
            app,
            req,
            reply,
            entry,
            "time-entry:update:ZUGEWIESEN",
            "Eintrag nicht gefunden",
          ))
        ) {
          return;
        }
      } else if (clockOutUpdateReach === null) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      // Pre-guard: already-closed entry shortcuts to 409 without paying the lock cost.
      if (entry.endTime) return reply.code(409).send({ error: "Bereits ausgestempelt" });

      // Build ClockEvent { intent: 'OUT' }.
      const now = new Date();
      const tz = await getTenantTimezone(app.prisma, entry.employee.tenantId);
      const event: ClockEvent = {
        employeeId: entry.employeeId,
        tenantId: entry.employee.tenantId,
        source: entry.source,
        intent: "OUT",
        timestamp: now,
        date: entry.date,
        dateStr: dateStrInTz(now, tz),
        note: body.note,
        actor: resolveActor(req),
        // Phase 307 (D-01): interactive — this is the reported bug. `source` above is
        // `entry.source`, the channel that CREATED this row, not who is clicking "Ausstempeln"
        // right now; branching the debounce guard on it would answer the wrong question. This
        // handler IS the adapter for the current call, so it — not the resolver — is the only
        // place that knows the CURRENT caller's channel, hence the field below is set.
        interactive: true,
      };

      const resolution = await resolveClockEvent(app, event, req);

      if (resolution.kind === "CONFLICT") {
        if (resolution.reason === "MONTH_LOCKED") {
          return reply
            .code(409)
            .send({ error: "Eintrag ist gesperrt und kann nicht bearbeitet werden", resolution });
        }
        if (resolution.reason === "NOT_CLOCKED_IN") {
          return reply.code(409).send({ error: "Bereits ausgestempelt", resolution });
        }
        // Phase 118: on this route the pre-guard `if (entry.endTime) return 409
        // "Bereits ausgestempelt"` usually fires first, because a Zeitnachtrag
        // created from the review form carries both times. It is NOT guaranteed:
        // `manualEntrySchema.endTime` is nullable, so the entry-first Nachtrag
        // path (Phase 96) can leave a pending row open. This branch is therefore
        // genuinely reachable, and it keeps the honest message from being
        // swallowed by the generic "Konflikt" fallback below.
        if (resolution.reason === "RETRO_PENDING") {
          return reply.code(409).send({
            error: "Für diesen Tag liegt ein offener Zeitnachtrag zur Genehmigung vor.",
            resolution,
          });
        }
        return reply.code(409).send({ error: "Konflikt", resolution });
      }

      // Phase 307 Plan 02 (D-03/D-05 corrected): DEBOUNCE_NOOP is now a 409, not a 200-with-field.
      // A NOOP is not a success — the user wanted to clock out and did not; 409 is exactly what
      // the five CONFLICT branches above already answer on this route, so it falls into the
      // dashboard's existing catch/toasts.error path without a new display mechanism, and keeps
      // the route internally consistent (one non-success shape, not two).
      //
      // Since Phase 307 Plan 01 set this route's ClockEvent.interactive field to true
      // unconditionally, the resolver's debounce guard is permanently short-circuited here — this
      // branch is defensive/unreachable from an HTTP call to `/:id/clock-out`, the same category
      // as the 500 guard immediately below for CLOCKED_IN/CONFIRMED. It exists for a future
      // adapter change that might send a non-interactive event through this route; D-04 (the
      // type names every result the endpoint can produce) holds in full force BECAUSE of this
      // defensiveness, not despite it — the guard is the assurance, the message is the courtesy.
      //
      // `/nfc-punch` (a separately registered route, see time-entries.ts's nfc-punch handler
      // above) keeps its own DEBOUNCE_NOOP branch at 200/`action: "NOOP"`, UNCHANGED by this
      // phase — a terminal double-tap is not an error and must not surface one; that is a
      // decision, not an omission (Phase 307 Plan 01 Task 1 proved no NFC-terminal path reaches
      // this route at all).
      if (resolution.kind === "DEBOUNCE_NOOP") {
        return reply.code(409).send({
          error: buildClockOutDebounceMessage(entry.startTime, tz),
          resolution,
        });
      }

      if (resolution.kind !== "CLOCKED_OUT" && resolution.kind !== "CONSOLIDATED") {
        app.log.error({ resolution }, "clock_out_unexpected_resolution_kind");
        return reply.code(500).send({ error: "Interner Serverfehler" });
      }

      const closedEntryId = resolution.entry.id;

      // ── Post-resolution side effects (adapter — explicitly out of resolver scope per CONTEXT D-05) ──
      // The removed breakMinutes branch also persisted the note; the resolver's STOP case does not
      // (only START does), so keep the note write — now independent of whether a break exists.
      if (body.note !== undefined) {
        await app.prisma.timeEntry.update({
          where: { id: closedEntryId },
          data: { note: body.note },
        });
      }

      // Auto-break (Phase 64 contract — preserved verbatim; Phase 129 removed the `else` wrapper
      // that used to guard it, but changed nothing inside it).
      const targetEmployee = await app.prisma.employee.findUnique({
        where: { id: entry.employeeId },
      });
      const tenantConfig = targetEmployee
        ? await app.prisma.tenantConfig.findUnique({
            where: { tenantId: targetEmployee.tenantId },
          })
        : null;

      // D-01 Pitfall 1 guard: skip auto-break when Break records already exist on this entry.
      // A reopened entry carries a gap Break — auto-break must not overwrite its breakMinutes.
      const existingBreakCount = await app.prisma.break.count({
        where: { timeEntryId: closedEntryId },
      });
      if (tenantConfig?.autoBreakEnabled && targetEmployee && existingBreakCount === 0) {
        const closedEntry = await app.prisma.timeEntry.findUnique({
          where: { id: closedEntryId },
        });
        if (closedEntry?.startTime && closedEntry?.endTime) {
          const workDurationMin =
            (closedEntry.endTime.getTime() - closedEntry.startTime.getTime()) / 60000;
          const autoBreakMin = getEffectiveBreakDuration(
            targetEmployee,
            tenantConfig,
            workDurationMin,
          );
          if (autoBreakMin > 0) {
            let breakStartTime: Date;
            if (tenantConfig.defaultBreakStart) {
              const [hh, mm] = tenantConfig.defaultBreakStart.split(":").map(Number);
              breakStartTime = new Date(closedEntry.startTime);
              breakStartTime.setHours(hh, mm, 0, 0);
              if (
                breakStartTime <= closedEntry.startTime ||
                breakStartTime >= closedEntry.endTime
              ) {
                const midMs =
                  closedEntry.startTime.getTime() +
                  (closedEntry.endTime.getTime() - closedEntry.startTime.getTime()) / 2;
                breakStartTime = new Date(midMs - (autoBreakMin / 2) * 60000);
              }
            } else {
              const midMs =
                closedEntry.startTime.getTime() +
                (closedEntry.endTime.getTime() - closedEntry.startTime.getTime()) / 2;
              breakStartTime = new Date(midMs - (autoBreakMin / 2) * 60000);
            }
            const breakEndTime = new Date(breakStartTime.getTime() + autoBreakMin * 60000);

            await app.prisma.break.create({
              data: {
                timeEntryId: closedEntryId,
                startTime: breakStartTime,
                endTime: breakEndTime,
              },
            });
            // Phase 91 (BREAK-02): Pflichtpause auto-inserted → mark AUTO for confirmation
            await app.prisma.timeEntry.update({
              where: { id: closedEntryId },
              data: { breakMinutes: autoBreakMin, breakStatus: "AUTO" },
            });
          }
        }
      }

      await updateOvertimeAccount(app, entry.employeeId);

      const warnings = await checkArbZG(app.prisma, entry.employeeId, entry.date);

      // Auto-dismiss CLOCK_OUT_REMINDER notifications for this entry (Phase 70 contract — preserved verbatim).
      try {
        await app.dismissByRelated("TimeEntry", closedEntryId);
      } catch (err) {
        app.log.warn(
          { err, timeEntryId: closedEntryId },
          "Failed to auto-dismiss CLOCK_OUT_REMINDER on clock-out",
        );
      }

      // Re-fetch with breaks for response (auto-break may have added one).
      const entryWithBreaks = await app.prisma.timeEntry.findUnique({
        where: { id: closedEntryId },
        include: { breaks: { orderBy: { startTime: "asc" } } },
      });

      return reply
        .code(200)
        .send({ resolution, audit: resolution.audit, warnings, entry: entryWithBreaks });
    },
  });

  // ── POST /api/v1/time-entries/:id/breaks ──────────────────────────────────
  // Append a completed break (startTime + endTime) to an open or closed TimeEntry.
  // Used by the dashboard Pause toggle: client tracks "break started at" locally
  // (localStorage) and POSTs the closed segment when the user clicks "Pause beenden".
  // Keeps Break records canonical (always closed segments) and avoids a schema
  // migration to nullable endTime. The recorded break-minutes are added to the
  // entry's existing breakMinutes total so live ArbZG warnings stay accurate.
  const appendBreakSchema = z.object({
    startTime: z.string().datetime(),
    endTime: z.string().datetime(),
  });
  app.post("/:id/breaks", {
    schema: { tags: ["Zeiterfassung"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = appendBreakSchema.parse(req.body);
      const user = req.user;

      const entry = await app.prisma.timeEntry.findFirst({
        where: { id, deletedAt: null },
        include: { employee: { select: { tenantId: true } } },
      });
      // T-100-09 cross-tenant existence oracle (Issue #310): folded into one condition so an
      // unknown id and a real id in a foreign tenant answer with the identical 404 — the previous
      // two-branch shape (404 for unknown, 403 "Kein Zugriff" for foreign-tenant) let any
      // authenticated user of any tenant probe whether an arbitrary id exists anywhere. The audit
      // is nested so it fires ONLY when the row exists: an unknown id must write no AuditLog row,
      // or the row count itself would reopen the oracle this guard just closed. This is a write
      // route, and #310 names the missing audit as part of the finding — sibling `/break-status`
      // already audits this same defect class, `PUT /:id` does not (mixed precedent in this file);
      // structure copied from `avatars.ts`'s folded-condition + nested-audit pattern.
      if (!entry || entry.employee.tenantId !== user.tenantId) {
        if (entry) {
          await app.audit({
            userId: user.sub,
            action: "CROSS_TENANT_ACCESS_DENIED",
            entity: "TimeEntry",
            entityId: id,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
        }
        return reply.code(404).send({ error: "Eintrag nicht gefunden" });
      }

      // Only the entry's owner or a caller holding time-entry:update:ZUGEWIESEN may append breaks.
      const breaksUpdateReach = await permissionReach(req, "time-entry:update");
      if (breaksUpdateReach !== "ZUGEWIESEN" && entry.employeeId !== user.employeeId) {
        return reply.code(403).send({ error: "Kein Zugriff" });
      }
      if (breaksUpdateReach === null) {
        return reply.code(403).send({ error: "Kein Zugriff" });
      }
      // Phase 91b Plan 03 (#91), D-09/D-14: a ZUGEWIESEN reach acting on someone else's entry may
      // still be scoped to salons/persons — enforce it, same 404 as a non-existent id, on the
      // entry already fetched above.
      if (breaksUpdateReach === "ZUGEWIESEN" && entry.employeeId !== user.employeeId) {
        if (
          !(await enforceTimeEntryScope(
            app,
            req,
            reply,
            entry,
            "time-entry:update:ZUGEWIESEN",
            "Eintrag nicht gefunden",
          ))
        ) {
          return;
        }
      }

      // Locked months are immutable (audit-proof, see CLAUDE.md).
      if (entry.isLocked) {
        return reply
          .code(409)
          .send({ error: "Eintrag ist gesperrt und kann nicht bearbeitet werden" });
      }

      const breakStart = new Date(body.startTime);
      const breakEnd = new Date(body.endTime);

      if (!(breakStart < breakEnd)) {
        return reply.code(400).send({ error: "Pausenende muss nach Pausenbeginn liegen" });
      }
      if (breakStart < entry.startTime) {
        return reply.code(400).send({ error: "Pause darf nicht vor dem Eintragsbeginn liegen" });
      }
      // For closed entries, the break must also lie within the entry. For still-open
      // entries (no endTime yet) we only require breakEnd <= now. A small tolerance
      // (5s) absorbs benign clock skew between the client (browser) and the API host
      // — otherwise a server clock that runs a few seconds ahead would reject every
      // "Pause beenden" click from a synchronously-correct client.
      const FUTURE_TOLERANCE_MS = 5_000;
      const now = new Date();
      if (entry.endTime) {
        if (breakEnd > entry.endTime) {
          return reply.code(400).send({ error: "Pause darf nicht nach dem Eintragsende liegen" });
        }
      } else if (breakEnd.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
        return reply.code(400).send({ error: "Pausenende darf nicht in der Zukunft liegen" });
      }

      const created = await app.prisma.break.create({
        data: { timeEntryId: id, startTime: breakStart, endTime: breakEnd },
      });

      // Recompute breakMinutes from the union of all breaks on this entry so the
      // summary stat stays consistent (multiple breaks per entry are allowed).
      const allBreaks = await app.prisma.break.findMany({ where: { timeEntryId: id } });
      const totalBreakMin = Math.round(calcBreakMinutes(allBreaks));
      await app.prisma.timeEntry.update({
        where: { id },
        // Phase 91 (BREAK-01): human appended a break -> CONFIRMED (runs after the isLocked
        // gate above, so locked entries never reach this point).
        data: { breakMinutes: totalBreakMin, breakStatus: "CONFIRMED" },
      });

      await app.audit({
        userId: user.sub,
        action: "BREAK_APPEND",
        entity: "Break",
        entityId: created.id,
        newValue: { timeEntryId: id, startTime: created.startTime, endTime: created.endTime },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      // D-10 (issue #310/#78): the Break-entity audit above records the NEW break; this second,
      // TimeEntry-entity audit records what appending it did to the entry itself
      // (breakMinutes/breakStatus before/after) — previously unaudited (§ 16 Abs. 2 ArbZG,
      // § 147 AO Revisionssicherheit). Action "UPDATE" per P-03 (78b-CONTEXT.md): consistent with
      // PUT /:id's self-edit UPDATE, not BREAK_CONFIRMED (that records a different act — the
      // employee confirming an already auto-inserted break on /break-status).
      await app.audit({
        userId: user.sub,
        action: "UPDATE",
        entity: "TimeEntry",
        entityId: id,
        oldValue: { breakMinutes: entry.breakMinutes, breakStatus: entry.breakStatus },
        newValue: { breakMinutes: totalBreakMin, breakStatus: "CONFIRMED" },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return { success: true, break: created, breakMinutes: totalBreakMin };
    },
  });

  // GET /api/v1/time-entries (own entries, or every in-scope entry for a manager — Phase 91b
  // Plan 03, Issue #91, D-09: a SALONS/PERSONS-scoped manager sees only in-scope entries, never
  // the whole tenant)
  app.get("/", {
    schema: { tags: ["Zeiterfassung"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { from, to, employeeId } = req.query as {
        from?: string;
        to?: string;
        employeeId?: string;
      };

      const user = req.user;
      // Phase 76b Plan 04 (Issue #76), P-02: a caller holding NEITHER reach (e.g. the
      // Personalabteilung template, which deliberately carries no time-entry permission at all)
      // must not fall into the own-entries branch below — that branch answered 200 with the
      // caller's own entries even for someone with zero time-entry:read grant. Every other
      // handler in this codebase already answers 403 for a null reach; this route was the one
      // exception (grep of `= (await permissionReach(req, …)) === "ZUGEWIESEN"` before this fix).
      const readReach = await permissionReach(req, "time-entry:read");
      if (readReach === null) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      const isManager = readReach === "ZUGEWIESEN";

      // PERF-V1814-03: cap + defaulted 90d window (non-breaking; web callers always pass bounds)
      const defaultFrom = from
        ? new Date(from)
        : (() => {
            const d = new Date();
            d.setDate(d.getDate() - 90);
            return d;
          })();
      const defaultTo = to ? new Date(to) : new Date();

      // Phase 91b Plan 03 (#91), D-09: a manager's reach narrows the list to in-scope entries
      // (own salon OR Stammsalon-at-the-entry's-own-date). `wholeTenant` (TENANT-scope managers,
      // today's behaviour) and the EIGENE (non-manager) branch below issue no extra query at all.
      let scopedIds: "all" | string[] = "all";
      if (isManager) {
        const access = accessContextFromRequest(req);
        const reach = await resolveAccessReach(app.prisma, access, "time-entry:read:ZUGEWIESEN");
        scopedIds = await scopedTimeEntryIds(
          app.prisma,
          user.tenantId,
          reach,
          defaultFrom,
          defaultTo,
        );
      }

      // PERF-V1814-03: hard cap. WR-01 — the cap can silently truncate for callers that
      // omit tight bounds (batch scripts / external API consumers). Web callers always pass
      // a from/to window so they never hit it, but we log a warning when the cap IS reached so
      // truncation is observable server-side (a caller receiving exactly TIME_ENTRIES_MAX rows
      // should narrow its date window or paginate).
      const TIME_ENTRIES_MAX = 1000;
      const entries = await app.prisma.timeEntry.findMany({
        where: {
          // Tenant isolation: always scope to the requesting user's tenant via employee.tenantId
          employee: { tenantId: user.tenantId },
          employeeId: isManager && employeeId ? employeeId : (user.employeeId ?? undefined),
          deletedAt: null,
          date: {
            gte: defaultFrom,
            lte: to ? new Date(to) : undefined,
          },
          ...(scopedIds !== "all" ? { id: { in: scopedIds } } : {}),
        },
        include: {
          employee: { select: { firstName: true, lastName: true } },
          breaks: { orderBy: { startTime: "asc" } },
        },
        take: TIME_ENTRIES_MAX,
        orderBy: { date: "desc" },
      });

      if (entries.length === TIME_ENTRIES_MAX) {
        req.log.warn(
          {
            tenantId: user.tenantId,
            employeeId: isManager && employeeId ? employeeId : user.employeeId,
            from: defaultFrom,
            to,
            cap: TIME_ENTRIES_MAX,
          },
          "GET /time-entries hit the result cap — response may be truncated; caller should narrow the date window",
        );
      }

      return entries;
    },
  });

  // POST /api/v1/time-entries  (manuelle Erfassung)
  app.post("/", {
    schema: { tags: ["Zeiterfassung"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const body = manualEntrySchema.parse(req.body);
      const user = req.user;
      // Feeds both the employeeId selection below and postIsCorrectionByManager (issue #75, D-13)
      const postCreateReach = await permissionReach(req, "time-entry:create");
      const isManager = postCreateReach === "ZUGEWIESEN";
      // Issue #359: a caller holding neither time-entry:create:ZUGEWIESEN nor :EIGENE fell through
      // to the self-create branch below with no rejection at all.
      if (postCreateReach === null) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      // Mitarbeiter ID ermitteln
      const employeeId =
        body.employeeId && isManager ? body.employeeId : (user.employeeId ?? undefined);

      if (!employeeId) return reply.code(400).send({ error: "Mitarbeiter nicht ermittelbar" });

      // Prüfen ob Mitarbeiter existiert, zum Tenant gehört und aktiv ist
      const targetEmployee = await app.prisma.employee.findFirst({
        where: { id: employeeId, tenantId: req.user.tenantId },
        include: { user: true },
      });
      if (!targetEmployee) {
        return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      }
      if (!targetEmployee.user.isActive) {
        return reply.code(403).send({ error: "Mitarbeiter ist deaktiviert" });
      }

      // Prüfen ob das Datum vor dem Eintrittsdatum liegt
      if (targetEmployee?.hireDate) {
        const entryDate = new Date(body.date);
        const hireDate = new Date(targetEmployee.hireDate);
        // Vergleich nur auf Tagesbasis (ohne Uhrzeit)
        const entryDay = new Date(
          entryDate.getFullYear(),
          entryDate.getMonth(),
          entryDate.getDate(),
        );
        const hireDay = new Date(hireDate.getFullYear(), hireDate.getMonth(), hireDate.getDate());
        if (entryDay < hireDay) {
          return reply
            .code(400)
            .send({ error: "Zeiteinträge vor dem Eintrittsdatum sind nicht erlaubt" });
        }
      }

      const newStart = new Date(body.startTime);
      const newEnd = body.endTime ? new Date(body.endTime) : null;

      // Zukunfts-Validierung: Datum max heute, Endzeit max now+30min
      const now = new Date();
      const tz = await getTenantTimezone(app.prisma, targetEmployee?.tenantId ?? req.user.tenantId);
      const todayStr = dateStrInTz(now, tz);
      const entryDateStr = dateStrInTz(new Date(body.date ?? body.startTime), tz);
      if (entryDateStr > todayStr) {
        return reply.code(400).send({ error: "Zeiteinträge in der Zukunft sind nicht erlaubt" });
      }
      if (newEnd) {
        const maxEnd = new Date(now.getTime() + 30 * 60 * 1000);
        if (newEnd > maxEnd) {
          return reply
            .code(400)
            .send({ error: "Endzeit darf max. 30 Minuten in der Zukunft liegen" });
        }
      }

      // § 8 BUrlG: Check for active leave (DATA-V1814-09). Use the already-resolved
      // employeeId (honors the isManager gate at :768-769) — NOT body.employeeId, which
      // a non-manager could set to a foreign UUID to bypass the leave block.
      const manualLeave = await hasApprovedLeaveOnDate(app.prisma, employeeId, entryDateStr);
      if (manualLeave?.status === "APPROVED") {
        // Phase 100b Plan 14 (D-05): render the display name here, at the caller, via the ONE
        // Phase 97/98b mapping — hasApprovedLeaveOnDate returns a stable code, never a
        // tenant-editable display string, so this § 8 BUrlG rejection message no longer depends
        // on a tenant setting.
        return reply.code(409).send({
          error: `§ 8 BUrlG: An diesem Tag ist ${DISPLAY_NAME[manualLeave.code]} genehmigt. Bitte zuerst stornieren.`,
        });
      }

      // Zeitvalidierung
      if (newEnd && newEnd <= newStart) {
        return reply.code(400).send({ error: "Endzeit muss nach der Startzeit liegen" });
      }

      // Phase 76.29 Plan 03 — RETRO grant lookup.
      // If the caller supplies a grantId, verify there is an APPROVED RetroEntryRequest
      // for this (employeeId, targetDate) before calling validateTimeEntryInvariants so
      // the retro-window guard is skipped for a pre-approved grant.
      // The grant is consumed atomically inside the $transaction below (Task 2).
      let resolvedGrantId: string | undefined;
      if (body.grantId) {
        const grant = await app.prisma.retroEntryRequest.findFirst({
          where: {
            id: body.grantId,
            employeeId,
            targetDate: new Date(body.date),
            status: "APPROVED",
            deletedAt: null,
          },
          select: { id: true },
        });
        if (!grant) {
          return reply.code(403).send({ error: "Antrag bereits verwendet oder ungültig" });
        }
        resolvedGrantId = grant.id;
      }

      // Shared invariants (D-01/D-03): one-entry-per-day, month-lock via SaldoSnapshot,
      // retro-window guard (RETRO-01), and overlap — extracted into validateTimeEntryInvariants
      // so the CSV import and PUT enforce the identical guards.
      // Month-lock → 403, RETRO_WINDOW_EXCEEDED → 403 with numeric body, everything else → 409.
      // isCorrectionByManager: manager creating an entry for a DIFFERENT employee is an inline
      // correction and is exempt from the retro-window guard (same logic as PUT).
      // Lock-first ordering is preserved: validateTimeEntryInvariants checks the month-lock
      // BEFORE the retro-window guard, so an approved grant for a locked month still fails.
      const postIsCorrectionByManager = isManager && employeeId !== user.employeeId;
      const invariantError = await validateTimeEntryInvariants(app, {
        employeeId,
        date: new Date(body.date),
        dateStr: entryDateStr,
        newStart,
        newEnd,
        tz,
        tenantId: user.tenantId,
        isCorrectionByManager: postIsCorrectionByManager,
        grantId: resolvedGrantId,
        // Grant race fix: defer the one-per-day + overlap checks to the $transaction
        // below so the single-use grant flip (checked first, before create) is the sole
        // discriminator for concurrent same-grant writes — see param doc on
        // validateTimeEntryInvariants. Re-run against `tx` after a successful flip.
        deferConflictChecksToTx: !!resolvedGrantId,
      });
      // Phase 96 (RETRO-10) — fall-through discriminator: true only when the create is
      // being allowed to proceed as a pending entry-first Nachtrag (see below).
      let pendingRetroCreate = false;
      // Phase 96 (RETRO-10) — entry-first Nachtrag: when the ONLY invariant failure is
      // RETRO_WINDOW_EXCEEDED and the caller supplied a reason (and no grant), do NOT
      // return 403 here. Set a flag and let control FALL THROUGH into the shared create
      // path below (finalBreakMinutes/breakSlots, the checkJArbSchG minor-protection
      // hard-block, checkArbZG, the generic CREATE audit) so a pending Nachtrag is
      // gated exactly like a normal create — see the `pendingRetroCreate` branch inside
      // the shared try/catch further down. Without a reason (or with a grantId), the
      // response stays byte-identical to today.
      if (invariantError) {
        if (invariantError.error === "RETRO_WINDOW_EXCEEDED") {
          const retroReason = body.reason?.trim();
          if (retroReason && !resolvedGrantId) {
            pendingRetroCreate = true;
          } else {
            return reply.code(403).send({
              error: invariantError.error,
              windowDays: invariantError.windowDays,
              entryAgeInDays: invariantError.entryAgeInDays,
            });
          }
        } else {
          const code = invariantError.error.includes("abgeschlossen") ? 403 : 409;
          return reply.code(code).send({ error: invariantError.error });
        }
      }

      // Phase 68b (issue #68), D-07/D-08/D-10: resolve the entry's salon BEFORE the grant flip,
      // the RetroEntryRequest create and the plain create, so a rejection (404/400) leaves zero
      // state change. An explicit salon (body.salonId) is stored UNCHANGED even when
      // `salonForDay` would suggest another, and the entry is not marked invalid for it (issue
      // #68: deviating from the #67 pattern here is not a mistake) — any caller allowed to use
      // this route, including an employee filing their own Zeitnachtrag, may name a salon.
      const salonResolution = await resolveEntrySalon(app.prisma, {
        tenantId: user.tenantId,
        employeeId,
        startTime: newStart,
        explicitSalonId: body.salonId,
      });
      if (!salonResolution.ok) {
        return reply.code(salonResolution.status).send(salonResolution.body);
      }

      // Determine breakMinutes from break slots or body
      let finalBreakMinutes = body.breakMinutes;
      const breakSlots: { startTime: Date; endTime: Date }[] = [];

      if (body.breaks && body.breaks.length > 0) {
        for (const b of body.breaks) {
          breakSlots.push({ startTime: new Date(b.startTime), endTime: new Date(b.endTime) });
        }
        const breakError = validateBreakSlots(breakSlots, newStart, newEnd);
        if (breakError) return reply.code(400).send({ error: breakError });
        finalBreakMinutes = Math.round(calcBreakMinutes(breakSlots));
      }

      // Phase 63 D-09..D-13 — JArbSchG §9 pre-check.
      // Runs AFTER the locked-month gate (so locked entries are never re-validated)
      // and BEFORE any DB write (so a hard block leaves zero state change).
      // Hard-block: AZUBI < 18 + BS day + planned > 225 min → HTTP 400.
      // Soft-warn: AZUBI ≥ 18 + BS day + planned > 225 min → emits a warning that
      // we append to the existing warnings response array (D-12).
      const plannedNetMinPost =
        newEnd != null
          ? Math.max(
              0,
              Math.round((newEnd.getTime() - newStart.getTime()) / 60_000) -
                (finalBreakMinutes ?? 0),
            )
          : 0;
      const jarbSchgPost = await checkJArbSchG(app.prisma, {
        employeeId,
        date: new Date(body.date),
        plannedNetWorkMin: plannedNetMinPost,
      });
      if (jarbSchgPost.blocked) {
        return reply
          .code(400)
          .send({ error: "JARBSCHG_MINOR_LIMIT", message: jarbSchgPost.message });
      }

      // Phase 76.29 Plan 03 — race-safe single-use grant consumption.
      // When a resolvedGrantId is present, the grant flip and the TimeEntry create
      // run inside one $transaction, in that order (grant flip FIRST). The conditional
      // updateMany (WHERE status=APPROVED) ensures exactly one concurrent write wins —
      // if count !== 1 the tx rolls back before the create is ever attempted, so the
      // loser is rejected with GRANT_ALREADY_USED (403) instead of racing into the
      // (employeeId,date) unique index and getting a P2002 (409) (fixed 2026-07: see
      // .planning/debug/resolved/retro-grant-race-403-vs-409.md).
      let entry: Awaited<ReturnType<typeof app.prisma.timeEntry.create>>;
      try {
        if (resolvedGrantId) {
          // Atomic: create entry + flip grant APPROVED → USED in one transaction.
          const grantIdForTx = resolvedGrantId;
          const result = await app.prisma.$transaction(async (tx) => {
            // Conditional flip FIRST: only succeeds if still APPROVED (single-use guard).
            // This must run before the TimeEntry create so the grant is the authoritative
            // discriminator for concurrent same-day writes — otherwise the loser can fail
            // on the (employeeId,date) unique index (P2002 -> 409) before the grant guard
            // ever gets a chance to reject it with 403.
            const consumed = await tx.retroEntryRequest.updateMany({
              where: { id: grantIdForTx, status: "APPROVED" },
              data: { status: "USED" },
            });
            if (consumed.count !== 1) {
              throw new Error("GRANT_ALREADY_USED");
            }

            // Re-run the one-per-day + overlap conflict checks against `tx` now that
            // this request has exclusively won the grant (deferConflictChecksToTx above
            // skipped these pre-tx). Only the winner ever reaches this point, so these
            // catch genuinely unrelated conflicts (e.g. a different, non-grant write to
            // the same day) rather than the grant race itself — the (employeeId,date)
            // partial unique index remains the final backstop for the one-per-day case.
            const conflictDate = new Date(body.date);
            const oneDayErrorTx = await checkOneEntryPerDay(
              tx,
              user.tenantId,
              employeeId,
              conflictDate,
            );
            if (oneDayErrorTx) {
              throw new Error(`ENTRY_CONFLICT:${oneDayErrorTx}`);
            }
            const overlapTx = await checkOverlap(
              tx,
              employeeId,
              newStart,
              newEnd,
              undefined,
              conflictDate,
              tz,
            );
            if (overlapTx) {
              throw new Error(`ENTRY_CONFLICT:${overlapTx}`);
            }

            const created = await tx.timeEntry.create({
              data: {
                employeeId,
                date: new Date(body.date),
                startTime: newStart,
                endTime: newEnd,
                breakMinutes: finalBreakMinutes,
                note: body.note,
                source: "CORRECTION", // grant-backed write is always a correction
                createdBy: user.sub,
                isInvalid: manualLeave?.status === "CANCELLATION_REQUESTED",
                salonId: salonResolution.salonId, // Phase 68b (issue #68), D-08/D-10
                ...(manualLeave
                  ? invalidReasonFields("LEAVE_CANCELLATION_PENDING")
                  : CLEARED_INVALID_REASON),
              },
            });

            await app.audit({
              userId: user.sub,
              action: "RETRO_ENTRY_APPROVED_USED",
              entity: "RetroEntryRequest",
              entityId: grantIdForTx,
              newValue: { timeEntryId: created.id, employeeId, date: body.date },
              tx,
            });

            return created;
          });
          entry = result;
        } else if (pendingRetroCreate) {
          // Phase 96 (RETRO-10) — entry-first Nachtrag: create the RetroEntryRequest
          // and the coupled pending TimeEntry atomically in one transaction. The entry
          // starts isInvalid=true and is only released (isInvalid=false) when a manager
          // approves via PATCH /retro-entry-requests/:id/review (96-02 Task 2). No
          // second CREATE audit here — the shared post-create tail below (unchanged)
          // already writes the generic TimeEntry CREATE audit for every create path,
          // including this one; this branch only owns the RETRO_ENTRY_REQUESTED audit
          // for the request. Reuses the SAME try/catch as the plain path — a P2002 on
          // the (employeeId,date) unique index maps to the existing 409 below.
          const result = await app.prisma.$transaction(async (tx) => {
            const request = await tx.retroEntryRequest.create({
              data: {
                employeeId,
                targetDate: new Date(body.date),
                reason: body.reason!.trim(),
                startTime: timeStrInTz(newStart, tz),
                endTime: newEnd ? timeStrInTz(newEnd, tz) : null,
                breakMinutes: finalBreakMinutes || null,
                status: "PENDING",
              },
            });
            const created = await tx.timeEntry.create({
              data: {
                employeeId,
                date: new Date(body.date),
                startTime: newStart,
                endTime: newEnd,
                breakMinutes: finalBreakMinutes,
                note: body.note,
                source: "MANUAL",
                createdBy: user.sub,
                isInvalid: true,
                salonId: salonResolution.salonId, // Phase 68b (issue #68), D-08/D-10
                ...invalidReasonFields("RETRO_APPROVAL_PENDING"),
                retroRequestId: request.id,
              },
            });

            await app.audit({
              tx,
              userId: user.sub,
              action: "RETRO_ENTRY_REQUESTED",
              entity: "RetroEntryRequest",
              entityId: request.id,
              newValue: { ...request, timeEntryId: created.id },
            });

            return created;
          });
          entry = result;
        } else {
          entry = await app.prisma.timeEntry.create({
            data: {
              employeeId,
              date: new Date(body.date),
              startTime: newStart,
              endTime: newEnd,
              breakMinutes: finalBreakMinutes,
              note: body.note,
              source: "MANUAL",
              createdBy: user.sub,
              isInvalid: manualLeave?.status === "CANCELLATION_REQUESTED",
              salonId: salonResolution.salonId, // Phase 68b (issue #68), D-08/D-10
              ...(manualLeave
                ? invalidReasonFields("LEAVE_CANCELLATION_PENDING")
                : CLEARED_INVALID_REASON),
            },
          });
        }
      } catch (err: unknown) {
        // Grant already consumed (concurrent race) → 403
        if (err instanceof Error && err.message === "GRANT_ALREADY_USED") {
          return reply.code(403).send({ error: "Antrag bereits verwendet oder ungültig" });
        }
        // Genuinely unrelated conflict (one-per-day/overlap), re-checked inside the tx
        // after the grant flip succeeded (deferConflictChecksToTx) → 409.
        if (err instanceof Error && err.message.startsWith("ENTRY_CONFLICT:")) {
          return reply.code(409).send({ error: err.message.slice("ENTRY_CONFLICT:".length) });
        }
        // MULTI-ENTRY: this P2002 → 409 mapping only exists because of the one-per-day unique index;
        // it disappears (or changes meaning) when the index is dropped (#70).
        // DATA-V1814-04: the partial-unique index catches a concurrent same-day create
        // that raced past the app-level one-per-day check → P2002 → 409 (not a 500).
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code: unknown }).code === "P2002"
        ) {
          return reply
            .code(409)
            .send({ error: "Es existiert bereits ein Eintrag für diesen Tag." });
        }
        throw err;
      }

      // Create break slot records
      if (breakSlots.length > 0) {
        await app.prisma.break.createMany({
          data: breakSlots.map((b) => ({
            timeEntryId: entry.id,
            startTime: b.startTime,
            endTime: b.endTime,
          })),
        });
      } else if (newEnd && finalBreakMinutes === 0) {
        // Auto-break: check tenant config
        const tenantConfig = targetEmployee
          ? await app.prisma.tenantConfig.findUnique({
              where: { tenantId: targetEmployee.tenantId },
            })
          : null;

        if (tenantConfig?.autoBreakEnabled) {
          const workDurationMin = (newEnd.getTime() - newStart.getTime()) / 60000;
          // Phase 64 (D-04, BREAK-03): effective break = employee override → tenant default → 0.
          // targetEmployee is loaded earlier without `select` → carries the two override fields.
          const autoBreakMin = targetEmployee
            ? getEffectiveBreakDuration(targetEmployee, tenantConfig, workDurationMin)
            : 0;

          if (autoBreakMin > 0) {
            // Determine break start time
            let breakStartTime: Date;
            if (tenantConfig.defaultBreakStart) {
              const [hh, mm] = tenantConfig.defaultBreakStart.split(":").map(Number);
              breakStartTime = new Date(newStart);
              breakStartTime.setHours(hh, mm, 0, 0);
              // If configured break start is outside work period, use middle
              if (breakStartTime <= newStart || breakStartTime >= newEnd) {
                const midMs = newStart.getTime() + (newEnd.getTime() - newStart.getTime()) / 2;
                breakStartTime = new Date(midMs - (autoBreakMin / 2) * 60000);
              }
            } else {
              const midMs = newStart.getTime() + (newEnd.getTime() - newStart.getTime()) / 2;
              breakStartTime = new Date(midMs - (autoBreakMin / 2) * 60000);
            }
            const breakEndTime = new Date(breakStartTime.getTime() + autoBreakMin * 60000);

            await app.prisma.break.create({
              data: {
                timeEntryId: entry.id,
                startTime: breakStartTime,
                endTime: breakEndTime,
              },
            });

            // Phase 91 (BREAK-02): Pflichtpause auto-inserted → mark AUTO for confirmation
            await app.prisma.timeEntry.update({
              where: { id: entry.id },
              data: { breakMinutes: autoBreakMin, breakStatus: "AUTO" },
            });
            // Update entry object for response
            entry.breakMinutes = autoBreakMin;
            entry.breakStatus = "AUTO";
          }
        }
      }

      await updateOvertimeAccount(app, employeeId);

      const warnings = await checkArbZG(app.prisma, employeeId, new Date(body.date));

      // Phase 63 D-12 — append JArbSchG soft-warn to the warnings array AND
      // emit a JARBSCHG_SOFT_WARN audit-log row tied to the created entry.
      if (jarbSchgPost.softWarn) {
        warnings.push(jarbSchgPost.softWarn);
        await app.audit({
          userId: user.sub,
          action: "JARBSCHG_SOFT_WARN",
          entity: "TimeEntry",
          entityId: entry.id,
          oldValue: null,
          newValue: { plannedNetWorkMin: plannedNetMinPost, bsDay: true },
        });
      }

      // Re-fetch entry with breaks for response
      const entryWithBreaks = await app.prisma.timeEntry.findUnique({
        where: { id: entry.id },
        include: { breaks: { orderBy: { startTime: "asc" } } },
      });

      await app.audit({
        userId: user.sub,
        action: "CREATE",
        entity: "TimeEntry",
        entityId: entry.id,
        newValue: entryWithBreaks,
      });

      // Phase 96 (RETRO-16/D-10) — submit-notify: tell the tenant's managers/admins
      // a new pending Nachtrag is waiting for them (net-new call site, Pitfall 3;
      // mirrors the BREAK_COMPLIANCE_ALERT manager-iteration precedent, :2042-2052,
      // skipping the actor).
      if (pendingRetroCreate && entry.retroRequestId) {
        try {
          // Phase 75b Plan 10 (#75), D-16: holders of retro-request:approve replace the legacy
          // A,M role predicate — the recorded recipient set is unchanged.
          const retroRequestedApproveHolderIds = await userIdsHoldingPermission(
            app.prisma,
            targetEmployee.tenantId,
            "retro-request:approve:ZUGEWIESEN",
          );
          // Phase 91b Plan 09 (Issue #91), D-10/D-17: RetroEntryRequest has no salonId of its
          // own (Plan 91b-03's own finding) — Stammsalon-only, Stichtag = the entry's own date.
          const scopedRetroRequestedApproveHolderIds = await resolveScopedHolderIds(
            app.prisma,
            targetEmployee.tenantId,
            retroRequestedApproveHolderIds,
            "retro-request:approve:ZUGEWIESEN",
            (reach) =>
              isStammsalonScopeMatch(
                app.prisma,
                targetEmployee.tenantId,
                reach,
                employeeId,
                new Date(body.date),
              ),
          );
          const submitManagers = await app.prisma.employee.findMany({
            where: {
              tenantId: targetEmployee.tenantId,
              user: { isActive: true, id: { in: scopedRetroRequestedApproveHolderIds } },
            },
            include: { user: { select: { id: true } } },
          });
          for (const mgr of submitManagers) {
            if (mgr.user.id === targetEmployee.user.id) continue; // don't self-notify
            await app.notify({
              userId: mgr.user.id,
              type: "RETRO_ENTRY_REQUESTED",
              title: "Neuer Zeitnachtrag",
              message: `${targetEmployee.firstName} ${targetEmployee.lastName} hat einen Zeitnachtrag für den ${entryDateStr} eingereicht und wartet auf Genehmigung.`,
              link: "/inbox",
              tenantId: targetEmployee.tenantId,
              relatedType: "RetroEntryRequest",
              relatedId: entry.retroRequestId,
            });
          }
        } catch (err) {
          app.log.warn(
            { err, timeEntryId: entry.id },
            "Failed to notify managers on Nachtrag submit",
          );
        }
      }

      return reply.code(201).send({ entry: entryWithBreaks, warnings });
    },
  });

  // PUT /api/v1/time-entries/:id  (Eintrag bearbeiten)
  app.put("/:id", {
    schema: { tags: ["Zeiterfassung"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const body = updateEntrySchema.parse(req.body);
      const user = req.user;
      // Feeds both the ownership check below and putIsCorrectionByManager (issue #75, D-13)
      const putUpdateReach = await permissionReach(req, "time-entry:update");
      const isManager = putUpdateReach === "ZUGEWIESEN";

      const existing = await app.prisma.timeEntry.findUnique({
        where: { id },
        include: {
          employee: { select: { tenantId: true, userId: true, firstName: true, lastName: true } },
          // Phase 96 (RETRO-16/D-10): loaded so the own-pending-edit exemption below can
          // verify the coupled request is still PENDING (strictness, Pitfall 2) — not
          // just that a retroRequestId happens to be set.
          retroRequest: { select: { status: true } },
        },
      });
      if (!existing) return reply.code(404).send({ error: "Eintrag nicht gefunden" });

      // Tenant isolation
      if (existing.employee.tenantId !== user.tenantId) {
        return reply.code(404).send({ error: "Eintrag nicht gefunden" });
      }

      // D-03(a): soft-deleted entries are immutable (findUnique cannot carry deletedAt:null
      // — Prisma unique-key restriction — so guard the fetched row instead).
      if (existing.deletedAt) {
        return reply.code(404).send({ error: "Eintrag nicht gefunden" });
      }

      // Nur eigene Einträge für normale Mitarbeiter
      if (!isManager && existing.employeeId !== user.employeeId) {
        return reply.code(403).send({ error: "Kein Zugriff" });
      }
      if (putUpdateReach === null) {
        return reply.code(403).send({ error: "Kein Zugriff" });
      }

      // Phase 91b Plan 03 (#91), D-09/D-14: a ZUGEWIESEN reach acting on someone else's entry may
      // still be scoped to salons/persons — enforce it, same 404 as a non-existent id, on the
      // entry already fetched above.
      if (isManager && existing.employeeId !== user.employeeId) {
        if (
          !(await enforceTimeEntryScope(
            app,
            req,
            reply,
            existing,
            "time-entry:update:ZUGEWIESEN",
            "Eintrag nicht gefunden",
          ))
        ) {
          return;
        }
      }

      // Gesperrte Einträge dürfen nicht bearbeitet werden
      if (existing.isLocked) {
        return reply
          .code(403)
          .send({ error: "Eintrag ist gesperrt und kann nicht bearbeitet werden" });
      }

      // Prüfen ob das neue Datum vor dem Eintrittsdatum liegt
      if (body.date) {
        const targetEmployee = await app.prisma.employee.findUnique({
          where: { id: existing.employeeId },
          select: { hireDate: true },
        });
        if (targetEmployee?.hireDate) {
          const entryDate = new Date(body.date);
          const hireDate = new Date(targetEmployee.hireDate);
          const entryDay = new Date(
            entryDate.getFullYear(),
            entryDate.getMonth(),
            entryDate.getDate(),
          );
          const hireDay = new Date(hireDate.getFullYear(), hireDate.getMonth(), hireDate.getDate());
          if (entryDay < hireDay) {
            return reply
              .code(400)
              .send({ error: "Zeiteinträge vor dem Eintrittsdatum sind nicht erlaubt" });
          }
        }
      }

      // Zukunfts-Validierung
      const nowEdit = new Date();
      if (body.date) {
        const emp = await app.prisma.employee.findUnique({
          where: { id: existing.employeeId },
          select: { tenantId: true },
        });
        const editTz = await getTenantTimezone(app.prisma, emp!.tenantId);
        const editTodayStr = dateStrInTz(nowEdit, editTz);
        const editDateStr = dateStrInTz(new Date(body.date), editTz);
        if (editDateStr > editTodayStr) {
          return reply.code(400).send({ error: "Zeiteinträge in der Zukunft sind nicht erlaubt" });
        }
      }

      // Überlappungsprüfung für geänderte Zeiten
      const updatedStart = body.startTime ? new Date(body.startTime) : existing.startTime;
      const updatedEnd =
        "endTime" in body
          ? body.endTime
            ? new Date(body.endTime as string)
            : null
          : existing.endTime;

      if (updatedEnd) {
        const maxEndEdit = new Date(nowEdit.getTime() + 30 * 60 * 1000);
        if (updatedEnd > maxEndEdit) {
          return reply
            .code(400)
            .send({ error: "Endzeit darf max. 30 Minuten in der Zukunft liegen" });
        }
      }

      if (updatedEnd && updatedEnd <= updatedStart) {
        return reply.code(400).send({ error: "Endzeit muss nach der Startzeit liegen" });
      }

      // D-03(b): moving/editing an entry must enforce the SAME invariants POST enforces —
      // target-month snapshot-lock (so an open entry cannot be re-dated into a closed month),
      // one-entry-per-day, retro-window guard (RETRO-01), and overlap — excluding this entry
      // itself. Open-entry conflicts stay scoped to the edited entry's calendar day (v1.8.13).
      //
      // isCorrectionByManager: manager editing a DIFFERENT employee's entry is an inline
      // correction (source=CORRECTION) and is exempt from the retro-window guard (RETRO-05 C6).
      // Manager editing their OWN entry is NOT exempt (C6 parity — same 403 as employee).
      // grantId (Phase 76.29.1 Plan 02): a pre-validated RetroEntryRequest id passed here skips
      // the retro-window guard inside validateTimeEntryInvariants. Lock-first ordering is preserved:
      // the month-lock check runs BEFORE the retro-window/grant skip inside validateTimeEntryInvariants,
      // so an approved grant for a locked month still returns the lock 403 — the grant NEVER bypasses
      // month-lock immutability. The grant is consumed atomically inside the update $transaction below.
      const overlapDate = body.date ? new Date(body.date) : existing.date;
      const overlapTz = await getTenantTimezone(app.prisma, existing.employee.tenantId);
      const putIsCorrectionByManager = isManager && existing.employeeId !== user.employeeId;

      // Quick 260824-cjd — a manager correcting ANOTHER employee's entry must supply a
      // Begründung. Conditional (cannot be a plain Zod field, see updateEntrySchema
      // comment) — enforced here, right after putIsCorrectionByManager is known and
      // after the isLocked gate above, before any other guard runs.
      let putAuditReason: string | undefined;
      if (putIsCorrectionByManager) {
        const putReasonCheck = auditReasonSchema.safeParse(body.reason ?? "");
        if (!putReasonCheck.success) {
          return reply.code(400).send({ error: AUDIT_REASON_REQUIRED });
        }
        putAuditReason = putReasonCheck.data;
      }

      // Phase 96 (RETRO-16/D-10) — employee editing their OWN still-pending coupled
      // Nachtrag entry must not be re-blocked by the retro-window guard (Pitfall 2).
      // Scoped tightly: retroRequestId set + isInvalid=true + the coupled request is
      // still PENDING (verified via the retroRequest include above) + the entry
      // belongs to the ACTOR themselves (a manager correcting a DIFFERENT employee's
      // entry already has its own exemption via putIsCorrectionByManager above — this
      // is specifically the self-edit case, regardless of role, matching C6 parity).
      const isOwnPendingNachtragEdit =
        !!existing.retroRequestId &&
        existing.isInvalid &&
        existing.retroRequest?.status === "PENDING" &&
        existing.employeeId === user.employeeId;

      // Phase 76.29.1 Plan 02 — PUT grant pre-validation (mirrors POST ~:1001–1017).
      // If the caller supplies a grantId, verify an APPROVED RetroEntryRequest exists for
      // (existing.employeeId, effective targetDate) — keyed to the ENTRY's employee, not the
      // caller, so a manager PUT-on-behalf cannot leak a grant from a different employee.
      // Match is against overlapDate (the effective date being written, body.date ?? existing.date).
      // On no match → 403 "Antrag bereits verwendet oder ungültig".
      // Grant consumption is deferred to the $transaction below (atomic with the update).
      let putResolvedGrantId: string | undefined;
      if (body.grantId) {
        const putGrant = await app.prisma.retroEntryRequest.findFirst({
          where: {
            id: body.grantId,
            employeeId: existing.employeeId,
            targetDate: overlapDate,
            status: "APPROVED",
            deletedAt: null,
          },
          select: { id: true },
        });
        if (!putGrant) {
          return reply.code(403).send({ error: "Antrag bereits verwendet oder ungültig" });
        }
        putResolvedGrantId = putGrant.id;
      }

      const invalid = await validateTimeEntryInvariants(app, {
        employeeId: existing.employeeId,
        date: overlapDate,
        dateStr: dateStrInTz(overlapDate, overlapTz),
        newStart: updatedStart,
        newEnd: updatedEnd,
        tz: overlapTz,
        tenantId: existing.employee.tenantId,
        excludeEntryId: id,
        isCorrectionByManager: putIsCorrectionByManager,
        grantId: putResolvedGrantId,
        isOwnPendingEdit: isOwnPendingNachtragEdit,
      });
      if (invalid) {
        if (invalid.error === "RETRO_WINDOW_EXCEEDED") {
          return reply.code(403).send({
            error: invalid.error,
            windowDays: invalid.windowDays,
            entryAgeInDays: invalid.entryAgeInDays,
          });
        }
        const code = invalid.error.includes("abgeschlossen") ? 403 : 409;
        return reply.code(code).send({ error: invalid.error });
      }

      // Phase 63 D-09..D-13 — JArbSchG §9 pre-check for PUT.
      // Runs AFTER existing.isLocked gate (D-13: locked-month immutability wins).
      // Uses merged {existing, body} payload — body wins on overlapping fields.
      // Hard-block: AZUBI < 18 + BS day + planned > 225 min → HTTP 400 BEFORE DB write.
      const editBreakMinutes = body.breaks
        ? Math.round(
            calcBreakMinutes(
              body.breaks.map((b) => ({
                startTime: new Date(b.startTime),
                endTime: new Date(b.endTime),
              })),
            ),
          )
        : (body.breakMinutes ?? existing.breakMinutes ?? 0);
      const editDate = body.date ? new Date(body.date) : existing.date;
      const plannedNetMinPut =
        updatedEnd != null
          ? Math.max(
              0,
              Math.round((updatedEnd.getTime() - updatedStart.getTime()) / 60_000) -
                Number(editBreakMinutes ?? 0),
            )
          : 0;
      const jarbSchgPut = await checkJArbSchG(app.prisma, {
        employeeId: existing.employeeId,
        date: editDate,
        plannedNetWorkMin: plannedNetMinPut,
      });
      if (jarbSchgPut.blocked) {
        return reply
          .code(400)
          .send({ error: "JARBSCHG_MINOR_LIMIT", message: jarbSchgPut.message });
      }

      // Phase 68b (issue #68), D-12: a salon change is validated only when a DIFFERENT salon is
      // requested — the existing.isLocked gate above already rejected locked entries, so the same
      // value is an accepted no-op even if that salon is inactive now (a form that re-sends the
      // current value must not fail; issue #68: an entry keeps its salon when the salon is
      // deactivated later). A change of date or times never re-derives the salon (the Ist-Ort is
      // the truth, no silent re-homing). Runs BEFORE the break-slot block below (its non-grant
      // path deletes+recreates Break rows outside any transaction), so a rejection changes
      // nothing. The existing audit (oldValue: existing, newValue: updated) carries both salon ids
      // unchanged — no audit code change needed.
      let resolvedSalonId: string | undefined;
      if (body.salonId !== undefined && body.salonId !== existing.salonId) {
        const putSalonResolution = await resolveEntrySalon(app.prisma, {
          tenantId: user.tenantId,
          employeeId: existing.employeeId,
          startTime: updatedStart,
          explicitSalonId: body.salonId,
        });
        if (!putSalonResolution.ok) {
          return reply.code(putSalonResolution.status).send(putSalonResolution.body);
        }
        resolvedSalonId = putSalonResolution.salonId;
      }

      // Patch-Objekt explizit aufbauen um TS-Spread-Probleme zu vermeiden
      // Only set source to CORRECTION when a manager edits another employee's entry, OR when a
      // grant-backed edit is performed (putResolvedGrantId present — grant edits are always corrections).
      // putIsCorrectionByManager is already computed above (before the invariant call) —
      // reuse it here so the patch and the retro-window exemption stay in sync.
      const patch: Record<string, unknown> =
        putIsCorrectionByManager || putResolvedGrantId ? { source: "CORRECTION" } : {};
      if (resolvedSalonId !== undefined) patch.salonId = resolvedSalonId; // Phase 68b (issue #68), D-12
      if (body.date) patch.date = new Date(body.date);
      if (body.startTime) patch.startTime = new Date(body.startTime);
      if ("endTime" in body) patch.endTime = body.endTime ? new Date(body.endTime as string) : null;
      if (body.breakMinutes !== undefined && !body.breaks) patch.breakMinutes = body.breakMinutes;
      if ("note" in body) patch.note = body.note ?? null;
      // Phase 91 (BREAK-01): human edited the break -> CONFIRMED (runs after the isLocked
      // gate above, so locked entries never reach this point).
      if (body.breaks !== undefined || body.breakMinutes !== undefined) {
        patch.breakStatus = "CONFIRMED";
      }

      // Auto-revalidate: if endTime is now set and entry was invalid due to missing clock-out
      if (updatedEnd && existing.isInvalid && existing.invalidReasonCode === "MISSING_CLOCK_OUT") {
        patch.isInvalid = false;
        Object.assign(patch, CLEARED_INVALID_REASON);
      }
      // Phase 96 (RETRO-16/D-10): a pending Nachtrag edit (isOwnPendingNachtragEdit) is
      // intentionally NOT auto-revalidated here — the code check above matches ONLY
      // MISSING_CLOCK_OUT, never RETRO_APPROVAL_PENDING. Since these are two distinct
      // enum values, the non-collision is now structural rather than a claim about two
      // strings that happen to differ. `isInvalid`/`retroRequestId` are never set in
      // `patch` for this case, so the update preserves both — the entry stays pending
      // until a manager decides via PATCH /retro-entry-requests/:id/review. Do not add
      // an isInvalid-clearing branch here for the Nachtrag reason without going through
      // that endpoint (Elevation-of-Privilege guard, T-96-12).

      // Handle break slots update (non-grant path: runs before the update, as before)
      // For the grant path, break-slots are handled inside the $transaction below.
      let newBreakSlotsForTx: { timeEntryId: string; startTime: Date; endTime: Date }[] | undefined;
      if (body.breaks) {
        const newBreakSlots = body.breaks.map((b) => ({
          timeEntryId: id,
          startTime: new Date(b.startTime),
          endTime: new Date(b.endTime),
        }));
        // Validate break slots before persisting (same for both paths)
        const breakError = validateBreakSlots(
          newBreakSlots.map((b) => ({ startTime: b.startTime, endTime: b.endTime })),
          updatedStart,
          updatedEnd,
        );
        if (breakError) return reply.code(400).send({ error: breakError });
        // Recalculate breakMinutes from the new break slots (same for both paths)
        patch.breakMinutes = Math.round(
          calcBreakMinutes(
            newBreakSlots.map((b) => ({ startTime: b.startTime, endTime: b.endTime })),
          ),
        );
        if (putResolvedGrantId) {
          // Defer to the tx below so the whole correction is atomic
          newBreakSlotsForTx = newBreakSlots;
        } else {
          // Non-grant path: delete existing breaks and create new ones outside tx (as before)
          await app.prisma.break.deleteMany({ where: { timeEntryId: id } });
          if (newBreakSlots.length > 0) {
            await app.prisma.break.createMany({ data: newBreakSlots });
          }
        }
      }

      // Phase 76.29.1 Plan 02 — race-safe single-use grant consumption on PUT.
      // When a putResolvedGrantId is present, the TimeEntry update + grant flip + audit run
      // inside one $transaction, mirroring the POST grant path (~:1095–1134).
      // The conditional updateMany (WHERE status=APPROVED) ensures exactly one concurrent PUT
      // wins — if count !== 1 the tx rolls back (GRANT_ALREADY_USED → 403).
      // Break-slot mutations are also pulled into the tx so the entire correction is atomic.
      // When no grant: keep the existing non-transactional update path byte-identical.
      let updated: Awaited<ReturnType<typeof app.prisma.timeEntry.update>>;
      try {
        if (putResolvedGrantId) {
          const grantIdForTx = putResolvedGrantId;
          const effectiveDateStr = dateStrInTz(overlapDate, overlapTz);
          const result = await app.prisma.$transaction(async (tx) => {
            // Break-slot replacement inside the tx (atomic with the update)
            if (newBreakSlotsForTx !== undefined) {
              await tx.break.deleteMany({ where: { timeEntryId: id } });
              if (newBreakSlotsForTx.length > 0) {
                await tx.break.createMany({ data: newBreakSlotsForTx });
              }
            }

            const txUpdated = await tx.timeEntry.update({
              where: { id },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              data: patch as any,
              include: { breaks: { orderBy: { startTime: "asc" } } },
            });

            // Conditional flip: only succeeds if still APPROVED (single-use guard).
            const consumed = await tx.retroEntryRequest.updateMany({
              where: { id: grantIdForTx, status: "APPROVED" },
              data: { status: "USED" },
            });
            if (consumed.count !== 1) {
              throw new Error("GRANT_ALREADY_USED");
            }

            await app.audit({
              userId: user.sub,
              action: "RETRO_ENTRY_APPROVED_USED",
              entity: "RetroEntryRequest",
              entityId: grantIdForTx,
              newValue: {
                timeEntryId: id,
                employeeId: existing.employeeId,
                date: effectiveDateStr,
              },
              tx,
            });

            return txUpdated;
          });
          updated = result;
        } else {
          updated = await app.prisma.timeEntry.update({
            where: { id },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data: patch as any,
            include: { breaks: { orderBy: { startTime: "asc" } } },
          });
        }
      } catch (err) {
        if (err instanceof Error && err.message === "GRANT_ALREADY_USED") {
          return reply.code(403).send({ error: "Antrag bereits verwendet oder ungültig" });
        }
        throw err;
      }

      await updateOvertimeAccount(app, existing.employeeId);

      const warnings = await checkArbZG(app.prisma, existing.employeeId, existing.date);

      // Phase 63 D-12 — append JArbSchG soft-warn + audit-log row.
      if (jarbSchgPut.softWarn) {
        warnings.push(jarbSchgPut.softWarn);
        await app.audit({
          userId: user.sub,
          action: "JARBSCHG_SOFT_WARN",
          entity: "TimeEntry",
          entityId: id,
          oldValue: null,
          newValue: { plannedNetWorkMin: plannedNetMinPut, bsDay: true },
        });
      }

      await app.audit({
        userId: user.sub,
        action: putIsCorrectionByManager ? "MANAGER_CORRECTION" : "UPDATE",
        entity: "TimeEntry",
        entityId: id,
        oldValue: existing,
        // Quick 260824-cjd: auditReason only on the MANAGER_CORRECTION branch — the
        // plain self-edit UPDATE path never carries one.
        newValue: putIsCorrectionByManager ? { ...updated, auditReason: putAuditReason } : updated,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      // Auto-dismiss CLOCK_OUT_REMINDER when open entry is closed via PATCH
      if (existing.endTime === null && updated.endTime !== null) {
        try {
          await app.dismissByRelated("TimeEntry", id);
        } catch (err) {
          app.log.warn(
            { err, timeEntryId: id },
            "Failed to auto-dismiss CLOCK_OUT_REMINDER on entry update",
          );
        }
      }

      // Phase 96 (RETRO-16/D-10) — re-notify the approver(s): editing an own
      // still-pending Nachtrag stays pending, but the manager should learn the
      // proposed times changed (net-new call site — no prior notify wiring existed
      // for RetroEntryRequest, Pitfall 3). Mirrors the BREAK_COMPLIANCE_ALERT
      // manager-iteration precedent (:2042-2052), skipping the actor.
      if (isOwnPendingNachtragEdit && existing.retroRequestId) {
        try {
          // Phase 75b Plan 10 (#75), D-16: holders of retro-request:approve replace the legacy
          // A,M role predicate — the recorded recipient set is unchanged.
          const retroUpdatedApproveHolderIds = await userIdsHoldingPermission(
            app.prisma,
            existing.employee.tenantId,
            "retro-request:approve:ZUGEWIESEN",
          );
          // Phase 91b Plan 09 (Issue #91), D-10/D-17: same rule as the submit-notify site above.
          const scopedRetroUpdatedApproveHolderIds = await resolveScopedHolderIds(
            app.prisma,
            existing.employee.tenantId,
            retroUpdatedApproveHolderIds,
            "retro-request:approve:ZUGEWIESEN",
            (reach) =>
              isStammsalonScopeMatch(
                app.prisma,
                existing.employee.tenantId,
                reach,
                existing.employeeId,
                existing.date,
              ),
          );
          const editManagers = await app.prisma.employee.findMany({
            where: {
              tenantId: existing.employee.tenantId,
              user: { isActive: true, id: { in: scopedRetroUpdatedApproveHolderIds } },
            },
            include: { user: { select: { id: true } } },
          });
          for (const mgr of editManagers) {
            if (mgr.user.id === user.sub) continue; // don't self-notify
            await app.notify({
              userId: mgr.user.id,
              type: "RETRO_ENTRY_UPDATED",
              title: "Zeitnachtrag geändert",
              message: `${existing.employee.firstName} ${existing.employee.lastName} hat einen Zeitnachtrag geändert. Er wartet weiter auf Genehmigung.`,
              link: "/inbox",
              tenantId: existing.employee.tenantId,
              relatedType: "RetroEntryRequest",
              relatedId: existing.retroRequestId,
            });
          }
        } catch (err) {
          app.log.warn(
            { err, timeEntryId: id },
            "Failed to re-notify approvers on pending Nachtrag edit",
          );
        }
      }

      return { entry: updated, warnings };
    },
  });

  // PATCH /api/v1/time-entries/:id/revalidate  (Admin/Manager setzt isInvalid zurück)
  // Optionally accepts startTime, endTime, breakMinutes to correct the entry in one step
  const revalidateSchema = z.object({
    startTime: z.string().datetime().optional(),
    endTime: z.string().datetime().optional().nullable(),
    breakMinutes: z.number().int().min(0).optional(),
    note: z.string().optional().nullable(),
  });

  app.patch("/:id/revalidate", {
    schema: { tags: ["Zeiterfassung"], security: [{ bearerAuth: [] }] },
    preHandler: requirePermission("time-entry:revalidate:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = revalidateSchema.parse(req.body ?? {});
      const user = req.user;

      const existing = await app.prisma.timeEntry.findUnique({
        where: { id },
        include: { employee: { select: { tenantId: true } } },
      });
      if (!existing || existing.deletedAt)
        return reply.code(404).send({ error: "Eintrag nicht gefunden" });

      // Tenant isolation
      if (existing.employee.tenantId !== user.tenantId) {
        return reply.code(404).send({ error: "Eintrag nicht gefunden" });
      }

      // Phase 91b Plan 03 (#91), D-09/D-14: this route is ZUGEWIESEN-only (preHandler above) — the
      // reach may still be scoped to salons/persons, enforce it on the entry already fetched above.
      if (
        !(await enforceTimeEntryScope(
          app,
          req,
          reply,
          existing,
          "time-entry:revalidate:ZUGEWIESEN",
          "Eintrag nicht gefunden",
        ))
      ) {
        return;
      }

      if (!existing.isInvalid)
        return reply.code(400).send({ error: "Eintrag ist nicht invalidiert" });

      // Gesperrte Einträge dürfen nicht revalidiert werden
      if (existing.isLocked) {
        return reply
          .code(403)
          .send({ error: "Eintrag ist gesperrt und kann nicht bearbeitet werden" });
      }

      // Build update data: always revalidate, optionally correct times
      const updateData: Prisma.TimeEntryUpdateInput = {
        isInvalid: false,
        ...CLEARED_INVALID_REASON,
      };

      const hasCorrection =
        body.startTime || body.endTime !== undefined || body.breakMinutes !== undefined;
      if (hasCorrection) {
        updateData.source = "CORRECTION";
        if (body.startTime) updateData.startTime = new Date(body.startTime);
        if (body.endTime !== undefined) {
          updateData.endTime = body.endTime ? new Date(body.endTime) : null;
        }
        if (body.breakMinutes !== undefined) updateData.breakMinutes = body.breakMinutes;

        // Validate times
        const newStart = body.startTime ? new Date(body.startTime) : existing.startTime;
        const newEnd =
          body.endTime !== undefined
            ? body.endTime
              ? new Date(body.endTime)
              : null
            : existing.endTime;

        if (newEnd && newEnd <= newStart) {
          return reply.code(400).send({ error: "Endzeit muss nach der Startzeit liegen" });
        }

        // Overlap check — scope open-entry conflicts to this entry's day (v1.8.13).
        const revalidateTz = await getTenantTimezone(app.prisma, existing.employee.tenantId);
        const overlap = await checkOverlap(
          app.prisma,
          existing.employeeId,
          newStart,
          newEnd,
          id,
          existing.date,
          revalidateTz,
        );
        if (overlap) return reply.code(409).send({ error: overlap });
      }
      if ("note" in body) updateData.note = body.note ?? null;

      const updated = await app.prisma.timeEntry.update({
        where: { id },
        data: updateData,
        include: { breaks: { orderBy: { startTime: "asc" } } },
      });

      await updateOvertimeAccount(app, existing.employeeId);

      await app.audit({
        userId: user.sub,
        action: hasCorrection ? "MANAGER_CORRECTION" : "REVALIDATE",
        entity: "TimeEntry",
        entityId: id,
        oldValue: existing,
        newValue: updated,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return updated;
    },
  });

  // DELETE /api/v1/time-entries/:id
  app.delete("/:id", {
    schema: { tags: ["Zeiterfassung"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const user = req.user;
      // Feeds both the ownership check below and deleteIsCorrectionByManager (issue #75, D-13)
      const deleteReach = await permissionReach(req, "time-entry:delete");
      const isManager = deleteReach === "ZUGEWIESEN";

      const existing = await app.prisma.timeEntry.findUnique({
        where: { id },
        include: { employee: { select: { tenantId: true } } },
      });
      if (!existing || existing.deletedAt)
        return reply.code(404).send({ error: "Eintrag nicht gefunden" });

      // Tenant isolation: reject cross-tenant deletes
      if (existing.employee.tenantId !== user.tenantId) {
        return reply.code(404).send({ error: "Eintrag nicht gefunden" });
      }

      if (!isManager && existing.employeeId !== user.employeeId) {
        return reply.code(403).send({ error: "Kein Zugriff" });
      }
      if (deleteReach === null) {
        return reply.code(403).send({ error: "Kein Zugriff" });
      }

      // Phase 91b Plan 03 (#91), D-09/D-14: a ZUGEWIESEN reach acting on someone else's entry may
      // still be scoped to salons/persons — enforce it, same 404 as a non-existent id, on the
      // entry already fetched above.
      if (isManager && existing.employeeId !== user.employeeId) {
        if (
          !(await enforceTimeEntryScope(
            app,
            req,
            reply,
            existing,
            "time-entry:delete:ZUGEWIESEN",
            "Eintrag nicht gefunden",
          ))
        ) {
          return;
        }
      }

      if (existing.isLocked) {
        return reply
          .code(403)
          .send({ error: "Eintrag ist gesperrt und kann nicht gelöscht werden" });
      }

      // Retro-window guard for DELETE (RETRO-01 / RETRO-05).
      // Must run AFTER isLocked (lock wins — C2): a locked-month entry returns the lock message,
      // never RETRO_WINDOW_EXCEEDED. DELETE does NOT call validateTimeEntryInvariants (no
      // newStart/newEnd), so the guard is applied inline here.
      // Exemption: MANAGER deleting a DIFFERENT employee's entry = inline correction (exempt).
      // MANAGER deleting their OWN old entry is blocked (parity with employee self-service).
      const deleteTz = await getTenantTimezone(app.prisma, existing.employee.tenantId);
      const deleteDateStr = dateStrInTz(existing.date, deleteTz);
      const deleteIsCorrectionByManager = isManager && existing.employeeId !== user.employeeId;
      if (!deleteIsCorrectionByManager) {
        const deleteWindowDays = await getRetroEntryWindowDays(
          app.prisma,
          existing.employee.tenantId,
        );
        const deleteRetroLimitStr = computeRetroLimitStr(deleteTz, deleteWindowDays);
        if (deleteDateStr < deleteRetroLimitStr) {
          const deleteTodayStr = dateStrInTz(todayInTz(deleteTz), deleteTz);
          const deleteEntryAgeInDays = computeEntryAgeInDays(deleteTodayStr, deleteDateStr);
          return reply.code(403).send({
            error: "RETRO_WINDOW_EXCEEDED",
            windowDays: deleteWindowDays,
            entryAgeInDays: deleteEntryAgeInDays,
          });
        }
      }

      // Quick 260824-cjd: parsed AFTER 404/403/isLocked/retro-window guards so a bad-
      // reason 400 never leaks the existence of a foreign/locked/out-of-window entry.
      const { reason } = z.object({ reason: auditReasonSchema }).parse(req.body);

      // Soft delete instead of hard delete
      await app.prisma.timeEntry.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      await updateOvertimeAccount(app, existing.employeeId);

      await app.audit({
        userId: user.sub,
        action: "DELETE",
        entity: "TimeEntry",
        entityId: id,
        oldValue: existing,
        newValue: { auditReason: reason },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return reply.code(204).send();
    },
  });

  // PATCH /api/v1/time-entries/:id/break-status  (Phase 91 — BREAK-01/BREAK-03/BREAK-04)
  // Confirm/waive an auto-inserted break (BAG 12.02.2025, 5 AZR 51/24 — an automatic break
  // deduction alone does not prove the break was taken). `waive` ("durchgearbeitet") zeroes the
  // break out and marks the time worked/payable — see the audit-proof guards below.
  app.patch("/:id/break-status", {
    schema: { tags: ["Zeiterfassung"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const { action, reason } = breakStatusSchema.parse(req.body);
      const user = req.user;

      const entry = await app.prisma.timeEntry.findFirst({
        where: { id, deletedAt: null },
        include: {
          employee: { select: { tenantId: true, userId: true, firstName: true, lastName: true } },
        },
      });
      if (!entry) return reply.code(404).send({ error: "Eintrag nicht gefunden" });

      // Tenant isolation (fetch-then-compare, existing idiom — no existence leak on 404).
      if (entry.employee.tenantId !== user.tenantId) {
        await app.audit({
          userId: user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "TimeEntry",
          entityId: id,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "Eintrag nicht gefunden" });
      }

      // Owner or a caller holding time-entry:update:ZUGEWIESEN.
      const breakStatusReach = await permissionReach(req, "time-entry:update");
      if (breakStatusReach !== "ZUGEWIESEN" && entry.employeeId !== user.employeeId) {
        return reply.code(403).send({ error: "Kein Zugriff" });
      }
      if (breakStatusReach === null) {
        return reply.code(403).send({ error: "Kein Zugriff" });
      }

      // Phase 91b Plan 03 (#91), D-09/D-14: a ZUGEWIESEN reach acting on someone else's entry may
      // still be scoped to salons/persons — enforce it, same 404 as a non-existent id, on the
      // entry already fetched above.
      if (breakStatusReach === "ZUGEWIESEN" && entry.employeeId !== user.employeeId) {
        if (
          !(await enforceTimeEntryScope(
            app,
            req,
            reply,
            entry,
            "time-entry:update:ZUGEWIESEN",
            "Eintrag nicht gefunden",
          ))
        ) {
          return;
        }
      }

      // Lock wins (Revisionssicherheit) — checked BEFORE any write, even for admins.
      if (entry.isLocked) {
        return reply
          .code(409)
          .send({ error: "Eintrag ist gesperrt und kann nicht bearbeitet werden" });
      }

      const oldStatus = entry.breakStatus;

      if (action === "confirm") {
        // Idempotent — allowed from any non-locked state.
        const updated = await app.prisma.timeEntry.update({
          where: { id },
          data: { breakStatus: "CONFIRMED" },
          include: { breaks: { orderBy: { startTime: "asc" } } },
        });
        await app.audit({
          userId: user.sub,
          action: "BREAK_CONFIRMED",
          entity: "TimeEntry",
          entityId: id,
          oldValue: { breakStatus: oldStatus },
          newValue: { breakStatus: "CONFIRMED" },
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        // Phase 92 (BREAK-06): clear the employee BREAK_UNCONFIRMED nudge for this entry.
        // Type-scoped so the manager BREAK_COMPLIANCE_ALERT (same relatedId) is never touched.
        await app.dismissByRelated("TimeEntry", id, "BREAK_UNCONFIRMED");
        return { entry: updated };
      }

      // action === "waive" — "durchgearbeitet": no break taken, time is really worked and
      // therefore payable. No manager approval required (LOCKED Decision 5).
      //
      // "Durchgearbeitet" answers the auto-inserted-break nudge (Decision 5); it may ONLY be
      // declared for an AUTO entry. A CONFIRMED day already carries the employee's affirmed real
      // breaks — the waive shortcut must not silently hard-delete those (Revisionssicherheit,
      // WR-02). An already-WAIVED entry is likewise rejected (no repeat waive → no duplicate
      // manager alerts).
      if (oldStatus !== "AUTO") {
        return reply.code(409).send({
          error: "Durchgearbeitet kann nur für eine automatisch eingetragene Pause erklärt werden.",
        });
      }

      // Capture the exact pre-waive break slots BEFORE deletion. Break is not a soft-delete model,
      // so these rows are gone after deleteMany — the audit oldValue is the only reconstruction
      // path for a later "durchgearbeitet" dispute (Revisionssicherheit, WR-01).
      const priorBreaks = await app.prisma.break.findMany({
        where: { timeEntryId: id },
        select: { id: true, startTime: true, endTime: true },
      });
      await app.prisma.break.deleteMany({ where: { timeEntryId: id } });
      const updated = await app.prisma.timeEntry.update({
        where: { id },
        data: { breakStatus: "WAIVED", breakMinutes: 0, breakWaivedReason: reason ?? null },
        include: { breaks: true },
      });
      await app.audit({
        userId: user.sub,
        action: "BREAK_WAIVED",
        entity: "TimeEntry",
        entityId: id,
        oldValue: {
          breakStatus: oldStatus,
          breakMinutes: entry.breakMinutes,
          breaks: priorBreaks,
        },
        newValue: { breakStatus: "WAIVED", breakMinutes: 0, breakWaivedReason: reason ?? null },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      // Phase 92 (BREAK-06): clear the employee BREAK_UNCONFIRMED nudge for this entry.
      // Type-scoped so it never dismisses the manager BREAK_COMPLIANCE_ALERT emitted below
      // (this call's or any pre-existing one for the same entry).
      await app.dismissByRelated("TimeEntry", id, "BREAK_UNCONFIRMED");

      // 0-ing the break changes net worked time — every other break-mutating path recomputes.
      await updateOvertimeAccount(app, entry.employeeId);

      // Manager alert: also emails via the toggle field emailOnMissingEntries — see the
      // explicit BREAK_COMPLIANCE_ALERT policy entry in
      // apps/api/src/utils/notification-email-policy.ts (quick-260825-k3g).
      // Phase 75b Plan 10 (#75), D-16: holders of team-overview:read replace the legacy A,M role
      // predicate — the recorded recipient set is unchanged.
      const breakComplianceTeamOverviewHolderIds = await userIdsHoldingPermission(
        app.prisma,
        entry.employee.tenantId,
        "team-overview:read:ZUGEWIESEN",
      );
      // Phase 91b Plan 09 (Issue #91), D-09/D-17: `entry` is a TimeEntry — the entry's own
      // salon/employee/date is the scope resource (same rule as attendance-checker.ts's
      // OPEN_ENTRY_INVALIDATED site).
      const scopedBreakComplianceTeamOverviewHolderIds = await resolveScopedHolderIds(
        app.prisma,
        entry.employee.tenantId,
        breakComplianceTeamOverviewHolderIds,
        "team-overview:read:ZUGEWIESEN",
        (reach) =>
          isTimeEntryInScope(app.prisma, entry.employee.tenantId, reach, {
            salonId: entry.salonId,
            employeeId: entry.employeeId,
            date: entry.date,
          }),
      );
      const managers = await app.prisma.employee.findMany({
        where: {
          tenantId: entry.employee.tenantId,
          user: { isActive: true, id: { in: scopedBreakComplianceTeamOverviewHolderIds } },
        },
        include: { user: { select: { id: true } } },
      });
      for (const mgr of managers) {
        if (mgr.user.id === entry.employee.userId) continue; // don't self-notify
        await app.notify({
          userId: mgr.user.id,
          type: "BREAK_COMPLIANCE_ALERT",
          title: "Pause als „durchgearbeitet“ erklärt",
          message: `${entry.employee.firstName} ${entry.employee.lastName} hat für einen Tag „durchgearbeitet – keine Pause“ erklärt.`,
          link: `/time-entries?highlight=${id}`,
          tenantId: entry.employee.tenantId,
          relatedType: "TimeEntry",
          relatedId: id,
        });
      }

      return { entry: updated };
    },
  });
}
