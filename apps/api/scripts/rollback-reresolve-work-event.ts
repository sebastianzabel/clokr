/**
 * Phase 83 Plan 04 — Inverse rollback script for reresolve-work-event-minutes.ts.
 *
 * Restores `WorkEvent.workedMinutes` + `expectedMinutes` to their pre-resolution
 * originals by reading a snapshot file written by the forward script.
 *
 * Source of truth: `.snapshots/reresolve-{tenantId}-{runId}.json` containing
 * the full updates[] array with `oldWorked`/`oldExpected` values written BEFORE
 * the original `$transaction` applied changes. Snapshot files are intentionally
 * NOT deleted after rollback (Revisionssicherheit — keep audit trail of all
 * operator actions on disk).
 *
 * ── Phase 80 conventions mirrored ────────────────────────────────────────────
 *
 *   B2: --operator-user-id is REQUIRED. AuditLog.userId = operatorUserId,
 *       never null (Revisionssicherheit per CLAUDE.md "Audit trail").
 *
 *   B3: AuditLog.create runs INSIDE the $transaction as the LAST write before
 *       commit boundary.
 *
 * ── Locked-month re-check ─────────────────────────────────────────────────────
 *
 *   Per CLAUDE.md "no silent overwrites": rollback must NOT modify rows whose
 *   month became locked AFTER the original re-resolution (e.g. a Monatsabschluss
 *   ran between Phase-83-deploy and rollback). Such rows are skipped + reported
 *   so operators see the gap.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
 *     scripts/rollback-reresolve-work-event.ts \
 *     --tenant-id <uuid> \
 *     --run-id <uuid-from-snapshot-filename> \
 *     --operator-user-id <uuid> \
 *     [--apply]
 *
 * Without --apply: dry-run, prints JSON restore plan.
 * With    --apply: opens ONE prisma.$transaction per tenant.
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { toIsoDate } from "../src/utils/work-event.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const ROLLBACK_ACTION = "RERESOLVE_WORK_EVENT_MINUTES_ROLLBACK_V19";
const ROLLBACK_USER_AGENT = "script:rollback-reresolve-work-event";
const TX_TIMEOUT_MS = 90_000;

// __dirname polyfill for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SNAPSHOT_DIR = join(__dirname, ".snapshots");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Types ─────────────────────────────────────────────────────────────────────

interface SnapshotRow {
  id: string;
  employeeId: string;
  date: string; // ISO YYYY-MM-DD from JSON.stringify
  oldWorked: number;
  oldExpected: number | null;
  newWorked: number;
  newExpected: number | null;
}

interface SnapshotFile {
  runId: string;
  tenantId: string;
  updates: SnapshotRow[];
}

export interface RollbackSummary {
  runId: string;
  rollbackRunId: string;
  tenantId: string;
  dryRun: boolean;
  restoreCount: number;
  lockedSkipped: number;
  snapshotPath: string;
  durationMs: number;
  sample: SnapshotRow[];
}

// ── parseArgs2 ────────────────────────────────────────────────────────────────

const USAGE = `Usage: tsx scripts/rollback-reresolve-work-event.ts \\
  --tenant-id <uuid> \\
  --run-id <uuid-from-snapshot-filename> \\
  --operator-user-id <uuid> \\
  [--apply]

  --tenant-id          REQUIRED — UUID of the tenant (sanity-check against snapshot).
  --run-id             REQUIRED — runId from the forward script's snapshot filename.
  --operator-user-id   REQUIRED — UUID of the operator User row;
                       written to AuditLog.userId (B2 — Revisionssicherheit).
  --apply              Opt-in. Without it the script runs dry-run.

Safety:
  - Reads snapshot: .snapshots/reresolve-{tenantId}-{runId}.json
  - Sanity-checks tenantId + runId match snapshot file header.
  - Locked months re-checked: rows in newly-locked months are SKIPPED + reported.
  - AuditLog RERESOLVE_WORK_EVENT_MINUTES_ROLLBACK_V19 written as last tx write (B3).
  - Snapshot file NOT deleted after rollback (Revisionssicherheit).
  - --operator-user-id REQUIRED; missing → exit 1 with German error.
`;

export interface CliArgs {
  tenantId: string | null;
  runId: string | null;
  operatorUserId: string | null;
  apply: boolean;
}

export function parseArgs2(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "tenant-id": { type: "string" },
      "run-id": { type: "string" },
      "operator-user-id": { type: "string" },
      apply: { type: "boolean", default: false },
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
    runId: values["run-id"] ?? null,
    operatorUserId: values["operator-user-id"] ?? null,
    apply: Boolean(values["apply"]),
  };
}

// ── Locked-month helper ───────────────────────────────────────────────────────

/**
 * Checks whether an employee+month combination has any locked TimeEntry rows.
 * Canonical signal: at least one TimeEntry in the month period has isLocked=true.
 * (Mirrors reresolve-work-event-minutes.ts pattern.)
 */
async function buildLockedMonthSet(
  prisma: PrismaClient,
  tenantId: string,
): Promise<Set<string>> {
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
    const monthKey = `${entry.employeeId}:${toIsoDate(entry.date).slice(0, 7)}`;
    lockedSet.add(monthKey);
  }
  return lockedSet;
}

function isLockedFor(lockedSet: Set<string>, employeeId: string, dateStr: string): boolean {
  const monthKey = `${employeeId}:${dateStr.slice(0, 7)}`;
  return lockedSet.has(monthKey);
}

// ── main ──────────────────────────────────────────────────────────────────────

/**
 * Test-injectable entry point. Pass a PrismaClient to inject a test connection.
 */
export async function main(
  argv: string[],
  injectedPrisma?: PrismaClient,
): Promise<RollbackSummary> {
  const args = parseArgs2(argv);

  // ── Required-flag validation (B2) ──────────────────────────────────────────
  if (!args.tenantId) {
    throw new Error("Tenant-Auswahl erforderlich: bitte --tenant-id <uuid> angeben.");
  }
  if (!args.runId) {
    throw new Error("Run-ID erforderlich: bitte --run-id <uuid> angeben.");
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
  const runId = args.runId;
  const operatorUserId = args.operatorUserId;
  const rollbackRunId = randomUUID();
  const startedAt = Date.now();

  // ── Read snapshot ───────────────────────────────────────────────────────────
  const snapshotPath = join(SNAPSHOT_DIR, `reresolve-${tenantId}-${runId}.json`);
  let snapshot: SnapshotFile;
  try {
    snapshot = JSON.parse(readFileSync(snapshotPath, "utf-8")) as SnapshotFile;
  } catch (err) {
    throw new Error(
      `Snapshot-Datei nicht gefunden: ${snapshotPath}\n` +
        `(${(err as Error).message})`,
    );
  }

  // Sanity-check snapshot header.
  if (snapshot.tenantId !== tenantId || snapshot.runId !== runId) {
    throw new Error(
      `Snapshot mismatch — tenantId/runId nicht übereinstimmend mit Argumenten.\n` +
        `Snapshot: tenantId=${snapshot.tenantId} runId=${snapshot.runId}\n` +
        `Args:     tenantId=${tenantId} runId=${runId}`,
    );
  }

  const prisma = injectedPrisma ?? new PrismaClient();
  const ownsPrisma = !injectedPrisma;

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

    // ── Build locked-month set for re-check ─────────────────────────────────
    const lockedSet = await buildLockedMonthSet(prisma, tenantId);

    // Partition updates into restorable vs locked-skipped.
    const toRestore = snapshot.updates.filter(
      (u) => !isLockedFor(lockedSet, u.employeeId, u.date),
    );
    const lockedSkippedRows = snapshot.updates.filter((u) =>
      isLockedFor(lockedSet, u.employeeId, u.date),
    );

    // ── Dry-run branch ───────────────────────────────────────────────────────
    if (!args.apply) {
      const drySummary: RollbackSummary = {
        runId,
        rollbackRunId,
        tenantId,
        dryRun: true,
        restoreCount: toRestore.length,
        lockedSkipped: lockedSkippedRows.length,
        snapshotPath,
        durationMs: Date.now() - startedAt,
        sample: toRestore.slice(0, 5),
      };
      console.log(JSON.stringify(drySummary, null, 2));
      return drySummary;
    }

    // ── Apply branch ─────────────────────────────────────────────────────────
    // IN-10: First-line stdout for log correlation.
    console.log(`runId=${runId} tenantId=${tenantId} apply=true rollback=true`);

    await prisma.$transaction(
      async (tx) => {
        // Restore oldWorked/oldExpected for all non-locked rows.
        for (const u of toRestore) {
          await tx.workEvent.update({
            where: { id: u.id },
            data: {
              workedMinutes: u.oldWorked,
              expectedMinutes: u.oldExpected,
            },
          });
        }

        // B3: AuditLog as LAST write inside tx.
        await tx.auditLog.create({
          data: {
            userId: operatorUserId,
            action: ROLLBACK_ACTION,
            entity: "WorkEvent",
            entityId: tenantId,
            oldValue: {
              snapshotRunId: runId,
              restoreCount: toRestore.length,
              lockedSkipped: lockedSkippedRows.length,
              lockedSkippedIds: lockedSkippedRows.map((r) => r.id),
            },
            newValue: {
              rollbackRunId,
              snapshotPath,
              restoredFromRunId: runId,
              restoreCount: toRestore.length,
              lockedSkipped: lockedSkippedRows.length,
              durationMs: Date.now() - startedAt,
            },
            ipAddress: null,
            userAgent: ROLLBACK_USER_AGENT,
          },
        });
      },
      { timeout: TX_TIMEOUT_MS },
    );

    const summary: RollbackSummary = {
      runId,
      rollbackRunId,
      tenantId,
      dryRun: false,
      restoreCount: toRestore.length,
      lockedSkipped: lockedSkippedRows.length,
      snapshotPath,
      durationMs: Date.now() - startedAt,
      sample: toRestore.slice(0, 5),
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
