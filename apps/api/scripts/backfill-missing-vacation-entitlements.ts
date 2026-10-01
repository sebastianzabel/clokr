/**
 * Operator script — Issue #416 repair.
 *
 * Root cause (see 416-CONTEXT.md, fully diagnosed before this script): no code path ever
 * created a VACATION `LeaveEntitlement` row automatically before this phase — only a manual
 * PUT /settings/vacation/:employeeId write did. Active employees hired before this phase
 * shipped (or created through any path other than the admin UI) can therefore be missing their
 * CURRENT-year row entirely, which this script's `--confirm` mode backfills.
 *
 * Scope (binding, per 416-CONTEXT.md decision 5):
 *   - ONLY active employees (`exitDate: null` — there is no `isActive` boolean on `Employee`).
 *   - ONLY the CURRENT year (mirrors the "first access" self-heal, GET /settings/vacation —
 *     the same missing-row shape, on read; this script is the batch/dry-run-first counterpart).
 *   - NEVER touches an employee that already has a VACATION entitlement row for the current
 *     year — including one already manually repaired (prod's two affected employees were
 *     repaired ahead of this script existing, 29.09.2026) — that is what makes `--confirm`
 *     idempotent by construction (structural, via `ensureVacationEntitlementForYear`'s own
 *     no-op-on-existing check — not re-implemented here).
 *
 * Issue #417's sibling repair (SHIFT_BASED leave requests miscounted against the roster instead
 * of the contract) is out of this script's scope (issue #416's own AC) — see
 * `scripts/recalculate-shift-based-leave-days.ts`.
 *
 * Issue #435 (D-06/D-09): the base value per candidate is the ONE shared resolution — the
 * employee's person value (`Employee.annualVacationDays`) falling back to the tenant's configured
 * default, never a raw tenant-config column read directly — and the proposed/written `totalDays`
 * is floored at the § 19 JArbSchG / § 3 BUrlG statutory minimum for the employee's birth date
 * before the § 4 BUrlG Wartezeit/hire-year pro-rata decision, exactly like every other
 * `ensureVacationEntitlementForYear` caller. The dry-run preview below calls the shared regular-
 * entitlement helper directly — the SAME helper `ensureVacationEntitlementForYear` (the
 * `--confirm` path) calls internally — so the two can never drift (RESEARCH.md Pitfall 4).
 *
 * Invariants:
 *   - NEVER hard-deletes anything (Revisionssicherheit per CLAUDE.md) — this script only
 *     creates missing rows, never mutates or removes an existing one.
 *   - Every created row is audited `action: "CREATE", entity: "LeaveEntitlement"` via the
 *     shared `ensureVacationEntitlementForYear` facade helper (contexts/absence), reason
 *     "Nachtrag fehlender Urlaubsanspruch".
 *   - Requires explicit tenant scope: --tenant-id OR --all-tenants (no silent default).
 *   - No PII in dry-run output — employeeNumber only (this repo's established convention;
 *     mirrors cleanup-time-entry-duplicates.ts's own id-only listing), never firstName/lastName.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
 *     scripts/backfill-missing-vacation-entitlements.ts \
 *     ( --tenant-id <uuid> | --all-tenants ) \
 *     [--confirm] \
 *     [--help]
 *
 * Without --confirm: dry-run (default) — lists every candidate with the totalDays it WOULD get,
 *                     writes nothing.
 * With    --confirm: for each candidate, calls ensureVacationEntitlementForYear inside its own
 *                     per-employee $transaction (one candidate, one transaction — mirrors
 *                     backfill-workschedule-model-switch-history.ts's own per-candidate shape).
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { ensureVacationEntitlementForYear } from "../src/contexts/absence";
import {
  resolveContractWorkDaysPerWeek,
  resolveVacationBaseDays, // Issue #435 (D-06) — the ONE base-value resolution, same as --confirm
} from "../src/contexts/absence/leave-days";
import { computeRegularVacationDays } from "../src/contexts/absence/vacation-calc";

const REPAIR_REASON = "Nachtrag fehlender Urlaubsanspruch";

// ── Exported types ──────────────────────────────────────────────────────────
export type CliArgs = {
  tenantId: string | null;
  allTenants: boolean;
  confirm: boolean;
  help: boolean;
};

export type BackfillCandidate = {
  employeeId: string;
  tenantId: string;
  employeeNumber: string;
  /** Preview only — the write path recomputes this itself via ensureVacationEntitlementForYear. */
  proposedTotalDays: number;
};

export type BackfillSummary = {
  dryRun: boolean;
  year: number;
  tenantsScanned: number;
  employeesScanned: number;
  candidates: BackfillCandidate[];
  created: number;
  skippedExisting: number;
  errors: Array<{ employeeId: string; tenantId: string; error: string }>;
};

const USAGE = `
Usage:
  DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \\
    scripts/backfill-missing-vacation-entitlements.ts \\
    ( --tenant-id <uuid> | --all-tenants ) \\
    [--confirm] \\
    [--help]

Without --confirm: dry-run (default) — lists candidates, writes nothing.
With    --confirm: creates the missing VACATION LeaveEntitlement rows.

Scope:
  - Active employees only (exitDate: null).
  - Current calendar year only.
  - Idempotent: an employee that already has a row for this year (including one already
    manually repaired) is skipped, never touched.
`;

// ── CLI parsing ─────────────────────────────────────────────────────────────
export function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "tenant-id": { type: "string" },
      "all-tenants": { type: "boolean", default: false },
      confirm: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  return {
    tenantId: values["tenant-id"] ?? null,
    allTenants: Boolean(values["all-tenants"]),
    confirm: Boolean(values["confirm"]),
    help: Boolean(values["help"]),
  };
}

// ── Main entry point ─────────────────────────────────────────────────────────
/**
 * Main entry point. Exported for unit-testability — pass a PrismaClient to inject a test
 * connection; without one the function creates its own (mirrors
 * backfill-workschedule-model-switch-history.ts's own shape).
 */
export async function main(
  argv: string[],
  injectedPrisma?: PrismaClient,
): Promise<BackfillSummary> {
  const args = parseCli(argv);

  if (args.help) {
    console.info(USAGE);
    return {
      dryRun: true,
      year: new Date().getFullYear(),
      tenantsScanned: 0,
      employeesScanned: 0,
      candidates: [],
      created: 0,
      skippedExisting: 0,
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
  const year = new Date().getFullYear();

  try {
    const summary: BackfillSummary = {
      dryRun: !args.confirm,
      year,
      tenantsScanned: 0,
      employeesScanned: 0,
      candidates: [],
      created: 0,
      skippedExisting: 0,
      errors: [],
    };

    const tenants = args.allTenants
      ? await prisma.tenant.findMany({ select: { id: true } })
      : [{ id: args.tenantId! }];
    summary.tenantsScanned = tenants.length;

    for (const t of tenants) {
      const activeEmployees = await prisma.employee.findMany({
        where: { tenantId: t.id, exitDate: null },
        select: { id: true, employeeNumber: true, hireDate: true, birthDate: true },
      });
      summary.employeesScanned += activeEmployees.length;

      for (const emp of activeEmployees) {
        try {
          const existing = await prisma.leaveEntitlement.findFirst({
            where: {
              employeeId: emp.id,
              year,
              leaveType: { tenantId: t.id, code: "VACATION" },
            },
          });
          if (existing) {
            summary.skippedExisting++;
            continue;
          }

          const workDaysPerWeek = await resolveContractWorkDaysPerWeek(prisma, emp.id, t.id);
          // Issue #435 (D-06): the ONE base-value resolution — person value ?? tenant default ??
          // 30 — computed ONCE per candidate and used by both the dry-run preview and --confirm,
          // so the two can never drift on the base value either.
          const baseDays = await resolveVacationBaseDays(prisma, emp.id, t.id);

          if (!args.confirm) {
            // Dry-run preview: calls the EXACT function and inputs ensureVacationEntitlementForYear
            // (the --confirm path below) uses internally — not a hand-rolled duplicate — so the two
            // can never drift (Issue #435, RESEARCH.md Pitfall 4).
            const proposedTotalDays = computeRegularVacationDays({
              year,
              hireDate: emp.hireDate,
              birthDate: emp.birthDate,
              workDaysPerWeek,
              baseDays,
            });

            summary.candidates.push({
              employeeId: emp.id,
              tenantId: t.id,
              employeeNumber: emp.employeeNumber,
              proposedTotalDays,
            });
            console.info(
              `[DRY-RUN] Candidate — employeeId=${emp.id} (${emp.employeeNumber}) ` +
                `year=${year} → proposedTotalDays=${proposedTotalDays}`,
            );
            continue;
          }

          // ── --confirm: create via the shared facade helper (own transaction per candidate,
          // mirrors backfill-workschedule-model-switch-history.ts's per-candidate shape) ──────
          const result = await prisma.$transaction(async (tx) =>
            ensureVacationEntitlementForYear(
              tx,
              emp.id,
              t.id,
              year,
              emp.hireDate,
              emp.birthDate,
              workDaysPerWeek,
              baseDays,
              REPAIR_REASON,
              (entry) =>
                tx.auditLog.create({
                  data: {
                    userId: null, // system-initiated (no human actor)
                    action: entry.action,
                    entity: entry.entity,
                    entityId: entry.entityId,
                    newValue: entry.newValue
                      ? (JSON.parse(JSON.stringify(entry.newValue)) as object)
                      : undefined,
                    userAgent: "script:backfill-missing-vacation-entitlements",
                  },
                }),
            ),
          );

          if (result?.created) {
            summary.created++;
            console.info(
              `[APPLIED] Created LeaveEntitlement — employeeId=${emp.id} (${emp.employeeNumber}) ` +
                `year=${year} totalDays=${Number(result.entitlement.totalDays)}`,
            );
          } else {
            // Structural idempotency: a row appeared between the pre-check above and this
            // write (e.g. a concurrent manual PUT) — not an error, just a no-op.
            summary.skippedExisting++;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          summary.errors.push({ employeeId: emp.id, tenantId: t.id, error: message });
          console.error(`[ERROR] employeeId=${emp.id}: ${message}`);
        }
      } // end employee loop
    } // end tenant loop

    if (!args.confirm) {
      console.info(
        `\nSummary: ${summary.candidates.length} candidate(s) found. Re-run with --confirm to write.`,
      );
    } else {
      console.info(
        `\nDone: ${summary.created} row(s) created, ${summary.skippedExisting} already present (untouched).`,
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
