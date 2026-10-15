/**
 * Operator support reads (Issue #93, D-05, D-06, D-11, D-18, D-19, D-24).
 *
 *   GET /employees                          the curated employee list of one tenant (no e-mail, birth date,
 *                                           NFC id or address)
 *   GET /employees/:employeeId/month        one employee's month: entries, breaks, leave, absences, figures
 *   GET /employees/:employeeId/contracts    one employee's contract history
 *
 * Mounted at `/api/v1/operator/tenants/:id/support`; `:id` is the tenant. This plugin registers GET
 * routes only (D-05): a write method here would be a write path for the operator into tenant data. Every
 * route is guarded by `requireOperator` and opens only with an active grant of THIS operator for THIS
 * tenant. Every reply of the plugin, refusals and 404s included, carries `Cache-Control: private,
 * no-store` (D-11).
 *
 * Tenant data comes in through the `ports` option that the composition root fills
 * (`composition/operator-support-ports.ts`): the Unterbau must not import a business context and this
 * file reads no person model itself (D-24).
 *
 * A read is audit-first and fail-closed (D-06, D-19). `runSupportRead` asks the one decider before it
 * opens a transaction, then asks it again inside the transaction with `lockGrant`, which holds the grant
 * row under a share lock: a grant that ends while the read waits is refused there, and the refusal is
 * logged instead of a read. Only then are the two read records written, and the transaction commits
 * BEFORE the data is read. If the audit write fails, nothing is read.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../../../../config";
import { requireOperator } from "../../operator-auth";
import {
  assertActiveSupportAccess,
  recordSupportAccessRefused,
  writeSupportReadAudit,
} from "../../support-access";
import type { OperatorSupportPorts, SupportReadCategory } from "../../support-access-types";

export interface OperatorSupportRoutesOptions {
  ports: OperatorSupportPorts;
}

const readRateLimit = {
  rateLimit: { max: config.NODE_ENV === "test" ? 1000 : 60, timeWindow: "1 minute" },
};

const tenantParamSchema = z.object({ id: z.string().uuid() });

const employeeParamSchema = z.object({ employeeId: z.string().uuid() });

/** `YYYY-MM`, month 01-12, year 2000-2100 (a bound that keeps `Date` year arithmetic out of 1900s aliasing). */
const monthQuerySchema = z
  .object({
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Monat muss das Format JJJJ-MM haben")
      .refine((value) => {
        const year = Number(value.slice(0, 4));
        return year >= 2000 && year <= 2100;
      }, "Jahr außerhalb des unterstützten Bereichs"),
  })
  .strict();

const TENANT_NOT_FOUND = { error: "Mandant nicht gefunden" };
const EMPLOYEE_NOT_FOUND = { error: "Mitarbeiter nicht gefunden" };

/** The two refusals of a read, keyed by the decider's status; bodies are exactly `{ error, code }`. */
const SUPPORT_REFUSALS = {
  REQUIRED: {
    status: 403,
    body: {
      error: "Für diesen Mandanten besteht kein aktiver Support-Zugriff.",
      code: "SUPPORT_ACCESS_REQUIRED",
    },
  },
  TENANT_DEACTIVATED: {
    status: 409,
    body: {
      error: "Der Mandant ist deaktiviert. Ein Support-Zugriff ist nicht möglich.",
      code: "TENANT_DEACTIVATED",
    },
  },
} as const;

type RefusalKey = keyof typeof SUPPORT_REFUSALS;

/** What one read records about itself in both audit logs (the control values, never display text). */
interface SupportReadSpec {
  category: SupportReadCategory;
  employeeId?: string;
  month?: string;
  filters?: Record<string, unknown>;
}

type AuditPhase =
  | { kind: "REFUSED"; key: RefusalKey }
  | { kind: "TENANT_NOT_FOUND" }
  | { kind: "EMPLOYEE_NOT_FOUND" }
  | { kind: "RECORDED" };

export async function operatorSupportRoutes(
  app: FastifyInstance,
  opts: OperatorSupportRoutesOptions,
) {
  // D-11: nothing a support route answers may be cached by the browser or a proxy.
  app.addHook("onSend", async (_req, reply) => {
    reply.header("Cache-Control", "private, no-store");
  });

  /** A refused read is logged in its own transaction and answered with the fixed refusal body. */
  async function refuse(
    req: FastifyRequest,
    reply: FastifyReply,
    tenantId: string,
    key: RefusalKey,
  ) {
    const refusal = SUPPORT_REFUSALS[key];
    await recordSupportAccessRefused(app.prisma, {
      operatorId: req.operator.sub,
      tenantId,
      method: req.method,
      route: req.routeOptions.url ?? req.url,
      code: refusal.body.code,
      request: req,
    });
    return reply.code(refusal.status).send(refusal.body);
  }

  /**
   * The ONE way a support route reads tenant data (D-19). Order: decider -> `prepare()` (the route's
   * own input validation, deliberately AFTER the grant decision so an operator without a grant gets the
   * 403, never a validation answer) -> audit transaction (decider again under the grant's share lock,
   * optional employee existence check, both read records) -> commit -> `read()` outside any
   * transaction. A refusal found inside the transaction writes no read record. A `ZodError` thrown by
   * `prepare()` is a 400 through the global handler and writes no read record.
   */
  async function runSupportRead<I, T>(
    req: FastifyRequest,
    reply: FastifyReply,
    prepare: () => { spec: SupportReadSpec; input: I },
    read: (tenantId: string, input: I) => Promise<T>,
  ): Promise<T | FastifyReply> {
    const { id: tenantId } = tenantParamSchema.parse(req.params);
    const operatorId = req.operator.sub;

    const first = await assertActiveSupportAccess(app.prisma, { tenantId, operatorId });
    if (first.status === "TENANT_NOT_FOUND") return reply.code(404).send(TENANT_NOT_FOUND);
    if (first.status === "TENANT_DEACTIVATED") {
      return refuse(req, reply, tenantId, "TENANT_DEACTIVATED");
    }
    if (first.status === "REQUIRED") return refuse(req, reply, tenantId, "REQUIRED");

    const { spec, input } = prepare();

    const audited = await app.prisma.$transaction(
      async (tx): Promise<AuditPhase> => {
        const recheck = await assertActiveSupportAccess(tx, { tenantId, operatorId }, new Date(), {
          lockGrant: true,
        });
        if (recheck.status === "TENANT_NOT_FOUND") return { kind: "TENANT_NOT_FOUND" };
        if (recheck.status !== "OK") return { kind: "REFUSED", key: recheck.status };

        if (
          spec.employeeId !== undefined &&
          !(await opts.ports.employeeExists(tx, tenantId, spec.employeeId))
        ) {
          return { kind: "EMPLOYEE_NOT_FOUND" };
        }

        await writeSupportReadAudit(app, tx, {
          operatorId,
          tenantId,
          accessId: recheck.accessId,
          newValue: {
            category: spec.category,
            employeeId: spec.employeeId,
            month: spec.month,
            filters: spec.filters,
            reason: recheck.reason,
          },
          request: req,
        });
        return { kind: "RECORDED" };
      },
      { timeout: 15_000, maxWait: 15_000 },
    );

    switch (audited.kind) {
      case "TENANT_NOT_FOUND":
        return reply.code(404).send(TENANT_NOT_FOUND);
      case "EMPLOYEE_NOT_FOUND":
        return reply.code(404).send(EMPLOYEE_NOT_FOUND);
      case "REFUSED":
        return refuse(req, reply, tenantId, audited.key);
      case "RECORDED":
        return read(tenantId, input);
    }
  }

  // GET /api/v1/operator/tenants/:id/support/employees
  app.get("/employees", {
    config: readRateLimit,
    schema: {
      tags: ["Betreiber"],
      description:
        "Curated employee list of one tenant, only under an active support access; every read is logged twice.",
    },
    preHandler: requireOperator,
    handler: async (req, reply) =>
      runSupportRead(
        req,
        reply,
        () => ({ spec: { category: "EMPLOYEES" }, input: undefined }),
        async (tenantId) => ({ items: await opts.ports.listEmployees(app, tenantId) }),
      ),
  });

  // GET /api/v1/operator/tenants/:id/support/employees/:employeeId/month?month=YYYY-MM
  app.get("/employees/:employeeId/month", {
    config: readRateLimit,
    schema: {
      tags: ["Betreiber"],
      description:
        "Month of one employee (entries, breaks, leave, absences, figures) without free text, documents or attests, only under an active support access; every read is logged twice.",
    },
    preHandler: requireOperator,
    handler: async (req, reply) =>
      runSupportRead(
        req,
        reply,
        () => {
          const { employeeId } = employeeParamSchema.parse(req.params);
          const { month } = monthQuerySchema.parse(req.query);
          return {
            spec: { category: "EMPLOYEE_MONTH", employeeId, month },
            input: {
              employeeId,
              month,
              year: Number(month.slice(0, 4)),
              monthIndex: Number(month.slice(5, 7)),
            },
          };
        },
        async (tenantId, input) =>
          opts.ports.employeeMonth(app, {
            tenantId,
            employeeId: input.employeeId,
            year: input.year,
            month: input.monthIndex,
          }),
      ),
  });

  // GET /api/v1/operator/tenants/:id/support/employees/:employeeId/contracts
  app.get("/employees/:employeeId/contracts", {
    config: readRateLimit,
    schema: {
      tags: ["Betreiber"],
      description:
        "Contract history of one employee (newest first), only under an active support access; every read is logged twice.",
    },
    preHandler: requireOperator,
    handler: async (req, reply) =>
      runSupportRead(
        req,
        reply,
        () => {
          const { employeeId } = employeeParamSchema.parse(req.params);
          return { spec: { category: "CONTRACTS", employeeId }, input: { employeeId } };
        },
        async (tenantId, input) => ({
          items: await opts.ports.employeeContracts(app, {
            tenantId,
            employeeId: input.employeeId,
          }),
        }),
      ),
  });
}
