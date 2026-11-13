/**
 * Audit tool — Issue #799.
 *
 * Before #799 only the web clock-out applied the automatic break (`TenantConfig.autoBreakEnabled`);
 * an entry closed by an NFC terminal punch or a WIFI presence source got none unless a break was
 * entered by hand. Since #799 every clock trigger runs the same post-STOP step. This script lists
 * the entries closed BEFORE the fix that therefore carry no break although their tenant has the
 * automatic break on, so the owner knows the size of the Bestand before the deploy.
 *
 * What it lists: closed, non-deleted WORK entries with source NFC or WIFI, in a month that is not
 * closed (`isLocked = false`), of a tenant with `autoBreakEnabled`, with more than 6 h of presence,
 * `breakMinutes = 0` and no Break rows. Entries of closed months are never listed.
 *
 * READ-ONLY. ZERO mutations, and NEVER a backfill: a stored entry is not rewritten (the saldo of a
 * past day would move). There is no write flag; `--confirm` / `--apply` are rejected. Output is
 * entry ids and counts only - no name, no employee number, no times (DSGVO).
 *
 * Usage:
 *   DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \
 *     scripts/audit-799-clock-entries-without-auto-break.ts ( --tenant-id <uuid> | --all-tenants ) [--help]
 *
 * Exit codes:
 *   0 — no entry listed for the given scope
 *   1 — DATABASE_URL missing, bad CLI, or a DB connection/query failure
 *   2 — one or more entries listed
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_FINDINGS = 2;

/** More than 6 h of presence is where § 4 ArbZG starts requiring a break. */
export const MIN_PRESENCE_MS = 6 * 3_600_000;

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
    scripts/audit-799-clock-entries-without-auto-break.ts ( --tenant-id <uuid> | --all-tenants ) [--help]

READ-ONLY — lists closed NFC/WIFI entries in open months of tenants with the automatic break on,
longer than 6 h, without any break. Ids and counts only. Never backfills.

Exit codes:
  0 — nothing listed
  1 — DATABASE_URL missing, bad CLI, or a DB connection/query failure
  2 — one or more entries listed
`;

export type Finding = { tenantId: string; entryId: string; source: string };

export function formatFindingLine(f: Finding): string {
  return `entry tenantId=${f.tenantId} entryId=${f.entryId} source=${f.source}`;
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

  try {
    const configs = await prisma.tenantConfig.findMany({
      where: { autoBreakEnabled: true, ...(args.tenantId ? { tenantId: args.tenantId } : {}) },
      select: { tenantId: true },
      orderBy: { tenantId: "asc" },
    });

    let listed = 0;
    for (const { tenantId } of configs) {
      const entries = await prisma.timeEntry.findMany({
        where: {
          deletedAt: null,
          type: "WORK",
          source: { in: ["NFC", "WIFI"] },
          endTime: { not: null },
          isLocked: false,
          breakMinutes: 0,
          breaks: { none: {} },
          employee: { tenantId },
        },
        select: { id: true, source: true, startTime: true, endTime: true },
        orderBy: { id: "asc" },
      });
      for (const e of entries) {
        if (e.endTime!.getTime() - e.startTime.getTime() <= MIN_PRESENCE_MS) continue;
        listed++;
        console.info(formatFindingLine({ tenantId, entryId: e.id, source: e.source }));
      }
    }

    console.info(
      `\nSummary: ${listed} entr${listed === 1 ? "y" : "ies"} listed in ${configs.length} tenant(s) ` +
        `with the automatic break on. This script writes nothing and nothing is to be backfilled.`,
    );
    return listed > 0 ? EXIT_FINDINGS : EXIT_OK;
  } finally {
    if (!injectedPrisma) {
      await prisma.$disconnect();
      await pool?.end();
    }
  }
}

// Run-guard: only bootstrap the DB + execute when invoked as a script.
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
