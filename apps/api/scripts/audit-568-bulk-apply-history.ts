/**
 * Audit tool — Issue #568.
 *
 * Until Issue #568 the tenant-wide "apply to existing employees" of the default working time
 * (`PUT /api/v1/settings/work` with the apply flag) wrote a NEW contract row for every employee
 * whose newest contract was a FIXED_SCHEDULE — from the 1st of the CURRENT month, without a
 * preview and without a confirmation. On 04.10.2026 that turned an individual 16 h Mo-Do contract
 * into 40 h Mo-Fr, retroactively. Since #568 the apply is a two-step flow (preview, then a
 * confirmed selection, never retroactive, § 3 Satz 1 NachwG). This script lists what the OLD
 * applies changed, so the operator can correct those contracts deliberately.
 *
 * What it lists: for every past bulk apply (an `UPDATE` audit row of `TenantConfig` whose
 * `newValue.applyToExisting` is true) one line per `CREATE WorkSchedule` audit row it paired with —
 * config audit id and time, tenant id, employee id, work-schedule id, validFrom, the old -> new
 * weekly hours and the seven day-hours, the pairing source and the flags:
 *   HOURS_CHANGED        weekly hours or any day-hours differ from the previous contract
 *   NO_PREVIOUS_CONTRACT the employee had no contract before (nothing individual was overwritten)
 *   RETROACTIVE          validFrom lies before the tenant-local calendar date of the apply
 * A `Totals:` line follows (configRows, pairedRows, hoursChanged, retroactive, noPreviousContract).
 *
 * Pairing rule. When a `BULK_APPLY` audit row of the same TenantConfig lies in the 10 minutes
 * before the config row (written since #568, in the same transaction), it is the exact source: its
 * `appliedEmployeeIds` and `effectiveFrom` select the `CREATE WorkSchedule` rows (source=BULK_APPLY).
 * Otherwise (a historic, pre-#568 apply) the `CREATE WorkSchedule` rows of the same user (a missing
 * user pairs with a missing user) in the 10 minutes before the config row are taken — the old loop
 * audited before the config row — restricted to FIXED_SCHEDULE rows whose validFrom is the UTC
 * month-first of the config row's time and to employees of that tenant (source=WINDOW).
 *
 * What it cannot see: `CREATE WorkSchedule` rows of a pre-#568 loop that crashed before it wrote the
 * config audit row (no config row, nothing to pair with). An apply through an API key has no user
 * id and is paired by "no user" (flag ACTOR_UNKNOWN is printed on such a row).
 *
 * READ-ONLY. ZERO mutations: only Prisma reads run, there is no write flag and none may ever be
 * added (a stray `--confirm` or `--apply` is rejected). The output carries ids, dates, hours and
 * flags only — no name, no employee number, no mail address (DSGVO); the script never selects those
 * columns. Full, untruncated UUIDs, so each row can be located directly.
 *
 * Operator step: run it ONCE on int and on prod after the #568 release and correct every listed
 * contract that should not have changed deliberately, through the per-employee path
 * `PUT /api/v1/settings/work/:employeeId` (a correction entry, never an in-place rewrite).
 *
 * Usage:
 *   DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \
 *     scripts/audit-568-bulk-apply-history.ts [--tenant-id <uuid>] [--help]
 *
 * Exit codes:
 *   0 — no bulk apply changed hours or took effect retroactively for the given scope
 *   1 — DATABASE_URL missing, bad CLI, or a DB connection/query failure
 *   2 — one or more paired rows carry HOURS_CHANGED or RETROACTIVE (review, correct deliberately)
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { snapToMonthFirstUtc } from "../src/contexts/platform";
import { dateStrInTz } from "../src/contexts/working-time-account";

// ── Exit codes ──────────────────────────────────────────────────────────────
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_FINDINGS = 2;

/** How far before the config audit row its paired rows may lie (the old loop audited first). */
const PAIRING_WINDOW_MS = 10 * 60 * 1000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DAY_FIELDS = [
  "mondayHours",
  "tuesdayHours",
  "wednesdayHours",
  "thursdayHours",
  "fridayHours",
  "saturdayHours",
  "sundayHours",
] as const;

// ── CLI parsing ───────────────────────────────────────────────────────────────
export type CliArgs = { tenantId: string | null; help: boolean };

export function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "tenant-id": { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true, // rejects any unknown flag, in particular --confirm / --apply
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
    scripts/audit-568-bulk-apply-history.ts [--tenant-id <uuid>] [--help]

READ-ONLY — lists every contract row a past tenant-wide bulk apply of the default working time
wrote (Issue #568): config audit id, employee id, work-schedule id, validFrom, old -> new weekly
hours and day-hours, pairing source and the flags HOURS_CHANGED / NO_PREVIOUS_CONTRACT /
RETROACTIVE, then a totals line. Ids and numbers only, no personal data. No write flag exists.
--tenant-id narrows the survey to one tenant.

Exit codes:
  0 — nothing changed hours or took effect retroactively
  1 — DATABASE_URL missing, bad CLI, or a DB connection/query failure
  2 — one or more rows are flagged HOURS_CHANGED or RETROACTIVE (correct deliberately)
`;

// ── JSON helpers ────────────────────────────────────────────────────────────
type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;
}

/** Decimal values are stored as strings in the audit JSON; null/absent stays null. */
function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateOnly(value: unknown): string | null {
  return typeof value === "string" && value.length >= 10 ? value.slice(0, 10) : null;
}

type Hours = { weekly: number | null; days: (number | null)[] };

function hoursOf(row: Json): Hours {
  return { weekly: num(row.weeklyHours), days: DAY_FIELDS.map((field) => num(row[field])) };
}

function hoursEqual(a: Hours, b: Hours): boolean {
  return a.weekly === b.weekly && a.days.every((value, i) => value === b.days[i]);
}

const fmt = (value: number | null): string => (value === null ? "null" : String(value));
const fmtHours = (hours: Hours | null): string =>
  hours === null ? "none" : `${fmt(hours.weekly)}`;
const fmtDays = (hours: Hours | null): string =>
  hours === null ? "none" : hours.days.map(fmt).join("/");

// ── Result shape ────────────────────────────────────────────────────────────
export type PairedRow = {
  configAuditId: string;
  at: Date;
  tenantId: string;
  employeeId: string;
  workScheduleId: string;
  validFrom: string;
  oldHours: Hours | null;
  newHours: Hours;
  source: "BULK_APPLY" | "WINDOW";
  flags: string[];
};

/**
 * Exported for unit-testability — pass a PrismaClient to inject a test connection (run against the
 * worker test DB only); without one the CLI entrypoint below bootstraps its own connection from
 * DATABASE_URL.
 */
export async function main(argv: string[], injectedPrisma?: PrismaClient): Promise<number> {
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
    // Narrow to one tenant through its TenantConfig id (the config audit row's entityId).
    let entityIdFilter: string | undefined;
    if (args.tenantId) {
      const config = await prisma.tenantConfig.findUnique({
        where: { tenantId: args.tenantId },
        select: { id: true },
      });
      if (!config) {
        console.info(`No TenantConfig found for tenant ${args.tenantId}.`);
        console.info(
          "Totals: configRows=0 pairedRows=0 hoursChanged=0 retroactive=0 noPreviousContract=0",
        );
        return EXIT_OK;
      }
      entityIdFilter = config.id;
    }

    const configRows = await prisma.auditLog.findMany({
      where: {
        action: "UPDATE",
        entity: "TenantConfig",
        ...(entityIdFilter ? { entityId: entityIdFilter } : {}),
        newValue: { path: ["applyToExisting"], equals: true },
      },
      select: { id: true, userId: true, entityId: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    let configCount = 0;
    let pairedCount = 0;
    let hoursChanged = 0;
    let retroactive = 0;
    let noPrevious = 0;

    for (const configRow of configRows) {
      configCount += 1;
      const config = configRow.entityId
        ? await prisma.tenantConfig.findUnique({
            where: { id: configRow.entityId },
            select: { tenantId: true, timezone: true },
          })
        : null;
      if (!config) {
        console.info(
          `configAuditId=${configRow.id} at=${configRow.createdAt.toISOString()} ` +
            "note=TENANT_CONFIG_NOT_FOUND pairedRows=0",
        );
        continue;
      }

      const windowStart = new Date(configRow.createdAt.getTime() - PAIRING_WINDOW_MS);
      const rows = await pairRows(prisma, {
        configAuditId: configRow.id,
        configEntityId: configRow.entityId as string,
        configUserId: configRow.userId,
        configAt: configRow.createdAt,
        windowStart,
        tenantId: config.tenantId,
        timezone: config.timezone,
      });

      if (rows.length === 0) {
        console.info(
          `configAuditId=${configRow.id} at=${configRow.createdAt.toISOString()} ` +
            `tenantId=${config.tenantId} pairedRows=0`,
        );
        continue;
      }

      for (const row of rows) {
        pairedCount += 1;
        if (row.flags.includes("HOURS_CHANGED")) hoursChanged += 1;
        if (row.flags.includes("RETROACTIVE")) retroactive += 1;
        if (row.flags.includes("NO_PREVIOUS_CONTRACT")) noPrevious += 1;
        console.info(
          `configAuditId=${row.configAuditId} at=${row.at.toISOString()} tenantId=${row.tenantId} ` +
            `employeeId=${row.employeeId} workScheduleId=${row.workScheduleId} ` +
            `validFrom=${row.validFrom} weekly=${fmtHours(row.oldHours)}->${fmtHours(row.newHours)} ` +
            `days=${fmtDays(row.oldHours)}->${fmtDays(row.newHours)} source=${row.source} ` +
            `flags=${row.flags.length > 0 ? row.flags.join(",") : "NONE"}`,
        );
      }
    }

    console.info(
      `Totals: configRows=${configCount} pairedRows=${pairedCount} hoursChanged=${hoursChanged} ` +
        `retroactive=${retroactive} noPreviousContract=${noPrevious}`,
    );
    if (configCount === 0) {
      console.info("No bulk apply of the default working time found.");
    } else {
      console.info(
        "Correct unwanted contracts deliberately via PUT /api/v1/settings/work/:employeeId. " +
          "This script writes nothing.",
      );
    }

    return hoursChanged > 0 || retroactive > 0 ? EXIT_FINDINGS : EXIT_OK;
  } finally {
    if (!injectedPrisma) {
      await prisma.$disconnect();
      await pool?.end();
    }
  }
}

type PairInput = {
  configAuditId: string;
  configEntityId: string;
  configUserId: string | null;
  configAt: Date;
  windowStart: Date;
  tenantId: string;
  timezone: string;
};

/** The CREATE WorkSchedule audit rows one config audit row paired with, flags computed. */
async function pairRows(prisma: PrismaClient, input: PairInput): Promise<PairedRow[]> {
  // Exact source: the collective BULK_APPLY row written since #568 inside the same transaction.
  const bulkRow = await prisma.auditLog.findFirst({
    where: {
      action: "BULK_APPLY",
      entity: "TenantConfig",
      entityId: input.configEntityId,
      createdAt: { gte: input.windowStart, lte: input.configAt },
    },
    select: { newValue: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  const bulkValue = asRecord(bulkRow?.newValue);
  const appliedIds = Array.isArray(bulkValue?.appliedEmployeeIds)
    ? (bulkValue.appliedEmployeeIds as unknown[]).filter(
        (id): id is string => typeof id === "string",
      )
    : null;
  const effectiveFrom = dateOnly(bulkValue?.effectiveFrom);

  const source: PairedRow["source"] =
    bulkRow && appliedIds && effectiveFrom ? "BULK_APPLY" : "WINDOW";
  const createdWindowStart =
    source === "BULK_APPLY" && bulkRow
      ? new Date(bulkRow.createdAt.getTime() - PAIRING_WINDOW_MS)
      : input.windowStart;
  const createdWindowEnd = source === "BULK_APPLY" && bulkRow ? bulkRow.createdAt : input.configAt;

  const created = await prisma.auditLog.findMany({
    where: {
      action: "CREATE",
      entity: "WorkSchedule",
      userId: input.configUserId, // null pairs with null: an API-key apply has no user id
      createdAt: { gte: createdWindowStart, lte: createdWindowEnd },
    },
    select: { id: true, entityId: true, oldValue: true, newValue: true },
    orderBy: { createdAt: "asc" },
  });

  // A month-first of the config row's time; an apply that straddles UTC midnight of the 1st wrote
  // the month-first of the minute before, so that one is accepted as well.
  const monthFirsts = new Set([
    snapToMonthFirstUtc(input.configAt).toISOString().slice(0, 10),
    snapToMonthFirstUtc(new Date(input.configAt.getTime() - PAIRING_WINDOW_MS))
      .toISOString()
      .slice(0, 10),
  ]);
  const atLocalDate = dateStrInTz(input.configAt, input.timezone);

  const candidates = created.flatMap((row) => {
    const newValue = asRecord(row.newValue);
    const employeeId = typeof newValue?.employeeId === "string" ? newValue.employeeId : null;
    const validFrom = dateOnly(newValue?.validFrom);
    if (!newValue || !employeeId || !validFrom || !row.entityId) return [];
    if (source === "BULK_APPLY") {
      if (!appliedIds?.includes(employeeId) || validFrom !== effectiveFrom) return [];
    } else if (newValue.type !== "FIXED_SCHEDULE" || !monthFirsts.has(validFrom)) {
      return [];
    }
    return [{ row, newValue, employeeId, validFrom, workScheduleId: row.entityId }];
  });
  if (candidates.length === 0) return [];

  // Tenant membership: ids only, never names.
  const inTenant = new Set(
    (
      await prisma.employee.findMany({
        where: { tenantId: input.tenantId, id: { in: candidates.map((c) => c.employeeId) } },
        select: { id: true },
      })
    ).map((e) => e.id),
  );

  return candidates
    .filter((c) => inTenant.has(c.employeeId))
    .map((c) => {
      const oldValue = asRecord(c.row.oldValue);
      const oldHours = oldValue ? hoursOf(oldValue) : null;
      const newHours = hoursOf(c.newValue);
      const flags: string[] = [];
      if (oldHours && !hoursEqual(oldHours, newHours)) flags.push("HOURS_CHANGED");
      if (!oldHours) flags.push("NO_PREVIOUS_CONTRACT");
      if (c.validFrom < atLocalDate) flags.push("RETROACTIVE");
      if (input.configUserId === null) flags.push("ACTOR_UNKNOWN");
      return {
        configAuditId: input.configAuditId,
        at: input.configAt,
        tenantId: input.tenantId,
        employeeId: c.employeeId,
        workScheduleId: c.workScheduleId,
        validFrom: c.validFrom,
        oldHours,
        newHours,
        source,
        flags,
      };
    });
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
