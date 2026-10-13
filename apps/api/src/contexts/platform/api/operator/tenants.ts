/**
 * Operator tenant management (Phase 88, #88, AC-88-05…10, D-04/D-05/D-07/D-09).
 *
 *   GET  /                              all tenants, metadata only
 *   GET  /:id                           one tenant, metadata only
 *   POST /                              create tenant + configuration + default salon + first admin + invitation
 *
 * Every route is guarded by `requireOperator`; a tenant token is refused with 403 and an audit row.
 * Responses carry tenant METADATA only (`toOperatorTenantDto`) plus the ids that provisioning
 * created — never employee lists, counts or other Mandantendaten (owner decision 2026-08-27;
 * support access is #93). The raw invitation token is mailed and never part of any response: whoever
 * holds it sets the first admin's password (T-88-52).
 *
 * Handlers touch the `tenant` model and platform functions only; every other model access lives in
 * `tenant-provisioning.ts` / `tenant-status.ts` / `employee-creation.ts` with a required `tenantId`.
 * Request bodies are parsed with strict zod schemas inside the handler (a JSON schema would run
 * before the guard and answer an unauthenticated caller with a validation error).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { FederalState } from "@clokr/db";
import type { Prisma } from "@clokr/db";
import { config } from "../../../../config";
import { OPERATOR_AUDIT_ACTIONS, recordOperatorAudit } from "../../operator-audit";
import { requireOperator } from "../../operator-auth";
import {
  TenantProvisioningConflictError,
  operatorEmployeeCreationAudit,
  provisionTenantWithAdmin,
} from "../../tenant-provisioning";

export interface OperatorTenantRoutesOptions {
  /**
   * Seam of the composition root: runs inside the tenant-create transaction right after the tenant
   * skeleton exists (default leave types of the absence context). The Unterbau must not import the
   * absence context, so `app.ts` hands it in.
   */
  onTenantCreated?: (tx: Prisma.TransactionClient, tenantId: string) => Promise<void>;
}

const readRateLimit = {
  rateLimit: { max: config.NODE_ENV === "test" ? 1000 : 60, timeWindow: "1 minute" },
};
const mutationRateLimit = {
  rateLimit: { max: config.NODE_ENV === "test" ? 1000 : 20, timeWindow: "1 minute" },
};

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("de-DE", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const createTenantSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    slug: z.string().min(3).max(63).regex(SLUG_PATTERN, "Ungültiger Kurzname"),
    // Required, no default: the Bundesland decides the statutory holidays (#71).
    federalState: z.nativeEnum(FederalState),
    timezone: z.string().min(1).max(100).refine(isValidTimeZone, "Ungültige Zeitzone").optional(),
    admin: z
      .object({
        email: z.string().trim().toLowerCase().email().max(254),
        firstName: z.string().trim().min(1).max(100),
        lastName: z.string().trim().min(1).max(100),
        employeeNumber: z.string().trim().min(1).max(50).optional(),
      })
      .strict(),
  })
  .strict();

const idParamSchema = z.object({ id: z.string().uuid() });

const tenantSelect = {
  id: true,
  name: true,
  slug: true,
  federalState: true,
  createdAt: true,
  deactivatedAt: true,
  deactivatedReason: true,
} satisfies Prisma.TenantSelect;

type TenantMetadataRow = Prisma.TenantGetPayload<{ select: typeof tenantSelect }>;

/** The one operator-facing shape of a tenant: exactly these keys, never more (T-88-51). */
export function toOperatorTenantDto(row: TenantMetadataRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    federalState: row.federalState,
    createdAt: row.createdAt,
    deactivatedAt: row.deactivatedAt,
    deactivatedReason: row.deactivatedReason,
  };
}

const TENANT_NOT_FOUND = { error: "Mandant nicht gefunden" };

export async function operatorTenantRoutes(
  app: FastifyInstance,
  opts: OperatorTenantRoutesOptions,
) {
  // GET /api/v1/operator/tenants
  app.get("/", {
    config: readRateLimit,
    schema: {
      tags: ["Betreiber"],
      description: "All tenants (metadata only), deactivated included.",
    },
    preHandler: requireOperator,
    handler: async () => {
      const rows = await app.prisma.tenant.findMany({
        select: tenantSelect,
        orderBy: [{ name: "asc" }, { id: "asc" }],
      });
      return rows.map(toOperatorTenantDto);
    },
  });

  // GET /api/v1/operator/tenants/:id
  app.get("/:id", {
    config: readRateLimit,
    schema: { tags: ["Betreiber"], description: "One tenant (metadata only)." },
    preHandler: requireOperator,
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const row = await app.prisma.tenant.findUnique({ where: { id }, select: tenantSelect });
      if (!row) return reply.code(404).send(TENANT_NOT_FOUND);
      return toOperatorTenantDto(row);
    },
  });

  // POST /api/v1/operator/tenants
  app.post("/", {
    config: mutationRateLimit,
    schema: {
      tags: ["Betreiber"],
      description:
        "Creates a tenant with configuration, default salon, first admin and invitation in one transaction.",
    },
    preHandler: requireOperator,
    handler: async (req, reply) => {
      const body = createTenantSchema.parse(req.body);
      const operatorId = req.operator.sub;

      let result;
      try {
        result = await app.prisma.$transaction(async (tx) => {
          const provisioned = await provisionTenantWithAdmin(
            tx,
            {
              tenant: {
                name: body.name,
                slug: body.slug,
                federalState: body.federalState,
                timezone: body.timezone,
              },
              admin: body.admin,
              onTenantCreated: opts.onTenantCreated,
            },
            operatorEmployeeCreationAudit(app, { operatorId, request: req }),
          );
          if (provisioned.status !== "OK") return provisioned;

          const dto = toOperatorTenantDto(provisioned.tenant);
          await recordOperatorAudit(tx, {
            action: OPERATOR_AUDIT_ACTIONS.TENANT_CREATED,
            operatorId,
            subjectTenantId: provisioned.tenant.id,
            entity: "Tenant",
            entityId: provisioned.tenant.id,
            newValue: {
              tenant: dto,
              defaultSalonId: provisioned.salon.id,
              adminEmployeeId: provisioned.employee.id,
              adminUserId: provisioned.user.id,
            },
            request: req,
          });
          return { ...provisioned, dto };
        });
      } catch (err) {
        if (err instanceof TenantProvisioningConflictError) {
          return reply.code(409).send(conflictBody(err.status));
        }
        throw err;
      }

      if (result.status === "SLUG_TAKEN" || result.status === "EMAIL_TAKEN") {
        return reply.code(409).send(conflictBody(result.status));
      }
      if (result.status === "INVALID") {
        return reply.code(400).send({ error: result.error });
      }

      // After commit: a failing mail must never undo the tenant. The outcome is reported instead,
      // and a dead-ended invitation is re-issued through POST /:id/resend-admin-invitation.
      let invitationMailSent = true;
      try {
        await app.mailer.sendInvitation({
          to: result.user.email,
          firstName: body.admin.firstName,
          token: result.invitationToken,
          tenantId: result.tenant.id,
        });
      } catch (err) {
        invitationMailSent = false;
        req.log.warn({ err, tenantId: result.tenant.id }, "Operator: invitation mail not sent");
      }

      return reply.code(201).send({
        tenant: result.dto,
        defaultSalonId: result.salon.id,
        adminEmployeeId: result.employee.id,
        invitationMailSent,
      });
    },
  });
}

function conflictBody(status: "SLUG_TAKEN" | "EMAIL_TAKEN") {
  return status === "SLUG_TAKEN"
    ? { error: "Dieser Kurzname ist bereits vergeben.", code: "SLUG_TAKEN" }
    : { error: "Diese E-Mail-Adresse ist bereits vergeben.", code: "EMAIL_TAKEN" };
}
