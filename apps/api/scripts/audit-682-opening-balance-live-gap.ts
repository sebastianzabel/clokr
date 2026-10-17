/**
 * Audit tool — Issue #682.
 *
 * Since #682 the live saldo (`computeOvertimeBalanceBreakdown`, dashboard, `GET /overtime/:id`, the
 * stored `OvertimeAccount.balanceHours` written by `updateOvertimeAccount`) starts with the active
 * OpeningBalance when the person has no closed month yet — exactly like every close path and the
 * month series. Before #682 it started at 0 for those persons. This script lists, per tenant, every
 * person whose live saldo moves by that change, so the owner knows in advance whose displayed saldo
 * changes after the deploy (and the stored balance at the person's next write).
 *
 * What it lists: persons with an active (not superseded) OpeningBalance and no non-superseded
 * MONTHLY SaldoSnapshot, whose live saldo differs between "with" and "without" the OpeningBalance.
 * The gap is MEASURED, not re-derived: the same live computation runs twice, once normally and once
 * with a read-only Prisma view that answers "no OpeningBalance" — so every rule of the live chain
 * (track-only display of today's contract, a track-only month resetting the chain, § 18 exemption,
 * exit date) is applied by the production code itself. Run with the code of the release that
 * contains #682; with an older checkout both runs agree and the list is empty.
 *
 * Persons WITH a closed month are not listed: their live saldo reads the stored carry of the last
 * close, which the first close already seeded with the OpeningBalance — nothing changes for them.
 *
 * READ-ONLY. ZERO mutations. There is no write flag; `--confirm` / `--apply` are rejected.
 * Output contains ids and the gap in minutes only — no name, no employee number (DSGVO).
 *
 * Usage:
 *   DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \
 *     scripts/audit-682-opening-balance-live-gap.ts ( --tenant-id <uuid> | --all-tenants ) [--help]
 *
 * Exit codes:
 *   0 — no person's live saldo changes for the given scope
 *   1 — DATABASE_URL missing, bad CLI, or a DB connection/query failure
 *   2 — one or more persons listed (expected for open state; review, nothing to correct)
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  getConfirmedCarryOver,
  computeOvertimeBalanceBreakdown,
} from "../src/contexts/working-time-account";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_FINDINGS = 2;

export type CliArgs = { tenantId: string | null; allTenants: boolean; help: boolean };

export function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "tenant-id": { type: "string" },
      "all-tenants": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true, // rejects any unknown flag, in particular --confirm / --apply
  });
  return {
    tenantId: values["tenant-id"] ?? null,
    allTenants: Boolean(values["all-tenants"]),
    help: Boolean(values.help),
  };
}

export const USAGE = `
Usage:
  DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \\
    scripts/audit-682-opening-balance-live-gap.ts ( --tenant-id <uuid> | --all-tenants ) [--help]

READ-ONLY — lists persons with an active OpeningBalance and no closed month whose live saldo
changes with Issue #682 (the live saldo now starts with the OpeningBalance). Ids and minutes only.

Exit codes:
  0 — nobody listed
  1 — DATABASE_URL missing, bad CLI, or a DB connection/query failure
  2 — one or more persons listed
`;

export type Finding = { tenantId: string; employeeId: string; gapMinutes: number };

export function formatFindingLine(f: Finding): string {
  return `employee tenantId=${f.tenantId} employeeId=${f.employeeId} gapMinutes=${f.gapMinutes}`;
}

/**
 * A read-only view of the client in which no OpeningBalance exists. `getCarryOverBase` is the only
 * reader of the model on the live path, so the live computation through this view is the pre-#682
 * value. Every other delegate is the real client's.
 */
export function withoutOpeningBalance(prisma: PrismaClient): PrismaClient {
  return new Proxy(prisma, {
    get(target, prop) {
      if (prop === "openingBalance") {
        return { findFirst: async () => null, findMany: async () => [] };
      }
      return Reflect.get(target, prop, target);
    },
  });
}

/**
 * Exported for unit-testability — pass a PrismaClient to inject a test connection (worker test DB
 * only); without one the CLI entrypoint below bootstraps its own connection from DATABASE_URL.
 */
export async function main(argv: string[], injectedPrisma?: PrismaClient): Promise<number> {
  const args = parseCli(argv);
  if (args.help) {
    console.info(USAGE);
    return EXIT_OK;
  }
  if ((!args.tenantId && !args.allTenants) || (args.tenantId && args.allTenants)) {
    throw new Error(
      "Tenant-Auswahl erforderlich: bitte --tenant-id <uuid> ODER --all-tenants angeben.",
    );
  }
  if (!injectedPrisma && !process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    return EXIT_ERROR;
  }

  let pool: pg.Pool | undefined;
  let prisma: PrismaClient;
  if (injectedPrisma) {
    prisma = injectedPrisma;
  } else {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new PrismaPg(pool as any);
    prisma = new PrismaClient({ adapter });
  }

  // The live computation only reads `app.prisma` / `app.log` (same shim as audit-494).
  const log = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    warn: (...a: any[]) => console.warn(...a),
    info: () => undefined,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const appWith: any = { prisma, log };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const appWithout: any = { prisma: withoutOpeningBalance(prisma), log };

  try {
    const tenantIds = args.allTenants
      ? (await prisma.tenant.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map(
          (t) => t.id,
        )
      : [args.tenantId!];

    const rows = await prisma.openingBalance.findMany({
      where: { superseded: false, employee: { tenantId: { in: tenantIds } } },
      orderBy: [{ employeeId: "asc" }],
      select: { employee: { select: { id: true, tenantId: true } } },
    });

    let listed = 0;
    let withClosedMonth = 0;
    let unchanged = 0;
    let exempt = 0;
    for (const { employee } of rows) {
      const confirmed = await getConfirmedCarryOver(prisma, employee.id, employee.tenantId);
      if (confirmed.hasClosedMonth) {
        withClosedMonth++;
        continue;
      }
      const after = await computeOvertimeBalanceBreakdown(appWith, employee.id);
      const before = await computeOvertimeBalanceBreakdown(appWithout, employee.id);
      if (after === null || before === null) {
        exempt++;
        continue;
      }
      const gapMinutes = Math.round(after.totalHours * 60) - Math.round(before.totalHours * 60);
      if (gapMinutes === 0) {
        unchanged++;
        continue;
      }
      listed++;
      console.info(
        formatFindingLine({ tenantId: employee.tenantId, employeeId: employee.id, gapMinutes }),
      );
    }

    console.info(
      `\nSummary: ${listed} person(s) listed; ${rows.length} active opening balance(s) in ` +
        `${tenantIds.length} tenant(s): ${withClosedMonth} with a closed month (unchanged), ` +
        `${unchanged} without a closed month but no change (e.g. track-only today), ${exempt} exempt. ` +
        `This script writes nothing.`,
    );
    return listed > 0 ? EXIT_FINDINGS : EXIT_OK;
  } finally {
    if (!injectedPrisma) {
      await prisma.$disconnect();
      await pool?.end();
    }
  }
}

// Run-guard: only bootstrap the DB + execute when invoked as a script, so importing the module
// for unit tests is side-effect-free (no connection, no process.exit).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = EXIT_ERROR;
    });
}
