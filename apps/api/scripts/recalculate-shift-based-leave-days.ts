/**
 * Operator script — Issue #417 repair (the sibling script the Issue #416 TODO in
 * backfill-missing-vacation-entitlements.ts pointed at).
 *
 * Root cause (Issue #417, fully diagnosed before this script, owner decision 2026-09-29,
 * supersedes Phase 107 D-06): `countShiftBasedLeaveDays()` used to count a SHIFT_BASED
 * employee's vacation days against the ROSTER. A Salon never plans a vacation day as a shift, so
 * both orderings of request-vs-roster-planning could end at `days: 0` — the statutory
 * entitlement was never actually consumed. Day counting is now BY CONTRACT
 * (`countShiftBasedLeaveDays()` in `contexts/absence/vacation-calc.ts`, reached here through
 * `resolveLeaveDays()`), roster-independent. This script finds every existing SHIFT_BASED
 * VACATION `LeaveRequest` whose stored `days` (or `daysProvisional` flag) disagrees with what
 * that function would compute TODAY, and corrects it.
 *
 * Scope (binding, per this issue's AC):
 *   - Only `LeaveType.code === "VACATION"` requests of SHIFT_BASED employees (the only schedule
 *     type `countShiftBasedLeaveDays()` applies to at all).
 *   - Only `status: PENDING` or `status: APPROVED` (deletedAt: null) — a REJECTED/CANCELLED
 *     request never consumed the entitlement and needs no correction; CANCELLATION_REQUESTED is
 *     out of scope for this script (documented decision, Issue #417 comment) — its request stays
 *     APPROVED-adjacent but is a live cancellation workflow this script does not touch.
 *   - PENDING requests are corrected DIRECTLY (`days`/`daysProvisional` updated in place,
 *     `UPDATE` audit) — nothing has been booked against the entitlement yet, mirroring
 *     `PATCH /requests/:id`'s own own write shape for a still-pending edit.
 *   - APPROVED requests are corrected ONLY through the same reverse-old/apply-new booking pair
 *     `PATCH /requests/:id/correct` uses (Phase 94), producing a `LEAVE_CORRECTED` audit —
 *     NEVER a silent field overwrite. A request whose full date range touches a locked month is
 *     SKIPPED and reported (`locked: true`) — never edited in place, mirroring the correction
 *     route's own 409 refusal (CLAUDE.md "Immutability after lock").
 *
 * Invariants:
 *   - NEVER hard-deletes or bypasses soft-delete (Revisionssicherheit per CLAUDE.md) — only
 *     `LeaveRequest.days`/`daysProvisional` are updated, and only for rows this script's own
 *     query selected.
 *   - Every write is audited (`UPDATE` for PENDING, `LEAVE_CORRECTED` for APPROVED) with the
 *     old/new `days` pair, mirroring `backfill-missing-vacation-entitlements.ts`'s own dry-run /
 *     --confirm / reporting shape for consistency across the two Issue #416/#417 sibling scripts.
 *   - Requires explicit tenant scope: --tenant-id OR --all-tenants (no silent default).
 *   - No PII in dry-run output — employeeNumber only.
 *   - Idempotent by construction: a request whose stored `days`/`daysProvisional` already match
 *     the by-contract value is not a candidate at all (not even re-audited).
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
 *     scripts/recalculate-shift-based-leave-days.ts \
 *     ( --tenant-id <uuid> | --all-tenants ) \
 *     [--status PENDING|APPROVED] \
 *     [--request-id <uuid> ...] \
 *     [--confirm] \
 *     [--help]
 *
 * Without --confirm: dry-run (default) — lists every candidate with old vs. new days, writes
 *                     nothing.
 * With    --confirm: corrects PENDING rows directly, corrects APPROVED rows via the reverse/
 *                     apply booking pair + LEAVE_CORRECTED audit, skips (and reports) any
 *                     APPROVED row touching a locked month.
 *
 *                     Since Issue #436 (week-union pricing across sibling VACATION requests),
 *                     `--confirm` on an APPROVED row is ALSO the (non-silent, audited) way an
 *                     already-approved SHIFT_BASED request's stored `days` gets corrected under
 *                     the week-union rule, not only under the original Issue #417 contract-vs-
 *                     roster rule this script was written for. An operator reaching for
 *                     `--confirm` to resolve an Issue #417-flavoured Bestand case now ALSO
 *                     re-prices every APPROVED SHIFT_BASED VACATION request this process finds
 *                     under the week-union rule in the same pass — review the dry-run list
 *                     first. See `docs/adr/0001-abweichungen.md` Nachtrag Phase 436, WR-02.
 *
 * --status PENDING|APPROVED: restricts scanning to that single status (default: both, the
 *                             existing scope). Any other value throws a German error.
 * --request-id <uuid>:       repeatable — restricts scanning to those specific requests (ANDed
 *                             with --status when both are given). Issue #425: lets the owner
 *                             identify affected requests via dry-run before deciding on a
 *                             correction pass.
 */
import { PrismaClient, Prisma } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import {
  resolveLeaveDays,
  getHolidayMap,
  deductVacationDays,
  reverseVacationDays,
} from "../src/contexts/absence";
import { computeAffectedMonths } from "../src/contexts/absence/correction-lock";
import {
  isMonthClosed,
  recalculateSnapshots,
  monthRangeUtc,
  getTenantTimezone,
} from "../src/contexts/working-time-account";

const CORRECTION_REASON = "Nachberechnung Urlaubstage nach Vertrag (Issue #417)";

// ── Exported types ──────────────────────────────────────────────────────────
export type CliArgs = {
  tenantId: string | null;
  allTenants: boolean;
  status: "PENDING" | "APPROVED" | null;
  requestIds: string[];
  /** Issue #481 (D-09): optional explicit cut-off; requests ending before it are skipped. */
  before: Date | null;
  confirm: boolean;
  help: boolean;
};

export type Candidate = {
  leaveRequestId: string;
  employeeId: string;
  tenantId: string;
  employeeNumber: string;
  status: "PENDING" | "APPROVED";
  oldDays: number;
  newDays: number;
  oldProvisional: boolean | null;
};

export type Summary = {
  dryRun: boolean;
  tenantsScanned: number;
  requestsScanned: number;
  candidates: Candidate[];
  correctedPending: number;
  correctedApproved: number;
  skippedLocked: Array<{ leaveRequestId: string; employeeId: string; reason: string }>;
  /** Issue #481 (D-09): would-be candidates left untouched as imported pre-tracking data. */
  skippedPreTracking: Array<{ leaveRequestId: string; employeeId: string; reason: string }>;
  /** Issue #481 (D-09): employees with no tracked day — the exclusion cannot apply (fail-open). */
  employeesWithoutTrackedDay: string[];
  errors: Array<{ leaveRequestId: string; employeeId: string; error: string }>;
};

const USAGE = `
Usage:
  DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \\
    scripts/recalculate-shift-based-leave-days.ts \\
    ( --tenant-id <uuid> | --all-tenants ) \\
    [--status PENDING|APPROVED] \\
    [--request-id <uuid> ...] \\
    [--before <YYYY-MM-DD>] \\
    [--confirm] \\
    [--help]

Without --confirm: dry-run (default) — lists candidates (old vs. new days), writes nothing.
With    --confirm: corrects PENDING rows directly; corrects APPROVED rows via the same
                    reverse/apply booking pair PATCH /requests/:id/correct uses, with a
                    LEAVE_CORRECTED audit; skips (and reports) any APPROVED row whose period
                    touches a locked month.

Scope:
  - SHIFT_BASED employees' VACATION requests only (PENDING or APPROVED, not soft-deleted).
  - Idempotent: a request whose stored days/daysProvisional already match the by-contract
    value is not touched.
  - --status PENDING|APPROVED restricts scanning to that single status (default: both).
  - --request-id <uuid> is repeatable and restricts scanning to those specific requests
    (ANDed with --status when both are given).

Pre-tracking exclusion (Issue #481, D-09):
  - A would-be candidate that ends before the employee's first tracked day (first
    non-deleted time entry) is imported pre-tracking data: listed as [SKIPPED-PRE-TRACKING]
    and never repriced, in dry-run and with --confirm.
  - --before <YYYY-MM-DD> additionally skips every would-be candidate ending before that date.
  - An employee without any tracked day cannot be excluded this way; the run prints one
    [NOTE] line for them — review those requests (--request-id / --before) before --confirm.
`;

// ── CLI parsing ─────────────────────────────────────────────────────────────
export function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "tenant-id": { type: "string" },
      "all-tenants": { type: "boolean", default: false },
      status: { type: "string" },
      "request-id": { type: "string", multiple: true },
      before: { type: "string" },
      confirm: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  const rawStatus = values.status;
  if (rawStatus !== undefined && rawStatus !== "PENDING" && rawStatus !== "APPROVED") {
    throw new Error(`Ungültiger --status Wert: "${rawStatus}" (erlaubt: PENDING, APPROVED).`);
  }

  let before: Date | null = null;
  if (values.before !== undefined) {
    const raw = values.before;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
    if (!d || d.toISOString().slice(0, 10) !== raw) {
      throw new Error(`Ungültiger --before Wert: "${raw}" (erwartet YYYY-MM-DD).`);
    }
    before = d;
  }

  return {
    tenantId: values["tenant-id"] ?? null,
    allTenants: Boolean(values["all-tenants"]),
    status: rawStatus ?? null,
    requestIds: values["request-id"] ?? [],
    before,
    confirm: Boolean(values.confirm),
    help: Boolean(values.help),
  };
}

// ── Main entry point ─────────────────────────────────────────────────────────
export async function main(argv: string[], injectedPrisma?: PrismaClient): Promise<Summary> {
  const args = parseCli(argv);

  if (args.help) {
    console.info(USAGE);
    return {
      dryRun: true,
      tenantsScanned: 0,
      requestsScanned: 0,
      candidates: [],
      correctedPending: 0,
      correctedApproved: 0,
      skippedLocked: [],
      skippedPreTracking: [],
      employeesWithoutTrackedDay: [],
      errors: [],
    };
  }

  if (!args.tenantId && !args.allTenants) {
    throw new Error(
      "Tenant-Auswahl erforderlich: bitte --tenant-id <uuid> ODER --all-tenants angeben.",
    );
  }

  const prisma = injectedPrisma ?? new PrismaClient();
  const ownsPrisma = !injectedPrisma;
  // Duck-typed `FastifyInstance` shim (mirrors migrate-opening-balances.ts's own `appShim`) —
  // recalculateSnapshots() only reads `.prisma` and logs via `.log`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const appShim: any = {
    prisma,
    log: {
      warn: (...a: unknown[]) => console.warn(...a),
      info: (...a: unknown[]) => console.info(...a),
    },
  };

  try {
    const summary: Summary = {
      dryRun: !args.confirm,
      tenantsScanned: 0,
      requestsScanned: 0,
      candidates: [],
      correctedPending: 0,
      correctedApproved: 0,
      skippedLocked: [],
      skippedPreTracking: [],
      employeesWithoutTrackedDay: [],
      errors: [],
    };

    const tenants = args.allTenants
      ? await prisma.tenant.findMany({ select: { id: true } })
      : [{ id: args.tenantId! }];
    summary.tenantsScanned = tenants.length;

    // Issue #481 (D-09): first non-deleted time entry per employee — the data-derived marker of
    // tracking start (no tracking-start field exists; OpeningBalance.effectiveFrom is not
    // universal). One query per scanned employee, cached for the run.
    const firstTrackedDayCache = new Map<string, Date | null>();
    const firstTrackedDay = async (tenantId: string, employeeId: string): Promise<Date | null> => {
      if (!firstTrackedDayCache.has(employeeId)) {
        const first = await prisma.timeEntry.findFirst({
          where: { employeeId, deletedAt: null, employee: { tenantId } },
          orderBy: { date: "asc" },
          select: { date: true },
        });
        firstTrackedDayCache.set(employeeId, first?.date ?? null);
      }
      return firstTrackedDayCache.get(employeeId) ?? null;
    };

    for (const t of tenants) {
      const requests = await prisma.leaveRequest.findMany({
        where: {
          deletedAt: null,
          status: args.status ?? { in: ["PENDING", "APPROVED"] },
          leaveType: { tenantId: t.id, code: "VACATION" },
          employee: {
            tenantId: t.id,
            workSchedules: { some: { type: "SHIFT_BASED" } },
          },
          ...(args.requestIds.length > 0 ? { id: { in: args.requestIds } } : {}),
        },
        include: {
          employee: { select: { id: true, employeeNumber: true, tenantId: true } },
        },
      });

      for (const req of requests) {
        summary.requestsScanned++;
        try {
          // Deliberate SCAN scope: only employees whose CURRENT WorkSchedule is SHIFT_BASED (the
          // "some" filter above is a coarse pre-filter). Since Issue #481 the PRICE of every
          // request comes from the contract valid at the time inside resolveLeaveDays(), so a
          // schedule-type change since booking is no longer misinterpreted there.
          const ws = await prisma.workSchedule.findFirst({
            where: { employeeId: req.employeeId },
            orderBy: { validFrom: "desc" },
            select: { type: true },
          });
          if (ws?.type !== "SHIFT_BASED") continue;

          const holidayMap = await getHolidayMap(
            prisma,
            t.id,
            req.employeeId,
            req.startDate,
            req.endDate,
          );
          const holidays = new Set(holidayMap.keys());
          // Issue #436 (D-04/D-09): since this issue, the dry-run also lists requests whose
          // stored days predate the week-union rule (the Bestand list) — excluding the request
          // itself, so it is never priced against its own stored dates.
          const recomputed = await resolveLeaveDays(
            prisma,
            req.employeeId,
            t.id,
            req.startDate,
            req.endDate,
            req.halfDay,
            holidays,
            { mode: "request", leaveTypeCode: "VACATION", excludeRequestId: req.id },
          );

          const oldDays = Number(req.days);
          const newDays = recomputed.days;
          // Issue #417: daysProvisional is never true for the by-contract value — a stored
          // `true` is itself a sign this row predates the fix, even when the number already
          // happens to match (e.g. a request whose only fragment week was always a whole week).
          const isCandidate = newDays !== oldDays || req.daysProvisional === true;
          if (!isCandidate) continue;

          // Issue #481 (D-09): imported pre-tracking data is never repriced — checked before
          // anything is listed as a candidate or written, in dry-run AND with --confirm.
          const tracked = await firstTrackedDay(t.id, req.employeeId);
          let skipReason: string | null = null;
          if (tracked && req.endDate.getTime() < tracked.getTime()) {
            skipReason = `Endet vor dem ersten erfassten Arbeitstag (${tracked.toISOString().slice(0, 10)}) – Vorlauf/Import, wird nicht neu bepreist`;
          } else if (args.before && req.endDate.getTime() < args.before.getTime()) {
            skipReason = `Endet vor --before ${args.before.toISOString().slice(0, 10)} – wird nicht neu bepreist`;
          }
          if (!tracked && !summary.employeesWithoutTrackedDay.includes(req.employeeId)) {
            summary.employeesWithoutTrackedDay.push(req.employeeId);
            console.info(
              `[NOTE] employeeId=${req.employeeId} (${req.employee.employeeNumber}) – kein erfasster ` +
                `Arbeitstag: Vorlauf-Ausschluss nicht anwendbar, Anträge vor --confirm prüfen ` +
                `(--request-id / --before)`,
            );
          }
          if (skipReason) {
            summary.skippedPreTracking.push({
              leaveRequestId: req.id,
              employeeId: req.employeeId,
              reason: skipReason,
            });
            console.info(
              `[SKIPPED-PRE-TRACKING] leaveRequestId=${req.id} employeeId=${req.employeeId} ` +
                `(${req.employee.employeeNumber}) days ${oldDays} -> ${newDays} — ${skipReason}`,
            );
            continue;
          }

          summary.candidates.push({
            leaveRequestId: req.id,
            employeeId: req.employeeId,
            tenantId: t.id,
            employeeNumber: req.employee.employeeNumber,
            status: req.status as "PENDING" | "APPROVED",
            oldDays,
            newDays,
            oldProvisional: req.daysProvisional,
          });

          if (!args.confirm) {
            console.info(
              `[DRY-RUN] ${req.status} — leaveRequestId=${req.id} employeeId=${req.employeeId} ` +
                `(${req.employee.employeeNumber}) days ${oldDays} -> ${newDays} ` +
                `(daysProvisional ${req.daysProvisional} -> false)`,
            );
            continue;
          }

          // ── --confirm ────────────────────────────────────────────────────────────────
          if (req.status === "PENDING") {
            // Nothing has been booked against the entitlement yet — a direct field update,
            // mirroring PATCH /requests/:id's own write shape for a still-pending edit.
            await prisma.$transaction(async (tx) => {
              await tx.leaveRequest.update({
                where: { id: req.id },
                data: { days: newDays, daysProvisional: false },
              });
              await tx.auditLog.create({
                data: {
                  userId: null, // system-initiated (no human actor)
                  action: "UPDATE",
                  entity: "LeaveRequest",
                  entityId: req.id,
                  oldValue: { days: oldDays, daysProvisional: req.daysProvisional },
                  newValue: {
                    days: newDays,
                    daysProvisional: false,
                    reason: CORRECTION_REASON,
                  },
                  userAgent: "script:recalculate-shift-based-leave-days",
                },
              });
            });
            summary.correctedPending++;
            console.info(
              `[APPLIED] PENDING corrected — leaveRequestId=${req.id} days ${oldDays} -> ${newDays}`,
            );
            continue;
          }

          // ── APPROVED: locked-month guard first (never edit a locked month in place) ──────
          // The date range itself is UNCHANGED (only `days` moves) — mirrors leave.ts's own
          // WR-94-01 "note-only edit" handling: force the full retained range into the
          // affected-months check via typeChanged:true, since a same-range diff would
          // otherwise report zero affected months and skip the lock check entirely.
          const affectedMonths = computeAffectedMonths({
            oldStart: req.startDate,
            oldEnd: req.endDate,
            newStart: req.startDate,
            newEnd: req.endDate,
            typeChanged: true,
            halfDayChanged: false,
          });
          const tz = await getTenantTimezone(prisma, t.id);
          let locked = false;
          for (const { year, month } of affectedMonths) {
            const { start: monthStart } = monthRangeUtc(year, month, tz);
            if (await isMonthClosed(prisma, req.employeeId, t.id, monthStart)) {
              locked = true;
              break;
            }
          }
          if (locked) {
            summary.skippedLocked.push({
              leaveRequestId: req.id,
              employeeId: req.employeeId,
              reason: "Gesperrter Monat — Korrektur nicht möglich, manuelle Prüfung erforderlich",
            });
            console.info(
              `[SKIPPED-LOCKED] leaveRequestId=${req.id} employeeId=${req.employeeId} — locked month in range`,
            );
            continue;
          }

          // Reverse the OLD booking, apply the NEW one — same pair PATCH /requests/:id/correct
          // uses for a same-type, same-date correction (Phase 94-02 recalc model).
          await prisma.$transaction(async (tx) => {
            await reverseVacationDays(
              tx,
              req.employeeId,
              req.leaveTypeId,
              req.startDate,
              req.endDate,
              oldDays,
              holidays,
              t.id,
            );
            const updated = await tx.leaveRequest.update({
              where: { id: req.id },
              data: { days: newDays, daysProvisional: false },
            });
            await deductVacationDays(
              tx,
              req.employeeId,
              req.leaveTypeId,
              req.startDate,
              req.endDate,
              newDays,
              holidays,
              t.id,
            );
            await tx.auditLog.create({
              data: {
                userId: null, // system-initiated (no human actor)
                action: "LEAVE_CORRECTED",
                entity: "LeaveRequest",
                entityId: req.id,
                oldValue: { days: oldDays, daysProvisional: req.daysProvisional },
                newValue: {
                  days: Number(updated.days),
                  daysProvisional: false,
                  auditReason: CORRECTION_REASON,
                },
                userAgent: "script:recalculate-shift-based-leave-days",
              },
            });
          });

          // Saldo-Recalc AFTER the transaction commits — mirrors PATCH /requests/:id/correct's
          // own post-transaction recalculateSnapshots() call; a failure here is logged, never
          // fatal to the loop (matches that route's own non-blocking error handling).
          await recalculateSnapshots(appShim, req.employeeId, req.startDate).catch(
            (err: unknown) => {
              console.error(
                `[WARN] recalculateSnapshots failed for employeeId=${req.employeeId}: ` +
                  `${err instanceof Error ? err.message : String(err)}`,
              );
            },
          );

          summary.correctedApproved++;
          console.info(
            `[APPLIED] APPROVED corrected — leaveRequestId=${req.id} days ${oldDays} -> ${newDays}`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          summary.errors.push({
            leaveRequestId: req.id,
            employeeId: req.employeeId,
            error: message,
          });
          console.error(`[ERROR] leaveRequestId=${req.id}: ${message}`);
        }
      }
    }

    if (!args.confirm) {
      console.info(
        `\nSummary: ${summary.candidates.length} candidate(s) found ` +
          `(${summary.candidates.filter((c) => c.status === "PENDING").length} PENDING, ` +
          `${summary.candidates.filter((c) => c.status === "APPROVED").length} APPROVED), ` +
          `${summary.skippedPreTracking.length} skipped (Vorlauf/--before). ` +
          `Re-run with --confirm to write.`,
      );
    } else {
      console.info(
        `\nDone: ${summary.correctedPending} PENDING corrected, ${summary.correctedApproved} ` +
          `APPROVED corrected, ${summary.skippedLocked.length} skipped (locked month), ` +
          `${summary.skippedPreTracking.length} skipped (Vorlauf/--before), ` +
          `${summary.errors.length} error(s).`,
      );
    }

    return summary;
  } finally {
    if (ownsPrisma) {
      await prisma.$disconnect();
    }
  }
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────
const isMain =
  typeof require !== "undefined" && typeof module !== "undefined" && require.main === module;

if (isMain) {
  (async () => {
    if (process.argv.includes("--help")) {
      await main(process.argv.slice(2));
      process.exit(0);
    }

    if (!process.env.DATABASE_URL) {
      console.error("DATABASE_URL is required");
      process.exit(1);
    }

    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new PrismaPg(pool as any);
    const prisma = new PrismaClient({ adapter });

    try {
      await main(process.argv.slice(2), prisma);
    } catch (err) {
      console.error((err as Error).message ?? err);
      process.exit(1);
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }
  })();
}

// Re-exported so the type checker catches a Prisma schema drift in this script's own query
// shape (mirrors backfill-missing-vacation-entitlements.ts's own unused-import guard pattern).
export type { Prisma };
