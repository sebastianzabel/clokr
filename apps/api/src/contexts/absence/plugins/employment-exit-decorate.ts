import fp from "fastify-plugin";
import type { Prisma } from "@clokr/db";
import {
  afterEmploymentExit,
  applyEmploymentExit,
  planEmploymentExit,
  type EmploymentExitAuditPort,
  type EmploymentExitInput,
  type EmploymentExitPlan,
  type EmploymentExitResult,
} from "../employment-exit";

/**
 * Issue #614 (D-01/D-02) — hands the employment-exit rule of Abwesenheiten to the Unterbau route
 * `DELETE /api/v1/employees/:id` WITHOUT an import.
 *
 * Two constraints force a decoration, exactly as for `vacation-balance-decorate.ts` (Issue #451
 * D-07): the Unterbau (`contexts/platform/**`) never imports a new symbol from a business context,
 * and `employment-exit.ts` imports `../working-time-account` and `./leave-days`, both members of
 * the 22-module absence/scheduling/time-tracking/working-time-account import cycle — an
 * `index.ts` re-export would pull the module into that cycle. `app.ts` imports this plugin
 * directly (the documented composition-root exception), so registering it adds no cross-context
 * import edge: this file is never reachable from `contexts/absence/index.ts`.
 *
 * The three functions are the three phases of the contract in `employment-exit.ts`: `plan` before
 * the anonymization transaction, `apply` inside it, `afterCommit` after it (reactive, never throws).
 */
declare module "fastify" {
  interface FastifyInstance {
    absenceExit: {
      plan: (input: EmploymentExitInput) => Promise<EmploymentExitPlan>;
      apply: (
        tx: Prisma.TransactionClient,
        plan: EmploymentExitPlan,
        audit: EmploymentExitAuditPort,
      ) => Promise<EmploymentExitResult>;
      afterCommit: (result: EmploymentExitResult) => Promise<void>;
    };
  }
}

export const employmentExitDecoratePlugin = fp(async (app) => {
  app.decorate("absenceExit", {
    plan: (input: EmploymentExitInput) => planEmploymentExit(app.prisma, input, app.log),
    apply: (
      tx: Prisma.TransactionClient,
      plan: EmploymentExitPlan,
      audit: EmploymentExitAuditPort,
    ) => applyEmploymentExit(tx, plan, audit),
    afterCommit: (result: EmploymentExitResult) => afterEmploymentExit(app, result),
  });
});
