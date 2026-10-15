/**
 * Audit tool — Issue #566 (booked packages per tenant), D-09.
 *
 * The `*_tenant_packages` migration grants every EXISTING tenant the packages whose functions it
 * uses today and a salon quota of at least its number of active salons (Bestandsschutz). This
 * script previews that grant, so the operator can see it BEFORE the release that carries the
 * migration is deployed.
 *
 * What it lists: one line per tenant id (ordered by id) with the `salonQuota` and the
 * `bookedModules` the backfill grants and the signals that fired:
 *   SALONS>1             the tenant has more than one salon, in any state          -> CHAIN
 *   CUSTOMER_ROLE        a role owned by the tenant                                -> CHAIN
 *   SCOPED_ASSIGNMENT    a role assignment scoped to salons or persons             -> CHAIN
 *   DEPLOYMENT           a deployment-kind salon assignment                        -> CHAIN
 *   COUPLING             a salon coupling                                          -> INTEGRATIONS
 *   API_KEY              an API key, revoked ones included                        -> INTEGRATIONS
 *   PHOREST_CREDENTIALS  a non-blank Phorest business id, user name or password    -> INTEGRATIONS
 *   TERMINAL             a terminal API key                                        -> HARDWARE_CLOCK
 *   PRESENCE_SOURCE      a presence source in any state                            -> HARDWARE_CLOCK
 *   CLASSIFIED_ENTRY     a time entry with an activity kind other than UNSPECIFIED -> ANALYTICS
 *   ACTIVITY_SHARE       an activity share row                                     -> ANALYTICS
 * A `Totals:` line follows (tenants and the number of tenants per module).
 *
 * Activity kinds (Phase 81) ship in the same release as the migration. On int/prod BEFORE that
 * deploy `TimeEntry.activityKind` and `TimeEntryActivityShare` do not exist yet, so the script
 * probes their existence read-only first. When one is missing the ANALYTICS signals are reported
 * as not evaluable (`analytics=not-evaluable`): no tenant can have a classification yet, the
 * migration will not grant ANALYTICS either, and every other grant is still printed.
 *
 * The logic is an INDEPENDENT implementation with Prisma reads — it does not execute the
 * migration SQL. A test compares both tenant by tenant. Like the SQL it over-grants on purpose:
 * soft-deleted and revoked rows count, deactivated tenants are included.
 *
 * READ-ONLY. ZERO mutations: only reads run, there is no write flag and none may ever be added
 * (a stray `--apply` or `--confirm` is rejected). The output carries tenant ids, numbers, module
 * names and signal names only — no tenant name, no slug, no person data (DSGVO). The Phorest
 * credentials are selected only to test them for "non-blank" and are never printed.
 *
 * Operator step: run it ONCE on int and ONCE on prod BEFORE deploying the release that carries
 * the migration, and keep the output. After the deploy the stored values must equal it for every
 * tenant an operator has not edited since.
 *
 * Usage:
 *   DATABASE_URL=<dsn> pnpm tsx scripts/audit-566-package-backfill.ts [--help]
 *   (from /app/apps/api in the runtime image, or `pnpm --filter @clokr/api exec tsx scripts/...`)
 *
 * Exit codes:
 *   0 — the preview was printed
 *   1 — DATABASE_URL missing, bad CLI, or a DB connection/query failure
 */
import { PrismaClient } from "@clokr/db";
import type { Prisma, TenantModule } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

// ── Exit codes ──────────────────────────────────────────────────────────────
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;

/** Canonical module order — the same order the migration writes. */
const MODULE_ORDER: readonly TenantModule[] = [
  "CHAIN",
  "INTEGRATIONS",
  "HARDWARE_CLOCK",
  "ANALYTICS",
];

export type PackageBackfillRow = {
  tenantId: string;
  salonQuota: number;
  bookedModules: TenantModule[];
  signals: string[];
  /** False when the activity-kind schema is not migrated yet, so ANALYTICS could not be judged. */
  analyticsEvaluated: boolean;
};

/** Everything a PrismaClient or an interactive-transaction client can run. */
type Db = Prisma.TransactionClient;

/** SQL `BTRIM` trims spaces only; "contains a non-space character" is the same test, linear. */
function hasText(value: string | null): boolean {
  return value !== null && /[^ ]/.test(value);
}

function idSet(rows: Array<{ tenantId: string | null }>): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) if (row.tenantId !== null) ids.add(row.tenantId);
  return ids;
}

/** Read-only probe: do the Phase 81 column and table exist in the connected database? */
async function activityKindSchemaExists(db: Db): Promise<boolean> {
  const columns = await db.$queryRaw<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'TimeEntry' AND column_name = 'activityKind'`;
  const tables = await db.$queryRaw<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'TimeEntryActivityShare'`;
  return (columns[0]?.n ?? 0) > 0 && (tables[0]?.n ?? 0) > 0;
}

/**
 * What the Bestandsschutz backfill would grant every tenant, computed with Prisma reads only.
 * Exported for the parity test; the CLI below prints it.
 */
export async function computePackageBackfill(db: Db): Promise<PackageBackfillRow[]> {
  const tenants = await db.tenant.findMany({ select: { id: true } });

  const salons = await db.salon.findMany({ select: { tenantId: true, isActive: true } });
  const salonCount = new Map<string, number>();
  const activeSalonCount = new Map<string, number>();
  for (const salon of salons) {
    salonCount.set(salon.tenantId, (salonCount.get(salon.tenantId) ?? 0) + 1);
    if (salon.isActive) {
      activeSalonCount.set(salon.tenantId, (activeSalonCount.get(salon.tenantId) ?? 0) + 1);
    }
  }

  // A role with a tenant id is a customer role; the system templates (tenantId null) are no signal.
  const customerRole = idSet(
    await db.accessRole.findMany({
      where: { tenantId: { not: null } },
      select: { tenantId: true },
      distinct: ["tenantId"],
    }),
  );
  const scopedAssignment = idSet(
    await db.roleAssignment.findMany({
      where: { scopeType: { in: ["SALONS", "PERSONS"] } },
      select: { tenantId: true },
      distinct: ["tenantId"],
    }),
  );
  const deployment = idSet(
    await db.employeeSalonAssignment.findMany({
      where: { kind: "DEPLOYMENT" },
      select: { tenantId: true },
      distinct: ["tenantId"],
    }),
  );
  const coupling = idSet(
    await db.salonCoupling.findMany({ select: { tenantId: true }, distinct: ["tenantId"] }),
  );
  const apiKey = idSet(
    await db.apiKey.findMany({ select: { tenantId: true }, distinct: ["tenantId"] }),
  );
  const terminal = idSet(
    await db.terminalApiKey.findMany({ select: { tenantId: true }, distinct: ["tenantId"] }),
  );
  const presenceSource = idSet(
    await db.presenceSource.findMany({ select: { tenantId: true }, distinct: ["tenantId"] }),
  );

  // Selected only to test them for "non-blank"; the values are never kept or printed.
  const phorestCredentials = new Set<string>();
  const configs = await db.tenantConfig.findMany({
    select: {
      tenantId: true,
      phorestBusinessId: true,
      phorestUsername: true,
      phorestPassword: true,
    },
  });
  for (const config of configs) {
    if (
      hasText(config.phorestBusinessId) ||
      hasText(config.phorestUsername) ||
      (config.phorestPassword !== null && config.phorestPassword !== "")
    ) {
      phorestCredentials.add(config.tenantId);
    }
  }

  const analyticsEvaluated = await activityKindSchemaExists(db);
  let classifiedEntry = new Set<string>();
  let activityShare = new Set<string>();
  if (analyticsEvaluated) {
    // No deletedAt filter on purpose: a soft-deleted classified entry is still a signal of use.
    classifiedEntry = idSet(
      await db.employee.findMany({
        where: { timeEntries: { some: { activityKind: { not: "UNSPECIFIED" } } } },
        select: { tenantId: true },
        distinct: ["tenantId"],
      }),
    );
    activityShare = idSet(
      await db.employee.findMany({
        where: { timeEntries: { some: { activityShares: { some: {} } } } },
        select: { tenantId: true },
        distinct: ["tenantId"],
      }),
    );
  }

  return tenants
    .map(({ id }): PackageBackfillRow => {
      const signals: string[] = [];
      const chainSignals: Array<[string, boolean]> = [
        ["SALONS>1", (salonCount.get(id) ?? 0) > 1],
        ["CUSTOMER_ROLE", customerRole.has(id)],
        ["SCOPED_ASSIGNMENT", scopedAssignment.has(id)],
        ["DEPLOYMENT", deployment.has(id)],
      ];
      const integrationSignals: Array<[string, boolean]> = [
        ["COUPLING", coupling.has(id)],
        ["API_KEY", apiKey.has(id)],
        ["PHOREST_CREDENTIALS", phorestCredentials.has(id)],
      ];
      const hardwareSignals: Array<[string, boolean]> = [
        ["TERMINAL", terminal.has(id)],
        ["PRESENCE_SOURCE", presenceSource.has(id)],
      ];
      const analyticsSignals: Array<[string, boolean]> = [
        ["CLASSIFIED_ENTRY", classifiedEntry.has(id)],
        ["ACTIVITY_SHARE", activityShare.has(id)],
      ];
      const fired = (list: Array<[string, boolean]>): boolean => {
        const names = list.filter(([, on]) => on).map(([name]) => name);
        signals.push(...names);
        return names.length > 0;
      };
      const granted: Record<TenantModule, boolean> = {
        CHAIN: fired(chainSignals),
        INTEGRATIONS: fired(integrationSignals),
        HARDWARE_CLOCK: fired(hardwareSignals),
        ANALYTICS: fired(analyticsSignals),
      };
      return {
        tenantId: id,
        salonQuota: Math.max(1, activeSalonCount.get(id) ?? 0),
        bookedModules: MODULE_ORDER.filter((module) => granted[module]),
        signals,
        analyticsEvaluated,
      };
    })
    .sort((a, b) => (a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0));
}

// ── CLI parsing ───────────────────────────────────────────────────────────────
export type CliArgs = { help: boolean };

export function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: { help: { type: "boolean", default: false } },
    strict: true, // rejects any unknown flag, in particular --apply / --confirm
  });
  return { help: Boolean(values.help) };
}

export const USAGE = `
Usage:
  DATABASE_URL=<dsn> pnpm tsx scripts/audit-566-package-backfill.ts [--help]

READ-ONLY — previews, per tenant id, the salon quota and the booked modules the Phase 566
migration grants (Bestandsschutz) and the signals that fired. Run it on int and prod BEFORE the
deploy. Ids, numbers, module and signal names only. No write flag exists.

Exit codes:
  0 — the preview was printed
  1 — DATABASE_URL missing, bad CLI, or a DB connection/query failure
`;

/**
 * Exported for unit-testability — pass a client to inject a test connection (worker test DB only);
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
    const rows = await computePackageBackfill(prisma);
    for (const row of rows) {
      console.info(
        `tenantId=${row.tenantId} salonQuota=${row.salonQuota} ` +
          `bookedModules=${row.bookedModules.length > 0 ? row.bookedModules.join(",") : "NONE"} ` +
          `signals=${row.signals.length > 0 ? row.signals.join(",") : "NONE"} ` +
          `analytics=${row.analyticsEvaluated ? "evaluated" : "not-evaluable"}`,
      );
    }
    const perModule = MODULE_ORDER.map(
      (module) => `${module}=${rows.filter((r) => r.bookedModules.includes(module)).length}`,
    );
    console.info(`Totals: tenants=${rows.length} ${perModule.join(" ")}`);
    if (rows.some((row) => !row.analyticsEvaluated)) {
      console.info(
        "Activity kinds are not migrated yet (TimeEntry.activityKind / TimeEntryActivityShare " +
          "missing): ANALYTICS cannot be granted, and the migration will not grant it either. " +
          "This script writes nothing.",
      );
    } else {
      console.info("This script writes nothing.");
    }
    return EXIT_OK;
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
