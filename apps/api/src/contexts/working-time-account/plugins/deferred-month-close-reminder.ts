import fp from "fastify-plugin";
import cron, { type ScheduledTask } from "node-cron";
import { withAdvisoryLock, ADVISORY_LOCK_KEYS } from "../../../utils/with-advisory-lock";
import { getDeferredMonthCloseState, type DeferredMonthCloseState } from "../deferred-month-close";
import {
  MONTH_CLOSE_DEFERRAL_RELATED_TYPE,
  monthCloseDeepLink,
  monthLabelDe,
} from "../month-close-notification";
import {
  userIdsHoldingPermission,
  resolveScopedHolderIds,
  isStammsalonScopeMatch,
} from "../../platform"; // Phase 75b Plan 10 (#75), D-16; Phase 91b Plan 09 (#91), D-10/D-17
import { getTenantTimezone, monthRangeUtc } from "../timezone";

declare module "fastify" {
  interface FastifyInstance {
    /** Phase 292 (#292) — exposed for tests; the cron calls exactly this. */
    remindDeferredMonthClose: () => Promise<void>;
  }
}

/**
 * Weekly escalation for a Monatsabschluss that stays deferred (GitHub issue #292).
 *
 * ── Why a second, slower sender next to the daily cron ───────────────────────────────────────
 * `auto-close-month.ts` reports an EVENT: "this month could not be closed in this run". It fires
 * while the state is created. Measured on a production tenant (2026-09-21), four employees had
 * been unclosed since 31.05. — four months — and nothing in the product said so: the daily
 * message had been repeating the same sentence every morning since June, naming the wrong month
 * (the ceiling of the backfill range) and linking to a page that opens on the current one. A
 * message that says the same thing 120 times is not an escalation, it is wallpaper.
 *
 * This plugin reports the STATE and its AGE instead, and that is what changes over time.
 *
 * ── The cadence, and why it is weekly ────────────────────────────────────────────────────────
 * Mondays, 07:00 Europe/Berlin — one working-week cycle.
 *
 *   - NOT daily. Daily is what the code did before (`notify()` has no deduplication and the
 *     blocked set is rebuilt on every run), and it is precisely the habituation the issue names:
 *     a reminder you dismiss every morning is invisible by the second week.
 *   - NOT monthly. The unit of drift here IS a month: one unclosed month becomes two before a
 *     monthly reminder has fired twice. A signal must be denser than the thing it tracks, so a
 *     backlog cannot grow by a whole step between two signals.
 *   - Weekly gives roughly four signals per month of drift — enough that the SEVERITY visibly
 *     rises between two of them, few enough to stay readable. Monday is when the salon week is
 *     planned, and correcting a missing clock-out is a task for the week, not for the shift.
 *
 * Urgency grows with AGE, not with frequency: {@link severityForMonthsBehind} maps months behind
 * to INFO / WARNING / CRITICAL, and only the wording and the ArbZG reference change with it. A
 * reminder that also got MORE FREQUENT with age would end up back at daily, which is where this
 * started.
 *
 * ── What it never does ───────────────────────────────────────────────────────────────────────
 * It closes nothing, writes no `TimeEntry`, and does not touch `closeMonthWithGapsAllowed`. It
 * is a reporter: a month with gaps stays open until a human resolves the gaps
 * (`apps/api/src/__tests__/deferred-month-close.test.ts` pins both).
 */
export const deferredMonthCloseReminderPlugin = fp(async (app) => {
  const tasks: ScheduledTask[] = [];

  function buildMessage(state: DeferredMonthCloseState): string {
    const oldest = state.oldestOpenMonth ? monthLabelDe(state.oldestOpenMonth) : "unbekannt";
    const head =
      state.employeeCount === 1
        ? `Für 1 Mitarbeiter ist der Monatsabschluss überfällig.`
        : `Für ${state.employeeCount} Mitarbeiter ist der Monatsabschluss überfällig.`;
    const age =
      state.monthsBehind === 1
        ? `Ältester offener Monat: ${oldest} (1 Monat Rückstand).`
        : `Ältester offener Monat: ${oldest} (${state.monthsBehind} Monate Rückstand).`;
    const gaps =
      state.gapCount > 0
        ? `${state.gapCount} fehlende Tageseinträge blockieren den Abschluss.`
        : `Es wurden keine fehlenden Tageseinträge gefunden — bitte den Monat im Monatsabschluss prüfen.`;
    const rows = state.employees
      .slice(0, 10)
      .map((e) => {
        const month = monthLabelDe(e.oldestOpenMonth);
        const detail =
          e.gapCount > 0
            ? `${e.gapCount} fehlende Tage: ${e.gapDates.join(", ")}`
            : "keine Lücken gefunden";
        return `${e.employeeName} — offen seit ${month} (${e.monthsBehind} Monate), ${detail}`;
      })
      .join("\n");
    const more =
      state.employees.length > 10 ? `\n… und ${state.employees.length - 10} weitere.` : "";
    const law =
      state.severity === "CRITICAL"
        ? "\n\nHinweis: Der Arbeitszeitnachweis ist nach § 16 Abs. 2 ArbZG aufzubewahren. Ein Monat ohne Abschluss ist nicht bestätigt."
        : "";
    return `${head} ${age}\n${gaps}\n\n${rows}${more}${law}`;
  }

  function buildTitle(state: DeferredMonthCloseState): string {
    const oldest = state.oldestOpenMonth ? monthLabelDe(state.oldestOpenMonth) : "";
    switch (state.severity) {
      case "CRITICAL":
        return `Dringend: Monatsabschluss seit ${oldest} offen`;
      case "WARNING":
        return `Monatsabschluss überfällig — offen seit ${oldest}`;
      default:
        return `Monatsabschluss offen — ${oldest}`;
    }
  }

  async function remindDeferredMonthClose() {
    const now = new Date();
    const tenants = await app.prisma.tenant.findMany({ select: { id: true, name: true } });

    for (const tenant of tenants) {
      try {
        const state = await getDeferredMonthCloseState(app.prisma, tenant.id, {
          now,
          detailed: true,
        });
        if (state.employeeCount === 0 || state.oldestOpenMonth === null) continue;

        // Phase 75b Plan 10 (#75), D-16: holders of month-close:close replace the legacy A,M
        // role predicate — the recorded recipient set is unchanged.
        const monthCloseCloseHolderIds = await userIdsHoldingPermission(
          app.prisma,
          tenant.id,
          "month-close:close:ZUGEWIESEN",
        );
        // Phase 91b Plan 09 (Issue #91), D-10/D-17: this reminder is a tenant-wide AGGREGATE
        // across every employee behind on Monatsabschluss (`state.employees`), not one single
        // employee — a holder is kept if their reach covers AT LEAST ONE of the affected
        // employees' Stammsalon, Stichtag = the aggregate's own oldest open month's end (one
        // Stichtag for the whole batch, the same single-Stichtag simplification D-10's list
        // routes already use).
        const tz = await getTenantTimezone(app.prisma, tenant.id);
        const stichtag = state.oldestOpenMonth
          ? monthRangeUtc(state.oldestOpenMonth.year, state.oldestOpenMonth.month, tz).end
          : now;
        const scopedMonthCloseCloseHolderIds = await resolveScopedHolderIds(
          app.prisma,
          tenant.id,
          monthCloseCloseHolderIds,
          "month-close:close:ZUGEWIESEN",
          async (reach) => {
            for (const e of state.employees) {
              if (
                await isStammsalonScopeMatch(app.prisma, tenant.id, reach, e.employeeId, stichtag)
              ) {
                return true;
              }
            }
            return false;
          },
        );
        const recipients = await app.prisma.employee.findMany({
          where: {
            tenantId: tenant.id,
            user: { isActive: true, id: { in: scopedMonthCloseCloseHolderIds } },
          },
          select: { user: { select: { id: true } } },
        });

        const title = buildTitle(state);
        const message = buildMessage(state);
        const link = monthCloseDeepLink(state.oldestOpenMonth);
        // The relatedId changes when the oldest open month or the severity changes, so an
        // escalation that has GROWN is never swallowed by an older, still-undismissed row.
        const relatedId = `${tenant.id}:${state.oldestOpenMonth.year}-${String(
          state.oldestOpenMonth.month,
        ).padStart(2, "0")}:${state.severity}`;

        for (const r of recipients) {
          await app.notify({
            userId: r.user.id,
            type: "MONTH_CLOSE_DEFERRED",
            title,
            message,
            link,
            tenantId: tenant.id,
            relatedType: MONTH_CLOSE_DEFERRAL_RELATED_TYPE,
            relatedId,
          });
        }

        app.log.warn(
          {
            tenant: tenant.id,
            employeeCount: state.employeeCount,
            monthsBehind: state.monthsBehind,
            severity: state.severity,
          },
          "Monatsabschluss-Eskalation: zurückgestellte Monate gemeldet",
        );
      } catch (err) {
        // One tenant's failure must not abort the escalation for every later tenant (D-04 parity).
        app.log.error(
          { err, tenant: tenant.id },
          "Monatsabschluss-Eskalation: Mandant fehlgeschlagen, fahre fort",
        );
      }
    }
  }

  app.decorate("remindDeferredMonthClose", remindDeferredMonthClose);

  // Mondays 07:00 Berlin — one hour after the daily Monatsabschluss run, so the state the
  // escalation reports is the one this morning's run left behind, not yesterday's.
  const task = cron.schedule(
    "0 7 * * 1",
    () => {
      withAdvisoryLock(
        app.prisma,
        ADVISORY_LOCK_KEYS.MONTH_CLOSE_DEFERRAL_REMINDER,
        () => remindDeferredMonthClose(),
        app.log,
      ).catch((err) => app.log.error({ err }, "Monatsabschluss-Eskalation fehlgeschlagen"));
    },
    { timezone: "Europe/Berlin", noOverlap: true },
  );
  tasks.push(task);
  app.log.info("Monatsabschluss-Eskalation: Wöchentliche Prüfung geplant (Mo 07:00)");

  app.addHook("onClose", () => {
    tasks.forEach((t) => void t.stop());
  });
});
