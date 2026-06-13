/**
 * Phase 80 Plan 01 — Forward migration script for the WorkEvent model.
 *
 * Moves every `Absence` row of type `VOCATIONAL_SCHOOL` for a single tenant to a
 * `WorkEvent` row, then flips `TenantConfig.workEventModelLive` from `false` to
 * `true` — all inside ONE per-tenant `prisma.$transaction`.
 *
 * Phase 78 added the flag with @default(false). Phase 79 wired the BC proxy +
 * new /work-events endpoints. This script is the missing operator step that
 * trips the flag for a specific tenant.
 *
 * ── Surgical fixes from plan-checker review (2026-06-12) ─────────────────────
 *
 *   B1: ALL workedMinutes + expectedMinutes are precomputed BEFORE entering the
 *       write loop. countBsDaysInIsoWeek reads `Absence WHERE deletedAt:null`,
 *       so a per-row resolve inside the loop would see a shrinking live-set
 *       after each iteration's soft-delete → wrong block-week math. Mirrors
 *       work-event.ts aggregateLegacyAbsences pattern (single source read,
 *       then walk rows in memory).
 *
 *   B2: --operator-user-id is REQUIRED. AuditLog.userId is set to the validated
 *       operator UUID (Revisionssicherheit per CLAUDE.md "Audit trail").
 *
 *   B3: AuditLog.create runs IMMEDIATELY BEFORE the flag flip. The flag flip is
 *       THE FINAL write — the irreversible signal that the tenant is migrated.
 *       If AuditLog throws, the entire tx rolls back including the flag flip.
 *
 *   B4: preserveOriginalNote non-destructively appends the migration marker to
 *       Absence.note. The rollback script (Plan 80-02) strips the suffix to
 *       restore byte-equivalent original notes.
 *
 *   W5: Pre-flight halts on pre-existing WorkEvent rows with legacyAbsenceId
 *       IS NULL (likely Phase 79 manual inserts) unless --allow-existing-work-events.
 *
 *   W7: isP2002OnUniqueKey type-narrowed to the expected `[employeeId, date,
 *       type]` target only. P2002 on `legacyAbsenceId` (different target) is
 *       rethrown — that indicates a duplicate concurrent run.
 *
 *   W8: invalidateTenantWorkEventModelLiveCache called AFTER successful commit
 *       so the BC proxy + saldo paths observe the new flag immediately.
 *
 *   W9: Source query is unbatched (single findMany). Limit: < 100k Absence VS
 *       rows per tenant per migration window. Larger tenants are a deferred
 *       multi-batch concern — see docs/work-event-migration-runbook.md.
 *
 * ── Mitigations from CONTEXT.md ──────────────────────────────────────────────
 *
 *   M-1: Idempotency via @@unique([employeeId, date, type]) P2002 catch (W7).
 *   M-2: Summary-only AuditLog — ONE row per tenant per run.
 *   M-4: pauseTenantGeneration(tenantId) before tx + resumeTenantGeneration in
 *        finally so the daily 02:30 BS cron cannot insert mid-migration.
 *   M-5: Non-AZUBI safety pre-flight halt + --allow-non-azubi-legacy override.
 *   M-6: Inverse rollback script (Plan 80-02) ships in the SAME PR.
 *
 * ── Runbook ──────────────────────────────────────────────────────────────────
 *
 *   docs/work-event-migration-runbook.md — operator playbook with W6 + W8
 *   hardening + 5 recovery scenarios.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
 *     scripts/migrate-bs-to-work-event.ts \
 *     --tenant-id <uuid> \
 *     --operator-user-id <uuid> \
 *     [--apply] \
 *     [--allow-non-azubi-legacy] \
 *     [--allow-existing-work-events] \
 *     [--help]
 *
 * Without --apply: dry-run, prints the JSON summary.
 * With    --apply: opens ONE prisma.$transaction per tenant (rollback on any throw).
 */
import { PrismaClient, Prisma, WorkEventType, WorkEventSource, AbsenceType } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import {
  pauseTenantGeneration,
  resumeTenantGeneration,
} from "../src/utils/vocational-school-generator";
import { invalidateTenantWorkEventModelLiveCache } from "../src/utils/work-event";
import { getVocationalSchoolMinutesForDate } from "../src/utils/vocational-school-saldo";

// ── Constants ─────────────────────────────────────────────────────────────────

export const MIGRATION_ACTION = "WORK_EVENT_MIGRATION_V19";
const MIGRATION_USER_AGENT = "script:migrate-bs-to-work-event";
const TX_TIMEOUT_MS = 60_000;

/**
 * W9: source query is unbatched (single findMany). Limit: < 100k Absence VS
 * rows per tenant per migration window. Larger tenants are a deferred multi-
 * batch concern — see docs/work-event-migration-runbook.md.
 *
 * IN_MEMORY_PRECOMPUTE_BATCH_SIZE controls Promise.all concurrency for the
 * getVocationalSchoolMinutesForDate read fan-out, NOT tx-internal batching.
 */
const IN_MEMORY_PRECOMPUTE_BATCH_SIZE = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Regex used by both forward + rollback scripts to detect/strip the migration
 * marker. Phase 80 Plan 02 imports this constant to keep round-trip semantics
 * byte-equivalent.
 *
 * The runId portion accepts any non-`]` chars so that:
 *   - Production UUIDs (always lowercased hex+hyphen) match.
 *   - Test fake runIds (e.g. "old-run-1234") also match the strip path so
 *     re-run idempotency can be exercised in unit tests without coupling to
 *     UUID format.
 */
export const MIGRATION_NOTE_PATTERN = /\n?\[Migrated to WorkEvent\. Run: [^\]]+\]$/;

// ── Exported types ────────────────────────────────────────────────────────────

export type CliArgs = {
  tenantId: string | null;
  operatorUserId: string | null;
  apply: boolean;
  allowNonAzubiLegacy: boolean;
  allowExistingWorkEvents: boolean;
  help: boolean;
};

export type DataQualityIssues = {
  existingWorkEventsWithoutLegacyLink: number;
};

export type MigrationSummary = {
  tenantId: string | null;
  operatorUserId: string | null;
  dryRun: boolean;
  runId: string;
  sourceCount: number;
  nonAzubiLegacyCount: number;
  existingWorkEventCount: number;
  createdCount: number;
  skipped: number;
  allowNonAzubiLegacy: boolean;
  allowExistingWorkEvents: boolean;
  dataQualityIssues: DataQualityIssues;
  durationMs: number;
  flagFlipped: boolean;
};

// ── Exported helpers (test-importable) ────────────────────────────────────────

/**
 * B4 — Non-destructive Absence.note marker append.
 *
 *   - null note      → "[Migrated to WorkEvent. Run: <runId>]"
 *   - operator note  → "<operator note>\n[Migrated to WorkEvent. Run: <runId>]"
 *   - idempotent: re-runs with same runId produce identical output
 *   - new runId on already-migrated note strips the old marker first
 *
 * Plan 80-02 (rollback) imports this regex constant to strip the suffix
 * cleanly so the post-rollback note byte-equals the original operator note.
 */
export function preserveOriginalNote(existingNote: string | null, runId: string): string {
  const suffix = `[Migrated to WorkEvent. Run: ${runId}]`;
  if (existingNote === null || existingNote === "") {
    return suffix;
  }
  // Strip any prior migration marker (idempotent re-runs + cross-run replacements).
  const stripped = existingNote.replace(MIGRATION_NOTE_PATTERN, "");
  if (stripped === "") {
    return suffix;
  }
  return `${stripped}\n${suffix}`;
}

/**
 * W7 — Type-narrow a thrown error to Prisma P2002 ON A SPECIFIC unique target.
 *
 * The migration loop expects P2002 ONLY on the @@unique([employeeId, date,
 * type]) constraint (idempotent re-run hit). P2002 on `legacyAbsenceId`
 * (different target) means a concurrent migration is writing to the same
 * source Absence → real bug, rethrow.
 *
 * Matches when `e.meta.target` is an array containing ALL of the expected
 * keys (Prisma encodes the unique-constraint columns there).
 */
export function isP2002OnUniqueKey(e: unknown, expectedTarget: string[]): boolean {
  if (e === null || e === undefined) return false;
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (e.code !== "P2002") return false;
  const meta = e.meta as { target?: unknown } | undefined;
  const target = meta?.target;
  if (!Array.isArray(target)) return false;
  return expectedTarget.every((k) => (target as string[]).includes(k));
}

// ── parseArgs2 ────────────────────────────────────────────────────────────────

const USAGE = `Usage: tsx scripts/migrate-bs-to-work-event.ts \\
  --tenant-id <uuid> \\
  --operator-user-id <uuid> \\
  [--apply] \\
  [--allow-non-azubi-legacy] \\
  [--allow-existing-work-events] \\
  [--help]

  --tenant-id                    REQUIRED — UUID of the tenant to migrate.
  --operator-user-id             REQUIRED — UUID of the operator User row;
                                 written to AuditLog.userId (B2 — Revisionssicherheit).
  --apply                        Opt-in. Without it the script runs dry-run.
  --allow-non-azubi-legacy       Proceed when Absence VS rows exist on non-AZUBI
                                 employees (M-5). Default: fail-closed halt.
  --allow-existing-work-events   Proceed when WorkEvent VS rows exist with
                                 legacyAbsenceId IS NULL (W5 — likely Phase 79
                                 manual inserts). Default: fail-closed halt.
  --help                         Print this usage block and exit 0.

Safety:
  - Per-tenant atomic transaction; AuditLog + flag flip are the last two writes
    inside the tx, in that order (B3). Rollback on any throw.
  - Idempotent: re-running --apply produces createdCount=0, skipped=<prior createdCount>.
  - Generator pause via pauseTenantGeneration(tenantId) before tx; resume in finally.
  - Cache invalidation via invalidateTenantWorkEventModelLiveCache(tenantId) after commit.
  - Notes: operator-authored Absence.note preserved byte-for-byte; rollback
    script (Plan 80-02) strips the migration marker via the shared regex constant.

See docs/work-event-migration-runbook.md for the operator playbook.
`;

export function parseArgs2(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "tenant-id": { type: "string" },
      "operator-user-id": { type: "string" },
      apply: { type: "boolean", default: false },
      "allow-non-azubi-legacy": { type: "boolean", default: false },
      "allow-existing-work-events": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  return {
    tenantId: values["tenant-id"] ?? null,
    operatorUserId: values["operator-user-id"] ?? null,
    apply: Boolean(values["apply"]),
    allowNonAzubiLegacy: Boolean(values["allow-non-azubi-legacy"]),
    allowExistingWorkEvents: Boolean(values["allow-existing-work-events"]),
    help: Boolean(values["help"]),
  };
}

// ── main ──────────────────────────────────────────────────────────────────────

function emptySummary(): MigrationSummary {
  return {
    tenantId: null,
    operatorUserId: null,
    dryRun: true,
    runId: "",
    sourceCount: 0,
    nonAzubiLegacyCount: 0,
    existingWorkEventCount: 0,
    createdCount: 0,
    skipped: 0,
    allowNonAzubiLegacy: false,
    allowExistingWorkEvents: false,
    dataQualityIssues: { existingWorkEventsWithoutLegacyLink: 0 },
    durationMs: 0,
    flagFlipped: false,
  };
}

/**
 * Test-injectable entry point. Pass a PrismaClient to inject a test
 * connection; without one the function creates its own.
 */
export async function main(
  argv: string[],
  injectedPrisma?: PrismaClient,
): Promise<MigrationSummary> {
  const args = parseArgs2(argv);

  if (args.help) {
    console.log(USAGE);
    return emptySummary();
  }

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

  const prisma = injectedPrisma ?? new PrismaClient();
  const ownsPrisma = !injectedPrisma;

  try {
    // ── Tenant + operator existence checks ─────────────────────────────────
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      throw new Error(`Tenant ${tenantId} nicht gefunden.`);
    }

    const operator = await prisma.user.findUnique({ where: { id: operatorUserId } });
    if (!operator) {
      throw new Error(`Operator-User ${operatorUserId} nicht gefunden.`);
    }

    // ── Pre-flight safety queries ──────────────────────────────────────────
    // (M-5) Non-AZUBI Absence VS rows — silent migration would hide upstream bugs.
    const nonAzubiLegacyCount = await prisma.absence.count({
      where: {
        deletedAt: null,
        type: AbsenceType.VOCATIONAL_SCHOOL,
        employee: {
          tenantId,
          classification: { not: "AZUBI" },
        },
      },
    });
    if (nonAzubiLegacyCount > 0 && !args.allowNonAzubiLegacy) {
      throw new Error(
        `Pre-flight Halt: ${nonAzubiLegacyCount} Absence VS Rows ohne AZUBI-Klassifikation gefunden. ` +
          "Mit --allow-non-azubi-legacy fortfahren oder Datenquelle bereinigen.",
      );
    }

    // (W5) Pre-existing WorkEvent VS rows lacking legacyAbsenceId — likely
    // Phase 79 manual inserts. Silent migration alongside them would obscure
    // the operational picture.
    const existingWorkEventCount = await prisma.workEvent.count({
      where: {
        deletedAt: null,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        legacyAbsenceId: null,
        employee: { tenantId },
      },
    });
    if (existingWorkEventCount > 0 && !args.allowExistingWorkEvents) {
      throw new Error(
        `Pre-flight Halt: ${existingWorkEventCount} bestehende WorkEvent VS Rows ohne legacyAbsenceId gefunden ` +
          "(vorab durch /work-events erstellt?). " +
          "Mit --allow-existing-work-events fortfahren oder Datenquelle prüfen.",
      );
    }

    // ── Resolve TenantConfig slice once ────────────────────────────────────
    const tenantConfig = await prisma.tenantConfig.findUnique({
      where: { tenantId },
      select: {
        vocationalSchoolMinutesPerDay: true,
        vocationalSchoolBlockMinutesPerWeek: true,
      },
    });
    const tenantConfigSlice = {
      vocationalSchoolMinutesPerDay: tenantConfig?.vocationalSchoolMinutesPerDay ?? null,
      vocationalSchoolBlockMinutesPerWeek:
        tenantConfig?.vocationalSchoolBlockMinutesPerWeek ?? null,
    };

    // ── Phase 1: snapshot read + precompute (B1) ───────────────────────────
    // CRITICAL B1 fix: precompute ALL workedMinutes BEFORE entering the tx.
    // getVocationalSchoolMinutesForDate internally calls countBsDaysInIsoWeek
    // which reads `Absence WHERE deletedAt:null`. If we called it inside the
    // tx write loop, each iteration's soft-delete would shrink the live-set
    // for subsequent iterations → wrong block-week math. This pattern mirrors
    // aggregateLegacyAbsences in work-event.ts (single source read, then walk
    // in memory).
    //
    // Soft-delete contract — operator-script exception: This findMany does NOT
    // filter by `deletedAt: null`. The script is an audit-trail operator tool;
    // it must see soft-deleted rows to correctly account for previously-
    // migrated state on re-runs (idempotency: re-running produces
    // `createdCount: 0, skipped: <prior createdCount>` via the @@unique
    // [employeeId,date,type] P2002 catch). CLAUDE.md's soft-delete-filter rule
    // protects app logic from seeing tombstones; here we WANT them so the
    // P2002 path reports accurate skipped counts. The block-week math (B1)
    // still uses the live Absence pool inside getVocationalSchoolMinutesForDate
    // (called BEFORE any soft-delete), which itself filters by deletedAt:null
    // as required.
    const sourceAbsences = await prisma.absence.findMany({
      where: {
        type: AbsenceType.VOCATIONAL_SCHOOL,
        employee: { tenantId },
      },
      orderBy: [{ employeeId: "asc" }, { startDate: "asc" }],
    });
    const sourceCount = sourceAbsences.length;

    // Precompute workedMin + expectedMin for every Absence row. Use a chunked
    // Promise.all to bound DB-read concurrency.
    const precomputed: Array<{
      absence: (typeof sourceAbsences)[number];
      workedMin: number;
      expectedMin: number | null;
    }> = [];
    for (let i = 0; i < sourceAbsences.length; i += IN_MEMORY_PRECOMPUTE_BATCH_SIZE) {
      const chunk = sourceAbsences.slice(i, i + IN_MEMORY_PRECOMPUTE_BATCH_SIZE);
      const resolved = await Promise.all(
        chunk.map(async (absence) => {
          const workedMin = await getVocationalSchoolMinutesForDate(
            prisma,
            absence.employeeId,
            absence.startDate,
            tenantConfigSlice,
          );
          // Resolve schedule type at the BS date to decide expectedMin.
          // FIXED_SCHEDULE / SHIFT_BASED / FLEXTIME → expectedMin === workedMin (D-01/D-02/D-03).
          // MONTHLY_HOURS                          → expectedMin = null (D-04).
          const schedule = await prisma.workSchedule.findFirst({
            where: { employeeId: absence.employeeId, validFrom: { lte: absence.startDate } },
            orderBy: { validFrom: "desc" },
            select: { type: true },
          });
          const scheduleType = schedule?.type ?? "FIXED_SCHEDULE";
          const expectedMin = scheduleType === "MONTHLY_HOURS" ? null : workedMin;
          return { absence, workedMin, expectedMin };
        }),
      );
      precomputed.push(...resolved);
    }

    // ── Dry-run branch ─────────────────────────────────────────────────────
    if (!args.apply) {
      const dryRunSummary: MigrationSummary = {
        tenantId,
        operatorUserId,
        dryRun: true,
        runId: "",
        sourceCount,
        nonAzubiLegacyCount,
        existingWorkEventCount,
        createdCount: 0,
        skipped: 0,
        allowNonAzubiLegacy: args.allowNonAzubiLegacy,
        allowExistingWorkEvents: args.allowExistingWorkEvents,
        dataQualityIssues: {
          existingWorkEventsWithoutLegacyLink: existingWorkEventCount,
        },
        durationMs: 0,
        flagFlipped: false,
      };
      console.log(JSON.stringify(dryRunSummary, null, 2));
      return dryRunSummary;
    }

    // ── --apply branch (B3 — single LAST = flag flip) ──────────────────────
    const runId = randomUUID();
    // IN-10: First line on --apply for log correlation.
    console.error(
      `[migrate-bs-to-work-event] runId=${runId} tenantId=${tenantId} operatorUserId=${operatorUserId} apply=true`,
    );

    let createdCount = 0;
    let skipped = 0;
    const startedAt = Date.now();

    // M-4: pause the BS cron BEFORE the tx so it cannot insert mid-migration.
    // resume in finally so even a throw releases the pause.
    pauseTenantGeneration(tenantId);
    try {
      await prisma.$transaction(
        async (tx) => {
          // ── Phase 2: write loop ────────────────────────────────────────
          for (const { absence, workedMin, expectedMin } of precomputed) {
            // Pre-check the legacyAbsenceId provenance link before attempting
            // the create. Two reasons:
            //   1. Postgres aborts the entire transaction on any constraint
            //      violation — subsequent queries inside the tx return
            //      `25P02 current transaction is aborted`. So we cannot
            //      do a `findUnique` inside the catch branch. The pre-check
            //      moves the lookup to a clean tx state.
            //   2. Re-runs on already-migrated rows must produce skipped++
            //      (idempotency contract — see plan must_haves). A pre-existing
            //      WorkEvent linked to this exact Absence.id with the SAME
            //      (employeeId, date, type) means the row is already migrated.
            //      A pre-existing WorkEvent linked to this Absence.id but on a
            //      DIFFERENT date is a corruption / concurrent-attacker scenario
            //      and must rethrow so the tx rolls back (W7 invariant).
            const existingByLegacy = await tx.workEvent.findUnique({
              where: { legacyAbsenceId: absence.id },
              select: { employeeId: true, date: true, type: true },
            });
            if (existingByLegacy) {
              const sameRow =
                existingByLegacy.employeeId === absence.employeeId &&
                existingByLegacy.date.getTime() === absence.startDate.getTime() &&
                existingByLegacy.type === WorkEventType.VOCATIONAL_SCHOOL;
              if (sameRow) {
                // Idempotent re-run path — count as skipped, leave the
                // existing WorkEvent + soft-deleted Absence untouched.
                skipped++;
                continue;
              }
              // Mismatched provenance — different date / employee / type.
              // Throw P2002-shaped error so the tx rolls back and the flag
              // stays at false. This preserves the W7 invariant: a corrupt
              // legacyAbsenceId state ALWAYS rolls back, never silently
              // migrates alongside.
              throw new Prisma.PrismaClientKnownRequestError(
                `Unique constraint failed on the fields: (\`legacyAbsenceId\`) ` +
                  `for source Absence ${absence.id} — existing WorkEvent has ` +
                  `mismatched (employeeId, date, type). Refusing to silently overwrite.`,
                { code: "P2002", clientVersion: "0", meta: { target: ["legacyAbsenceId"] } },
              );
            }

            try {
              await tx.workEvent.create({
                data: {
                  employeeId: absence.employeeId,
                  type: WorkEventType.VOCATIONAL_SCHOOL,
                  source: WorkEventSource.MANUAL,
                  date: absence.startDate,
                  workedMinutes: workedMin,
                  expectedMinutes: expectedMin,
                  legacyAbsenceId: absence.id,
                  createdBy: operatorUserId,
                },
              });
            } catch (e) {
              // W7: type-narrow P2002 to the expected unique target.
              // After the legacyAbsenceId pre-check above, the only expected
              // P2002 here is on @@unique([employeeId, date, type]) — happens
              // when a WorkEvent VS row exists for this date that does NOT
              // share the legacyAbsenceId (e.g. Phase 79 manual insert which
              // the pre-flight W5 check + --allow-existing-work-events would
              // already have surfaced).
              if (isP2002OnUniqueKey(e, ["employeeId", "date", "type"])) {
                skipped++;
                continue;
              }
              // Anything else (including unexpected P2002 targets) → rethrow.
              throw e;
            }

            await tx.absence.update({
              where: { id: absence.id },
              data: {
                deletedAt: new Date(),
                note: preserveOriginalNote(absence.note, runId),
              },
            });
            createdCount++;
          }

          // ── THIRD-FROM-LAST: AuditLog summary row (M-2 + B2) ───────────
          // Exactly ONE AuditLog row per --apply run. userId = operatorUserId
          // (B2 — never null). entity = "Tenant", entityId = tenantId so the
          // row can be located by tenant scope.
          await tx.auditLog.create({
            data: {
              userId: operatorUserId,
              action: MIGRATION_ACTION,
              entity: "Tenant",
              entityId: tenantId,
              oldValue: { workEventModelLive: false },
              newValue: {
                runId,
                sourceCount,
                createdCount,
                skipped,
                allowNonAzubiLegacy: args.allowNonAzubiLegacy,
                nonAzubiLegacyCount,
                allowExistingWorkEvents: args.allowExistingWorkEvents,
                existingWorkEventCount,
                dataQualityIssues: {
                  existingWorkEventsWithoutLegacyLink: existingWorkEventCount,
                },
                durationMs: Date.now() - startedAt,
              },
              ipAddress: null,
              userAgent: MIGRATION_USER_AGENT,
            },
          });

          // ── LAST (B3 — flag flip is THE FINAL write) ───────────────────
          // The flag flip is the irreversible signal that the tenant is
          // migrated. If anything before it throws (including the AuditLog
          // create above), the whole tx rolls back and the flag stays false.
          await tx.tenantConfig.update({
            where: { tenantId },
            data: { workEventModelLive: true },
          });
        },
        { timeout: TX_TIMEOUT_MS },
      );

      // ── After tx commits ──────────────────────────────────────────────
      // W8: invalidate the tenant cache so the BC proxy + saldo paths observe
      // the new flag value immediately (the cache TTL is 5min, too slow for
      // operator workflow).
      invalidateTenantWorkEventModelLiveCache(tenantId);
    } finally {
      // M-4: resume even on throw so the BS cron is not left paused
      // permanently after a failed migration.
      resumeTenantGeneration(tenantId);
    }

    const summary: MigrationSummary = {
      tenantId,
      operatorUserId,
      dryRun: false,
      runId,
      sourceCount,
      nonAzubiLegacyCount,
      existingWorkEventCount,
      createdCount,
      skipped,
      allowNonAzubiLegacy: args.allowNonAzubiLegacy,
      allowExistingWorkEvents: args.allowExistingWorkEvents,
      dataQualityIssues: {
        existingWorkEventsWithoutLegacyLink: existingWorkEventCount,
      },
      durationMs: Date.now() - startedAt,
      flagFlipped: true,
    };
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    if (ownsPrisma) {
      await prisma.$disconnect();
    }
  }
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────
// Mirrors recalculate-snapshots-after-soll-fix.ts L350-381: PrismaPg adapter
// from DATABASE_URL, exit non-zero on any error. Skipped when imported
// (require.main !== module) so the test suite can `import { main }` without
// triggering DB connection setup.
const isMain =
  typeof require !== "undefined" && typeof module !== "undefined" && require.main === module;

if (isMain) {
  (async () => {
    if (!process.env.DATABASE_URL) {
      console.error("DATABASE_URL is required");
      process.exit(1);
    }

    // Allow --help to short-circuit before pool construction.
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
