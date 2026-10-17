/**
 * Audit tool - Issue #662 (§ 9 credit survives an approved leave cancellation).
 *
 * Before Issue #662 the approval of a cancellation (CANCELLATION_REQUESTED -> CANCELLED) and the
 * #614 employment-exit cancellation left the § 9 BUrlG credits (`Section9Credit`) of the cancelled
 * request standing: the days were credited twice, once by the cancellation and once by the credit,
 * and `selfHealUsedDays` hid the difference in the display. Since #662 both paths supersede every
 * credit of the cancelled request. This script lists the Bestand BEFORE/AFTER the deploy: one line
 * per `Section9Credit` that is NOT `SUPERSEDED` although one of its two requests is `CANCELLED`.
 *
 * Per line: tenant id, credit id, employee id, the credit status, and the cancelled request id(s)
 * with the side they stand on (`vacation` = the credit's vacation request, `sick` = its sick
 * request). Ordered by tenant id, then credit id. A `Totals:` line follows.
 *
 * It corrects nothing: whether and how the Bestand is corrected is a separate, explicit decision
 * (a CONFIRMED credit has a ledger effect that a correction would have to undo with an audited
 * booking). Closed months are never touched by this script.
 *
 * Tenants: all of them, deactivated ones included (retention does not end with the contract).
 * `--tenant <id>` narrows the run to one tenant.
 *
 * READ-ONLY. ZERO mutations: only reads run, there is no write flag and none may ever be added
 * (a stray `--apply` or `--confirm` is rejected before anything is read). The output carries ids,
 * status names and side names only - never a name, a note, an employee number or an e-mail address
 * (DSGVO).
 *
 * Usage:
 *   DATABASE_URL=<dsn> pnpm tsx scripts/audit-662-cancelled-leave-section9.ts [--tenant <id>] [--help]
 *   (from /app/apps/api in the runtime image, or `pnpm --filter @clokr/api exec tsx scripts/...`)
 *
 * Exit codes:
 *   0 - no finding
 *   2 - at least one finding (the list was printed)
 *   1 - DATABASE_URL missing, bad CLI, or a DB connection/query failure
 */
import { PrismaClient } from "@clokr/db";
import type { Prisma } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

// ── Exit codes ──────────────────────────────────────────────────────────────
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_FINDINGS = 2;

export type CancelledSection9Row = {
  tenantId: string;
  creditId: string;
  employeeId: string;
  creditStatus: string;
  /** The cancelled request(s) of the credit, with the side they stand on. */
  cancelledRequests: Array<{ id: string; side: "vacation" | "sick" }>;
};

/** Everything a PrismaClient or an interactive-transaction client can run. */
type Db = Prisma.TransactionClient;

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Every non-superseded § 9 credit with a cancelled request on either side. Exported for the test;
 * the CLI prints it. Reads only.
 */
export async function computeCancelledSection9(
  db: Db,
  options: { tenantId?: string } = {},
): Promise<CancelledSection9Row[]> {
  const credits = await db.section9Credit.findMany({
    where: {
      status: { not: "SUPERSEDED" },
      ...(options.tenantId ? { employee: { tenantId: options.tenantId } } : {}),
      OR: [{ vacationRequest: { status: "CANCELLED" } }, { sickRequest: { status: "CANCELLED" } }],
    },
    select: {
      id: true,
      employeeId: true,
      status: true,
      employee: { select: { tenantId: true } },
      vacationRequest: { select: { id: true, status: true } },
      sickRequest: { select: { id: true, status: true } },
    },
  });

  const rows: CancelledSection9Row[] = credits.map((credit) => {
    const cancelledRequests: CancelledSection9Row["cancelledRequests"] = [];
    if (credit.vacationRequest.status === "CANCELLED") {
      cancelledRequests.push({ id: credit.vacationRequest.id, side: "vacation" });
    }
    if (credit.sickRequest.status === "CANCELLED") {
      cancelledRequests.push({ id: credit.sickRequest.id, side: "sick" });
    }
    return {
      tenantId: credit.employee.tenantId,
      creditId: credit.id,
      employeeId: credit.employeeId,
      creditStatus: credit.status,
      cancelledRequests,
    };
  });
  return rows.sort(
    (a, b) => compareStrings(a.tenantId, b.tenantId) || compareStrings(a.creditId, b.creditId),
  );
}

export function formatRow(row: CancelledSection9Row): string {
  return [
    `tenant=${row.tenantId}`,
    `credit=${row.creditId}`,
    `employee=${row.employeeId}`,
    `creditStatus=${row.creditStatus}`,
    `cancelled=${row.cancelledRequests.map((r) => `${r.side}:${r.id}`).join(",")}`,
  ].join(" ");
}

export function formatTotals(rows: CancelledSection9Row[]): string {
  const count = (status: string) => rows.filter((row) => row.creditStatus === status).length;
  return (
    `Totals: credits=${rows.length} confirmed=${count("CONFIRMED")} ` +
    `auPending=${count("AU_PENDING")} rejected=${count("REJECTED")} ` +
    `tenants=${new Set(rows.map((row) => row.tenantId)).size}`
  );
}

// ── CLI parsing ───────────────────────────────────────────────────────────────
export type CliArgs = { help: boolean; tenant: string | undefined };

export function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", default: false },
      tenant: { type: "string" },
    },
    strict: true, // rejects any unknown flag, in particular --apply / --confirm
  });
  return { help: Boolean(values.help), tenant: values.tenant };
}

export const USAGE = `
Usage:
  DATABASE_URL=<dsn> pnpm tsx scripts/audit-662-cancelled-leave-section9.ts [--tenant <id>] [--help]

READ-ONLY - lists, per tenant id and credit id, every § 9 credit that is not SUPERSEDED although
one of its two leave requests is CANCELLED (the pre-#662 state). Ids and status names only. No
write flag exists. Run it on int and prod before and after the deploy.

Exit codes:
  0 - no finding
  2 - at least one finding (the list was printed)
  1 - DATABASE_URL missing, bad CLI, or a DB connection/query failure
`;

/**
 * Exported for unit-testability - pass a client to inject a test connection (worker test DB only);
 * without one the CLI entrypoint below bootstraps its own connection from DATABASE_URL.
 */
export async function main(argv: string[], injectedPrisma?: PrismaClient): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCli(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(USAGE);
    return EXIT_ERROR;
  }

  if (args.help) {
    console.info(USAGE);
    return EXIT_OK;
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

  try {
    const rows = await computeCancelledSection9(prisma, { tenantId: args.tenant });
    for (const row of rows) console.info(formatRow(row));
    console.info(formatTotals(rows));
    console.info("This script writes nothing.");
    return rows.length > 0 ? EXIT_FINDINGS : EXIT_OK;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return EXIT_ERROR;
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
