import { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash } from "crypto";
import { requireAuth, requireRole } from "../middleware/auth";
import { TimeEntrySource, Prisma } from "@clokr/db";
import { checkArbZG } from "../utils/arbzg";
import { checkJArbSchG } from "../utils/jarbschg";
import { getVocationalSchoolMinutesForDate } from "../utils/vocational-school-saldo";
import { getEffectiveBreakDuration } from "../utils/break-effective";
import {
  getTenantTimezone,
  todayInTz,
  dateStrInTz,
  monthRangeUtc,
  calcExpectedMinutesTz,
  calcLeaveAbsenceMinutesTz,
  getDayOfWeekInTz,
  getDayHoursFromSchedule,
} from "../utils/timezone";
import { getHolidays, STATE_MAP } from "../utils/holidays";
import { hasApprovedLeaveOnDate } from "../utils/leave-check";
import { resolveClockEvent } from "../services/clock/resolver";
import { resolveActor } from "../services/clock/audit-actor";
import type { ClockEvent } from "../services/clock/types";

const nfcPunchSchema = z.object({
  nfcCardId: z.string().min(1),
});

const clockInSchema = z.object({
  employeeId: z.string().uuid().optional(), // optional: Manager kann für andere stempeln
  nfcCardId: z.string().optional(),
  source: z.nativeEnum(TimeEntrySource).default("MANUAL"),
  note: z.string().optional(),
});

const clockOutSchema = z.object({
  breakMinutes: z.number().int().min(0).default(0),
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
});

const idParamSchema = z.object({ id: z.string().uuid() });

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

// ── Überlappungsprüfung ────────────────────────────────────────────────────────
// entryDate (optional): the calendar date of the entry being created/updated.
// An open entry (endTime = null) has no natural upper bound, so it must only be
// treated as "still running" for conflict purposes ON ITS OWN DAY. Without this
// scoping a single stale open entry (e.g. a forgotten clock-out) would be treated
// as running until year 9999 and would block creating OR editing entries on any
// later day — even in a following month (v1.8.13 cross-day/cross-month fix).
// Closed entries that legitimately span midnight are still caught by the
// { endTime: { gt: startTime } } branch, which is not date-scoped.
//
// tz (optional): tenant timezone used to format the conflict message. The server
// container runs in UTC, so without it the message printed times in UTC with no
// date — making a cross-month conflict impossible for the user to identify.
async function checkOverlap(
  app: FastifyInstance,
  employeeId: string,
  startTime: Date,
  endTime: Date | null,
  excludeId?: string,
  entryDate?: Date,
  tz?: string,
): Promise<string | null> {
  // Kein endTime = offener Eintrag → als "läuft noch" behandeln
  const effectiveEnd = endTime ?? new Date("9999-12-31");

  // When the entry date is known, only open entries on the SAME calendar date
  // count as an active conflict. Fall back to the original broad match otherwise.
  const openEntryCondition: Prisma.TimeEntryWhereInput = entryDate
    ? { endTime: null, date: entryDate }
    : { endTime: null };

  const overlapping = await app.prisma.timeEntry.findFirst({
    where: {
      employeeId,
      deletedAt: null,
      id: excludeId ? { not: excludeId } : undefined,
      startTime: { lt: effectiveEnd },
      OR: [
        openEntryCondition, // offener Eintrag am selben Tag läuft noch
        { endTime: { gt: startTime } }, // abgeschlossener Eintrag endet nach neuem Start
      ],
    },
  });

  if (!overlapping) return null;

  // Include the date (and format in the tenant tz) so the user can identify the
  // conflicting entry — critical when it is a stale open entry from another day.
  const dateOpts: Intl.DateTimeFormatOptions = {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    ...(tz ? { timeZone: tz } : {}),
  };
  const timeOpts: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
    ...(tz ? { timeZone: tz } : {}),
  };
  const dateLabel = overlapping.startTime.toLocaleDateString("de-DE", dateOpts);
  const fmt = (d: Date | null) => (d ? d.toLocaleTimeString("de-DE", timeOpts) : "läuft");
  return `Überschneidung mit bestehendem Eintrag vom ${dateLabel} (${fmt(overlapping.startTime)} – ${fmt(overlapping.endTime)})`;
}

// Shared time-entry invariants enforced by POST /time-entries, PUT /time-entries/:id
// and the CSV import (POST /imports/time-entries). Extracting them here (D-01/D-03)
// guarantees the three write paths cannot drift: one-entry-per-day, month-lock via
// SaldoSnapshot, and overlap — all with self-exclusion for edits.
// Returns { error } (German, byte-identical to the POST handler's messages) or null.
// Callers map the "abgeschlossen" (month-lock) error to HTTP 403 and everything else to 409.
export async function validateTimeEntryInvariants(
  app: FastifyInstance,
  params: {
    employeeId: string;
    date: Date; // calendar date (midnight) used for one-per-day + month key
    dateStr: string; // YYYY-MM-DD in tenant TZ, used for logging/consistency
    newStart: Date;
    newEnd: Date | null;
    tz: string;
    excludeEntryId?: string;
  },
): Promise<{ error: string } | null> {
  const { employeeId, date, newStart, newEnd, tz, excludeEntryId } = params;

  // 1. one-per-day (mirror POST) — exclude self when editing
  const existingEntry = await app.prisma.timeEntry.findFirst({
    where: {
      employeeId,
      deletedAt: null,
      date,
      ...(excludeEntryId ? { id: { not: excludeEntryId } } : {}),
    },
  });
  if (existingEntry) {
    return {
      error:
        "Es existiert bereits ein Eintrag für diesen Tag. Bitte den bestehenden Eintrag bearbeiten.",
    };
  }

  // 2. month-lock via SaldoSnapshot (mirror POST) — authoritative even with no entries
  const { start: lockedMonthStart } = monthRangeUtc(date.getFullYear(), date.getMonth() + 1, tz);
  const lockedSnapshot = await app.prisma.saldoSnapshot.findUnique({
    where: {
      employeeId_periodType_periodStart: {
        employeeId,
        periodType: "MONTHLY",
        periodStart: lockedMonthStart,
      },
    },
    select: { id: true },
  });
  if (lockedSnapshot) {
    return { error: "Monat ist abgeschlossen und kann nicht bearbeitet werden" };
  }

  // 3. overlap (mirror POST) — preserve v1.8.13 same-day open-entry scoping + tz message
  const overlap = await checkOverlap(app, employeeId, newStart, newEnd, excludeEntryId, date, tz);
  if (overlap) {
    return { error: overlap };
  }

  return null;
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
        return reply.code(409).send({ error: "Konflikt", resolution });
      }

      const getBalance = async () => {
        const account = await app.prisma.overtimeAccount.findFirst({
          where: { employeeId: employee.id },
        });
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

      if (resolution.kind !== "CLOCKED_OUT" && resolution.kind !== "CONSOLIDATED") {
        app.log.error({ resolution }, "nfc_punch_unexpected_resolution_kind");
        return reply.code(500).send({ error: "Interner Serverfehler" });
      }

      // CLOCKED_OUT or CONSOLIDATED — post-resolution side effects (auto-break — Phase 64 preserved)
      const clockedOutEntryId = resolution.entry.id;
      const existingBreaks = await app.prisma.break.findMany({
        where: { timeEntryId: clockedOutEntryId },
      });
      const manualBreakMin = existingBreaks.reduce(
        (s, b) => s + Math.round((b.endTime.getTime() - b.startTime.getTime()) / 60000),
        0,
      );
      if (manualBreakMin === 0) {
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
              await app.prisma.timeEntry.update({
                where: { id: clockedOutEntryId },
                data: { breakMinutes: autoBreakMin },
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
        const emp = await app.prisma.employee.findUnique({ where: { nfcCardId: body.nfcCardId } });
        if (!emp) return reply.code(404).send({ error: "NFC Karte nicht gefunden" });
        employeeId = emp.id;
      }
      if (!employeeId) return reply.code(400).send({ error: "Mitarbeiter nicht gefunden" });
      // D-04: EMPLOYEE may only clock themselves in (not on behalf of others)
      const isOnBehalfOf = !!body.employeeId && body.employeeId !== user.employeeId;
      if (isOnBehalfOf && user.role === "EMPLOYEE") {
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
        return reply.code(409).send({ error: "Konflikt", resolution });
      }

      if (resolution.kind !== "CLOCKED_OUT" && resolution.kind !== "CONSOLIDATED") {
        app.log.error({ resolution }, "clock_out_unexpected_resolution_kind");
        return reply.code(500).send({ error: "Interner Serverfehler" });
      }

      const closedEntryId = resolution.entry.id;

      // ── Post-resolution side effects (adapter — explicitly out of resolver scope per CONTEXT D-05) ──
      const initialBreakMinutes = body.breakMinutes ?? 0;
      if (initialBreakMinutes > 0) {
        await app.prisma.timeEntry.update({
          where: { id: closedEntryId },
          data: { breakMinutes: initialBreakMinutes, note: body.note },
        });
      } else {
        // Auto-break (Phase 64 contract — preserved verbatim).
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
              await app.prisma.timeEntry.update({
                where: { id: closedEntryId },
                data: { breakMinutes: autoBreakMin },
              });
            }
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
      if (!entry) return reply.code(404).send({ error: "Eintrag nicht gefunden" });

      // Multi-tenancy: cross-tenant access is not allowed.
      if (entry.employee.tenantId !== user.tenantId) {
        return reply.code(403).send({ error: "Kein Zugriff" });
      }

      // Only the entry's owner or a manager/admin may append breaks.
      const isManager = user.role === "MANAGER" || user.role === "ADMIN";
      if (!isManager && entry.employeeId !== user.employeeId) {
        return reply.code(403).send({ error: "Kein Zugriff" });
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
        data: { breakMinutes: totalBreakMin },
      });

      await app.audit({
        userId: user.sub,
        action: "BREAK_APPEND",
        entity: "Break",
        entityId: created.id,
        newValue: { timeEntryId: id, startTime: created.startTime, endTime: created.endTime },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return { success: true, break: created, breakMinutes: totalBreakMin };
    },
  });

  // GET /api/v1/time-entries  (eigene oder alle für Manager)
  app.get("/", {
    schema: { tags: ["Zeiterfassung"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req) => {
      const { from, to, employeeId } = req.query as {
        from?: string;
        to?: string;
        employeeId?: string;
      };

      const user = req.user;
      const isManager = ["ADMIN", "MANAGER"].includes(user.role);

      const entries = await app.prisma.timeEntry.findMany({
        where: {
          // Tenant isolation: always scope to the requesting user's tenant via employee.tenantId
          employee: { tenantId: user.tenantId },
          employeeId: isManager && employeeId ? employeeId : (user.employeeId ?? undefined),
          deletedAt: null,
          date: {
            gte: from ? new Date(from) : undefined,
            lte: to ? new Date(to) : undefined,
          },
        },
        include: {
          employee: { select: { firstName: true, lastName: true } },
          breaks: { orderBy: { startTime: "asc" } },
        },
        orderBy: { date: "desc" },
      });

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
      const isManager = ["ADMIN", "MANAGER"].includes(user.role);

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
        return reply.code(409).send({
          error: `§ 8 BUrlG: An diesem Tag ist ${manualLeave.type} genehmigt. Bitte zuerst stornieren.`,
        });
      }

      // Zeitvalidierung
      if (newEnd && newEnd <= newStart) {
        return reply.code(400).send({ error: "Endzeit muss nach der Startzeit liegen" });
      }

      // Shared invariants (D-01/D-03): one-entry-per-day, month-lock via SaldoSnapshot,
      // and overlap — extracted into validateTimeEntryInvariants so the CSV import and
      // PUT enforce the identical guards. Month-lock → 403, everything else → 409
      // (preserves the exact HTTP codes and German messages this handler used inline).
      const invariantError = await validateTimeEntryInvariants(app, {
        employeeId,
        date: new Date(body.date),
        dateStr: entryDateStr,
        newStart,
        newEnd,
        tz,
      });
      if (invariantError) {
        const code = invariantError.error.includes("abgeschlossen") ? 403 : 409;
        return reply.code(code).send({ error: invariantError.error });
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

      let entry: Awaited<ReturnType<typeof app.prisma.timeEntry.create>>;
      try {
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
            invalidReason: manualLeave ? "Urlaubsstornierung ausstehend" : null,
          },
        });
      } catch (err: unknown) {
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

            await app.prisma.timeEntry.update({
              where: { id: entry.id },
              data: { breakMinutes: autoBreakMin },
            });
            // Update entry object for response
            entry.breakMinutes = autoBreakMin;
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
      const isManager = ["ADMIN", "MANAGER"].includes(user.role);

      const existing = await app.prisma.timeEntry.findUnique({
        where: { id },
        include: { employee: { select: { tenantId: true } } },
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
      // one-entry-per-day, and overlap — excluding this entry itself. Open-entry conflicts stay
      // scoped to the edited entry's calendar day (v1.8.13).
      const overlapDate = body.date ? new Date(body.date) : existing.date;
      const overlapTz = await getTenantTimezone(app.prisma, existing.employee.tenantId);
      const invalid = await validateTimeEntryInvariants(app, {
        employeeId: existing.employeeId,
        date: overlapDate,
        dateStr: dateStrInTz(overlapDate, overlapTz),
        newStart: updatedStart,
        newEnd: updatedEnd,
        tz: overlapTz,
        excludeEntryId: id,
      });
      if (invalid) {
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

      // Patch-Objekt explizit aufbauen um TS-Spread-Probleme zu vermeiden
      // Only set source to CORRECTION when a manager edits another employee's entry
      const isCorrectionByManager = isManager && existing.employeeId !== user.employeeId;
      const patch: Record<string, unknown> = isCorrectionByManager ? { source: "CORRECTION" } : {};
      if (body.date) patch.date = new Date(body.date);
      if (body.startTime) patch.startTime = new Date(body.startTime);
      if ("endTime" in body) patch.endTime = body.endTime ? new Date(body.endTime as string) : null;
      if (body.breakMinutes !== undefined && !body.breaks) patch.breakMinutes = body.breakMinutes;
      if ("note" in body) patch.note = body.note ?? null;

      // Auto-revalidate: if endTime is now set and entry was invalid due to missing clock-out
      if (updatedEnd && existing.isInvalid && existing.invalidReason === "Ausstempeln fehlt") {
        patch.isInvalid = false;
        patch.invalidReason = null;
      }

      // Handle break slots update
      if (body.breaks) {
        const newBreakSlots = body.breaks.map((b) => ({
          timeEntryId: id,
          startTime: new Date(b.startTime),
          endTime: new Date(b.endTime),
        }));
        // Validate break slots before persisting
        const breakError = validateBreakSlots(
          newBreakSlots.map((b) => ({ startTime: b.startTime, endTime: b.endTime })),
          updatedStart,
          updatedEnd,
        );
        if (breakError) return reply.code(400).send({ error: breakError });
        // Delete existing breaks and create new ones
        await app.prisma.break.deleteMany({ where: { timeEntryId: id } });
        if (newBreakSlots.length > 0) {
          await app.prisma.break.createMany({ data: newBreakSlots });
        }
        // Recalculate breakMinutes from the new break slots
        patch.breakMinutes = Math.round(
          calcBreakMinutes(
            newBreakSlots.map((b) => ({ startTime: b.startTime, endTime: b.endTime })),
          ),
        );
      }

      const updated = await app.prisma.timeEntry.update({
        where: { id },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: patch as any,
        include: { breaks: { orderBy: { startTime: "asc" } } },
      });

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
        action: isCorrectionByManager ? "MANAGER_CORRECTION" : "UPDATE",
        entity: "TimeEntry",
        entityId: id,
        oldValue: existing,
        newValue: updated,
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
    preHandler: requireRole("ADMIN", "MANAGER"),
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
        invalidReason: null,
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
          app,
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
      const isManager = ["ADMIN", "MANAGER"].includes(user.role);

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

      if (existing.isLocked) {
        return reply
          .code(403)
          .send({ error: "Eintrag ist gesperrt und kann nicht gelöscht werden" });
      }

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
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return reply.code(204).send();
    },
  });
}

// ── Hilfsfunktion: Überstundensaldo berechnen (snapshot-basiert, TZ-aware) ────
// Nutzt den letzten SaldoSnapshot als Basis und rechnet nur den offenen Zeitraum
// seit dem Snapshot neu. Ohne Snapshot: Fallback auf den aktuellen Monat.
export async function updateOvertimeAccount(app: FastifyInstance, employeeId: string) {
  const schedule = await getEffectiveSchedule(app, employeeId);

  // Tenant-Timezone laden + hireDate + federalState for holiday computation
  // v1.8.9: also fetch break overrides for SHIFT_BASED netto calculation.
  const employee = await app.prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      tenantId: true,
      hireDate: true,
      isTimeTrackingExempt: true, // Phase 76.7 (D-04, SALDO-V19-04)
      breakOver6hOverride: true, // v1.8.9 — SHIFT_BASED netto saldo
      breakOver9hOverride: true, // v1.8.9 — SHIFT_BASED netto saldo
      tenant: { select: { federalState: true } },
    },
  });

  // Phase 76.7 (D-04, D-10) — exempt employees never compute saldo.
  // We do NOT reset balanceHours to 0 (preserve audit-trail of prior value).
  if (employee?.isTimeTrackingExempt) {
    app.log.info(
      { employeeId, exempt: true },
      "updateOvertimeAccount skipped (isTimeTrackingExempt)",
    );
    return;
  }

  const tz = await getTenantTimezone(app.prisma, employee?.tenantId ?? "");

  // Letzten Snapshot suchen (Basis für die Berechnung)
  const lastSnapshot = await app.prisma.saldoSnapshot.findFirst({
    where: { employeeId, periodType: "MONTHLY", superseded: false },
    orderBy: { periodStart: "desc" },
  });

  const now = new Date();
  const todayStr = dateStrInTz(now, tz);
  const todayDate = new Date(todayStr + "T00:00:00Z");
  const yesterdayDate = new Date(todayDate.getTime() - 86400000);

  // Berechne den offenen Zeitraum: ab Tag nach Snapshot-Ende bis heute
  // Ohne Snapshot: ab Monatsanfang (oder Eintrittsdatum)
  let rangeStart: Date;
  let snapshotCarryOver = 0;

  if (lastSnapshot) {
    // Start: Tag nach dem Snapshot-Ende
    rangeStart = new Date(lastSnapshot.periodEnd.getTime() + 86400000);
    snapshotCarryOver = lastSnapshot.carryOver;
  } else {
    // Kein Snapshot: ab Monatsanfang oder Eintrittsdatum
    const zonedNow = new Date(dateStrInTz(now, tz) + "T12:00:00Z");
    const { start: monthStart } = monthRangeUtc(
      zonedNow.getUTCFullYear(),
      zonedNow.getUTCMonth() + 1,
      tz,
    );
    const hireDateNorm = employee?.hireDate
      ? new Date(dateStrInTz(employee.hireDate, tz) + "T00:00:00Z")
      : null;
    rangeStart = hireDateNorm && hireDateNorm > monthStart ? hireDateNorm : monthStart;
  }

  // Determine cutoff: include today only if entries exist
  const hasTodayEntries = await app.prisma.timeEntry.count({
    where: {
      employeeId,
      deletedAt: null,
      date: todayDate,
      endTime: { not: null },
      type: "WORK",
      isInvalid: false,
    },
  });
  const cutoffDate = hasTodayEntries > 0 ? todayDate : yesterdayDate;
  const effectiveEnd = cutoffDate < rangeStart ? rangeStart : cutoffDate;

  // Worked minutes since snapshot (or month start)
  const entries = await app.prisma.timeEntry.findMany({
    where: {
      employeeId,
      deletedAt: null,
      date: { gte: rangeStart, lte: effectiveEnd },
      endTime: { not: null },
      type: "WORK",
      isInvalid: false,
    },
  });

  const workedMinutes = entries.reduce((sum, e) => {
    if (!e.endTime) return sum;
    return sum + (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes);
  }, 0);

  // ── Schedule-type-aware expected/holiday/leave/absence computation ──────────
  // - SHIFT_BASED: expected = Σ Shift durations (skipping leave/absence-covered days);
  //   leave/absence/holiday subtractions stay at 0 (already excluded by skipping shifts).
  // - MONTHLY_HOURS (monthlyHours > 0) spanning multiple calendar months: per-month
  //   segmentation for expected/leave/absence so the proration denominator matches
  //   each segment's month (avoids single-month-denominator distortion).
  // - All other types (FIXED_WEEKLY, FLEXTIME, MONTHLY_HOURS single-month,
  //   pure-tracking MONTHLY_HOURS with monthlyHours=0): unchanged single-call logic.
  const scheduleType = String(schedule.type ?? "");

  // Tenant config + state code are needed by both holiday + MONTHLY_HOURS branches
  const tenantConfig = await app.prisma.tenantConfig.findUnique({
    where: { tenantId: employee!.tenantId },
  });
  const updateStateCode = employee?.tenant
    ? (STATE_MAP[employee.tenant.federalState] ?? "NI")
    : "NI";

  // Hoisted holiday block — runs for default + MONTHLY_HOURS-multi-month branches.
  // SHIFT_BASED resets holidayMinutes = 0 at the end of its branch (manager-assigned
  // shifts on Feiertagen are intentional and count as worked).
  const rangeYear = rangeStart.getUTCFullYear();
  const effectiveEndYear = effectiveEnd.getUTCFullYear();
  const computedHolidaysByDate = new Map<string, { date: Date }>();
  for (let yr = rangeYear; yr <= effectiveEndYear; yr++) {
    for (const h of getHolidays(yr, updateStateCode)) {
      if (h.date >= dateStrInTz(rangeStart, tz) && h.date <= dateStrInTz(effectiveEnd, tz)) {
        computedHolidaysByDate.set(h.date, { date: new Date(h.date + "T00:00:00Z") });
      }
    }
  }
  const dbHolidays = await app.prisma.publicHoliday.findMany({
    where: {
      tenant: { employees: { some: { id: employeeId } } },
      date: { gte: rangeStart, lte: effectiveEnd },
    },
  });
  const allHolidays: { date: Date }[] = [...computedHolidaysByDate.values()];
  for (const h of dbHolidays) {
    if (!computedHolidaysByDate.has(dateStrInTz(h.date, tz))) {
      allHolidays.push({ date: h.date });
    }
  }
  // D-06: holiday dates as tenant-TZ YYYY-MM-DD, passed to calcLeaveAbsenceMinutesTz so a
  // holiday inside approved leave/absence is NOT double-deducted (holidayMinutes already
  // subtracts it separately).
  const holidayDateStrSet = new Set(allHolidays.map((h) => dateStrInTz(h.date, tz)));

  const isMonthlyHoursDeduction =
    scheduleType === "MONTHLY_HOURS" &&
    Number(schedule.monthlyHours ?? 0) > 0 &&
    tenantConfig?.monthlyHoursHolidayDeduction === true;

  let workingDaysInRange = 0;
  if (isMonthlyHoursDeduction) {
    const { start: wdMonthStart, end: wdMonthEnd } = monthRangeUtc(
      rangeStart.getUTCFullYear(),
      rangeStart.getUTCMonth() + 1,
      tz,
    );
    const wdCur = new Date(wdMonthStart);
    while (wdCur <= wdMonthEnd) {
      const wdDow = getDayOfWeekInTz(wdCur, tz);
      if (getDayHoursFromSchedule(schedule, wdDow) > 0) workingDaysInRange++;
      wdCur.setDate(wdCur.getDate() + 1);
    }
  }
  const dailySollMin =
    isMonthlyHoursDeduction && workingDaysInRange > 0
      ? (Number(schedule.monthlyHours!) * 60) / workingDaysInRange
      : 0;

  let holidayMinutes = allHolidays.reduce((sum, h) => {
    const dow = getDayOfWeekInTz(h.date, tz);
    if (isMonthlyHoursDeduction) {
      return getDayHoursFromSchedule(schedule, dow) > 0 ? sum + dailySollMin : sum;
    }
    return sum + getDayHoursFromSchedule(schedule, dow) * 60;
  }, 0);

  let expectedMinutes = 0;
  let leaveMinutes = 0;
  let absenceMinutes = 0;

  if (scheduleType === "SHIFT_BASED") {
    // ── SHIFT_BASED: expected = Σ Shift durations minus leave/absence-covered days ─
    const shifts = await app.prisma.shift.findMany({
      where: {
        employeeId,
        date: { gte: rangeStart, lte: effectiveEnd },
        deletedAt: null, // Phase 67.2 — saldo math ignores soft-deleted shifts
      },
      select: { date: true, startTime: true, endTime: true },
    });

    const approvedLeave = await app.prisma.leaveRequest.findMany({
      where: {
        employeeId,
        deletedAt: null, // required by soft-delete convention
        status: "APPROVED",
        startDate: { lte: effectiveEnd },
        endDate: { gte: rangeStart },
      },
    });
    const absences = await app.prisma.absence.findMany({
      where: {
        employeeId,
        deletedAt: null, // required by soft-delete convention
        startDate: { lte: effectiveEnd },
        endDate: { gte: rangeStart },
      },
    });

    const coveredDates = new Set<string>();
    const addRange = (s: Date, e: Date) => {
      const cur = new Date(dateStrInTz(s, tz) + "T00:00:00Z");
      const end = new Date(dateStrInTz(e, tz) + "T00:00:00Z");
      while (cur <= end) {
        coveredDates.add(dateStrInTz(cur, tz));
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    };
    for (const lr of approvedLeave) {
      const s = lr.startDate < rangeStart ? rangeStart : lr.startDate;
      const e = lr.endDate > effectiveEnd ? effectiveEnd : lr.endDate;
      if (s <= e) addRange(s, e);
    }
    for (const ab of absences) {
      const s = ab.startDate < rangeStart ? rangeStart : ab.startDate;
      const e = ab.endDate > effectiveEnd ? effectiveEnd : ab.endDate;
      if (s <= e) addRange(s, e);
    }

    const hmToMin = (hm: string) => {
      const [h, m] = hm.split(":").map(Number);
      return (h ?? 0) * 60 + (m ?? 0);
    };

    // v1.8.9 — SHIFT_BASED netto: subtract configured break from brutto shift duration.
    // Fixes brutto-vs-netto mismatch (workedMinutes already subtracts breakMinutes).
    // Uses getEffectiveBreakDuration — single source of truth from Phase 64 (break-effective.ts).
    // Cross-midnight fix: if brutto < 0, add 1440 (mirrors shifts.ts /range endpoint).
    const employeeBreakShape = {
      breakOver6hOverride: employee?.breakOver6hOverride ?? null,
      breakOver9hOverride: employee?.breakOver9hOverride ?? null,
    };
    const tenantConfigShape = {
      defaultBreakOver6h: tenantConfig?.defaultBreakOver6h ?? 30,
      defaultBreakOver9h: tenantConfig?.defaultBreakOver9h ?? 45,
    };
    for (const sh of shifts) {
      if (coveredDates.has(dateStrInTz(sh.date, tz))) continue;
      let brutto = hmToMin(sh.endTime) - hmToMin(sh.startTime);
      if (brutto < 0) brutto += 24 * 60; // cross-midnight (e.g. 22:00–06:00)
      if (brutto <= 0) continue;
      const breakMin = getEffectiveBreakDuration(employeeBreakShape, tenantConfigShape, brutto);
      const netto = Math.max(0, brutto - breakMin);
      expectedMinutes += netto;
    }

    // Leave/absence already excluded above; manager-assigned shifts on Feiertagen
    // count as worked. Zero out subtractions to avoid double-deduction.
    leaveMinutes = 0;
    absenceMinutes = 0;
    holidayMinutes = 0;
  } else if (
    scheduleType === "MONTHLY_HOURS" &&
    Number(schedule.monthlyHours ?? 0) > 0 &&
    effectiveEnd >= rangeStart &&
    !sameCalendarMonth(rangeStart, effectiveEnd, tz)
  ) {
    // ── MONTHLY_HOURS spanning multiple calendar months: per-month proration ────
    const segments = splitRangeByMonth(rangeStart, effectiveEnd, tz);
    for (const seg of segments) {
      expectedMinutes += calcExpectedMinutesTz(schedule, seg.start, seg.end, tz);
    }

    const approvedLeave = await app.prisma.leaveRequest.findMany({
      where: {
        employeeId,
        deletedAt: null, // required by soft-delete convention
        status: "APPROVED",
        startDate: { lte: effectiveEnd },
        endDate: { gte: rangeStart },
      },
    });
    for (const lr of approvedLeave) {
      const lrStart = lr.startDate < rangeStart ? rangeStart : lr.startDate;
      const lrEnd = lr.endDate > effectiveEnd ? effectiveEnd : lr.endDate;
      if (lrStart > lrEnd) continue;
      for (const seg of splitRangeByMonth(lrStart, lrEnd, tz)) {
        // Phase 76.12 — Ø-Methode (BAG 9 AZR 406/17). MONTHLY_HOURS branch will
        // zero this out at the end (#192), but using the new helper keeps the
        // intent consistent with the default branch and prevents drift if the
        // zero-out is ever lifted (D-12 carry-forward).
        leaveMinutes += calcLeaveAbsenceMinutesTz(schedule, seg.start, seg.end, tz, {
          halfDay: Boolean(lr.halfDay),
          excludeHolidays: holidayDateStrSet, // D-06 (no-op here — zeroed below — kept for parity)
        });
      }
    }

    const absences = await app.prisma.absence.findMany({
      where: {
        employeeId,
        deletedAt: null, // required by soft-delete convention
        type: { not: "VOCATIONAL_SCHOOL" }, // Phase 76.12 D-12: BBiG §15 — BS = Arbeitstag
        source: { not: "PATTERN" }, // Phase 76.12 D-12: auto-generated, not approved
        startDate: { lte: effectiveEnd },
        endDate: { gte: rangeStart },
      },
    });
    for (const ab of absences) {
      const abStart = ab.startDate < rangeStart ? rangeStart : ab.startDate;
      const abEnd = ab.endDate > effectiveEnd ? effectiveEnd : ab.endDate;
      if (abStart > abEnd) continue;
      for (const seg of splitRangeByMonth(abStart, abEnd, tz)) {
        absenceMinutes += calcLeaveAbsenceMinutesTz(schedule, seg.start, seg.end, tz, {
          excludeHolidays: holidayDateStrSet, // D-06 (no-op here — zeroed below — kept for parity)
        });
      }
    }

    // CLAUDE.md "Schedule Types": MONTHLY_HOURS — holiday/absence deductions do NOT apply.
    // We still compute the per-month-segmented values above for parity with the default
    // branch shape, then zero leave + absence so the flat monthly budget stays the Soll. (#192)
    leaveMinutes = 0;
    absenceMinutes = 0;
  } else {
    // ── Default: FIXED_WEEKLY / FLEXTIME / MONTHLY_HOURS single-month / pure-tracking ─
    expectedMinutes =
      effectiveEnd < rangeStart ? 0 : calcExpectedMinutesTz(schedule, rangeStart, effectiveEnd, tz);

    // Genehmigte Abwesenheiten abziehen
    const approvedLeave = await app.prisma.leaveRequest.findMany({
      where: {
        employeeId,
        deletedAt: null, // required by soft-delete convention
        status: "APPROVED",
        startDate: { lte: effectiveEnd },
        endDate: { gte: rangeStart },
      },
    });
    leaveMinutes = approvedLeave.reduce((sum, lr) => {
      const leaveStart = lr.startDate < rangeStart ? rangeStart : lr.startDate;
      const leaveEnd = lr.endDate > effectiveEnd ? effectiveEnd : lr.endDate;
      if (leaveStart > leaveEnd) return sum;
      // Phase 76.12 D-13 — Ø-Methode (BAG 9 AZR 406/17) honors lr.halfDay.
      return (
        sum +
        calcLeaveAbsenceMinutesTz(schedule, leaveStart, leaveEnd, tz, {
          halfDay: Boolean(lr.halfDay),
          excludeHolidays: holidayDateStrSet, // D-06: holiday inside leave deducted once
        })
      );
    }, 0);

    // Approved/recorded absences (Krank, Sonderurlaub, etc.) — abziehen wie Urlaub.
    // Phase 76.12 D-13 — filter VOCATIONAL_SCHOOL + PATTERN at Prisma layer
    // (BBiG §15: BS-Tag = Arbeitstag, not abwesend; PATTERN-source is auto-gen).
    const absences = await app.prisma.absence.findMany({
      where: {
        employeeId,
        deletedAt: null, // required by soft-delete convention
        type: { not: "VOCATIONAL_SCHOOL" },
        source: { not: "PATTERN" },
        startDate: { lte: effectiveEnd },
        endDate: { gte: rangeStart },
      },
    });
    absenceMinutes = absences.reduce((sum, ab) => {
      const absStart = ab.startDate < rangeStart ? rangeStart : ab.startDate;
      const absEnd = ab.endDate > effectiveEnd ? effectiveEnd : ab.endDate;
      if (absStart > absEnd) return sum;
      return (
        sum +
        calcLeaveAbsenceMinutesTz(schedule, absStart, absEnd, tz, {
          excludeHolidays: holidayDateStrSet, // D-06: holiday inside absence deducted once
        })
      );
    }, 0);

    // CLAUDE.md "Schedule Types": MONTHLY_HOURS — holiday/absence deductions do NOT apply.
    // This covers MONTHLY_HOURS single-month + pure-tracking (monthlyHours = 0). (#192)
    if (scheduleType === "MONTHLY_HOURS") {
      leaveMinutes = 0;
      absenceMinutes = 0;
    }
  }

  // Phase 63 — Berufsschule (BS) doubling for the LIVE saldo path.
  // Mirrors the doubling in overtime.ts (close-month) and auto-close-month.ts
  // (snapshot). Per D-01..D-04: VOCATIONAL_SCHOOL absences add the same minutes to
  // BOTH workedMinutes AND expectedMinutes (FIXED_SCHEDULE / SHIFT_BASED) or to
  // workedMinutes only (MONTHLY_HOURS, D-04). Live and snapshot must agree
  // (RESEARCH Pitfall #2 — live/snapshot drift).
  const bsAbsencesUpdate = await app.prisma.absence.findMany({
    where: {
      employeeId,
      deletedAt: null, // CLAUDE.md soft-delete rule
      type: "VOCATIONAL_SCHOOL",
      startDate: { lte: effectiveEnd },
      endDate: { gte: rangeStart },
    },
  });
  let bsWorkedMinutes = 0;
  let bsExpectedMinutes = 0;
  for (const ab of bsAbsencesUpdate) {
    const start = ab.startDate < rangeStart ? rangeStart : ab.startDate;
    const end = ab.endDate > effectiveEnd ? effectiveEnd : ab.endDate;
    const cur = new Date(start);
    while (cur <= end) {
      const bsMin = await getVocationalSchoolMinutesForDate(
        app.prisma,
        employeeId,
        cur,
        tenantConfig,
      );
      bsWorkedMinutes += bsMin;
      if (scheduleType !== "MONTHLY_HOURS") {
        bsExpectedMinutes += bsMin;
      }
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }

  // Saldo = Snapshot-CarryOver + offener Zeitraum
  const openPeriodBalance =
    workedMinutes +
    bsWorkedMinutes -
    Math.max(
      0,
      expectedMinutes + bsExpectedMinutes - holidayMinutes - leaveMinutes - absenceMinutes,
    );
  const totalBalanceHours = (snapshotCarryOver + openPeriodBalance) / 60;

  // D-06: TRACK_ONLY mode — display balance as 0 (hours are tracked but not accumulated)
  const isTrackOnly =
    String(schedule.type) === "MONTHLY_HOURS" && schedule.overtimeMode === "TRACK_ONLY";
  const effectiveBalanceHours = isTrackOnly ? 0 : totalBalanceHours;

  const account = await app.prisma.overtimeAccount.upsert({
    where: { employeeId },
    create: { employeeId, balanceHours: effectiveBalanceHours },
    update: { balanceHours: effectiveBalanceHours },
  });

  const threshold = Number(schedule.overtimeThreshold);
  if (Number(account.balanceHours) >= threshold) {
    app.log.warn(
      `⚠️  Mitarbeiter ${employeeId} hat ${account.balanceHours}h Überstunden (Threshold: ${threshold}h)`,
    );
  }
}

// ── Effektiven Arbeitsplan ermitteln (Employee > TenantConfig > Hardcoded) ────
export async function getEffectiveSchedule(
  app: FastifyInstance,
  employeeId: string,
  forDate?: Date,
) {
  const targetDate = forDate ?? new Date();
  const schedule = await app.prisma.workSchedule.findFirst({
    where: { employeeId, validFrom: { lte: targetDate } },
    orderBy: { validFrom: "desc" },
  });
  if (schedule) return schedule;

  const employee = await app.prisma.employee.findUnique({
    where: { id: employeeId },
    select: { tenantId: true },
  });
  const tenantConfig = employee
    ? await app.prisma.tenantConfig.findUnique({ where: { tenantId: employee.tenantId } })
    : null;

  return {
    type: "FIXED_SCHEDULE" as const,
    weeklyHours: tenantConfig?.defaultWeeklyHours ?? 40,
    monthlyHours: null,
    mondayHours: tenantConfig?.defaultMondayHours ?? 8,
    tuesdayHours: tenantConfig?.defaultTuesdayHours ?? 8,
    wednesdayHours: tenantConfig?.defaultWednesdayHours ?? 8,
    thursdayHours: tenantConfig?.defaultThursdayHours ?? 8,
    fridayHours: tenantConfig?.defaultFridayHours ?? 8,
    saturdayHours: tenantConfig?.defaultSaturdayHours ?? 0,
    sundayHours: tenantConfig?.defaultSundayHours ?? 0,
    overtimeThreshold: tenantConfig?.overtimeThreshold ?? 60,
    allowOvertimePayout: tenantConfig?.allowOvertimePayout ?? false,
    overtimeMode: "CARRY_FORWARD" as const,
  };
}
