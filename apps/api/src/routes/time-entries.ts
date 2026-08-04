import { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash } from "crypto";
import { requireAuth, requireRole } from "../middleware/auth";
import { TimeEntrySource, Prisma } from "@clokr/db";
import { checkArbZG } from "../utils/arbzg";
import { checkJArbSchG } from "../utils/jarbschg";
import { getEffectiveBreakDuration } from "../utils/break-effective";
import {
  getTenantTimezone,
  todayInTz,
  dateStrInTz,
  monthRangeUtc,
  monthDayBounds,
  calcExpectedMinutesTz,
} from "../utils/timezone";
import { getHolidays, STATE_MAP } from "../utils/holidays";
import { hasApprovedLeaveOnDate } from "../utils/leave-check";
import { resolveClockEvent } from "../services/clock/resolver";
import { resolveActor } from "../services/clock/audit-actor";
import type { ClockEvent } from "../services/clock/types";
import { closeEmployeeMonth } from "../utils/close-employee-month"; // SNAP-03 — Phase 76.27
import { loadBsSlotOverrides } from "../utils/load-bs-slot-overrides"; // Phase 76.31 — D-06 slot overrides
import {
  getRetroEntryWindowDays,
  computeRetroLimitStr,
  computeEntryAgeInDays,
} from "../utils/retro-config"; // Phase 76.29 — RETRO-01 window guard

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
  grantId: z.string().uuid().optional(), // Phase 76.29 Plan 03: pre-approved RetroEntryRequest id
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
// Prisma client shape shared by `app.prisma` (top-level) and the `tx` handle inside
// `$transaction(async (tx) => ...)` — lets checkOverlap / checkEntryConflicts run
// against either, which the grant-consumption race fix (retro-grant-race-403-vs-409)
// relies on to re-run conflict checks INSIDE the tx after the single-use grant flip.
type DbClient = FastifyInstance["prisma"] | Prisma.TransactionClient;

async function checkOverlap(
  db: DbClient,
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

  const overlapping = await db.timeEntry.findFirst({
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

// One-per-day existence check (step 1 of validateTimeEntryInvariants), extracted so it
// can be re-run against a `tx` handle from inside the grant-consumption $transaction
// (retro-grant-race-403-vs-409 fix) — see param doc on deferConflictChecksToTx below.
async function checkOneEntryPerDay(
  db: DbClient,
  employeeId: string,
  date: Date,
  excludeEntryId?: string,
): Promise<string | null> {
  const existingEntry = await db.timeEntry.findFirst({
    where: {
      employeeId,
      deletedAt: null,
      date,
      ...(excludeEntryId ? { id: { not: excludeEntryId } } : {}),
    },
  });
  if (existingEntry) {
    return "Es existiert bereits ein Eintrag für diesen Tag. Bitte den bestehenden Eintrag bearbeiten.";
  }
  return null;
}

// Shared time-entry invariants enforced by POST /time-entries, PUT /time-entries/:id
// and the CSV import (POST /imports/time-entries). Extracting them here (D-01/D-03)
// guarantees the three write paths cannot drift: one-entry-per-day, month-lock via
// SaldoSnapshot, retro-window guard (RETRO-01), and overlap — all with self-exclusion for edits.
// Returns { error, windowDays?, entryAgeInDays? } or null.
// Callers map "abgeschlossen" (month-lock) and "RETRO_WINDOW_EXCEEDED" errors to HTTP 403
// and everything else to 409.
//
// Exemptions from the retro-window guard (RETRO-01 / RETRO-05):
//   - isCorrectionByManager=true  → manager editing a DIFFERENT employee's entry (inline correction)
//   - grantId present             → caller pre-validated an approved RetroEntryRequest (Plan 03)
//   - NFC/terminal punches        → naturally exempt (see nfc-punch route comment below)
//   - CSV import                  → exempt via isCorrectionByManager:true (see imports.ts)
export async function validateTimeEntryInvariants(
  app: FastifyInstance,
  params: {
    employeeId: string;
    date: Date; // calendar date (midnight) used for one-per-day + month key
    dateStr: string; // YYYY-MM-DD in tenant TZ, used for logging/consistency
    newStart: Date;
    newEnd: Date | null;
    tz: string;
    tenantId: string;
    excludeEntryId?: string;
    isCorrectionByManager?: boolean; // skip retro-window guard for manager-on-behalf edits
    grantId?: string; // approved RetroEntryRequest id — Plan 03 wires consumption
    // Race fix (retro-grant-race-403-vs-409, 2026-07): the POST grant-consumption path
    // passes true here. Both the one-per-day check (step 1) AND the overlap check
    // (step 3) below are advisory pre-tx queries against the TimeEntry table — under
    // concurrent same-grant writes, the loser can observe the winner's already-committed
    // entry in EITHER check and get a generic 409 ("day already taken" / "overlaps with
    // existing entry") instead of the single-use grant being the authoritative
    // discriminator (403, "Antrag bereits verwendet"). When true, both checks are
    // skipped here; the caller's own $transaction re-runs them (via checkOneEntryPerDay
    // / checkOverlap against `tx`) AFTER the grant-flip succeeds, so only the winner
    // ever reaches them, and the loser is rejected by the grant-flip itself before any
    // conflict check runs. Never set for PUT: PUT updates an existing row by id
    // (excludeEntryId), which does not race the same way and whose catch block does
    // not re-run these checks.
    deferConflictChecksToTx?: boolean;
  },
): Promise<{ error: string; windowDays?: number; entryAgeInDays?: number } | null> {
  const {
    employeeId,
    date,
    newStart,
    newEnd,
    tz,
    tenantId,
    excludeEntryId,
    isCorrectionByManager,
    grantId,
    deferConflictChecksToTx,
  } = params;

  // 1. one-per-day (mirror POST) — exclude self when editing.
  // Skipped when deferConflictChecksToTx is set (see param doc above) — the caller's own
  // $transaction is the authoritative source of truth in that case.
  if (!deferConflictChecksToTx) {
    const oneDayError = await checkOneEntryPerDay(app.prisma, employeeId, date, excludeEntryId);
    if (oneDayError) {
      return { error: oneDayError };
    }
  }

  // 2. month-lock via SaldoSnapshot (mirror POST) — authoritative even with no entries
  // findFirst with superseded:false (compound accessor removed, COMP-V1814-04)
  // RETRO-01 C2: lock-check runs FIRST — a locked month returns the lock message, never RETRO_WINDOW_EXCEEDED.
  const { start: lockedMonthStart } = monthRangeUtc(date.getFullYear(), date.getMonth() + 1, tz);
  const lockedSnapshot = await app.prisma.saldoSnapshot.findFirst({
    where: {
      employeeId,
      periodType: "MONTHLY",
      periodStart: lockedMonthStart,
      superseded: false,
    },
    select: { id: true },
  });
  if (lockedSnapshot) {
    return { error: "Monat ist abgeschlossen und kann nicht bearbeitet werden" };
  }

  // 2.5. Retro-window guard (RETRO-01) — AFTER month-lock (C2), BEFORE overlap.
  // Fires when the entry date is older than the tenant's configured window AND neither
  // an approved manager correction nor a pre-validated retro grant is present.
  // Uses tenant-TZ date strings — never raw UTC arithmetic (C1 / DST-safety).
  if (!isCorrectionByManager && !grantId) {
    const windowDays = await getRetroEntryWindowDays(app.prisma, tenantId);
    const todayStr = dateStrInTz(todayInTz(tz), tz);
    const retroLimitStr = computeRetroLimitStr(tz, windowDays);
    if (params.dateStr < retroLimitStr) {
      const entryAgeInDays = computeEntryAgeInDays(todayStr, params.dateStr);
      return { error: "RETRO_WINDOW_EXCEEDED", windowDays, entryAgeInDays };
    }
  }

  // 3. overlap (mirror POST) — preserve v1.8.13 same-day open-entry scoping + tz message.
  // Skipped when deferConflictChecksToTx is set — see param doc above.
  if (!deferConflictChecksToTx) {
    const overlap = await checkOverlap(
      app.prisma,
      employeeId,
      newStart,
      newEnd,
      excludeEntryId,
      date,
      tz,
    );
    if (overlap) {
      return { error: overlap };
    }
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

      // D-02: DEBOUNCE_NOOP — STOP within 60s of START is a double-tap NO-OP; return 200.
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

      // D-02: DEBOUNCE_NOOP — STOP within 60s of START is a double-tap NO-OP; return 200.
      if (resolution.kind === "DEBOUNCE_NOOP") {
        return reply.code(200).send({ action: "NOOP" as const, resolution });
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
              // Phase 91 (BREAK-02): Pflichtpause auto-inserted → mark AUTO for confirmation
              await app.prisma.timeEntry.update({
                where: { id: closedEntryId },
                data: { breakMinutes: autoBreakMin, breakStatus: "AUTO" },
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

      // PERF-V1814-03: cap + defaulted 90d window (non-breaking; web callers always pass bounds)
      const defaultFrom = from
        ? new Date(from)
        : (() => {
            const d = new Date();
            d.setDate(d.getDate() - 90);
            return d;
          })();

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
      if (invariantError) {
        if (invariantError.error === "RETRO_WINDOW_EXCEEDED") {
          return reply.code(403).send({
            error: invariantError.error,
            windowDays: invariantError.windowDays,
            entryAgeInDays: invariantError.entryAgeInDays,
          });
        }
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
            const oneDayErrorTx = await checkOneEntryPerDay(tx, employeeId, conflictDate);
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
                invalidReason: manualLeave ? "Urlaubsstornierung ausstehend" : null,
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
              invalidReason: manualLeave ? "Urlaubsstornierung ausstehend" : null,
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

      // Patch-Objekt explizit aufbauen um TS-Spread-Probleme zu vermeiden
      // Only set source to CORRECTION when a manager edits another employee's entry, OR when a
      // grant-backed edit is performed (putResolvedGrantId present — grant edits are always corrections).
      // putIsCorrectionByManager is already computed above (before the invariant call) —
      // reuse it here so the patch and the retro-window exemption stay in sync.
      const patch: Record<string, unknown> =
        putIsCorrectionByManager || putResolvedGrantId ? { source: "CORRECTION" } : {};
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
      if (updatedEnd && existing.isInvalid && existing.invalidReason === "Ausstempeln fehlt") {
        patch.isInvalid = false;
        patch.invalidReason = null;
      }

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

      // Owner or manager/admin.
      const isManager = user.role === "MANAGER" || user.role === "ADMIN";
      if (!isManager && entry.employeeId !== user.employeeId) {
        return reply.code(403).send({ error: "Kein Zugriff" });
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
        return { entry: updated };
      }

      // action === "waive" — "durchgearbeitet": no break taken, time is really worked and
      // therefore payable. No manager approval required (LOCKED Decision 5).

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

      // 0-ing the break changes net worked time — every other break-mutating path recomputes.
      await updateOvertimeAccount(app, entry.employeeId);

      // In-app manager alert (Phase 91: in-app only; EMAIL_TYPE_MAP entry deferred to Phase 92).
      const managers = await app.prisma.employee.findMany({
        where: {
          tenantId: entry.employee.tenantId,
          user: { isActive: true, role: { in: ["ADMIN", "MANAGER"] } },
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

// ── Hilfsfunktion: Überstundensaldo berechnen (snapshot-basiert, TZ-aware) ────
// Nutzt den letzten SaldoSnapshot als Basis und rechnet nur den offenen Zeitraum
// seit dem Snapshot neu. Ohne Snapshot: Fallback auf den aktuellen Monat.
//
// PURE READ (no DB write). Returns the LIFETIME running Überstundensaldo in hours through the
// windowEnd cutoff (today only if today has completed entries, else yesterday — the same
// hasTodayEntries convention the §615 calendar header/cells use). Handles all schedule types:
//   - MONTHLY_HOURS TRACK_ONLY → 0 (tracked, not accumulated).
//   - SHIFT_BASED / FIXED_* / FLEXTIME / MONTHLY_HOURS(target>0) → live lifetime saldo.
// Lifetime-correct: the balance = last-snapshot carryOver (or full history from hireDate when no
// snapshot) + Σ balances of ALL open months (complete + current partial) up to windowEnd. This is
// the SAME value updateOvertimeAccount persists — it is the single source of truth; the writer
// wraps this and upserts. Returns null for §18-exempt employees (caller: skip / no value).
export async function computeOvertimeBalanceHours(
  app: FastifyInstance,
  employeeId: string,
): Promise<number | null> {
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
      "computeOvertimeBalanceHours skipped (isTimeTrackingExempt)",
    );
    return null;
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
    // No non-superseded snapshot: recompute from hireDate so that reopen of the
    // only/earliest snapshot includes the full employment history (D-05 fix).
    // Using currentMonthFirstDay as rangeStart would exclude all history before the
    // current calendar month — the root cause of the reopen→0 saldo bug (SALDO-09).
    const hireDateNorm = employee?.hireDate
      ? new Date(dateStrInTz(employee.hireDate, tz) + "T00:00:00Z")
      : null;
    rangeStart = hireDateNorm ?? new Date(0); // epoch fallback if hireDate is null
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

  // ── SNAP-03 (Phase 76.27): Per-month iteration via closeEmployeeMonth() ─────
  // ALL schedule models now use the unified per-month loop for COMPLETE open months,
  // calling closeEmployeeMonth() once per month. The current partial month is computed
  // inline (F-01 Option A — SHIFT_BASED: roster-prorated; non-SHIFT: flat calcExpectedMinutesTz).
  const scheduleType = String(schedule.type ?? "");

  // Tenant config + state code are needed by both holiday + closeEmployeeMonth branches
  const tenantConfig = await app.prisma.tenantConfig.findUnique({
    where: { tenantId: employee!.tenantId },
  });
  const updateStateCode = employee?.tenant
    ? (STATE_MAP[employee.tenant.federalState] ?? "NI")
    : "NI";

  // Hoisted holiday block — FULL-YEAR coverage (not filtered to [rangeStart, effectiveEnd]).
  //
  // SNAP-03 (76.27): closeEmployeeMonth() subtracts ALL holidays in the provided set from each
  // month's expected (no internal month-range filtering). To maintain parity with the close paths
  // (which use buildHolidaySet(year) = all year's holidays), the live path MUST pass the full
  // annual holiday set to closeEmployeeMonth() for each complete open month AND for the current
  // partial month close. Only covering holidays within [rangeStart, effectiveEnd] would cause the
  // live path to subtract fewer holidays than the close path, breaking parity.
  //
  // We therefore build the holiday set for ALL calendar years spanned by the open range (typically
  // just one year, but can span two). No date-range filtering — include all holidays for each year.
  //
  // DB manual holidays: still filter to [rangeStart, effectiveEnd] for the inline current-month
  // branch (those are already included in the year-wide computed set for the close calls).
  const rangeYear = rangeStart.getUTCFullYear();
  const effectiveEndYear = effectiveEnd.getUTCFullYear();
  const computedHolidaysByDate = new Map<string, { date: Date }>();
  for (let yr = rangeYear; yr <= effectiveEndYear; yr++) {
    for (const h of getHolidays(yr, updateStateCode)) {
      // Full year — NO date-range filter (SNAP-03: match close-path convention).
      computedHolidaysByDate.set(h.date, { date: new Date(h.date + "T00:00:00Z") });
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
  // subtracts it separately). Full-year set used for all closeEmployeeMonth calls.
  const holidayDateStrSet = new Set(allHolidays.map((h) => dateStrInTz(h.date, tz)));

  // ── SNAP-03 (Phase 76.27): Per-month iteration via closeEmployeeMonth() ────────
  //
  // Build the list of COMPLETE open months: all calendar months entirely before the
  // calendar month of effectiveEnd. The current (partial) month is handled inline below.
  // Uses monthRangeUtc + monthDayBounds (SNAP-05 — never raw Date math).
  //
  // Algorithm: iterate month-by-month from rangeStart's month up to (but not including)
  // the calendar month that contains effectiveEnd. Oldest-first.

  // Current month: the calendar month that contains TODAY (not effectiveEnd).
  //
  // SNAP-03-A fix: when effectiveEnd is the last day of the previous calendar month
  // (because today has no entries yet, so effectiveEnd = yesterday), using effectiveEnd's
  // month would classify that complete month as the "current partial" month and skip it
  // from the complete-months loop. Using todayDate ensures the month boundary is always
  // the ACTUAL current calendar month, so all complete prior months (including yesterday's
  // full month) are processed by closeEmployeeMonth().
  const currentMonthRange = monthRangeUtc(
    todayDate.getUTCFullYear(),
    todayDate.getUTCMonth() + 1,
    tz,
  );

  // Build complete open months list (all months before the current month).
  interface CompleteMonth {
    monthStart: Date;
    monthEnd: Date;
    monthFirstDay: Date;
    monthLastDay: Date;
  }
  const completeOpenMonths: CompleteMonth[] = [];
  {
    // Start from the calendar month containing rangeStart.
    const rsStr = dateStrInTz(rangeStart, tz);
    const [rsYear, rsMonth] = rsStr.split("-").map(Number);
    let cy = rsYear!;
    let cm = rsMonth!; // 1-based
    for (let i = 0; i < 240; i++) {
      const { start: mStart, end: mEnd } = monthRangeUtc(cy, cm, tz);
      // Stop when this month IS the current month (contains effectiveEnd).
      if (mStart >= currentMonthRange.start) break;
      // Only include months that overlap with rangeStart (first segment may start mid-month).
      if (mEnd >= rangeStart) {
        const { firstDay: mFirstDay, lastDay: mLastDay } = monthDayBounds(mStart, mEnd, tz);
        completeOpenMonths.push({
          monthStart: mStart,
          monthEnd: mEnd,
          monthFirstDay: mFirstDay,
          monthLastDay: mLastDay,
        });
      }
      cm++;
      if (cm > 12) {
        cm = 1;
        cy++;
      }
    }
  }

  // ── Range-wide pre-fetch (ONE query per collection) ───────────────────────────
  // Pre-fetch all data for [rangeStart, effectiveEnd] once. The per-month loop
  // and current-month computation filter inline — no N×DB-round-trips (RESEARCH §2.4).
  //
  // Compute @db.Date bounds for the full range so entry/shift queries use the correct
  // boundary type (SNAP-05). rangeStart and effectiveEnd are already @db.Date-compatible
  // UTC midnight values from the snapshot.periodEnd+1 calculation above.
  const rangeFirstDay = rangeStart; // Already a UTC-midnight @db.Date-compatible value
  const rangeLastDay = effectiveEnd; // Already a UTC-midnight @db.Date-compatible value

  // SHIFT_BASED roster fetch upper bound: include the WHOLE current calendar month, not just
  // rangeLastDay (= effectiveEnd = yesterday when today has no entries). The partial-month §615
  // block needs rosterPeriodMinutes = the FULL current-month roster (incl. future-planned shifts)
  // to prorate the contract Soll (R_toDate ÷ R_periodFull). Truncating at effectiveEnd made
  // R_periodFull == R_toDate → factor 1 → NO proration → the open partial month collapsed to ~0,
  // dropping the current month from the running total (Bug 5). Only the roster DENOMINATOR needs
  // future days; entries/leave/absences below keep the effectiveEnd bound, and the shift LIST fed
  // to closeEmployeeMonth is still clamped to effectiveEnd (only curMonthAllShifts widens).
  // currentMonthRange (computed above) is the calendar month containing today.
  const shiftRangeLastDay =
    currentMonthRange.end > rangeLastDay ? currentMonthRange.end : rangeLastDay;

  const allShifts =
    scheduleType === "SHIFT_BASED"
      ? await app.prisma.shift.findMany({
          where: {
            employeeId,
            date: { gte: rangeFirstDay, lte: shiftRangeLastDay },
            deletedAt: null,
          },
          select: { date: true, startTime: true, endTime: true },
        })
      : ([] as { date: Date; startTime: string; endTime: string }[]);

  // Upper bound = shiftRangeLastDay (= full current calendar month, NOT effectiveEnd).
  // The SHIFT_BASED partial-month C_net credit (closeEmployeeMonth uses monthEnd =
  // currentMonthRange.end) must see approved leave/absences that START LATER in the current
  // month than effectiveEnd (= yesterday when today has no entries). Truncating at effectiveEnd
  // dropped a future-in-month approved vacation → its Soll-credit was never subtracted from
  // C_net → the prorated effective Soll was inflated above W → the whole open-month §615
  // contribution collapsed to 0, diverging from the per-day cells (computeMonthSaldo, which
  // fetches the FULL month). This mirrors the shiftRangeLastDay widening above (Bug 5); the
  // leave/absence fetch was left at effectiveEnd — that asymmetry is the divergence root cause.
  // Non-SHIFT partial (monthEnd = effectiveEnd) ignores the extra rows (out of window) → no-op.
  const allApprovedLeave = await app.prisma.leaveRequest.findMany({
    where: {
      employeeId,
      deletedAt: null,
      status: "APPROVED",
      startDate: { lte: shiftRangeLastDay },
      endDate: { gte: rangeStart },
    },
  });

  const allAbsences = await app.prisma.absence.findMany({
    where: {
      employeeId,
      deletedAt: null,
      startDate: { lte: shiftRangeLastDay },
      endDate: { gte: rangeStart },
    },
  });

  // Build a full-range holidayDateStrings Set covering all years in [rangeStart, effectiveEnd].
  // (Already computed above as holidayDateStrSet — reuse it directly for closeEmployeeMonth calls.)

  // ── Complete open months loop: one closeEmployeeMonth() call per month ────────
  // For each COMPLETE open month (all months before the current partial month),
  // call closeEmployeeMonth() with the filtered data slice. Thread effectiveCarryOverOut
  // as carryOverIn for the next month. Accumulate balanceMinutes into openPeriodBalance.
  //
  // SHIFT_BASED: each complete month is full/close-equivalent (no rosterProration).
  // §615 applied per-month → eliminates the +64h lumping artifact (SNAP-03 fix).
  // FIXED/FLEXTIME/MONTHLY_HOURS: also go through closeEmployeeMonth() for uniformity
  // (RESEARCH §2.6 — all models benefit from per-month snapshot guarantee).

  let accumulatedCarryOver = snapshotCarryOver;
  let openPeriodBalance = 0;

  for (const cm of completeOpenMonths) {
    const { monthStart, monthEnd, monthFirstDay, monthLastDay } = cm;

    // Filter each pre-fetched collection to this month's range.
    // entries: @db.Date comparison (date >= monthFirstDay && date <= monthLastDay)
    const monthEntries = entries.filter((e) => e.date >= monthFirstDay && e.date <= monthLastDay);
    // shifts: same @db.Date filter
    const monthShifts = allShifts.filter((s) => s.date >= monthFirstDay && s.date <= monthLastDay);
    // leave/absences: range overlap (startDate <= monthEnd && endDate >= monthStart)
    const monthLeave = allApprovedLeave.filter(
      (lr) => lr.startDate <= monthEnd && lr.endDate >= monthStart,
    );
    const monthAbsences = allAbsences.filter(
      (ab) => ab.startDate <= monthEnd && ab.endDate >= monthStart,
    );

    // Filter holidays to this month's range only (matching the close-path convention in
    // auto-close-month.ts which filters to [empEffectiveStart, monthEnd]).
    // closeEmployeeMonth() has no internal month-range filtering — it subtracts ALL holidays
    // in the provided set. Passing the full-year set causes every complete month to subtract
    // ALL annual holidays, inflating expected by holidays from other months (saldo invariant
    // regression). Filter to [monthFirstDay, monthLastDay] to match the actual month bounds.
    const monthFirstDayStr = dateStrInTz(monthFirstDay, tz);
    const monthLastDayStr = dateStrInTz(monthLastDay, tz);
    const monthHolidaySet = new Set(
      [...holidayDateStrSet].filter((d) => d >= monthFirstDayStr && d <= monthLastDayStr),
    );
    // Phase 76.31 (D-06): load Employee + active-Pattern bsSlot* overrides for this
    // month so the complete-month recompute honors per-MA / per-pattern slot amounts.
    const { employeeSlots, patternSlots, patternUnterrichtsMinutenByDow } =
      await loadBsSlotOverrides(app.prisma, employeeId, monthFirstDay);
    const result = closeEmployeeMonth({
      employeeId,
      monthStart,
      monthEnd,
      monthFirstDay,
      monthLastDay,
      tz,
      carryOverIn: accumulatedCarryOver,
      schedule: schedule as Record<string, unknown>,
      hireDate: employee!.hireDate,
      exitDate: null, // live path — still employed
      isTimeTrackingExempt: false, // already guarded above
      breakOver6hOverride: employee?.breakOver6hOverride ?? null,
      breakOver9hOverride: employee?.breakOver9hOverride ?? null,
      entries: monthEntries.map((e) => ({
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime!,
        breakMinutes: e.breakMinutes ?? 0,
      })),
      shifts: monthShifts,
      approvedLeave: monthLeave.map((lr) => ({
        startDate: lr.startDate,
        endDate: lr.endDate,
        halfDay: lr.halfDay,
      })),
      absences: monthAbsences.map((ab) => ({
        startDate: ab.startDate,
        endDate: ab.endDate,
        type: ab.type,
        source: ab.source,
        halfDay: ab.halfDay,
        // Phase 76.39 (D-11 cleanup): thread per-day Unterrichtszeit for duration-based
        // BS slot classification (null → Pattern/ordinal fallback — no regression).
        unterrichtsMinutes: ab.unterrichtsMinutes ?? undefined,
      })),
      holidayDateStrings: monthHolidaySet,
      tenantConfig: tenantConfig
        ? {
            defaultBreakOver6h: tenantConfig.defaultBreakOver6h,
            defaultBreakOver9h: tenantConfig.defaultBreakOver9h,
            monthlyHoursHolidayDeduction: tenantConfig.monthlyHoursHolidayDeduction ?? undefined,
            vocationalSchoolMinutesPerDay: tenantConfig.vocationalSchoolMinutesPerDay ?? undefined,
            vocationalSchoolBlockMinutesPerWeek:
              tenantConfig.vocationalSchoolBlockMinutesPerWeek ?? undefined,
            // Phase 76.31 (D-06) — TenantConfig slot layer.
            bsSlotFirstLongDayMinutes: tenantConfig.bsSlotFirstLongDayMinutes ?? undefined,
            bsSlotSecondLongDayMinutes: tenantConfig.bsSlotSecondLongDayMinutes ?? undefined,
            bsSlotShortDayMinutes: tenantConfig.bsSlotShortDayMinutes ?? undefined,
            bsSlotBlockWeekMinutes: tenantConfig.bsSlotBlockWeekMinutes ?? undefined,
          }
        : null,
      // Phase 76.31 (D-06) — Employee/Pattern slot layers (null → fallback).
      employeeSlots,
      patternSlots,
      // Phase 76.39 (D-11 cleanup) — active pattern's per-DOW Unterrichtszeit map.
      patternUnterrichtsMinutenByDow,
    });

    // Thread carryOver for next month (§2.3 RESEARCH).
    accumulatedCarryOver = result.effectiveCarryOverOut;
    // Accumulate complete-month balance (already net — do NOT also add via leave/absence path).
    openPeriodBalance += result.balanceMinutes;
  }

  // ── Current partial month: ONE closeEmployeeMonth() call (Phase 76.39, D-07) ─
  //
  // The calendar month containing effectiveEnd is the CURRENT PARTIAL month. It is
  // computed by the SAME shared closeEmployeeMonth() core as every close/cron/recalc path
  // (Phase 76.39 consolidation), so BS handling — including the v1.8.27 single-count fix —
  // is identical live vs closed. An earlier note here claimed a "live-path bsExpectedMinutes
  // gap ... do NOT fix"; that gap no longer exists (the live path was rewired through the
  // shared core) and the stale note has been removed.
  // For SHIFT_BASED: roster-prorated via rosterProration (D-07).
  // For non-SHIFT: flat calcExpectedMinutesTz over the current-month open range only.
  //
  // currentMonthOpenStart: the later of rangeStart and the current month's UTC start.
  // If rangeStart is already within the current month (no complete open months), the
  // entire open range is the current partial month.

  const currentMonthOpenStart =
    currentMonthRange.start < rangeStart ? rangeStart : currentMonthRange.start;

  // Current-month leave and absences (filtered from pre-fetched collections)
  const curLeave = allApprovedLeave.filter(
    (lr) => lr.startDate <= currentMonthRange.end && lr.endDate >= currentMonthRange.start,
  );
  const curAbsences = allAbsences.filter(
    (ab) => ab.startDate <= currentMonthRange.end && ab.endDate >= currentMonthRange.start,
  );

  // ── Current partial month: ONE closeEmployeeMonth() call (Phase 76.39, D-07) ─
  //
  // Replaces the former ~400-line inline replica (SHIFT_BASED roster-proration +
  // non-SHIFT flat calc + a redundant SHIFT_BASED BS-doubling DB loop). The shared
  // core now computes the current partial month exactly like every close/cron/recalc
  // path, with two partial-month adaptations threaded via input:
  //   1. rosterProration (SHIFT_BASED only) — scales the effective Soll by roster
  //      progress (R_toDate ÷ R_periodFull), preserving the §615 open-month semantics.
  //   2. monthEnd/monthLastDay — for non-SHIFT, monthEnd = effectiveEnd so
  //      calcExpectedMinutesTz covers ONLY the open window; for SHIFT_BASED, monthEnd =
  //      currentMonthRange.end (full-month C_net) while monthLastDay = effectiveEnd
  //      (partial window for shift/entry clamping). See RESEARCH §8.1.
  //   3. holidayDateStrings = partialHolidayExclude — window-filtered so no out-of-window
  //      holiday inflates the partial expected (SNAP-01 guard, RESEARCH §4).
  //
  // BS-doubling (SHIFT_BASED + non-SHIFT) is now handled purely inside the core from the
  // pre-fetched absences (with unterrichtsMinutes) + employeeSlots/patternSlots — no more
  // per-day getVocationalSchoolMinutesForDate DB calls.

  // effectiveEnd < currentMonthOpenStart → no open partial month (nothing to add).
  if (effectiveEnd >= currentMonthOpenStart) {
    const { firstDay: curMonthFirstDay, lastDay: curMonthLastDay } = monthDayBounds(
      currentMonthRange.start,
      currentMonthRange.end,
      tz,
    );

    // Load Employee + active-Pattern bsSlot* overrides + per-DOW Unterrichtszeit map for
    // the current month (same convention as the complete-months loop above).
    const { employeeSlots, patternSlots, patternUnterrichtsMinutenByDow } =
      await loadBsSlotOverrides(app.prisma, employeeId, curMonthFirstDay);

    // Pre-compute rosterProration for SHIFT_BASED (partial month only). R_toDate uses shifts
    // up to effectiveEnd (coveredDates for the open window); R_periodFull uses ALL current-
    // month shifts (coveredDates for the full month). getEffectiveBreakDuration/netto match
    // the core's shift-netto computation.
    let rosterProration: { rosterToDateMinutes: number; rosterPeriodMinutes: number } | undefined;
    if (scheduleType === "SHIFT_BASED") {
      const employeeBreakShape = {
        breakOver6hOverride: employee?.breakOver6hOverride ?? null,
        breakOver9hOverride: employee?.breakOver9hOverride ?? null,
      };
      const tenantConfigShape = {
        defaultBreakOver6h: tenantConfig?.defaultBreakOver6h ?? 30,
        defaultBreakOver9h: tenantConfig?.defaultBreakOver9h ?? 45,
      };
      const hmToMin = (hm: string) => {
        const [h, m] = hm.split(":").map(Number);
        return (h ?? 0) * 60 + (m ?? 0);
      };
      const sumShiftNetto = (
        list: { date: Date; startTime: string; endTime: string }[],
        covered: Set<string>,
      ): number => {
        let total = 0;
        for (const sh of list) {
          if (covered.has(dateStrInTz(sh.date, tz))) continue;
          let brutto = hmToMin(sh.endTime) - hmToMin(sh.startTime);
          if (brutto < 0) brutto += 24 * 60;
          if (brutto <= 0) continue;
          const breakMin = getEffectiveBreakDuration(employeeBreakShape, tenantConfigShape, brutto);
          total += Math.max(0, brutto - breakMin);
        }
        return total;
      };
      const buildCovered = (windowStart: Date, windowEnd: Date): Set<string> => {
        const set = new Set<string>();
        const add = (rangeStartD: Date, rangeEndD: Date) => {
          const s = rangeStartD < windowStart ? windowStart : rangeStartD;
          const e = rangeEndD > windowEnd ? windowEnd : rangeEndD;
          if (s > e) return;
          const cur = new Date(dateStrInTz(s, tz) + "T00:00:00Z");
          const last = new Date(dateStrInTz(e, tz) + "T00:00:00Z");
          while (cur <= last) {
            set.add(dateStrInTz(cur, tz));
            cur.setUTCDate(cur.getUTCDate() + 1);
          }
        };
        for (const lr of curLeave) add(lr.startDate, lr.endDate);
        for (const ab of curAbsences) add(ab.startDate, ab.endDate);
        return set;
      };

      const curMonthAllShifts = allShifts.filter(
        (s) => s.date >= curMonthFirstDay && s.date <= curMonthLastDay,
      );
      const curShiftsToDate = curMonthAllShifts.filter((s) => s.date <= effectiveEnd);
      const coveredToDate = buildCovered(currentMonthOpenStart, effectiveEnd);
      const monthCovered = buildCovered(currentMonthRange.start, currentMonthRange.end);
      rosterProration = {
        rosterToDateMinutes: sumShiftNetto(curShiftsToDate, coveredToDate),
        rosterPeriodMinutes: sumShiftNetto(curMonthAllShifts, monthCovered),
      };
    }

    // Window-filtered holiday set (partial open window only — SNAP-01 guard).
    const openStartStr = dateStrInTz(currentMonthOpenStart, tz);
    const openEndStr = dateStrInTz(effectiveEnd, tz);
    const partialHolidayExclude = new Set(
      [...holidayDateStrSet].filter((d) => d >= openStartStr && d <= openEndStr),
    );

    // monthEnd: SHIFT_BASED → full-month end (C_net Soll); non-SHIFT → effectiveEnd
    // (partial-window expected). monthLastDay = effectiveEnd for shift/entry clamping.
    const partialMonthEnd = scheduleType === "SHIFT_BASED" ? currentMonthRange.end : effectiveEnd;

    const partialResult = closeEmployeeMonth({
      employeeId,
      monthStart: currentMonthRange.start,
      monthEnd: partialMonthEnd,
      monthFirstDay: curMonthFirstDay,
      monthLastDay: effectiveEnd, // partial window end
      tz,
      carryOverIn: accumulatedCarryOver,
      schedule: schedule as Record<string, unknown>,
      hireDate: employee!.hireDate,
      exitDate: null, // live path — still employed
      isTimeTrackingExempt: false,
      breakOver6hOverride: employee?.breakOver6hOverride ?? null,
      breakOver9hOverride: employee?.breakOver9hOverride ?? null,
      entries: entries
        .filter((e) => e.date >= curMonthFirstDay && e.date <= effectiveEnd)
        .map((e) => ({
          date: e.date,
          startTime: e.startTime,
          endTime: e.endTime!,
          breakMinutes: e.breakMinutes ?? 0,
        })),
      shifts: allShifts.filter((s) => s.date >= curMonthFirstDay && s.date <= effectiveEnd),
      approvedLeave: curLeave.map((lr) => ({
        startDate: lr.startDate,
        endDate: lr.endDate,
        halfDay: lr.halfDay,
      })),
      absences: curAbsences.map((ab) => ({
        startDate: ab.startDate,
        endDate: ab.endDate,
        type: ab.type,
        source: ab.source,
        halfDay: ab.halfDay,
        unterrichtsMinutes: ab.unterrichtsMinutes ?? undefined,
      })),
      holidayDateStrings: partialHolidayExclude,
      tenantConfig: tenantConfig
        ? {
            defaultBreakOver6h: tenantConfig.defaultBreakOver6h,
            defaultBreakOver9h: tenantConfig.defaultBreakOver9h,
            monthlyHoursHolidayDeduction: tenantConfig.monthlyHoursHolidayDeduction ?? undefined,
            vocationalSchoolMinutesPerDay: tenantConfig.vocationalSchoolMinutesPerDay ?? undefined,
            vocationalSchoolBlockMinutesPerWeek:
              tenantConfig.vocationalSchoolBlockMinutesPerWeek ?? undefined,
            bsSlotFirstLongDayMinutes: tenantConfig.bsSlotFirstLongDayMinutes ?? undefined,
            bsSlotSecondLongDayMinutes: tenantConfig.bsSlotSecondLongDayMinutes ?? undefined,
            bsSlotShortDayMinutes: tenantConfig.bsSlotShortDayMinutes ?? undefined,
            bsSlotBlockWeekMinutes: tenantConfig.bsSlotBlockWeekMinutes ?? undefined,
          }
        : null,
      employeeSlots,
      patternSlots,
      patternUnterrichtsMinutenByDow,
      rosterProration, // Phase 76.39 (D-07): SHIFT_BASED only; undefined for non-SHIFT
    });

    // The partial-month balance is added to openPeriodBalance. carryOver threading stops
    // here (the displayed saldo is snapshotCarryOver + openPeriodBalance — SNAP-01).
    openPeriodBalance += partialResult.balanceMinutes;
  }

  // totalBalanceHours = (snapshotCarryOver from lastSnapshot) + openPeriodBalance
  // (complete-months loop threads effectiveCarryOverOut, but the final balance displayed
  // to the user is always relative to the snapshotCarryOver base — SNAP-01).
  const totalBalanceHours = (snapshotCarryOver + openPeriodBalance) / 60;

  // D-06: TRACK_ONLY mode — display balance as 0 (hours are tracked but not accumulated)
  const isTrackOnly =
    String(schedule.type) === "MONTHLY_HOURS" && schedule.overtimeMode === "TRACK_ONLY";
  const effectiveBalanceHours = isTrackOnly ? 0 : totalBalanceHours;

  return effectiveBalanceHours;
}

// ── Überstundensaldo berechnen UND persistieren (event-driven writer) ─────────
// Thin wrapper around computeOvertimeBalanceHours (single source of truth): recomputes the live
// lifetime saldo through windowEnd and upserts OvertimeAccount.balanceHours. Called on every
// time-entry mutation + month close/unlock. Exempt employees (compute → null) are skipped without
// resetting the stored value (preserve audit trail).
export async function updateOvertimeAccount(app: FastifyInstance, employeeId: string) {
  const effectiveBalanceHours = await computeOvertimeBalanceHours(app, employeeId);
  if (effectiveBalanceHours === null) return; // §18-exempt — do not touch stored balance

  const account = await app.prisma.overtimeAccount.upsert({
    where: { employeeId },
    create: { employeeId, balanceHours: effectiveBalanceHours },
    update: { balanceHours: effectiveBalanceHours },
  });

  const schedule = await getEffectiveSchedule(app, employeeId);
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
