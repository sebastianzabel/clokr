/**
 * Audit tool — Issue #70 (Phase 70b, pre-deploy check).
 *
 * Until Issue #70 a partial unique index allowed one TimeEntry per employee and day. The 70b migrations
 * replace it with a database guarantee: no two non-deleted CLOSED entries of one employee overlap
 * (exclusion constraint "TimeEntry_no_overlap_closed"), and at most one OPEN non-deleted entry exists per
 * employee and day (unique index "TimeEntry_employeeId_date_open_unique"). `ADD CONSTRAINT` validates
 * every existing row, so ONE legacy row that violates it aborts the whole deploy. Run this script against
 * the target database BEFORE `prisma migrate deploy` (docs/migrations.md); exit 0 means the migration
 * will apply.
 *
 * What it lists (three classes, exactly what the new objects refuse):
 *   overlap       two non-deleted closed entries of one employee whose half-open intervals
 *                 [startTime, endTime) overlap, on any dates (a midnight-spanning entry is covered);
 *                 a zero-length entry is an empty interval and never conflicts
 *   inverted      a non-deleted closed entry with endTime < startTime (the range constructor refuses it)
 *   multipleOpen  an employee and day with more than one non-deleted open entry
 * A `Totals:` line follows (overlap, inverted, multipleOpen).
 *
 * READ-ONLY. ZERO mutations: only SELECT statements run, there is no write flag and none may ever be
 * added (a stray `--confirm`, `--apply` or `--fix` is rejected). The output carries ids and calendar dates
 * only — no name, no employee number, no mail address (DSGVO). Full, untruncated UUIDs, so each row can be
 * located directly. A finding is corrected deliberately through the audited correction path, never
 * rewritten in place by this script.
 *
 * Cost note: the overlap class is a per-employee self-join (the exclusion constraint's own index does not
 * exist yet on the pre-migration database). That is quadratic in the entries of ONE employee, which is
 * fine at the data volumes of a pre-deploy check; narrow it with --tenant-id when needed.
 *
 * Usage:
 *   DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \
 *     scripts/audit-70-entry-overlaps.ts [--tenant-id <uuid>] [--help]
 *
 * Exit codes:
 *   0 — no finding (the 70b migration applies cleanly)
 *   1 — DATABASE_URL missing, bad CLI, or a DB connection/query failure
 *   2 — one or more findings (resolve them before deploying)
 */
import { PrismaClient, type Prisma } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

// ── Exit codes ──────────────────────────────────────────────────────────────
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_FINDINGS = 2;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── CLI parsing ───────────────────────────────────────────────────────────────
export type CliArgs = { tenantId: string | null; help: boolean };

export function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "tenant-id": { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true, // rejects any unknown flag, in particular --confirm / --apply / --fix
  });
  const tenantId = values["tenant-id"] ?? null;
  if (tenantId !== null && !UUID_PATTERN.test(tenantId)) {
    throw new Error(`--tenant-id must be a UUID, got "${tenantId}"`);
  }
  return { tenantId, help: Boolean(values.help) };
}

export const USAGE = `
Usage:
  DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \\
    scripts/audit-70-entry-overlaps.ts [--tenant-id <uuid>] [--help]

READ-ONLY — pre-deploy check of Issue #70: lists the time entries the no-overlap guarantee of the 70b
migration would refuse (overlapping closed entries, closed entries that end before they start, several
open entries of one employee and day), then a totals line. Ids and dates only, no personal data. No write
flag exists. --tenant-id narrows the survey to one tenant.

Exit codes:
  0 — no finding, the migration applies cleanly
  1 — DATABASE_URL missing, bad CLI, or a DB connection/query failure
  2 — one or more findings (resolve them before deploying)
`;

// ── Findings ──────────────────────────────────────────────────────────────────
export type OverlapFinding = {
  tenantId: string;
  employeeId: string;
  entryIdA: string;
  entryIdB: string;
};
export type InvertedFinding = { tenantId: string; employeeId: string; entryId: string };
export type MultipleOpenFinding = {
  tenantId: string;
  employeeId: string;
  date: string;
  entryIds: string[];
};
export type EntryOverlapFindings = {
  overlaps: OverlapFinding[];
  inverted: InvertedFinding[];
  multipleOpen: MultipleOpenFinding[];
};

/** Anything that can run raw SELECTs: the PrismaClient or a transaction client. */
type RawReader = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * The finder. Takes any raw-query reader, so a test can run it inside a rolled-back transaction in which
 * the guard objects were removed and violating rows were inserted. `tenantId` null surveys every tenant.
 * Results are ordered by id so the output is deterministic.
 */
export async function findEntryOverlapFindings(
  db: RawReader,
  tenantId: string | null,
): Promise<EntryOverlapFindings> {
  // `${tenantId}::text IS NULL OR e."tenantId" = ${tenantId}` keeps one statement per class and binds the
  // value as a parameter (never concatenated).
  const overlaps = await db.$queryRaw<OverlapFinding[]>`
    SELECT e."tenantId" AS "tenantId", a."employeeId" AS "employeeId",
           a."id" AS "entryIdA", b."id" AS "entryIdB"
      FROM "TimeEntry" a
      JOIN "TimeEntry" b
        ON b."employeeId" = a."employeeId" AND a."id" < b."id"
      JOIN "Employee" e ON e."id" = a."employeeId"
     WHERE a."deletedAt" IS NULL AND b."deletedAt" IS NULL
       AND a."endTime" IS NOT NULL AND b."endTime" IS NOT NULL
       AND a."endTime" > a."startTime" AND b."endTime" > b."startTime"
       AND a."startTime" < b."endTime" AND b."startTime" < a."endTime"
       AND (${tenantId}::text IS NULL OR e."tenantId" = ${tenantId}::text)
     ORDER BY a."employeeId", a."id", b."id"`;

  const inverted = await db.$queryRaw<InvertedFinding[]>`
    SELECT e."tenantId" AS "tenantId", t."employeeId" AS "employeeId", t."id" AS "entryId"
      FROM "TimeEntry" t
      JOIN "Employee" e ON e."id" = t."employeeId"
     WHERE t."deletedAt" IS NULL AND t."endTime" IS NOT NULL AND t."endTime" < t."startTime"
       AND (${tenantId}::text IS NULL OR e."tenantId" = ${tenantId}::text)
     ORDER BY t."employeeId", t."id"`;

  const multipleOpen = await db.$queryRaw<MultipleOpenFinding[]>`
    SELECT e."tenantId" AS "tenantId", t."employeeId" AS "employeeId",
           to_char(t."date", 'YYYY-MM-DD') AS "date",
           array_agg(t."id" ORDER BY t."id") AS "entryIds"
      FROM "TimeEntry" t
      JOIN "Employee" e ON e."id" = t."employeeId"
     WHERE t."deletedAt" IS NULL AND t."endTime" IS NULL
       AND (${tenantId}::text IS NULL OR e."tenantId" = ${tenantId}::text)
     GROUP BY e."tenantId", t."employeeId", t."date"
    HAVING count(*) > 1
     ORDER BY t."employeeId", t."date"`;

  return { overlaps, inverted, multipleOpen };
}

// ── Output ────────────────────────────────────────────────────────────────────
export function formatFindingLines(findings: EntryOverlapFindings): string[] {
  const lines: string[] = [];
  for (const f of findings.overlaps) {
    lines.push(
      `overlap tenantId=${f.tenantId} employeeId=${f.employeeId} entryA=${f.entryIdA} entryB=${f.entryIdB}`,
    );
  }
  for (const f of findings.inverted) {
    lines.push(`inverted tenantId=${f.tenantId} employeeId=${f.employeeId} entryId=${f.entryId}`);
  }
  for (const f of findings.multipleOpen) {
    lines.push(
      `multipleOpen tenantId=${f.tenantId} employeeId=${f.employeeId} date=${f.date} entryIds=${f.entryIds.join(",")}`,
    );
  }
  return lines;
}

export function formatTotals(findings: EntryOverlapFindings): string {
  return (
    `Totals: overlap=${findings.overlaps.length} inverted=${findings.inverted.length} ` +
    `multipleOpen=${findings.multipleOpen.length}`
  );
}

export function exitCodeFor(findings: EntryOverlapFindings): number {
  const total = findings.overlaps.length + findings.inverted.length + findings.multipleOpen.length;
  return total > 0 ? EXIT_FINDINGS : EXIT_OK;
}

/**
 * Exported for unit-testability — pass a PrismaClient (or a transaction client, which only needs
 * `$queryRaw`) to inject a test connection; without one the CLI entrypoint below bootstraps its own
 * connection from DATABASE_URL.
 */
export async function main(argv: string[], injectedPrisma?: RawReader): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCli(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
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
  let prisma: PrismaClient | undefined;
  let reader: RawReader;
  if (injectedPrisma) {
    reader = injectedPrisma;
  } else {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new PrismaPg(pool as any);
    prisma = new PrismaClient({ adapter });
    reader = prisma;
  }

  try {
    const findings = await findEntryOverlapFindings(reader, args.tenantId);
    for (const line of formatFindingLines(findings)) console.info(line);
    console.info(formatTotals(findings));
    return exitCodeFor(findings);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return EXIT_ERROR;
  } finally {
    if (prisma) await prisma.$disconnect();
    await pool?.end();
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
