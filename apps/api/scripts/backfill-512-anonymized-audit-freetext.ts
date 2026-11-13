/**
 * Bestandskorrektur - Issue #512 (follow-up of #718/#774).
 *
 * Since Issue #512 a DSGVO anonymization redacts the person-authored free text inside the AuditLog
 * old/new values of the person (type-based, `redactAuditFreeTextOfPerson()`). Persons anonymized by
 * an EARLIER release still carry those texts in audit rows that name them (`employeeId` in the
 * payload). This script runs the very same function for them; there is no second rule here.
 *
 * Limit: rows AUTHORED by the anonymized user cannot be found any more (their userId was already
 * set to null at anonymization), so only rows naming the employee are reached.
 *
 * DRY RUN is the default: the function runs inside a transaction that is rolled back, so the counts
 * are exactly what `--confirm` would redact and ZERO rows stay written. `--confirm` commits, one
 * transaction per person, with one audit row per person that had anything to redact
 * (`trigger: "BACKFILL_512"`, `auditReason: "Bestandskorrektur #512"`, counts only). Idempotent. A
 * failure for one person is reported and does not stop the others. `--tenant <id>` narrows the run.
 * Deactivated tenants are included. Output: ids and counts only (DSGVO).
 *
 * Usage:
 *   pnpm --filter @clokr/api exec tsx scripts/backfill-512-anonymized-audit-freetext.ts [--tenant <id>] [--confirm] [--help]
 *
 * Exit codes: 0 - done; 1 - usage error, DATABASE_URL missing, or at least one person failed.
 */
import type { FastifyInstance } from "fastify";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { ANONYMIZED_EMPLOYEE_WHERE } from "../src/contexts/platform/employee-anonymization-filter";
import {
  redactAuditFreeTextOfPerson,
  type AuditRedactionResult,
} from "../src/contexts/platform/audit-freetext-redaction";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;

export const BACKFILL_MARKER = {
  auditReason: "Bestandskorrektur #512",
  trigger: "BACKFILL_512",
} as const;

export type PersonResult = {
  tenantId: string;
  employeeId: string;
  redaction: AuditRedactionResult;
  /** `planned` = dry run would redact; `written`; `unchanged`; `failed:<CODE>`. */
  outcome: string;
};

export type BackfillOptions = { confirm: boolean; tenantId?: string };

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const EMPTY: AuditRedactionResult = { rowsScanned: 0, rowsRedacted: 0 };

/** Thrown inside the dry-run transaction to roll it back after the counts were taken. */
class DryRunRollback extends Error {
  constructor(readonly redaction: AuditRedactionResult) {
    super("dry run rollback");
  }
}

/** Runs the backfill. Exported for the test, which injects the test app. */
export async function runBackfill(
  app: FastifyInstance,
  options: BackfillOptions,
): Promise<PersonResult[]> {
  const candidates = await app.prisma.employee.findMany({
    where: {
      AND: [ANONYMIZED_EMPLOYEE_WHERE, options.tenantId ? { tenantId: options.tenantId } : {}],
    },
    select: { id: true, tenantId: true },
  });
  candidates.sort((a, b) => compareStrings(a.tenantId, b.tenantId) || compareStrings(a.id, b.id));

  const results: PersonResult[] = [];
  for (const candidate of candidates) {
    const base = { tenantId: candidate.tenantId, employeeId: candidate.id };
    try {
      let redaction: AuditRedactionResult;
      if (options.confirm) {
        redaction = await app.prisma.$transaction(async (tx) => {
          const counts = await redactAuditFreeTextOfPerson(tx, {
            employeeId: candidate.id,
            userId: null,
          });
          if (counts.rowsRedacted > 0) {
            await app.audit({
              tx,
              action: "UPDATE",
              entity: "Employee",
              entityId: candidate.id,
              newValue: { auditRowsRedacted: counts.rowsRedacted, ...BACKFILL_MARKER },
            });
          }
          return counts;
        });
      } else {
        try {
          await app.prisma.$transaction(async (tx) => {
            throw new DryRunRollback(
              await redactAuditFreeTextOfPerson(tx, { employeeId: candidate.id, userId: null }),
            );
          });
          throw new Error("unreachable");
        } catch (err) {
          if (!(err instanceof DryRunRollback)) throw err;
          redaction = err.redaction;
        }
      }
      results.push({
        ...base,
        redaction,
        outcome:
          redaction.rowsRedacted === 0 ? "unchanged" : options.confirm ? "written" : "planned",
      });
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      results.push({
        ...base,
        redaction: EMPTY,
        outcome: `failed:${typeof code === "string" ? code : ((err as Error).name ?? "ERROR")}`,
      });
    }
  }
  return results;
}

export function formatResult(r: PersonResult): string {
  return (
    `tenant=${r.tenantId} employee=${r.employeeId} auditRowsScanned=${r.redaction.rowsScanned} ` +
    `auditRowsRedacted=${r.redaction.rowsRedacted} result=${r.outcome}`
  );
}

export function formatTotals(results: PersonResult[]): string {
  return (
    `Totals: employees=${results.length} ` +
    `withFindings=${results.filter((r) => r.redaction.rowsRedacted > 0).length} ` +
    `auditRowsRedacted=${results.reduce((n, r) => n + r.redaction.rowsRedacted, 0)} ` +
    `failed=${results.filter((r) => r.outcome.startsWith("failed")).length}`
  );
}

export type CliArgs = { help: boolean; confirm: boolean; tenant: string | undefined };

export function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", default: false },
      confirm: { type: "boolean", default: false },
      tenant: { type: "string" },
    },
    strict: true,
  });
  return { help: Boolean(values.help), confirm: Boolean(values.confirm), tenant: values.tenant };
}

export const USAGE = `
Usage:
  pnpm --filter @clokr/api exec tsx scripts/backfill-512-anonymized-audit-freetext.ts [--tenant <id>] [--confirm] [--help]

Redacts, by type, the free text inside the AuditLog old/new values of persons anonymized BEFORE
Issue #512 (rows that name the employee; rows authored by the person cannot be found any more).
Same function as the anonymization.

  (none)     Dry run: counts per person, writes ZERO rows.
  --confirm  Writes, one transaction per person; one audit row per person (BACKFILL_512, counts only).
  --tenant   Restrict to one tenant id.

Ids and counts only - never a text.
Exit codes: 0 done, 1 usage error / DATABASE_URL missing / a person failed.
`;

export async function main(argv: string[], injectedApp?: FastifyInstance): Promise<number> {
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
  if (!injectedApp && !process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    return EXIT_ERROR;
  }

  const app = injectedApp ?? (await (await import("../src/app")).buildApp());
  try {
    if (!injectedApp) await app.ready();
    const results = await runBackfill(app, { confirm: args.confirm, tenantId: args.tenant });
    for (const result of results) console.info(formatResult(result));
    console.info(formatTotals(results));
    console.info(args.confirm ? "Written (--confirm)." : "Dry run: this run wrote nothing.");
    return results.some((r) => r.outcome.startsWith("failed")) ? EXIT_ERROR : EXIT_OK;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return EXIT_ERROR;
  } finally {
    if (!injectedApp) await app.close();
  }
}

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
