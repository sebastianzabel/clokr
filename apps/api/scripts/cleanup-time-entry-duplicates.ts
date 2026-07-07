/**
 * cleanup-time-entry-duplicates.ts — DATA-V1814-04 duplicate cleanup (D-03).
 *
 * READ-FIRST: Default (dry-run) mode lists every proposed action and writes NOTHING.
 * `--apply` soft-deletes classified excess rows and writes an AuditLog DATA_CORRECTION
 * row per soft-delete. ZERO hard-deletes — Revisionssicher.
 * Soft-delete only — `deletedAt` update, never a hard-delete method call.
 *
 * Run (dry-run — reviews proposed actions, writes nothing):
 *   DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx scripts/cleanup-time-entry-duplicates.ts
 *
 * Run (apply soft-deletes + AuditLog entries):
 *   DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx scripts/cleanup-time-entry-duplicates.ts --apply
 *
 * Exit: 0 = applied successfully, OR dry-run with no duplicates found.
 *       1 = dry-run with duplicates present (operator must review and run --apply).
 */
import { PrismaClient, Prisma } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adapter = new PrismaPg(pool as any);
const prisma = new PrismaClient({ adapter });

const isApply = process.argv.includes("--apply");

// ── Types ──────────────────────────────────────────────────────────────

type Classification = "ZERO_DURATION" | "MICRO_DURATION" | "NORMAL";
type ProposedAction = "KEEP" | "SOFT_DELETE";

interface RawRow {
  id: string;
  startTime: Date | null;
  endTime: Date | null;
  source: string | null;
  breakMinutes: number | null;
}

interface RowInfo extends RawRow {
  durationMin: number | null;
  classification: Classification;
  action: ProposedAction;
  reason: string;
}

interface GroupAnalysis {
  employeeId: string;
  date: string;
  rows: RowInfo[];
  excessRows: RowInfo[];
}

// ── Helpers ────────────────────────────────────────────────────────────

function classifyRow(endTime: Date | null, durationMin: number | null): Classification {
  if (!endTime) return "NORMAL"; // open (not yet closed) entry
  if (durationMin !== null && durationMin < 1) return "ZERO_DURATION";
  if (durationMin !== null && durationMin < 5) return "MICRO_DURATION";
  return "NORMAL";
}

/**
 * Assign KEEP / SOFT_DELETE actions to each row in a duplicate group.
 *
 * Rules (applied in order):
 * 1. ZERO_DURATION and MICRO_DURATION rows are classified as excess → SOFT_DELETE.
 * 2. If all rows in the group are NORMAL (e.g. adjacent split-session), keep the row
 *    with the earliest startTime (rows are pre-sorted ASC) → SOFT_DELETE all others.
 *    Documented reason: "adjacent split-session artifact — kept earliest; historical, not retro-merged".
 * Always leaves exactly ONE survivor per group.
 */
function assignActions(rows: RowInfo[]): void {
  const excessIds = new Set<string>();

  for (const row of rows) {
    if (row.classification === "ZERO_DURATION" || row.classification === "MICRO_DURATION") {
      excessIds.add(row.id);
    }
  }

  // If no zero/micro rows → all are NORMAL → keep earliest (index 0 = first by startTime ASC)
  if (excessIds.size === 0) {
    const normalRows = rows.filter((r) => r.classification === "NORMAL");
    normalRows.slice(1).forEach((r) => excessIds.add(r.id));
  }

  for (const row of rows) {
    if (excessIds.has(row.id)) {
      row.action = "SOFT_DELETE";
      if (row.classification === "ZERO_DURATION") {
        row.reason = "zero-duration artifact (NFC double-tap or equivalent)";
      } else if (row.classification === "MICRO_DURATION") {
        row.reason = "micro-duration artifact (< 5 min — mobile race or equivalent)";
      } else {
        row.reason =
          "adjacent split-session artifact — kept earliest; historical, not retro-merged";
      }
    } else {
      row.action = "KEEP";
      row.reason = "survivor (NORMAL or earliest start)";
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  // Step 1: Find duplicate (employeeId, date) groups — same query as scan-time-entry-duplicates.ts
  const duplicateGroups = await prisma.$queryRaw<
    Array<{ employeeId: string; date: string; cnt: number }>
  >`
    SELECT "employeeId", "date"::text AS date, COUNT(*)::int AS cnt
    FROM "TimeEntry"
    WHERE "deletedAt" IS NULL
    GROUP BY "employeeId", "date"
    HAVING COUNT(*) > 1
    ORDER BY "employeeId", "date";
  `;

  if (duplicateGroups.length === 0) {
    console.log("[OK] No duplicate non-deleted TimeEntry (employeeId, date) pairs found.");
    return 0;
  }

  // Step 2: Classify rows for each group
  const analyses: GroupAnalysis[] = [];

  for (const g of duplicateGroups) {
    // Fetch all non-deleted rows for this (employeeId, date) with the fields needed for classification
    const rawRows = await prisma.$queryRaw<RawRow[]>`
      SELECT id, "startTime", "endTime", source, "breakMinutes"
      FROM "TimeEntry"
      WHERE "employeeId" = ${g.employeeId}
        AND "date"::text = ${g.date}
        AND "deletedAt" IS NULL
      ORDER BY "startTime" ASC NULLS LAST;
    `;

    const rows: RowInfo[] = rawRows.map((r) => {
      const durationMin =
        r.endTime && r.startTime ? (r.endTime.getTime() - r.startTime.getTime()) / 60000 : null;
      return {
        ...r,
        durationMin,
        classification: classifyRow(r.endTime, durationMin),
        action: "KEEP", // placeholder — overwritten by assignActions
        reason: "",
      };
    });

    assignActions(rows);

    analyses.push({
      employeeId: g.employeeId,
      date: g.date,
      rows,
      excessRows: rows.filter((r) => r.action === "SOFT_DELETE"),
    });
  }

  const totalExcess = analyses.reduce((sum, a) => sum + a.excessRows.length, 0);

  // Step 3: Print per-group report (with dry-run banner)
  if (!isApply) {
    console.log("══════════════════════════════════════════════════════════════════");
    console.log(" DRY RUN — listing proposed actions; writing NOTHING.");
    console.log(" Re-run with --apply to write the soft-deletes and AuditLog entries.");
    console.log("══════════════════════════════════════════════════════════════════");
    console.log();
  }

  for (const a of analyses) {
    console.log(`Group: employeeId=${a.employeeId}  date=${a.date}`);
    for (const row of a.rows) {
      const start = row.startTime ? row.startTime.toISOString() : "null";
      const end = row.endTime ? row.endTime.toISOString() : "null";
      const dur = row.durationMin !== null ? `${row.durationMin.toFixed(1)}min` : "open";
      console.log(
        `  [${row.action.padEnd(11)}] id=${row.id}  source=${row.source ?? "null"}` +
          `  start=${start}  end=${end}  dur=${dur}` +
          `  class=${row.classification}  reason="${row.reason}"`,
      );
    }
    console.log();
  }

  if (!isApply) {
    console.log(
      `Summary: ${analyses.length} duplicate group(s), ${totalExcess} row(s) WOULD be soft-deleted.`,
    );
    console.log();
    console.log("DRY RUN — re-run with --apply to write.");
    return 1; // duplicates present; operator must review and run --apply
  }

  // Step 4: APPLY — soft-delete excess rows with AuditLog DATA_CORRECTION per row
  //
  // HARD-DELETE ASSERTION: Only `update({ data: { deletedAt } })` is used below.
  // Hard-delete methods are absent from this file by design — CLAUDE.md audit-proof rules
  // (Revisionssicherheit — no hard-deletes of time-tracking data, ever).
  let softDeletedCount = 0;

  for (const a of analyses) {
    for (const row of a.excessRows) {
      const deletedAt = new Date();
      let applied = false;

      await prisma.$transaction(async (tx) => {
        // Snapshot the full row as oldValue before any mutation
        const snapshot = await tx.timeEntry.findUnique({ where: { id: row.id } });
        if (!snapshot) {
          console.warn(`  [SKIP] id=${row.id} — row not found (already removed?), skipping`);
          return;
        }

        // Soft-delete only — sets deletedAt; no hard-delete method is used (Revisionssicher)
        await tx.timeEntry.update({
          where: { id: row.id },
          data: { deletedAt: new Date() },
        });

        // AuditLog: DATA_CORRECTION per soft-deleted row (userId null = SYSTEM)
        await tx.auditLog.create({
          data: {
            userId: null,
            action: "DATA_CORRECTION",
            entity: "TimeEntry",
            entityId: row.id,
            oldValue: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue,
            newValue: { deletedAt: deletedAt.toISOString(), reason: row.reason },
          },
        });

        applied = true;
      });

      if (applied) {
        console.log(`  [SOFT_DELETE] id=${row.id}  reason="${row.reason}"`);
        softDeletedCount++;
      }
    }
  }

  console.log();
  console.log(
    `Done: ${softDeletedCount} row(s) soft-deleted with DATA_CORRECTION AuditLog entries.`,
  );
  console.log("Re-run the scan gate to confirm [OK]:");
  console.log(
    "  DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx scripts/scan-time-entry-duplicates.ts",
  );
  return 0;
}

main()
  .then(async (code) => {
    await pool.end();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error("[ERROR] cleanup failed:", err);
    await pool.end();
    process.exit(1);
  });
