/**
 * Phase 83 Plan 04 — Forward re-resolution operator script.
 *
 * Re-computes `WorkEvent.workedMinutes` + `expectedMinutes` for all
 * VOCATIONAL_SCHOOL rows in a tenant using the Phase 83 slot-aware resolver
 * (`resolveBsTagSlot`). Run AFTER Phase 83 ships and BEFORE relying on saldo
 * readings for the affected tenant.
 *
 * Tenants migrated under Phase 80 (workEventModelLive=true) have WorkEvent rows
 * with stale `workedMinutes`/`expectedMinutes` from the Phase-78 pauschal-
 * placeholder logic. After Phase 83, the same BS-Tag for the same Azubi may now
 * be a SECOND_LONG_DAY with creditedMinutes=0 (netto, no instruction data) —
 * without re-resolution, the stored value is stale. This script closes that gap.
 *
 * ── Phase 80 conventions mirrored ────────────────────────────────────────────
 *
 *   B1: ALL new minute values pre-computed BEFORE entering the $transaction
 *       write loop. The week-context query reads WorkEvent rows ONCE per
 *       (employee, ISO week) before any update; no per-row re-read inside tx.
 *
 *   B2: --operator-user-id is REQUIRED. AuditLog.userId = operatorUserId,
 *       never null (Revisionssicherheit per CLAUDE.md "Audit trail").
 *
 *   B3: AuditLog.create runs INSIDE the $transaction as the LAST write before
 *       commit boundary. If it throws, the whole tx rolls back.
 *
 *   M-3: All queries scoped to the target tenant via employee relation filter.
 *
 * ── Locked-month skip (T-83-01) ──────────────────────────────────────────────
 *
 *   Pre-loads locked periods per employee using the canonical signal:
 *   at least one TimeEntry in the period has isLocked=true (mirrors
 *   recalculate-snapshots-after-soll-fix.ts isSnapshotLocked pattern).
 *   WorkEvent rows whose date falls in a locked period are skipped + counted.
 *   The AuditLog summary records lockedSkipped. Per CLAUDE.md: "Once a month
 *   is closed (isLocked), entries MUST NOT be editable or deletable — not even
 *   by admins."
 *
 * ── D-04 invariant ───────────────────────────────────────────────────────────
 *
 *   expectedMinutes is only set when slot.contributesToExpected is true
 *   (Phase 63 D-04: MONTHLY_HOURS schedules have no daily hour target →
 *   BS minutes add to workedMinutes but NOT expectedMinutes).
 *
 * ── Snapshot / Rollback ──────────────────────────────────────────────────────
 *
 *   Pre-update originals persisted to:
 *     apps/api/scripts/.snapshots/reresolve-{tenantId}-{runId}.json
 *   for byte-exact rollback via rollback-reresolve-work-event.ts.
 *   .snapshots/ is gitignored — never commit tenant data.
 *
 * ── Idempotency ──────────────────────────────────────────────────────────────
 *
 *   Re-running after a successful apply produces affectedRows=0 because the
 *   resolver yields the same output given identical inputs (pure function).
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
 *     scripts/reresolve-work-event-minutes.ts \
 *     --tenant-id <uuid> \
 *     --operator-user-id <uuid> \
 *     [--apply] \
 *     [--before-date <YYYY-MM-DD>]
 *
 * Without --apply: dry-run, prints JSON summary.
 * With    --apply: opens ONE prisma.$transaction per tenant.
 */
import { PrismaClient, WorkEventType, type ScheduleType } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveBsTagSlot,
  buildSlotOverrideHierarchy,
  isoWeekBoundsUtc,
  toIsoDate,
  resolveScheduleTypeAt,
} from "../src/utils/work-event.js";
import type { WeekContext, SlotLayerInputs } from "../src/utils/work-event.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const RERESOLVE_ACTION = "RERESOLVE_WORK_EVENT_MINUTES_V19";
const RERESOLVE_USER_AGENT = "script:reresolve-work-event-minutes";
const TX_TIMEOUT_MS = 90_000;

// __dirname polyfill for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SNAPSHOT_DIR = join(__dirname, ".snapshots");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UpdateRow {
  id: string;
  employeeId: string;
  date: string; // ISO YYYY-MM-DD
  oldWorked: number;
  oldExpected: number | null;
  newWorked: number;
  newExpected: number | null;
}

export interface ReresolveSummary {
  runId: string;
  tenantId: string;
  dryRun: boolean;
  affectedRows: number;
  unchangedRows: number;
  lockedSkipped: number;
  snapshotPath: string | null;
  sampleDiff: UpdateRow[];
  durationMs: number;
}

// ── parseArgs2 ────────────────────────────────────────────────────────────────

const USAGE = `Usage: tsx scripts/reresolve-work-event-minutes.ts \\
  --tenant-id <uuid> \\
  --operator-user-id <uuid> \\
  [--apply] \\
  [--before-date <YYYY-MM-DD>]

  --tenant-id          REQUIRED — UUID of the tenant to re-resolve.
  --operator-user-id   REQUIRED — UUID of the operator User row;
                       written to AuditLog.userId (B2 — Revisionssicherheit).
  --apply              Opt-in. Without it the script runs dry-run.
  --before-date        Optional ISO date cutoff — only process WorkEvent rows
                       with date < beforeDate.

Safety:
  - Pre-compute phase runs BEFORE the tx write loop (B1).
  - Locked months are skipped (T-83-01).
  - Summary AuditLog written INSIDE the tx as the last write (B3).
  - Originals persisted to .snapshots/ for rollback.
  - Idempotent: re-run produces affectedRows=0.
  - --operator-user-id REQUIRED; missing → exit 1 with German error.
`;

export interface CliArgs {
  tenantId: string | null;
  operatorUserId: string | null;
  apply: boolean;
  beforeDate: string | null;
}

export function parseArgs2(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "tenant-id": { type: "string" },
      "operator-user-id": { type: "string" },
      apply: { type: "boolean", default: false },
      "before-date": { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values["help"]) {
    console.log(USAGE);
    process.exit(0);
  }

  return {
    tenantId: values["tenant-id"] ?? null,
    operatorUserId: values["operator-user-id"] ?? null,
    apply: Boolean(values["apply"]),
    beforeDate: values["before-date"] ?? null,
  };
}

// ── Locked-month helper ───────────────────────────────────────────────────────

/**
 * Builds a lookup for locked periods per employee within a tenant.
 * Canonical signal: at least one TimeEntry in the period has isLocked=true
 * (mirrors recalculate-snapshots-after-soll-fix.ts isSnapshotLocked pattern).
 *
 * Returns a Set of "employeeId:YYYY-MM" strings for all locked month-starts.
 */
async function buildLockedMonthSet(
  prisma: PrismaClient,
  tenantId: string,
): Promise<Set<string>> {
  // Load all locked TimeEntry rows for the tenant's employees.
  const lockedEntries = await prisma.timeEntry.findMany({
    where: {
      deletedAt: null,
      isLocked: true,
      employee: { tenantId },
    },
    select: { employeeId: true, date: true },
  });

  const lockedSet = new Set<string>();
  for (const entry of lockedEntries) {
    const monthKey = `${entry.employeeId}:${toIsoDate(entry.date).slice(0, 7)}`; // "empId:YYYY-MM"
    lockedSet.add(monthKey);
  }
  return lockedSet;
}

function isLockedFor(lockedSet: Set<string>, employeeId: string, date: Date): boolean {
  const monthKey = `${employeeId}:${toIsoDate(date).slice(0, 7)}`;
  return lockedSet.has(monthKey);
}

// ── main ──────────────────────────────────────────────────────────────────────

/**
 * Test-injectable entry point. Pass a PrismaClient to inject a test
 * connection; without one the function creates its own.
 *
 * @param runIdOverride  For tests: override the randomUUID() runId so snapshots
 *                       are predictable. Must not be used in production.
 */
export async function main(
  argv: string[],
  injectedPrisma?: PrismaClient,
  runIdOverride?: string,
): Promise<ReresolveSummary> {
  const args = parseArgs2(argv);

  // ── Required-flag validation (B2) ──────────────────────────────────────────
  if (!args.tenantId) {
    throw new Error("Tenant-Auswahl erforderlich: bitte --tenant-id <uuid> angeben.");
  }
  if (!args.operatorUserId) {
    throw new Error(
      "Operator-Auswahl erforderlich: bitte --operator-user-id <uuid> angeben.",
    );
  }
  if (!UUID_RE.test(args.tenantId)) {
    throw new Error("--tenant-id muss eine gültige UUID sein.");
  }
  if (!UUID_RE.test(args.operatorUserId)) {
    throw new Error("--operator-user-id muss eine gültige UUID sein.");
  }

  const tenantId = args.tenantId;
  const operatorUserId = args.operatorUserId;
  const RUN_ID = runIdOverride ?? randomUUID();

  const prisma = injectedPrisma ?? new PrismaClient();
  const ownsPrisma = !injectedPrisma;
  const startedAt = Date.now();

  try {
    // ── Existence checks ────────────────────────────────────────────────────
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      throw new Error(`Tenant ${tenantId} nicht gefunden.`);
    }
    const operator = await prisma.user.findUnique({ where: { id: operatorUserId } });
    if (!operator) {
      throw new Error(`Operator-User ${operatorUserId} nicht gefunden.`);
    }

    // ── Announce on --apply (IN-10 pattern) ─────────────────────────────────
    if (args.apply) {
      console.log(`runId=${RUN_ID} tenantId=${tenantId} apply=true`);
    }

    // ── Phase 1: Pre-compute (B1) ────────────────────────────────────────────
    // Load all WorkEvent VS rows for tenant (via employee join).
    const weRows = await prisma.workEvent.findMany({
      where: {
        deletedAt: null,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        employee: { tenantId },
        ...(args.beforeDate ? { date: { lt: new Date(args.beforeDate + "T00:00:00Z") } } : {}),
      },
      orderBy: [{ employeeId: "asc" }, { date: "asc" }],
      select: {
        id: true,
        employeeId: true,
        date: true,
        workedMinutes: true,
        expectedMinutes: true,
      },
    });

    // Build locked-month set ONCE.
    const lockedSet = await buildLockedMonthSet(prisma, tenantId);

    // Per-employee caches to avoid redundant DB reads.
    // Employee bsSlot* + active pattern bsSlot* + tenantConfig — loaded once per employee.
    const employeeHierarchyCache = new Map<string, SlotLayerInputs>();

    // Load tenantConfig once (shared across all employees).
    const tenantConfig = await prisma.tenantConfig.findUnique({
      where: { tenantId },
      select: {
        bsSlotFirstLongDayMinutes: true,
        bsSlotSecondLongDayMinutes: true,
        bsSlotShortDayMinutes: true,
        bsSlotBlockWeekMinutes: true,
        vocationalSchoolMinutesPerDay: true,
        vocationalSchoolBlockMinutesPerWeek: true,
      },
    });
    if (!tenantConfig) {
      throw new Error(`TenantConfig für Tenant ${tenantId} nicht gefunden.`);
    }

    // ISO-week context cache: keyed by "employeeId:YYYY-MM-DD(monday)".
    const weekContextCache = new Map<string, WeekContext>();

    // scheduleType cache: keyed by "employeeId:YYYY-MM-DD".
    const scheduleTypeCache = new Map<string, ScheduleType>();

    const updates: UpdateRow[] = [];
    const unchanged: UpdateRow[] = [];
    const lockedSkippedRows: { id: string; employeeId: string; date: string }[] = [];

    for (const we of weRows) {
      // T-83-01 locked-month skip.
      if (isLockedFor(lockedSet, we.employeeId, we.date)) {
        lockedSkippedRows.push({ id: we.id, employeeId: we.employeeId, date: toIsoDate(we.date) });
        continue;
      }

      // Load per-employee hierarchy once (Employee + active Pattern + tenant config).
      if (!employeeHierarchyCache.has(we.employeeId)) {
        const emp = await prisma.employee.findUnique({
          where: { id: we.employeeId },
          select: {
            bsSlotFirstLongDayMinutes: true,
            bsSlotSecondLongDayMinutes: true,
            bsSlotShortDayMinutes: true,
            bsSlotBlockWeekMinutes: true,
            vocationalSchoolPatterns: {
              where: { isActive: true },
              select: {
                bsSlotFirstLongDayMinutes: true,
                bsSlotSecondLongDayMinutes: true,
                bsSlotShortDayMinutes: true,
                bsSlotBlockWeekMinutes: true,
              },
              take: 1,
            },
          },
        });

        const activePattern = emp?.vocationalSchoolPatterns[0] ?? null;

        employeeHierarchyCache.set(we.employeeId, {
          employee: emp
            ? {
                bsSlotFirstLongDayMinutes: emp.bsSlotFirstLongDayMinutes,
                bsSlotSecondLongDayMinutes: emp.bsSlotSecondLongDayMinutes,
                bsSlotShortDayMinutes: emp.bsSlotShortDayMinutes,
                bsSlotBlockWeekMinutes: emp.bsSlotBlockWeekMinutes,
              }
            : null,
          pattern: activePattern,
          tenantConfig: {
            bsSlotFirstLongDayMinutes: tenantConfig.bsSlotFirstLongDayMinutes,
            bsSlotSecondLongDayMinutes: tenantConfig.bsSlotSecondLongDayMinutes,
            bsSlotShortDayMinutes: tenantConfig.bsSlotShortDayMinutes,
            bsSlotBlockWeekMinutes: tenantConfig.bsSlotBlockWeekMinutes,
            vocationalSchoolMinutesPerDay: tenantConfig.vocationalSchoolMinutesPerDay,
            vocationalSchoolBlockMinutesPerWeek: tenantConfig.vocationalSchoolBlockMinutesPerWeek,
          },
        });
      }

      const hierarchy = buildSlotOverrideHierarchy(employeeHierarchyCache.get(we.employeeId)!);

      // Build ISO-week context (cached per employee+week).
      const { monday, nextMonday } = isoWeekBoundsUtc(we.date);
      const weekKey = `${we.employeeId}:${toIsoDate(monday)}`;

      if (!weekContextCache.has(weekKey)) {
        const weekRows = await prisma.workEvent.findMany({
          where: {
            employeeId: we.employeeId,
            deletedAt: null,
            type: WorkEventType.VOCATIONAL_SCHOOL,
            date: { gte: monday, lt: nextMonday },
          },
          orderBy: { date: "asc" },
          select: { date: true },
        });
        const bsDatesInWeek = weekRows.map((r) => toIsoDate(r.date));
        weekContextCache.set(weekKey, {
          bsDatesInWeek,
          isBlockWeek: bsDatesInWeek.length >= 5,
        });
      }

      const weekContext = weekContextCache.get(weekKey)!;

      // ordinalInWeek: 1-based position in bsDatesInWeek (clamped to >= 1).
      const ordinalInWeek = Math.max(1, weekContext.bsDatesInWeek.indexOf(toIsoDate(we.date)) + 1);

      // scheduleType (cached per employee+date).
      const dateCacheKey = `${we.employeeId}:${toIsoDate(we.date)}`;
      if (!scheduleTypeCache.has(dateCacheKey)) {
        const st = await resolveScheduleTypeAt(prisma, we.employeeId, we.date);
        scheduleTypeCache.set(dateCacheKey, st);
      }
      const scheduleType = scheduleTypeCache.get(dateCacheKey)!;

      // Resolve slot.
      const slot = resolveBsTagSlot(we.date, ordinalInWeek, weekContext, hierarchy, scheduleType);

      // D-04 invariant: expectedMinutes only set when contributesToExpected.
      const newExpected = slot.contributesToExpected ? slot.creditedMinutes : null;
      const newWorked = slot.creditedMinutes;

      if (we.workedMinutes === newWorked && we.expectedMinutes === newExpected) {
        unchanged.push({
          id: we.id,
          employeeId: we.employeeId,
          date: toIsoDate(we.date),
          oldWorked: we.workedMinutes,
          oldExpected: we.expectedMinutes,
          newWorked,
          newExpected,
        });
      } else {
        updates.push({
          id: we.id,
          employeeId: we.employeeId,
          date: toIsoDate(we.date),
          oldWorked: we.workedMinutes,
          oldExpected: we.expectedMinutes,
          newWorked,
          newExpected,
        });
      }
    }

    // ── Summary object ───────────────────────────────────────────────────────
    const summary: ReresolveSummary = {
      runId: RUN_ID,
      tenantId,
      dryRun: !args.apply,
      affectedRows: updates.length,
      unchangedRows: unchanged.length,
      lockedSkipped: lockedSkippedRows.length,
      snapshotPath: null,
      sampleDiff: updates.slice(0, 5),
      durationMs: Date.now() - startedAt,
    };

    // ── Dry-run branch ───────────────────────────────────────────────────────
    if (!args.apply) {
      console.log(JSON.stringify(summary, null, 2));
      return summary;
    }

    // ── Apply branch ─────────────────────────────────────────────────────────
    // Persist snapshot for rollback BEFORE the tx (so it's on disk even if tx fails).
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const snapshotPath = join(SNAPSHOT_DIR, `reresolve-${tenantId}-${RUN_ID}.json`);
    const snapshotPayload = { runId: RUN_ID, tenantId, updates };
    writeFileSync(snapshotPath, JSON.stringify(snapshotPayload, null, 2), "utf-8");
    summary.snapshotPath = snapshotPath;

    await prisma.$transaction(
      async (tx) => {
        // B1: all updates[] pre-computed; just write them.
        for (const u of updates) {
          await tx.workEvent.update({
            where: { id: u.id },
            data: {
              workedMinutes: u.newWorked,
              expectedMinutes: u.newExpected,
            },
          });
        }

        // B3: AuditLog as LAST write inside tx before commit boundary.
        await tx.auditLog.create({
          data: {
            userId: operatorUserId,
            action: RERESOLVE_ACTION,
            entity: "WorkEvent",
            entityId: tenantId,
            oldValue: {
              runId: RUN_ID,
              snapshotPath,
              affectedRows: updates.length,
            },
            newValue: {
              runId: RUN_ID,
              tenantId,
              affectedRows: updates.length,
              unchangedRows: unchanged.length,
              lockedSkipped: lockedSkippedRows.length,
              sampleDiff: updates.slice(0, 5),
              durationMs: Date.now() - startedAt,
            },
            ipAddress: null,
            userAgent: RERESOLVE_USER_AGENT,
          },
        });
      },
      { timeout: TX_TIMEOUT_MS },
    );

    summary.durationMs = Date.now() - startedAt;
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    if (ownsPrisma) {
      await prisma.$disconnect();
    }
  }
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

const isMain =
  typeof require !== "undefined" && typeof module !== "undefined" && require.main === module;

if (isMain) {
  (async () => {
    if (!process.env.DATABASE_URL) {
      console.error("DATABASE_URL is required");
      process.exit(1);
    }

    if (process.argv.includes("--help")) {
      await main(process.argv.slice(2));
      process.exit(0);
    }

    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new PrismaPg(pool as any);
    const prisma = new PrismaClient({ adapter });

    try {
      await main(process.argv.slice(2), prisma);
    } catch (err) {
      console.error((err as Error).message ?? err);
      process.exit(1);
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }
  })();
}
