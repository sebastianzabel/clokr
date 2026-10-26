/**
 * Bestandskorrektur — Issue #774 (follow-up of #718).
 *
 * Since Issue #718 a DSGVO anonymization also clears LeaveRequest.reviewNote, RetroEntryRequest
 * .reason (replaced by a neutral text, required column) and .reviewNote, OvertimePlan.note,
 * Shift.note and EmployeeAvailability.note. Persons anonymized by an EARLIER release still carry
 * those texts. `audit-388-anonymized-leftovers.ts` lists them; this script clears them.
 *
 * There is NO second clearing rule here: the script calls the very helpers
 * `anonymizeEmployeeData()` calls (`anonymizeLeaveRequestsForEmployee`, `clearEntryNotesForEmployee`,
 * `clearOvertimePlanNotesForEmployee`, `clearSchedulingNotesForEmployee`), per person, inside one
 * transaction. The kept texts (SaldoSnapshot.note / supersededReason, OpeningBalance texts, § 147 AO)
 * are not touched, because the helpers do not touch them.
 *
 * DRY RUN is the default: the same helpers run inside a transaction that is rolled back, so the
 * counts are exactly what `--confirm` would clear and ZERO rows stay written. `--confirm` commits,
 * one transaction per person, with one audit row per person that had anything to clear
 * (`trigger: "BACKFILL_774"`, `auditReason: "Bestandskorrektur #774"`, counts only, never text).
 * Idempotent: a second run finds nothing and writes nothing. A failure for one person is reported
 * and does not stop the others. `--tenant <id>` narrows the run. Deactivated tenants are included
 * (retention does not end with the contract). Output: ids and counts only (DSGVO).
 *
 * Usage:
 *   pnpm --filter @clokr/api exec tsx scripts/backfill-774-anonymized-freetext.ts [--tenant <id>] [--confirm] [--help]
 *
 * Exit codes: 0 — done; 1 — usage error, DATABASE_URL missing, or at least one person failed.
 */
import type { FastifyInstance } from "fastify";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { ANONYMIZED_EMPLOYEE_WHERE } from "../src/contexts/platform/employee-anonymization-filter";
import { anonymizeLeaveRequestsForEmployee } from "../src/contexts/absence";
import { clearEntryNotesForEmployee } from "../src/contexts/time-tracking";
import { clearOvertimePlanNotesForEmployee } from "../src/contexts/working-time-account";
import { clearSchedulingNotesForEmployee } from "../src/contexts/scheduling";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;

/** The machine marker and the German display reason written to every audit row of this run. */
export const BACKFILL_MARKER = {
  auditReason: "Bestandskorrektur #774",
  trigger: "BACKFILL_774",
} as const;

export type ClearedFreeText = {
  leaveReviewNotes: number;
  retroReasons: number;
  retroReviewNotes: number;
  overtimePlanNotes: number;
  shiftNotes: number;
  availabilityNotes: number;
};

export type PersonResult = {
  tenantId: string;
  employeeId: string;
  cleared: ClearedFreeText;
  /** `planned` = dry run would clear; `written`; `unchanged` = nothing to clear; `failed:<CODE>`. */
  outcome: string;
};

export type BackfillOptions = { confirm: boolean; tenantId?: string };

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const sum = (c: ClearedFreeText): number =>
  c.leaveReviewNotes +
  c.retroReasons +
  c.retroReviewNotes +
  c.overtimePlanNotes +
  c.shiftNotes +
  c.availabilityNotes;

/** Thrown inside the dry-run transaction to roll it back after the counts were taken. */
class DryRunRollback extends Error {
  constructor(readonly cleared: ClearedFreeText) {
    super("dry run rollback");
  }
}

type Tx = Parameters<Parameters<FastifyInstance["prisma"]["$transaction"]>[0]>[0];

/** The one clearing step: the same helpers, in the same order, as `anonymizeEmployeeData()`. */
async function clearFreeText(tx: Tx, employeeId: string): Promise<ClearedFreeText> {
  const retro = await clearEntryNotesForEmployee(tx, employeeId);
  const leaveReviewNotes = await anonymizeLeaveRequestsForEmployee(tx, employeeId);
  const overtimePlanNotes = await clearOvertimePlanNotesForEmployee(tx, employeeId);
  const scheduling = await clearSchedulingNotesForEmployee(tx, employeeId);
  return { leaveReviewNotes, ...retro, overtimePlanNotes, ...scheduling };
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
      let cleared: ClearedFreeText;
      if (options.confirm) {
        cleared = await app.prisma.$transaction(async (tx) => {
          const counts = await clearFreeText(tx, candidate.id);
          if (sum(counts) > 0) {
            await app.audit({
              tx,
              action: "UPDATE",
              entity: "Employee",
              entityId: candidate.id,
              newValue: { clearedFreeText: counts, ...BACKFILL_MARKER },
            });
          }
          return counts;
        });
      } else {
        try {
          await app.prisma.$transaction(async (tx) => {
            throw new DryRunRollback(await clearFreeText(tx, candidate.id));
          });
          throw new Error("unreachable");
        } catch (err) {
          if (!(err instanceof DryRunRollback)) throw err;
          cleared = err.cleared;
        }
      }
      const any = sum(cleared) > 0;
      results.push({
        ...base,
        cleared,
        outcome: !any ? "unchanged" : options.confirm ? "written" : "planned",
      });
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      results.push({
        ...base,
        cleared: {
          leaveReviewNotes: 0,
          retroReasons: 0,
          retroReviewNotes: 0,
          overtimePlanNotes: 0,
          shiftNotes: 0,
          availabilityNotes: 0,
        },
        outcome: `failed:${typeof code === "string" ? code : ((err as Error).name ?? "ERROR")}`,
      });
    }
  }
  return results;
}

export function formatResult(r: PersonResult): string {
  const c = r.cleared;
  return (
    `tenant=${r.tenantId} employee=${r.employeeId} leaveReviewNotes=${c.leaveReviewNotes} ` +
    `retroReasons=${c.retroReasons} retroReviewNotes=${c.retroReviewNotes} ` +
    `overtimePlanNotes=${c.overtimePlanNotes} shiftNotes=${c.shiftNotes} ` +
    `availabilityNotes=${c.availabilityNotes} result=${r.outcome}`
  );
}

export function formatTotals(results: PersonResult[]): string {
  const total = (pick: (c: ClearedFreeText) => number) =>
    results.reduce((n, r) => n + pick(r.cleared), 0);
  return (
    `Totals: employees=${results.length} ` +
    `withFindings=${results.filter((r) => sum(r.cleared) > 0).length} ` +
    `leaveReviewNotes=${total((c) => c.leaveReviewNotes)} retroReasons=${total((c) => c.retroReasons)} ` +
    `retroReviewNotes=${total((c) => c.retroReviewNotes)} overtimePlanNotes=${total((c) => c.overtimePlanNotes)} ` +
    `shiftNotes=${total((c) => c.shiftNotes)} availabilityNotes=${total((c) => c.availabilityNotes)} ` +
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
  pnpm --filter @clokr/api exec tsx scripts/backfill-774-anonymized-freetext.ts [--tenant <id>] [--confirm] [--help]

Clears the free texts that Issue #718 clears at anonymization, for persons anonymized BEFORE #718
(Issue #774): LeaveRequest.reviewNote, RetroEntryRequest.reason (neutral text) and reviewNote,
OvertimePlan.note, Shift.note, EmployeeAvailability.note. Same helpers as the anonymization.

  (none)     Dry run: counts per person, writes ZERO rows.
  --confirm  Writes, one transaction per person; one audit row per person (BACKFILL_774, counts only).
  --tenant   Restrict to one tenant id.

Ids and counts only - never a text.
Exit codes: 0 done, 1 usage error / DATABASE_URL missing / a person failed.
`;

/**
 * Exported for the test: pass the app to inject a test app (worker test DB only); without one the
 * entrypoint below builds the real app from DATABASE_URL.
 */
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

  // Lazy import: importing this module for a test must not load the whole app.
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

// Run-guard: bootstrap only when invoked as a script, so importing the module is side-effect-free.
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
