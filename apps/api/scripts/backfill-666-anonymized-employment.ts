/**
 * Bestandskorrektur — Issue #666 (follow-up of #614, owner decision 17.10.2026: options 1 AND 2).
 *
 * Since Issue #614 a DSGVO anonymization ends the employment (exit date, absences after it ended)
 * and KEEPS the employee number. Persons anonymized by an EARLIER release were handled by the old
 * rules: no exit date, absences standing on, the number overwritten with "GELÖSCHT-<number>".
 * `audit-614-anonymized-employment.ts` lists them; this script corrects them.
 *
 * What it does per DSGVO-anonymized employee (sentinel `ANONYMIZED_EMPLOYEE_WHERE`, deactivated
 * tenants included — retention does not end with the contract):
 *
 *   1. Exit date. Only when it is EMPTY: the tenant-local calendar day of the person's (first)
 *      ANONYMIZE audit row, stored as UTC midnight like the route stores it. An existing exit
 *      date, past or future, is never moved. A person without an exit date AND without an
 *      ANONYMIZE audit row has no decidable exit day: reported `exitDate=unknown`, nothing is
 *      written for that person's exit.
 *   2. The exit rule. EXACTLY the rule a new anonymization runs — `contexts/absence/employment-exit.ts`
 *      through the `app.absenceExit` decoration (plan -> apply inside the transaction -> after
 *      commit). There is no copy of the rule here: absences starting after the exit day are
 *      cancelled, spanning ones shortened, Berufsschule days after it soft-deleted; closed months,
 *      active § 17 BEEG reductions and cases the correction core refuses are skipped and listed
 *      (ids and codes). Setting the exit date also runs the #447 exit-year entitlement sync.
 *   3. Employee number. Restored from `oldValue.employeeNumber` of the ANONYMIZE audit row when the
 *      employee row still carries the pre-614 overwrite ("GELÖSCHT-…"). No usable oldValue ->
 *      `NO_OLD_VALUE`, the number stays overwritten and the id is reported. The restored number
 *      already belongs to ANOTHER employee of the tenant -> `COLLISION`, nothing is written.
 *      Legal basis of keeping it: § 41 EStG / § 147 AO, Art. 17 Abs. 3 lit. b DSGVO (the payroll
 *      office assigns corrections of old months by the DATEV `pnr`).
 *
 * Revisionssicherheit: every write is audited (userId absent = system, before/after values, no free
 * text) with `trigger: "BACKFILL_666"` and `auditReason: "Bestandskorrektur #666"`. Closed months
 * stay sum-identical (the exit rule never touches them). One transaction per person; a failure for
 * one person is reported and does not stop the others. Idempotent: a second run plans no write for
 * an already corrected person.
 *
 * DRY RUN is the default (writes ZERO rows). `--confirm` writes. `--tenant <id>` narrows the run.
 * The output carries tenant ids, employee ids, request/absence ids, dates, counts and codes only —
 * never a name, an employee number or an e-mail address (DSGVO).
 *
 * Operator step: dry run, read it, `--confirm`, then `audit-614-anonymized-employment.ts` again on
 * int and prod (docs/migrations.md, "Phase 666").
 *
 * Usage:
 *   pnpm --filter @clokr/api exec tsx scripts/backfill-666-anonymized-employment.ts [--tenant <id>] [--confirm] [--help]
 *   (from /app/apps/api in the runtime image with the entrypoint overridden, see the runbook)
 *
 * Exit codes: 0 — done (skips are not failures); 1 — usage error, DATABASE_URL missing, or at
 * least one person failed.
 */
import type { FastifyInstance } from "fastify";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { ANONYMIZED_EMPLOYEE_WHERE } from "../src/contexts/platform/employee-anonymization-filter";
import { dateStrInTz, getTenantTimezone } from "../src/contexts/working-time-account";
import {
  anonymizeSection9CreditsForEmployee,
  syncExitYearVacationEntitlement,
} from "../src/contexts/absence";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;

/** The machine marker and the German display reason written to every audit row of this run. */
export const BACKFILL_MARKER = {
  auditReason: "Bestandskorrektur #666",
  trigger: "BACKFILL_666",
} as const;

/** The prefix the pre-614 anonymization wrote into the employee number. */
const OVERWRITTEN_NUMBER_PREFIX = "GELÖSCHT-";

export type ExitDatePlan =
  { kind: "set"; day: string } | { kind: "keep"; day: string } | { kind: "unknown" };

export type NumberPlan = "restore" | "none" | "collision" | "no-oldValue";

export type PersonResult = {
  tenantId: string;
  employeeId: string;
  exitDate: ExitDatePlan;
  number: NumberPlan;
  cancelled: number;
  shortened: number;
  deleted: number;
  skipped: { entity: string; id: string; reason: string }[];
  /** `planned` = dry run would write; `written`; `unchanged` = nothing to write; `failed:<CODE>`. */
  outcome: string;
};

export type BackfillOptions = { confirm: boolean; tenantId?: string };

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const utcMidnight = (day: string): Date => new Date(`${day}T00:00:00Z`);

function oldNumberOf(oldValue: unknown): string | null {
  if (typeof oldValue !== "object" || oldValue === null) return null;
  const value = (oldValue as Record<string, unknown>).employeeNumber;
  return typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith(OVERWRITTEN_NUMBER_PREFIX)
    ? value
    : null;
}

type Candidate = {
  id: string;
  tenantId: string;
  employeeNumber: string;
  exitDate: Date | null;
};

/** What one person needs, decided from reads only. */
type PersonPlan = {
  candidate: Candidate;
  exitDate: ExitDatePlan;
  /** The exit day the rule runs with: the stored one or the audit-derived one; null = unknown. */
  exitDay: Date | null;
  number: NumberPlan;
  restoredNumber: string | null;
};

async function planPerson(app: FastifyInstance, candidate: Candidate): Promise<PersonPlan> {
  const audits = await app.prisma.auditLog.findMany({
    where: { action: "ANONYMIZE", entity: "Employee", entityId: candidate.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { createdAt: true, oldValue: true },
  });

  let exitDate: ExitDatePlan;
  let exitDay: Date | null;
  if (candidate.exitDate) {
    // A stored exit date is read with the convention that wrote it: its UTC calendar day.
    const day = candidate.exitDate.toISOString().slice(0, 10);
    exitDate = { kind: "keep", day };
    exitDay = utcMidnight(day);
  } else if (audits.length > 0) {
    const tz = await getTenantTimezone(app.prisma, candidate.tenantId);
    const day = dateStrInTz(audits[0].createdAt, tz);
    exitDate = { kind: "set", day };
    exitDay = utcMidnight(day);
  } else {
    exitDate = { kind: "unknown" };
    exitDay = null;
  }

  let number: NumberPlan = "none";
  let restoredNumber: string | null = null;
  if (candidate.employeeNumber.startsWith(OVERWRITTEN_NUMBER_PREFIX)) {
    restoredNumber = audits.map((a) => oldNumberOf(a.oldValue)).find((n) => n !== null) ?? null;
    if (restoredNumber === null) {
      number = "no-oldValue";
    } else {
      const taken = await app.prisma.employee.findFirst({
        where: {
          tenantId: candidate.tenantId,
          employeeNumber: restoredNumber,
          id: { not: candidate.id },
        },
        select: { id: true },
      });
      number = taken ? "collision" : "restore";
    }
  }
  return { candidate, exitDate, exitDay, number, restoredNumber };
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
    select: { id: true, tenantId: true, employeeNumber: true, exitDate: true },
  });
  candidates.sort((a, b) => compareStrings(a.tenantId, b.tenantId) || compareStrings(a.id, b.id));

  const results: PersonResult[] = [];
  for (const candidate of candidates) {
    const base = { tenantId: candidate.tenantId, employeeId: candidate.id };
    try {
      const plan = await planPerson(app, candidate);
      const exitPlan = plan.exitDay
        ? await app.absenceExit.plan({
            tenantId: candidate.tenantId,
            employeeId: candidate.id,
            exitDay: plan.exitDay,
            marker: BACKFILL_MARKER,
          })
        : null;
      const planned = (exitPlan?.actions.length ?? 0) > 0;
      const cancelled = exitPlan?.actions.filter((a) => a.kind === "cancelLeave").length ?? 0;
      const deleted = exitPlan?.actions.filter((a) => a.kind === "deleteAbsence").length ?? 0;
      const shortened = (exitPlan?.actions.length ?? 0) - cancelled - deleted;
      const skipped = exitPlan?.skipped ?? [];
      const writes = planned || plan.exitDate.kind === "set" || plan.number === "restore";
      const result: PersonResult = {
        ...base,
        exitDate: plan.exitDate,
        number: plan.number,
        cancelled,
        shortened,
        deleted,
        skipped,
        outcome: writes ? "planned" : "unchanged",
      };

      if (options.confirm && writes && exitPlan && plan.exitDay) {
        const exitDay = plan.exitDay;
        const held: { applied?: Awaited<ReturnType<FastifyInstance["absenceExit"]["apply"]>> } = {};
        let numberWritten: NumberPlan = plan.number;
        await app.prisma.$transaction(async (tx) => {
          // 1. The exit rule, exactly as the anonymization route runs it.
          const applied = (held.applied = await app.absenceExit.apply(tx, exitPlan, (entry) =>
            app.audit({
              tx,
              action: entry.action,
              entity: entry.entity,
              entityId: entry.entityId,
              oldValue: entry.oldValue,
              newValue: entry.newValue,
            }),
          ));
          // A correction credit written by a shortening carries a reason: swept like the route's
          // PII sweep does (Phase 104, D-26). Only when a shortening ran, so no other row is touched.
          if (applied.shortened.length > 0) {
            await anonymizeSection9CreditsForEmployee(tx, candidate.id);
          }

          // 2. The employee row, re-read inside the transaction: what changed meanwhile wins.
          const current = await tx.employee.findUniqueOrThrow({
            where: { id: candidate.id },
            select: { tenantId: true, exitDate: true, employeeNumber: true },
          });
          const data: { exitDate?: Date; employeeNumber?: string } = {};
          const oldValue: Record<string, string | null> = {};
          const newValue: Record<string, string | null> = {};
          const setExit = plan.exitDate.kind === "set" && current.exitDate === null;
          if (setExit) {
            data.exitDate = exitDay;
            oldValue.exitDate = null;
            newValue.exitDate = plan.exitDate.kind === "set" ? plan.exitDate.day : null;
          }
          numberWritten = "none";
          if (plan.number === "restore" && plan.restoredNumber !== null) {
            const stillOverwritten = current.employeeNumber.startsWith(OVERWRITTEN_NUMBER_PREFIX);
            const taken = await tx.employee.findFirst({
              where: {
                tenantId: current.tenantId,
                employeeNumber: plan.restoredNumber,
                id: { not: candidate.id },
              },
              select: { id: true },
            });
            if (taken) {
              numberWritten = "collision";
            } else if (stillOverwritten) {
              data.employeeNumber = plan.restoredNumber;
              oldValue.employeeNumber = current.employeeNumber;
              newValue.employeeNumber = plan.restoredNumber;
              numberWritten = "restore";
            }
          } else {
            numberWritten = plan.number;
          }
          if (Object.keys(data).length > 0) {
            await tx.employee.update({ where: { id: candidate.id }, data });
            await app.audit({
              tx,
              action: "UPDATE",
              entity: "Employee",
              entityId: candidate.id,
              oldValue,
              newValue: { ...newValue, ...BACKFILL_MARKER },
            });
          }

          // 3. The #447 exit-year entitlement sync, as after a new anonymization.
          if (setExit) {
            await syncExitYearVacationEntitlement(
              tx,
              candidate.id,
              candidate.tenantId,
              exitDay.getUTCFullYear(),
              (entry) =>
                app.audit({
                  tx,
                  action: entry.action,
                  entity: "LeaveEntitlement",
                  entityId: entry.entityId,
                  oldValue: entry.oldValue,
                  newValue: { ...(entry.newValue as object | undefined), ...BACKFILL_MARKER },
                }),
            );
          }
        });
        result.number = numberWritten;
        result.outcome = "written";
        if (held.applied) await app.absenceExit.afterCommit(held.applied);
      }
      results.push(result);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      results.push({
        ...base,
        exitDate: { kind: "unknown" },
        number: "none",
        cancelled: 0,
        shortened: 0,
        deleted: 0,
        skipped: [],
        outcome: `failed:${typeof code === "string" ? code : ((err as Error).name ?? "ERROR")}`,
      });
    }
  }
  return results;
}

export function formatResult(r: PersonResult): string {
  const exitDate =
    r.exitDate.kind === "unknown" ? "unknown" : `${r.exitDate.kind}:${r.exitDate.day}`;
  const skipped =
    r.skipped.length === 0
      ? "none"
      : r.skipped.map((s) => `${s.entity}:${s.id}:${s.reason}`).join(",");
  return (
    `tenant=${r.tenantId} employee=${r.employeeId} exitDate=${exitDate} number=${r.number} ` +
    `cancelled=${r.cancelled} shortened=${r.shortened} deleted=${r.deleted} skipped=${skipped} ` +
    `result=${r.outcome}`
  );
}

export function formatTotals(results: PersonResult[]): string {
  const count = (pred: (r: PersonResult) => boolean) => results.filter(pred).length;
  return (
    `Totals: employees=${results.length} exitDateSet=${count((r) => r.exitDate.kind === "set")} ` +
    `exitDateUnknown=${count((r) => r.exitDate.kind === "unknown")} ` +
    `numberRestore=${count((r) => r.number === "restore")} ` +
    `numberCollision=${count((r) => r.number === "collision")} ` +
    `numberNoOldValue=${count((r) => r.number === "no-oldValue")} ` +
    `cancelled=${results.reduce((n, r) => n + r.cancelled, 0)} ` +
    `shortened=${results.reduce((n, r) => n + r.shortened, 0)} ` +
    `deleted=${results.reduce((n, r) => n + r.deleted, 0)} ` +
    `skipped=${results.reduce((n, r) => n + r.skipped.length, 0)} ` +
    `failed=${count((r) => r.outcome.startsWith("failed"))}`
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
  pnpm --filter @clokr/api exec tsx scripts/backfill-666-anonymized-employment.ts [--tenant <id>] [--confirm] [--help]

Corrects the Bestand of DSGVO-anonymized persons (Issue #666): sets the missing exit date (tenant-local
day of the ANONYMIZE audit), runs the #614 exit rule (cancel / shorten / soft-delete absences after it),
restores the employee number from the ANONYMIZE audit where it is still available.

  (none)     Dry run: prints the plan per person, writes ZERO rows.
  --confirm  Writes, one transaction per person; every write is audited (BACKFILL_666).
  --tenant   Restrict to one tenant id.

Ids, dates, counts and codes only - never a name or an employee number.
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
