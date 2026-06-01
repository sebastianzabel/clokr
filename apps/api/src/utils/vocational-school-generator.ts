// Phase 62 — Berufsschultag Auto-Generator (Helper)
//
// Pure helper that reads active EmployeeVocationalSchoolPattern rows for a tenant and
// produces VOCATIONAL_SCHOOL Absence rows for the next N weeks. Reused by:
//   - apps/api/src/routes/vocational-school.ts (POST /generate, GET /preview)
//   - apps/api/src/plugins/vocational-school-generator.ts (daily cron at 02:30)
//
// LOCKED invariants (see CONTEXT.md):
//   - BERSCH-08: Existing Absence rows (any type) for (employeeId, date) are NEVER overwritten.
//                Generator is purely additive.
//   - BERSCH-09: Dates inside a locked month (SaldoSnapshot for (employeeId, MONTHLY, monthStart))
//                are skipped.
//   - Idempotent: re-running within the same window creates ZERO additional rows.
//   - Audit-logged: every CREATE produces an AuditLog entry with userId SYSTEM and
//                   action VOCATIONAL_SCHOOL_AUTO_GENERATED.

import type { PrismaClient } from "@clokr/db";
import type { FastifyInstance } from "fastify";

// ── Public types ─────────────────────────────────────────────────────────────

export interface GeneratorResult {
  created: number;
  skipped: {
    existing: number; // BERSCH-08: an Absence already exists for (employeeId, date)
    locked: number; // BERSCH-09: month is closed (SaldoSnapshot present)
    preHire: number;
    postExit: number;
    outOfWindow: number; // beyond pattern.validFrom/validUntil
  };
  details?: Array<{
    employeeId: string;
    date: string;
    action: "created" | "skipped";
    reason?: string;
  }>;
}

export interface RunOpts {
  tenantId: string;
  weeksAhead?: number;
  now?: Date;
  dryRun?: boolean;
}

export interface PreviewOpts {
  tenantId: string;
  weeksAhead?: number;
  now?: Date;
}

// app.audit signature copy (see plugins/audit.ts) — kept loose to match the Fastify decorator type.
type AuditFn = FastifyInstance["audit"];

// ── Date helpers (module-private) ────────────────────────────────────────────

/**
 * Return the UTC date (00:00:00.000Z) for the calendar day of `d`.
 * Used to align with Prisma @db.Date column semantics (date-only storage).
 */
function dateOnlyUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDaysUtc(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/**
 * Return the UTC date for the 1st of `d`'s month at 00:00:00.000Z.
 * Used to match SaldoSnapshot.periodStart (which is the month boundary).
 */
function monthStartUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/**
 * Map JS-native getUTCDay (0=Sun..6=Sat) onto the schema's Mo-based convention (0=Mo..6=So).
 * Matches EmployeeShiftPattern.dayOfWeek and EmployeeVocationalSchoolPattern.dayOfWeek.
 */
function dowMondayBased(d: Date): number {
  const native = d.getUTCDay(); // 0=Sun..6=Sat
  return native === 0 ? 6 : native - 1;
}

/**
 * Compute ISO 8601 week number and "ISO week year" for a date.
 * Algorithm: shift to the Thursday of the same ISO week; the ISO week year is the year of that
 * Thursday; the week number is the count of weeks since the first Thursday of that year.
 */
function isoWeekOf(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Day-of-week with Mon=1..Sun=7
  const dayNum = d.getUTCDay() || 7;
  // Shift to Thursday of the same week
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── Core: shared run + preview implementation ────────────────────────────────

/**
 * Shared implementation. When `dryRun=true`, populates `details[]` and returns counts
 * WITHOUT mutating the DB or calling audit().
 */
async function runOrPreview(
  prisma: PrismaClient,
  audit: AuditFn,
  opts: RunOpts & { dryRun: boolean },
): Promise<GeneratorResult> {
  const now = opts.now ?? new Date();
  const weeksAhead = opts.weeksAhead ?? 4;

  const windowStart = dateOnlyUtc(now);
  const windowEnd = addDaysUtc(windowStart, weeksAhead * 7);

  const result: GeneratorResult = {
    created: 0,
    skipped: { existing: 0, locked: 0, preHire: 0, postExit: 0, outOfWindow: 0 },
    details: opts.dryRun ? [] : undefined,
  };

  // 1. Load all active patterns for this tenant whose validity range intersects the window.
  const patterns = await prisma.employeeVocationalSchoolPattern.findMany({
    where: {
      isActive: true,
      employee: { tenantId: opts.tenantId },
      validFrom: { lte: windowEnd },
      OR: [{ validUntil: null }, { validUntil: { gte: windowStart } }],
    },
    include: {
      employee: { select: { id: true, hireDate: true, exitDate: true } },
    },
  });

  if (patterns.length === 0) return result;

  // 2. Bulk-fetch existing Absences in the window for these tenants' employees (idempotency).
  //    Build a set keyed by "employeeId::YYYY-MM-DD" for O(1) lookups.
  const employeeIds = Array.from(new Set(patterns.map((p) => p.employeeId)));
  const existingAbsences = await prisma.absence.findMany({
    where: {
      employeeId: { in: employeeIds },
      deletedAt: null,
      startDate: { gte: windowStart, lte: windowEnd },
    },
    select: { employeeId: true, startDate: true },
  });
  const existingSet = new Set<string>(
    existingAbsences.map((a) => `${a.employeeId}::${toIsoDate(a.startDate)}`),
  );

  // 3. Bulk-fetch SaldoSnapshots whose periodStart falls in the window's month range.
  //    Locked months are identified by (employeeId, MONTHLY, monthStartUtc(date)).
  const lockedSnapshots = await prisma.saldoSnapshot.findMany({
    where: {
      employeeId: { in: employeeIds },
      periodType: "MONTHLY",
      periodStart: { gte: monthStartUtc(windowStart), lte: monthStartUtc(windowEnd) },
    },
    select: { employeeId: true, periodStart: true },
  });
  const lockedSet = new Set<string>(
    lockedSnapshots.map((s) => `${s.employeeId}::${toIsoDate(s.periodStart)}`),
  );

  // 4. Iterate patterns × candidate dates, applying skip-conditions in order.
  for (const pattern of patterns) {
    const employee = pattern.employee;
    const patternValidUntil = pattern.validUntil;
    const patternValidFrom = pattern.validFrom;
    const hasWeekday = pattern.dayOfWeek != null;
    const hasBlockWeeks = pattern.blockWeeks.length > 0 && pattern.blockYear != null;

    // Iterate every day in the rolling window.
    for (let i = 0; i <= weeksAhead * 7; i++) {
      const date = addDaysUtc(windowStart, i);

      // (a) Pre-hire / post-exit guards — keyed on employee lifecycle.
      const hireDate = dateOnlyUtc(employee.hireDate);
      if (date < hireDate) {
        // Skipping for this pattern; counted once per skipped date.
        // We only count if a pattern would have produced this date — check after weekday/block check.
      }

      // (b) Decide if this pattern intends to produce a row for this date.
      let intended = false;
      if (hasWeekday && dowMondayBased(date) === pattern.dayOfWeek) {
        intended = true;
      }
      if (hasBlockWeeks) {
        const iso = isoWeekOf(date);
        if (iso.year === pattern.blockYear && pattern.blockWeeks.includes(iso.week)) {
          intended = true;
        }
      }
      if (!intended) continue;

      // (c) Now apply skip conditions in order.
      // Pre-hire
      if (date < hireDate) {
        result.skipped.preHire++;
        if (opts.dryRun) {
          result.details!.push({
            employeeId: employee.id,
            date: toIsoDate(date),
            action: "skipped",
            reason: "preHire",
          });
        }
        continue;
      }
      // Post-exit
      if (employee.exitDate && date > dateOnlyUtc(employee.exitDate)) {
        result.skipped.postExit++;
        if (opts.dryRun) {
          result.details!.push({
            employeeId: employee.id,
            date: toIsoDate(date),
            action: "skipped",
            reason: "postExit",
          });
        }
        continue;
      }
      // Out-of-pattern-window (validFrom/validUntil)
      if (date < dateOnlyUtc(patternValidFrom)) {
        result.skipped.outOfWindow++;
        if (opts.dryRun) {
          result.details!.push({
            employeeId: employee.id,
            date: toIsoDate(date),
            action: "skipped",
            reason: "outOfWindow",
          });
        }
        continue;
      }
      if (patternValidUntil && date > dateOnlyUtc(patternValidUntil)) {
        result.skipped.outOfWindow++;
        if (opts.dryRun) {
          result.details!.push({
            employeeId: employee.id,
            date: toIsoDate(date),
            action: "skipped",
            reason: "outOfWindow",
          });
        }
        continue;
      }
      // Existing Absence (BERSCH-08)
      const existKey = `${employee.id}::${toIsoDate(date)}`;
      if (existingSet.has(existKey)) {
        result.skipped.existing++;
        if (opts.dryRun) {
          result.details!.push({
            employeeId: employee.id,
            date: toIsoDate(date),
            action: "skipped",
            reason: "existing",
          });
        }
        continue;
      }
      // Locked month (BERSCH-09)
      const lockKey = `${employee.id}::${toIsoDate(monthStartUtc(date))}`;
      if (lockedSet.has(lockKey)) {
        result.skipped.locked++;
        if (opts.dryRun) {
          result.details!.push({
            employeeId: employee.id,
            date: toIsoDate(date),
            action: "skipped",
            reason: "locked",
          });
        }
        continue;
      }

      // (d) CREATE (or record as dry-run "created").
      if (opts.dryRun) {
        result.created++;
        result.details!.push({
          employeeId: employee.id,
          date: toIsoDate(date),
          action: "created",
        });
      } else {
        const absence = await prisma.absence.create({
          data: {
            employeeId: employee.id,
            type: "VOCATIONAL_SCHOOL",
            source: "PATTERN", // Phase 63 D-22: distinguishes auto-generated rows from MANUAL (D-23) inserts
            startDate: date,
            endDate: date,
            days: 1.0,
            createdBy: "SYSTEM",
          },
        });
        // userId is null (FK column) — the SYSTEM-origin marker lives inside newValue.
        // Encoding the originator inside newValue is the established convention for
        // SYSTEM-owned mutations (AuditLog.userId has @relation onDelete: SetNull and
        // no User row with id="SYSTEM" exists in the data model).
        await audit({
          userId: undefined,
          action: "VOCATIONAL_SCHOOL_AUTO_GENERATED",
          entity: "Absence",
          entityId: absence.id,
          newValue: {
            origin: "SYSTEM",
            employeeId: employee.id,
            date: toIsoDate(date),
            type: "VOCATIONAL_SCHOOL",
            patternId: pattern.id,
          },
        });
        // Add to existingSet so a second pattern hitting the same day won't double-create
        // (e.g. weekday + block-week both match in the same iteration).
        existingSet.add(existKey);
        result.created++;
      }
    }
  }

  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function runVocationalSchoolGeneration(
  prisma: PrismaClient,
  audit: AuditFn,
  opts: RunOpts,
): Promise<GeneratorResult> {
  return runOrPreview(prisma, audit, { ...opts, dryRun: opts.dryRun ?? false });
}

export async function previewVocationalSchoolGeneration(
  prisma: PrismaClient,
  opts: PreviewOpts,
): Promise<GeneratorResult> {
  // No-op audit fn for dry-run; runOrPreview never invokes it when dryRun=true anyway.
  const noopAudit: AuditFn = async () => {};
  return runOrPreview(prisma, noopAudit, { ...opts, dryRun: true });
}
