/**
 * Phase 80 Plan 02 — Inverse rollback script for the WorkEvent model.
 *
 * Reverses every operation Plan 80-01's forward script performs. Source of
 * truth = `WorkEvent.legacyAbsenceId` (the provenance link the forward script
 * sets on every row it creates). For each WorkEvent row with a non-null
 * `legacyAbsenceId`:
 *
 *   1. Reactivate the linked Absence row (`deletedAt: null`, strip migration
 *      marker suffix from `note` so the operator-authored prefix is restored
 *      byte-equivalent — B4).
 *   2. Soft-delete the WorkEvent row (`deletedAt = now()`, rollback marker
 *      `note` — Revisionssicherheit: the row remains in the DB as an audit
 *      trail residue of the migrate-then-rollback sequence).
 *
 * Then the AuditLog summary row + flag flip (`workEventModelLive = false`) run
 * as the LAST two writes inside the same `prisma.$transaction`. If anything
 * throws, the whole tx rolls back and the flag stays at whatever it was before
 * (either true if the tenant is still migrated, or false if the rollback was
 * a partial-state recovery attempt).
 *
 * ── CRITICAL safety property — operator-created rows ─────────────────────────
 *
 *   The source query filters by `legacyAbsenceId: { not: null }`. WorkEvent
 *   rows created by Phase 79 endpoints (POST /work-events, POST
 *   /vocational-school/manual-insert in WorkEvent-routed mode) have
 *   `legacyAbsenceId IS NULL` because they were never migrated from a
 *   pre-existing Absence row — they are native to the WorkEvent model.
 *
 *   This rollback script LEAVES THOSE ROWS UNTOUCHED. Otherwise rolling back a
 *   tenant who has been on the WorkEvent model long enough to accumulate
 *   operator-created entries would silently delete those entries.
 *
 * ── Surgical fixes from plan-checker review (2026-06-12) ─────────────────────
 *
 *   B2: --operator-user-id is REQUIRED. AuditLog.userId = operatorUserId,
 *       never null (Revisionssicherheit per CLAUDE.md "Audit trail").
 *
 *   B3: AuditLog.create runs IMMEDIATELY BEFORE the flag flip. The flag flip
 *       is THE FINAL write. If AuditLog throws, the whole tx rolls back.
 *
 *   B4: Note suffix is stripped via MIGRATION_NOTE_PATTERN — byte-equivalent
 *       (duplicate-but-identical to the regex in Plan 80-01). Empty strings
 *       collapse back to null so previously-null operator notes round-trip
 *       byte-equivalent too.
 *
 *   IN-10: First line on --apply runs: a `[rollback-work-event-to-bs] runId=…`
 *          console.error line for log correlation with the AuditLog row's
 *          newValue.runId.
 *
 *   IN-11: Tests call _resetPausedTenantsForTests() in beforeEach.
 *
 * ── Mitigations from CONTEXT.md ──────────────────────────────────────────────
 *
 *   M-2: Summary-only AuditLog — ONE row per tenant per --apply run.
 *   M-4: pauseTenantGeneration(tenantId) before tx + resumeTenantGeneration in
 *        finally so the daily 02:30 BS cron cannot insert mid-rollback.
 *   M-6: This script ships in the SAME PR as the forward script (Plan 80-01).
 *
 * ── Runbook ──────────────────────────────────────────────────────────────────
 *
 *   docs/work-event-migration-runbook.md — operator playbook covers the
 *   rollback procedure (when to run, pre-flight checklist, recovery scenarios).
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
 *     scripts/rollback-work-event-to-bs.ts \
 *     --tenant-id <uuid> \
 *     --operator-user-id <uuid> \
 *     [--apply] \
 *     [--help]
 *
 * Without --apply: dry-run, prints the JSON summary.
 * With    --apply: opens ONE prisma.$transaction per tenant (rollback on any throw).
 *
 * Note: --allow-non-azubi-legacy and --allow-existing-work-events are forward-
 *       only flags and are NOT accepted here.
 */
import { PrismaClient, WorkEventType } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import {
  pauseTenantGeneration,
  resumeTenantGeneration,
} from "../src/utils/vocational-school-generator";
import { invalidateTenantWorkEventModelLiveCache } from "../src/utils/work-event";

// ── Constants ─────────────────────────────────────────────────────────────────

export const ROLLBACK_ACTION = "WORK_EVENT_ROLLBACK_V19";
const ROLLBACK_USER_AGENT = "script:rollback-work-event-to-bs";
const TX_TIMEOUT_MS = 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * B4: MUST be byte-identical to MIGRATION_NOTE_PATTERN in
 * apps/api/scripts/migrate-bs-to-work-event.ts. Both scripts are the contract
 * for round-trip note byte-equivalence — see Plan 80-01 summary "Plan 80-02
 * interaction contract".
 *
 * Strips the migration suffix the forward script's preserveOriginalNote helper
 * appends. The leading \n? is critical — operator notes always have the suffix
 * preceded by a newline when the original note was non-null. The runId portion
 * accepts any non-`]` chars (mirrors forward script — supports fake runIds in
 * tests AND real UUIDs in production).
 */
export const MIGRATION_NOTE_PATTERN = /\n?\[Migrated to WorkEvent\. Run: [^\]]+\]$/;

// ── Exported types ────────────────────────────────────────────────────────────

export type CliArgs = {
  tenantId: string | null;
  operatorUserId: string | null;
  apply: boolean;
  help: boolean;
};

export type RollbackSummary = {
  tenantId: string | null;
  operatorUserId: string | null;
  dryRun: boolean;
  runId: string;
  sourceCount: number;
  reactivatedCount: number;
  skipped: number;
  durationMs: number;
  flagFlipped: boolean;
};

// ── parseArgs2 ────────────────────────────────────────────────────────────────

const USAGE = `Usage: tsx scripts/rollback-work-event-to-bs.ts \\
  --tenant-id <uuid> \\
  --operator-user-id <uuid> \\
  [--apply] \\
  [--help]

  --tenant-id          REQUIRED — UUID of the tenant to roll back.
  --operator-user-id   REQUIRED — UUID of the operator User row;
                       written to AuditLog.userId (B2 — Revisionssicherheit).
  --apply              Opt-in. Without it the script runs dry-run.
  --help               Print this usage block and exit 0.

Safety:
  - Per-tenant atomic transaction; AuditLog + flag flip are the last two writes
    inside the tx, in that order (B3). Rollback on any throw.
  - Source query filters legacyAbsenceId: { not: null } — operator-created
    WorkEvent rows from Phase 79 endpoints are LEFT UNTOUCHED.
  - Idempotent: re-running --apply after a successful rollback produces
    sourceCount=0 (the soft-deleted WorkEvent rows are no longer in the source).
  - Generator pause via pauseTenantGeneration(tenantId) before tx; resume in finally.
  - Cache invalidation via invalidateTenantWorkEventModelLiveCache(tenantId) after commit.
  - Notes: MIGRATION_NOTE_PATTERN regex strips the forward script's suffix so
    operator-authored Absence.note text is restored byte-equivalent (B4).

See docs/work-event-migration-runbook.md for the operator playbook.
`;

export function parseArgs2(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "tenant-id": { type: "string" },
      "operator-user-id": { type: "string" },
      apply: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  return {
    tenantId: values["tenant-id"] ?? null,
    operatorUserId: values["operator-user-id"] ?? null,
    apply: Boolean(values["apply"]),
    help: Boolean(values["help"]),
  };
}

// ── main ──────────────────────────────────────────────────────────────────────

function emptySummary(): RollbackSummary {
  return {
    tenantId: null,
    operatorUserId: null,
    dryRun: true,
    runId: "",
    sourceCount: 0,
    reactivatedCount: 0,
    skipped: 0,
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
): Promise<RollbackSummary> {
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

    // ── Source query: WorkEvent VS rows with legacyAbsenceId set ───────────
    // The `legacyAbsenceId: { not: null }` filter is THE critical safety
    // property: operator-created WorkEvent rows (created via Phase 79
    // endpoints) have legacyAbsenceId IS NULL and are LEFT UNTOUCHED. Only
    // rows the forward script created get rolled back.
    //
    // The `deletedAt: null` filter ensures the second --apply on the same
    // tenant produces sourceCount=0 (idempotent re-run): once the forward-
    // script-created rows are soft-deleted by this script, they are filtered
    // out on subsequent runs.
    const sourceWorkEvents = await prisma.workEvent.findMany({
      where: {
        type: WorkEventType.VOCATIONAL_SCHOOL,
        deletedAt: null,
        legacyAbsenceId: { not: null },
        employee: { tenantId },
      },
      select: {
        id: true,
        legacyAbsenceId: true,
        employeeId: true,
        date: true,
      },
      orderBy: [{ employeeId: "asc" }, { date: "asc" }],
    });
    const sourceCount = sourceWorkEvents.length;

    // ── Dry-run branch ─────────────────────────────────────────────────────
    if (!args.apply) {
      const dryRunSummary: RollbackSummary = {
        tenantId,
        operatorUserId,
        dryRun: true,
        runId: "",
        sourceCount,
        reactivatedCount: 0,
        skipped: 0,
        durationMs: 0,
        flagFlipped: false,
      };
      console.log(JSON.stringify(dryRunSummary, null, 2));
      return dryRunSummary;
    }

    // ── --apply branch (B3 — single LAST = flag flip) ──────────────────────
    const runId = randomUUID();
    // IN-10: First line on --apply for log correlation with AuditLog.newValue.runId.
    console.error(
      `[rollback-work-event-to-bs] runId=${runId} tenantId=${tenantId} operatorUserId=${operatorUserId} apply=true`,
    );

    let reactivatedCount = 0;
    let skipped = 0;
    const startedAt = Date.now();

    // M-4: pause the BS cron BEFORE the tx so it cannot insert mid-rollback.
    // resume in finally so even a throw releases the pause.
    pauseTenantGeneration(tenantId);
    try {
      await prisma.$transaction(
        async (tx) => {
          // ── Phase 2: write loop ────────────────────────────────────────
          for (const we of sourceWorkEvents) {
            // legacyAbsenceId is non-null by source query filter; type-guard
            // for TypeScript narrowing.
            if (we.legacyAbsenceId === null) {
              skipped++;
              continue;
            }

            // Look up the linked Absence row.
            const ab = await tx.absence.findUnique({
              where: { id: we.legacyAbsenceId },
              select: { id: true, deletedAt: true, note: true },
            });
            if (ab === null) {
              // Data corruption — the legacyAbsenceId points to a non-existent
              // Absence. Operator can audit later via the AuditLog.skipped
              // count. Don't crash the whole rollback over a single orphan.
              skipped++;
              continue;
            }

            // Idempotency boundary — Absence is already reactivated (e.g. a
            // partial prior rollback). Skip so the count is accurate.
            if (ab.deletedAt === null) {
              skipped++;
              continue;
            }

            // ── B4: Strip migration suffix non-destructively ───────────
            // Operator-authored prefix must round-trip byte-equivalent.
            // Collapse empty string back to null so previously-null notes
            // also round-trip exactly.
            const strippedNote = (ab.note ?? "").replace(MIGRATION_NOTE_PATTERN, "");
            const finalNote = strippedNote.length > 0 ? strippedNote : null;

            await tx.absence.update({
              where: { id: ab.id },
              data: {
                deletedAt: null,
                note: finalNote,
              },
            });

            // Soft-delete the WorkEvent. The row stays in the DB as an audit
            // trail residue of the migrate-then-rollback sequence.
            await tx.workEvent.update({
              where: { id: we.id },
              data: {
                deletedAt: new Date(),
                note: `Rolled back to Absence ${ab.id}. Run: ${runId}`,
              },
            });

            reactivatedCount++;
          }

          // ── THIRD-FROM-LAST: AuditLog summary row (M-2 + B2) ───────────
          // Exactly ONE AuditLog row per --apply run. userId = operatorUserId
          // (B2 — never null). entity = "Tenant", entityId = tenantId so the
          // row can be located by tenant scope. oldValue records the
          // pre-rollback flag state (true if the tenant was migrated).
          await tx.auditLog.create({
            data: {
              userId: operatorUserId,
              action: ROLLBACK_ACTION,
              entity: "Tenant",
              entityId: tenantId,
              oldValue: { workEventModelLive: true },
              newValue: {
                runId,
                sourceCount,
                reactivatedCount,
                skipped,
                durationMs: Date.now() - startedAt,
              },
              ipAddress: null,
              userAgent: ROLLBACK_USER_AGENT,
            },
          });

          // ── LAST (B3 — flag flip is THE FINAL write) ───────────────────
          // The flag flip is the irreversible signal that the tenant is back
          // on the legacy model. If anything before it throws (including the
          // AuditLog create above), the whole tx rolls back and the flag
          // stays at whatever it was before.
          await tx.tenantConfig.update({
            where: { tenantId },
            data: { workEventModelLive: false },
          });
        },
        { timeout: TX_TIMEOUT_MS },
      );

      // ── After tx commits ──────────────────────────────────────────────
      // W8 mirror: invalidate the tenant cache so the BC proxy + saldo
      // paths observe the new flag value immediately (the cache TTL is 5min,
      // too slow for operator workflow).
      invalidateTenantWorkEventModelLiveCache(tenantId);
    } finally {
      // M-4: resume even on throw so the BS cron is not left paused
      // permanently after a failed rollback.
      resumeTenantGeneration(tenantId);
    }

    const summary: RollbackSummary = {
      tenantId,
      operatorUserId,
      dryRun: false,
      runId,
      sourceCount,
      reactivatedCount,
      skipped,
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
// Mirrors migrate-bs-to-work-event.ts CLI shape: PrismaPg adapter from
// DATABASE_URL, exit non-zero on any error. Skipped when imported
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
