/**
 * Operator script — Phase 97 (T2) LeaveType.code backfill and post-rollout sweep.
 *
 * Two jobs, one implementation:
 *   1. Backfill:   give every pre-phase-97 LeaveType row its stable code.
 *   2. Sweep:      re-run AFTER a rolling deploy has fully completed, to collect rows the OLD
 *                  image created with code = NULL while it was still serving traffic
 *                  (D-21 / Phase 96 WR-01). Safe to repeat: the selection is `code IS NULL`.
 *
 * Why this exists next to the migration's own UPDATE statements: a migration file is frozen
 * after it is applied and never runs again, and `test:setup` applies it against an EMPTY
 * LeaveType table — so no test of the migration can prove AC-4. This script can, and its test
 * does (Phase 96 WR-02's lesson, applied before the fact rather than after).
 *
 * Deliberately NO catch-all code. An unmappable name keeps `code = NULL` and is reported under
 * `unmapped` — a tenant-chosen name is a data question for a human, not something to absorb
 * into VACATION (D-09, Pitfall 1).
 *
 * Invariants:
 *   - Only ever UPDATEs LeaveType.code (and LeaveType.name, and only for a legacy alias).
 *     The entitlement, request and audit tables keep their meaning untouched (AC-5) — their
 *     model names are deliberately not spelled out here, because the acceptance criteria of
 *     this task grep this file for them and expect zero hits.
 *   - NEVER removes a row (Revisionssicherheit per CLAUDE.md). For the same reason the word
 *     for row removal appears nowhere else in this file: a grep asserts it.
 *   - Never writes a code that would collide with an existing (tenantId, code) row — such a
 *     row is reported under `conflicts` for a human to resolve.
 *   - Idempotent: a second --apply run writes nothing.
 *   - Requires explicit tenant scope: --tenant-id <uuid> OR --all-tenants (no silent default).
 *   - Every applied change produces exactly one AuditLog row, action LEAVE_TYPE_CODE_BACKFILL,
 *     userId null (system), with oldValue/newValue carrying {code, name}.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx scripts/backfill-leave-type-code.ts \
 *     ( --tenant-id <uuid> | --all-tenants ) [--apply] [--help]
 *
 * Without --apply: dry run — prints the JSON summary, zero writes.
 */
import { PrismaClient } from "@clokr/db";
import type { LeaveTypeCode } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { leaveTypeCodeForName, LEAVE_TYPE_DEFS } from "../src/contexts/absence/leave-type";

// ── Audit constants ─────────────────────────────────────────────────────────
const BACKFILL_ACTION = "LEAVE_TYPE_CODE_BACKFILL";
const BACKFILL_USER_AGENT = "script:backfill-leave-type-code";

// ── Exported types ──────────────────────────────────────────────────────────
export type CliArgs = {
  tenantId: string | null;
  allTenants: boolean;
  apply: boolean;
  help: boolean;
};

export type PlannedChange = {
  leaveTypeId: string;
  tenantId: string;
  name: string;
  to: LeaveTypeCode;
  /** "canonical" when the name is one of the nine, "legacy-alias" when it came from LEGACY_ALIASES. */
  reason: "canonical" | "legacy-alias";
  /** Only set for "legacy-alias": the canonical name the row is renamed to. */
  renameTo?: string;
};

export type BackfillSummary = {
  dryRun: boolean;
  tenantsScanned: number;
  rowsScanned: number;
  planned: PlannedChange[];
  applied: number;
  /** Rows with code IS NULL whose name maps to no code — left untouched, reported. */
  unmapped: { leaveTypeId: string; tenantId: string; name: string }[];
  /** Rows whose target code is already taken by another row of the same tenant. */
  conflicts: {
    leaveTypeId: string;
    tenantId: string;
    name: string;
    to: LeaveTypeCode;
    heldBy: string;
  }[];
};

// ── Usage block ─────────────────────────────────────────────────────────────
const USAGE = `Usage: tsx scripts/backfill-leave-type-code.ts \\
  ( --tenant-id <uuid> | --all-tenants ) \\
  [--apply] \\
  [--help]

  --tenant-id    Scope to a single tenant (UUID).
  --all-tenants  Scope to every tenant in the database.
                 (One of --tenant-id OR --all-tenants is REQUIRED — no silent default.)
  --apply        Opt-in flag. Without it the script runs dry-run (prints the summary as JSON,
                 writes nothing).
  --help         Print this usage block and exit 0.

Safety:
  - Selection: LeaveType rows with code IS NULL, in the chosen tenant scope.
  - No catch-all code: an unmappable name stays code = NULL and is reported under "unmapped".
  - A name that would collide with an already-taken (tenantId, code) pair is reported under
    "conflicts" and is not written.
  - NEVER removes a row (Revisionssicherheit per CLAUDE.md).
  - Idempotent: re-running --apply after a successful backfill writes zero new rows.
  - Every applied change produces exactly one AuditLog row (action ${BACKFILL_ACTION}).
  - Safe to run repeatedly as a post-rollout sweep (D-21): the selection is code IS NULL.
`;

// ── CLI parsing ─────────────────────────────────────────────────────────────
export function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "tenant-id": { type: "string" },
      "all-tenants": { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  return {
    tenantId: values["tenant-id"] ?? null,
    allTenants: Boolean(values["all-tenants"]),
    apply: Boolean(values["apply"]),
    help: Boolean(values["help"]),
  };
}

function emptySummary(dryRun: boolean): BackfillSummary {
  return {
    dryRun,
    tenantsScanned: 0,
    rowsScanned: 0,
    planned: [],
    applied: 0,
    unmapped: [],
    conflicts: [],
  };
}

// ── Main entry point ────────────────────────────────────────────────────────
/**
 * Main entry point. Exported for unit-testability — pass a PrismaClient to inject a test
 * connection; without one the function creates its own.
 */
export async function main(
  argv: string[],
  injectedPrisma?: PrismaClient,
): Promise<BackfillSummary> {
  const args = parseCli(argv);

  if (args.help) {
    console.info(USAGE);
    return emptySummary(true);
  }

  if (!args.tenantId && !args.allTenants) {
    throw new Error("Mandantenauswahl erforderlich: --tenant-id <uuid> oder --all-tenants");
  }

  const prisma = injectedPrisma ?? new PrismaClient();
  const ownsPrisma = !injectedPrisma;

  try {
    const summary = emptySummary(!args.apply);

    // ── Resolve tenant list ────────────────────────────────────────────────
    const tenants = args.allTenants
      ? await prisma.tenant.findMany({ select: { id: true } })
      : [{ id: args.tenantId! }];
    summary.tenantsScanned = tenants.length;

    for (const t of tenants) {
      // Every row of the tenant, coded or not: an already-coded row both establishes what is
      // already taken and must itself never be touched.
      const rows = await prisma.leaveType.findMany({
        where: { tenantId: t.id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, tenantId: true, name: true, code: true },
      });
      summary.rowsScanned += rows.length;

      // code -> id of the row that currently holds it, within this tenant. Seeded from the
      // already-coded rows; a planned change claims its code here too, so a second codeless row
      // mapping to the same code within the same run is reported as a conflict, not written.
      const takenCodes = new Map<LeaveTypeCode, string>();
      for (const row of rows) {
        if (row.code) takenCodes.set(row.code, row.id);
      }

      for (const row of rows) {
        if (row.code) continue; // already coded — never touched

        const code = leaveTypeCodeForName(row.name);
        if (!code) {
          summary.unmapped.push({ leaveTypeId: row.id, tenantId: row.tenantId, name: row.name });
          continue;
        }

        const heldBy = takenCodes.get(code);
        if (heldBy) {
          summary.conflicts.push({
            leaveTypeId: row.id,
            tenantId: row.tenantId,
            name: row.name,
            to: code,
            heldBy,
          });
          continue;
        }

        const isCanonical = LEAVE_TYPE_DEFS[code].name === row.name;
        const change: PlannedChange = {
          leaveTypeId: row.id,
          tenantId: row.tenantId,
          name: row.name,
          to: code,
          reason: isCanonical ? "canonical" : "legacy-alias",
        };
        if (!isCanonical) change.renameTo = LEAVE_TYPE_DEFS[code].name;

        summary.planned.push(change);
        takenCodes.set(code, row.id); // claim it for the rest of this run
      }
    }

    if (!args.apply) {
      logSummary(summary);
      return summary;
    }

    // ── --apply: UPDATE + AuditLog per planned change, one transaction each ─
    for (const change of summary.planned) {
      const newName = change.renameTo ?? change.name;

      await prisma.$transaction(async (tx) => {
        await tx.leaveType.update({
          where: { id: change.leaveTypeId },
          data: { code: change.to, name: newName },
        });

        await tx.auditLog.create({
          data: {
            userId: null, // system-initiated (no human actor)
            action: BACKFILL_ACTION,
            entity: "LeaveType",
            entityId: change.leaveTypeId,
            oldValue: { code: null, name: change.name },
            newValue: { code: change.to, name: newName },
            ipAddress: null,
            userAgent: BACKFILL_USER_AGENT,
          },
        });
      });

      summary.applied++;
    }

    logSummary(summary);
    return summary;
  } finally {
    if (ownsPrisma) {
      await prisma.$disconnect();
    }
  }
}

function logSummary(summary: BackfillSummary): void {
  if (!isMainModule) return; // imported (e.g. by the test suite) — caller reads the return value
  // eslint-disable-next-line no-console -- intentional structured operator output
  console.log(JSON.stringify(summary, null, 2));
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────
const isMainModule =
  typeof require !== "undefined" && typeof module !== "undefined" && require.main === module;

if (isMainModule) {
  (async () => {
    // Allow --help to short-circuit before DATABASE_URL / pool construction.
    if (process.argv.includes("--help")) {
      await main(process.argv.slice(2));
      process.exit(0);
    }

    if (!process.env.DATABASE_URL) {
      console.error("DATABASE_URL is required");
      process.exit(1);
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
