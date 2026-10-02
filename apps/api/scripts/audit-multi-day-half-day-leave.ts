/**
 * Audit tool — Issue #449 (Befund G5), D-3.
 *
 * Root cause this script surfaces (fixed at the input side by the same issue, `leave.ts`'s
 * createSchema/updateSchema/correctSchema): a half-day leave request spanning more than one
 * calendar date makes entitlement and saldo disagree. The entitlement booking deducts a flat
 * 0.5 days regardless of range length (`vacation-calc.ts`), while the saldo halves the SALDO
 * MINUTES OF THE WHOLE REQUESTED RANGE (`working-time-account/timezone.ts`) — a half day across
 * e.g. Mon-Fri books 0.5 days of entitlement but halves five days' worth of Soll. The three write
 * paths now reject this combination going forward (D-1); this script lists the EXISTING
 * (Bestand) rows that predate the fix.
 *
 * READ-ONLY. ZERO mutations. There is no write/correction flag anywhere in this file, and none
 * may ever be added: correcting one of these rows runs only through "Antrag korrigieren" after
 * owner approval (issue AC) — a write mode here would contradict that AC and risk running
 * unsupervised against payroll-relevant data. Mirrors `dry-run-429-leave-contract-days.ts`'s own
 * reasoning and `audit-saldo-chain-integrity.ts`'s own DSGVO output convention.
 *
 * Scope: every non-soft-deleted `LeaveRequest` with `halfDay: true` whose `startDate` and
 * `endDate` differ, across ALL statuses (PENDING/APPROVED/REJECTED/CANCELLED/
 * CANCELLATION_REQUESTED) — the owner sees the full Bestand, not just the currently-active rows.
 * Tenant scope is explicit, never a silent default (--tenant-id OR --all-tenants).
 *
 * Output contains ids only — no employee name, no employee number (DSGVO). Full, untruncated
 * UUIDs (unlike `dry-run-429-leave-contract-days.ts`'s `truncId()`): the owner must be able to
 * locate each request directly, e.g. via an admin lookup or a direct DB query.
 *
 * Usage:
 *   DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \
 *     scripts/audit-multi-day-half-day-leave.ts \
 *     ( --tenant-id <uuid> | --all-tenants ) \
 *     [--help]
 *
 * Exit codes:
 *   0 — no multi-day half-day LeaveRequest found for the given scope
 *   1 — DATABASE_URL missing, or a DB connection/query failure
 *   2 — one or more findings (review manually; correction only via "Antrag korrigieren")
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

// ── Exit codes ──────────────────────────────────────────────────────────────
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_FINDINGS = 2;

// ── CLI parsing ───────────────────────────────────────────────────────────────
export type CliArgs = {
  tenantId: string | null;
  allTenants: boolean;
  help: boolean;
};

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

const USAGE = `
Usage:
  DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \\
    scripts/audit-multi-day-half-day-leave.ts \\
    ( --tenant-id <uuid> | --all-tenants ) \\
    [--help]

READ-ONLY — lists every non-deleted LeaveRequest with halfDay:true whose startDate and endDate
differ (Issue #449, D-3). No write/correction flag exists. All statuses are listed.

Exit codes:
  0 — no finding for the given scope
  1 — DATABASE_URL missing, or a DB connection/query failure
  2 — one or more findings (correction only via "Antrag korrigieren")
`;

// ── Finding shape ─────────────────────────────────────────────────────────────
export type Finding = {
  leaveRequestId: string;
  employeeId: string;
  tenantId: string;
  status: string;
  typeCode: string;
  startDate: string; // YYYY-MM-DD, read off the stored @db.Date value (UTC)
  endDate: string;
  days: number;
};

/** Full UUIDs — DSGVO-safe (no name, no employeeNumber), but locatable by the owner. */
export function formatFindingLine(f: Finding): string {
  return (
    `leaveRequestId=${f.leaveRequestId} employeeId=${f.employeeId} tenantId=${f.tenantId} ` +
    `status=${f.status} type=${f.typeCode} start=${f.startDate} end=${f.endDate} days=${f.days}`
  );
}

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── Main entry point ─────────────────────────────────────────────────────────
/**
 * Exported for unit-testability — pass a PrismaClient to inject a test connection (run against
 * the worker test DB only); without one the CLI entrypoint below bootstraps its own connection
 * from DATABASE_URL.
 */
export async function main(argv: string[], injectedPrisma?: PrismaClient): Promise<number> {
  const args = parseCli(argv);

  if (args.help) {
    console.info(USAGE);
    return EXIT_OK;
  }

  if (!args.tenantId && !args.allTenants) {
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
    const tenants = args.allTenants
      ? await prisma.tenant.findMany({ select: { id: true } })
      : [{ id: args.tenantId! }];

    const findings: Finding[] = [];
    const countsByStatus = new Map<string, number>();

    for (const t of tenants) {
      const rows = await prisma.leaveRequest.findMany({
        where: {
          deletedAt: null,
          halfDay: true,
          employee: { tenantId: t.id },
        },
        select: {
          id: true,
          employeeId: true,
          status: true,
          startDate: true,
          endDate: true,
          days: true,
          leaveType: { select: { code: true } },
        },
      });

      for (const row of rows) {
        if (row.startDate.getTime() === row.endDate.getTime()) continue; // single-day — not a finding
        const finding: Finding = {
          leaveRequestId: row.id,
          employeeId: row.employeeId,
          tenantId: t.id,
          status: row.status,
          typeCode: row.leaveType.code,
          startDate: dateOnly(row.startDate),
          endDate: dateOnly(row.endDate),
          days: Number(row.days),
        };
        findings.push(finding);
        countsByStatus.set(finding.status, (countsByStatus.get(finding.status) ?? 0) + 1);
        console.info(formatFindingLine(finding));
      }
    }

    if (findings.length === 0) {
      console.info("No multi-day half-day LeaveRequest found for the given scope.");
    } else {
      const byStatus = Array.from(countsByStatus.entries())
        .map(([status, count]) => `${status}=${count}`)
        .join(", ");
      console.info(
        `\nSummary: ${findings.length} finding(s) across ${tenants.length} tenant(s) (${byStatus}). ` +
          `Correction runs only via "Antrag korrigieren" after owner approval — this script writes nothing.`,
      );
    }

    return findings.length > 0 ? EXIT_FINDINGS : EXIT_OK;
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
