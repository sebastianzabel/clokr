/**
 * Operator script — Issue #445 correction (finding 1, D-07).
 *
 * Root cause: before this phase, `recalculateCarryOver()` and `autoCarryOver()` created a
 * missing VACATION `LeaveEntitlement` row with a hard-coded `totalDays: 0`, and the POST
 * /leave/requests availability check silently skipped whenever the row did not exist. Prod
 * accumulated 12 such zero rows for 2027 while staff applied for next year's leave. Phase 445's
 * other plans route every creation path through `ensureRegularVacationEntitlement()` so this
 * cannot recur; THIS script is the one-off, operator-run correction for the rows that already
 * exist.
 *
 * A *zero placeholder* (D-05, `isZeroVacationPlaceholder()` in
 * `../src/contexts/absence/leave-days`) is a VACATION row with `totalDays: 0`,
 * `isAutoCalculated: false`, and no AuditLog CREATE/UPDATE row whose `newValue` ever set
 * `totalDays` by a human/API write (PUT /settings/vacation always audits `newValue: body` with
 * `totalDays` — that write is NEVER healed, by design). A row is only a *candidate* when, in
 * addition, the employee's regular entitlement for that year
 * (`resolveRegularVacationDays()`) is greater than 0 — an employee who was not employed in that
 * year (exited earlier, hired later) legitimately keeps 0 and is never listed (P-03).
 *
 * The PRUEFEN flag (D-07): a candidate is flagged when the employee had a full prior year
 * (hired before 1 January of `year - 1`), that prior year's row exists and is itself NOT a
 * placeholder, and its `totalDays` differs from this year's target. This catches
 * Azubis/individual contracts whose historical entitlement (e.g. 20 days) would otherwise be
 * silently over-written by the #416 tenant-default-based target (e.g. 30) until Issue #435 adds
 * the per-person base value — those rows need a human look before healing.
 *
 * Invariants:
 *   - NEVER hard-deletes anything (Revisionssicherheit per CLAUDE.md) — only updates a zero
 *     placeholder's `totalDays`/`isAutoCalculated`, via the same wrapper every other call site
 *     of Issue #445 uses.
 *   - Every heal is audited (`UPDATE`, `oldValue { totalDays: 0 }`,
 *     `newValue.reason = "Korrektur Urlaubsanspruch 0 (Issue #445)"`) through
 *     `ensureRegularVacationEntitlement()` → `writeEntitlementAudit()`.
 *   - Idempotent: a healed row is no longer a placeholder, so a second run finds it again as a
 *     candidate — but `ensureRegularVacationEntitlement()` no-ops immediately once there is
 *     nothing to heal.
 *   - No PII in output — entitlementId/employeeId/employeeNumber/numbers only, never
 *     firstName/lastName.
 *   - Requires explicit tenant scope: --tenant-id OR --all-tenants (no silent default).
 *   - NEVER run against dev/int/prod in Phase 445 — this is the owner's decision; this script is
 *     tested ONLY against the per-worktree test database.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
 *     scripts/repair-zero-vacation-entitlements.ts \
 *     ( --tenant-id <uuid> | --all-tenants ) \
 *     [--year <yyyy>] \
 *     [--confirm] \
 *     [--include-flagged] \
 *     [--help]
 *
 * Without --confirm: dry-run (default) — lists every candidate, flags PRUEFEN rows, writes
 *                     nothing.
 * With    --confirm: heals every unflagged candidate; a flagged (PRUEFEN) candidate is healed
 *                     only together with --include-flagged.
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import {
  ensureRegularVacationEntitlement,
  isZeroVacationPlaceholder,
  resolveRegularVacationDays,
  isAmbiguousRegularEntitlement,
} from "../src/contexts/absence/leave-days";

const REPAIR_REASON = "Korrektur Urlaubsanspruch 0 (Issue #445)";

// ── Exported types ──────────────────────────────────────────────────────────
export type CliArgs = {
  tenantId: string | null;
  allTenants: boolean;
  year: number | null;
  confirm: boolean;
  includeFlagged: boolean;
  help: boolean;
};

export type RepairCandidate = {
  entitlementId: string;
  employeeId: string;
  tenantId: string;
  employeeNumber: string;
  year: number;
  currentTotalDays: number;
  targetTotalDays: number;
  priorYearTotalDays: number | null;
  flag: "PRUEFEN" | null;
};

export type RepairSummary = {
  dryRun: boolean;
  tenantsScanned: number;
  candidates: RepairCandidate[];
  applied: number;
  skippedFlagged: number;
  errors: Array<{ entitlementId: string; error: string }>;
};

const USAGE = `
Usage:
  DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \\
    scripts/repair-zero-vacation-entitlements.ts \\
    ( --tenant-id <uuid> | --all-tenants ) \\
    [--year <yyyy>] \\
    [--confirm] \\
    [--include-flagged] \\
    [--help]

Without --confirm: dry-run (default) — lists candidates, flags PRUEFEN rows, writes nothing.
With    --confirm: heals every unflagged candidate (via ensureRegularVacationEntitlement).
                    A PRUEFEN candidate is healed only together with --include-flagged.

Scope:
  - Only VACATION LeaveEntitlement rows that are zero placeholders (D-05) AND whose regular
    entitlement for that year is > 0.
  - --year restricts the scan to one year (default: every year with zero placeholders).
  - Idempotent: a healed row is not a candidate any more.
`;

// ── CLI parsing ─────────────────────────────────────────────────────────────
export function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "tenant-id": { type: "string" },
      "all-tenants": { type: "boolean", default: false },
      year: { type: "string" },
      confirm: { type: "boolean", default: false },
      "include-flagged": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  let year: number | null = null;
  if (values.year !== undefined) {
    const parsed = Number(values.year);
    if (!Number.isInteger(parsed) || parsed < 2000 || parsed > 2100) {
      throw new Error("Ungültiges Jahr: --year erwartet eine Jahreszahl zwischen 2000 und 2100.");
    }
    year = parsed;
  }

  return {
    tenantId: values["tenant-id"] ?? null,
    allTenants: Boolean(values["all-tenants"]),
    year,
    confirm: Boolean(values["confirm"]),
    includeFlagged: Boolean(values["include-flagged"]),
    help: Boolean(values["help"]),
  };
}

// ── Main entry point ─────────────────────────────────────────────────────────
/**
 * Main entry point. Exported for unit-testability — pass a PrismaClient to inject a test
 * connection; without one the function creates its own (mirrors
 * backfill-missing-vacation-entitlements.ts's own shape).
 */
export async function main(argv: string[], injectedPrisma?: PrismaClient): Promise<RepairSummary> {
  const args = parseCli(argv);

  if (args.help) {
    console.info(USAGE);
    return {
      dryRun: true,
      tenantsScanned: 0,
      candidates: [],
      applied: 0,
      skippedFlagged: 0,
      errors: [],
    };
  }

  if (!args.tenantId && !args.allTenants) {
    throw new Error(
      "Tenant-Auswahl erforderlich: bitte --tenant-id <uuid> ODER --all-tenants angeben.",
    );
  }

  const prisma = injectedPrisma ?? new PrismaClient();
  const ownsPrisma = !injectedPrisma;

  try {
    const summary: RepairSummary = {
      dryRun: !args.confirm,
      tenantsScanned: 0,
      candidates: [],
      applied: 0,
      skippedFlagged: 0,
      errors: [],
    };

    const tenants = args.allTenants
      ? await prisma.tenant.findMany({ select: { id: true } })
      : [{ id: args.tenantId! }];
    summary.tenantsScanned = tenants.length;

    for (const t of tenants) {
      const vacationType = await prisma.leaveType.findFirst({
        where: { tenantId: t.id, code: "VACATION" },
        select: { id: true },
      });
      if (!vacationType) continue; // tenant has no VACATION type configured — nothing to repair

      const rows = await prisma.leaveEntitlement.findMany({
        where: {
          leaveTypeId: vacationType.id,
          totalDays: 0,
          isAutoCalculated: false,
          employee: { tenantId: t.id },
          ...(args.year !== null ? { year: args.year } : {}),
        },
        include: { employee: { select: { employeeNumber: true, hireDate: true } } },
        orderBy: [{ year: "asc" }, { employeeId: "asc" }],
      });

      for (const row of rows) {
        try {
          const isPlaceholder = await isZeroVacationPlaceholder(prisma, {
            id: row.id,
            totalDays: row.totalDays,
            isAutoCalculated: row.isAutoCalculated,
          });
          if (!isPlaceholder) continue; // a human/API write already set totalDays — never a candidate

          const target = await resolveRegularVacationDays(prisma, row.employeeId, t.id, row.year);
          if (target <= 0) continue; // P-03: not employed in this year — 0 is the correct value

          // D-07, generalised: the SAME predicate ensureRegularVacationEntitlement's heal
          // branch uses (coordinator deviation from CONTEXT D-05) — one implementation, never
          // two copies.
          const ambiguous = await isAmbiguousRegularEntitlement(
            prisma,
            row.employeeId,
            vacationType.id,
            row.year,
            row.employee.hireDate,
            target,
          );
          const flag: "PRUEFEN" | null = ambiguous ? "PRUEFEN" : null;
          const priorRow = await prisma.leaveEntitlement.findUnique({
            where: {
              employeeId_leaveTypeId_year: {
                employeeId: row.employeeId,
                leaveTypeId: vacationType.id,
                year: row.year - 1,
              },
            },
          });

          const candidate: RepairCandidate = {
            entitlementId: row.id,
            employeeId: row.employeeId,
            tenantId: t.id,
            employeeNumber: row.employee.employeeNumber,
            year: row.year,
            currentTotalDays: Number(row.totalDays),
            targetTotalDays: target,
            priorYearTotalDays: priorRow ? Number(priorRow.totalDays) : null,
            flag,
          };
          summary.candidates.push(candidate);

          if (!args.confirm) {
            console.info(
              `[DRY-RUN] entitlementId=${candidate.entitlementId} employeeId=${candidate.employeeId} ` +
                `employeeNumber=${candidate.employeeNumber} year=${candidate.year} ` +
                `totalDays=${candidate.currentTotalDays} target=${candidate.targetTotalDays} ` +
                `priorYear=${candidate.priorYearTotalDays ?? "-"} flag=${candidate.flag ?? "-"}`,
            );
            continue;
          }

          if (flag === "PRUEFEN" && !args.includeFlagged) {
            summary.skippedFlagged++;
            continue;
          }

          const result = await prisma.$transaction((tx) =>
            ensureRegularVacationEntitlement(
              tx,
              row.employeeId,
              t.id,
              row.year,
              vacationType.id,
              REPAIR_REASON,
              // flag === "PRUEFEN" here only when --include-flagged let it reach this point
              // (the skip above intercepts it otherwise) — tell the wrapper to heal anyway.
              { allowAmbiguousHeal: flag === "PRUEFEN" },
            ),
          );
          if (result.healed) {
            summary.applied++;
            console.info(
              `[APPLIED] entitlementId=${candidate.entitlementId} employeeId=${candidate.employeeId} ` +
                `year=${candidate.year} totalDays=${Number(result.entitlement.totalDays)}`,
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          summary.errors.push({ entitlementId: row.id, error: message });
          console.error(`[ERROR] entitlementId=${row.id}: ${message}`);
        }
      } // end row loop
    } // end tenant loop

    if (!args.confirm) {
      console.info(
        `\nZusammenfassung: ${summary.candidates.length} Kandidat(en) gefunden. ` +
          `Erneut mit --confirm ausführen, um zu schreiben.`,
      );
    } else {
      console.info(
        `\nZusammenfassung: ${summary.applied} Zeile(n) korrigiert, ` +
          `${summary.skippedFlagged} zurückgestellt (PRUEFEN, --include-flagged erforderlich).`,
      );
    }

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
