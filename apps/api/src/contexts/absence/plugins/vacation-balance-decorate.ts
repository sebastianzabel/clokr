import fp from "fastify-plugin";
import { getVacationBalance, vacationBalanceForRow } from "../facade/vacation-balance";

/**
 * Issue #451 (D-07, 451-08) — hands the Resturlaub facade to the composition layer WITHOUT an
 * `contexts/absence/index.ts` re-export.
 *
 * `facade/vacation-balance.ts` imports `../leave-days`, which is already a member of the
 * pre-existing absence/scheduling/time-tracking/working-time-account import cycle (it imports
 * `../time-tracking` for other, unrelated readers). An `index.ts` re-export of
 * `getVacationBalance`/`vacationBalanceForRow` would close
 * `index.ts -> facade/vacation-balance.ts -> leave-days.ts -> ... -> index.ts`, pulling the facade
 * itself into that cycle — the SAME shape `plugins/carryover-warning.ts` avoided for
 * `runCarryoverWarningOnce` (see that file's module header). `composition/dashboard.ts` and
 * `composition/reports.ts` are the only callers outside this context; both already receive `app`
 * in their route handlers, so they read the facade via this decoration
 * (`app.getVacationBalance(...)` / `app.vacationBalanceForRow(...)`) instead of an import —
 * mirroring the existing `app.audit()` / `app.notify()` pattern. `app.ts` imports this plugin
 * directly (the documented composition-root exception), so registering it adds no new
 * cross-context import edge: this file is never reachable from `contexts/absence/index.ts`.
 *
 * Both decorated functions are thin, `app.prisma`-bound wrappers — the facade functions
 * themselves keep their pinned `db: Prisma.TransactionClient`-first signature
 * (`lint:facade-signatures`), unaware that Fastify exists.
 */
declare module "fastify" {
  interface FastifyInstance {
    getVacationBalance: (
      employeeId: string,
      tenantId: string,
      year: number,
      now: Date,
    ) => ReturnType<typeof getVacationBalance>;
    vacationBalanceForRow: (
      row: Parameters<typeof vacationBalanceForRow>[1],
      tenantId: string,
      now: Date,
      opts?: Parameters<typeof vacationBalanceForRow>[4],
    ) => ReturnType<typeof vacationBalanceForRow>;
  }
}

export const vacationBalanceDecoratePlugin = fp(async (app) => {
  app.decorate("getVacationBalance", (employeeId, tenantId, year, now) =>
    getVacationBalance(app.prisma, employeeId, tenantId, year, now),
  );
  app.decorate("vacationBalanceForRow", (row, tenantId, now, opts) =>
    vacationBalanceForRow(app.prisma, row, tenantId, now, opts),
  );
});
