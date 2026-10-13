/**
 * Operator salon management (Phase 89, #89, D-05/D-06/D-07/D-07a/D-09/D-11/D-12/D-12a/D-14a/D-16).
 *
 *   GET  /    all salons of one tenant (inactive included), master data plus the Phorest coupling
 *   POST /    create a salon (Bundesland and opening hours required) with an optional coupling
 *   PATCH /:salonId  edit master data, opening hours, Bundesland and the coupling (set, replace, remove)
 *   POST /:salonId/deactivate  deactivate a salon (never delete), ending its Einsatzsalon assignments
 *   POST /:salonId/activate    reactivate an inactive salon (ended assignments are not restored)
 *
 * There is deliberately NO DELETE route (D-08): a salon is deactivated, never removed, with or
 * without time data.
 *
 * Mounted at `/api/v1/operator/tenants/:id/salons`; `:id` is the tenant. Every route is guarded by
 * `requireOperator`; a tenant token is refused with 403 and an audit row. The response is the
 * metadata-only `toOperatorSalonDto` shape (D-06): no counts, no employee data (D-14a).
 *
 * Salons are read and created only through the Unterbau facade (`listSalons`, `createSalon`), so the
 * tenant's own salon routes and this one share ONE rule set (D-07). The Bundesland is required here
 * (D-07a): no silent inheritance from the tenant. The coupling belongs to Schichtplanung and the
 * Unterbau must not import a business context, so it comes in through the `ports` option that the
 * composition root fills (`composition/operator-salon-ports.ts`). The provider is fixed to Phorest
 * on the server; no request key chooses it (D-11).
 *
 * A write is ONE transaction: the salon, its coupling, the operator's accountability row and the
 * tenant's own audit row commit together or not at all (D-09, D-16). A refusal that is found after
 * the transaction already wrote something is thrown as an `OperatorSalonRejection` so the
 * transaction rolls back, and mapped to its reply outside. Refusal bodies are exactly
 * `{ error, code }` with count-free sentences (D-14a). Request parameters and bodies are parsed
 * inside the handler, after the guard.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { FederalState } from "@clokr/db";
import type { Prisma } from "@clokr/db";
import { config } from "../../../../config";
import { OPERATOR_AUDIT_ACTIONS, recordOperatorAudit } from "../../operator-audit";
import { requireOperator } from "../../operator-auth";
import { operatorTenantAudit } from "../../operator-tenant-audit";
import { toAssignmentDto } from "../../salon-assignment-rules";
import {
  activateSalon,
  createSalon,
  createSalonSchema,
  deactivateSalon,
  findSalon,
  listSalons,
  updateSalon,
  updateSalonSchema,
} from "../../facade/salons";

/** A coupling row as the port hands it back (structural; the Unterbau imports no context). */
interface PortCouplingRow {
  id: string;
  salonId: string;
  provider: string;
  externalBranchId: string;
}

type PortSetResult =
  | { status: "SALON_INACTIVE" }
  | { status: "BRANCH_ALREADY_COUPLED" }
  | { status: "CREATED"; coupling: PortCouplingRow }
  | { status: "UNCHANGED"; coupling: PortCouplingRow }
  | { status: "REPLACED"; removed: PortCouplingRow; created: PortCouplingRow };

type PortRemoveResult = { status: "NOT_FOUND" } | { status: "REMOVED"; removed: PortCouplingRow };

/** Structural shape of the composition port; declared here so the Unterbau imports no context. */
export interface OperatorSalonRoutesOptions {
  ports: {
    countTimeEntriesForSalon(
      db: Prisma.TransactionClient,
      tenantId: string,
      salonId: string,
    ): Promise<number>;
    coupling: {
      list(db: Prisma.TransactionClient, tenantId: string): Promise<PortCouplingRow[]>;
      set(
        db: Prisma.TransactionClient,
        tenantId: string,
        salon: { id: string; isActive: boolean },
        externalBranchId: string,
      ): Promise<PortSetResult>;
      remove(
        db: Prisma.TransactionClient,
        tenantId: string,
        salonId: string,
      ): Promise<PortRemoveResult>;
    };
  };
}

const readRateLimit = {
  rateLimit: { max: config.NODE_ENV === "test" ? 1000 : 60, timeWindow: "1 minute" },
};
const mutationRateLimit = {
  rateLimit: { max: config.NODE_ENV === "test" ? 1000 : 20, timeWindow: "1 minute" },
};

const tenantParamSchema = z.object({ id: z.string().uuid() });

const salonParamSchema = z.object({ id: z.string().uuid(), salonId: z.string().uuid() });

const TENANT_NOT_FOUND = { error: "Mandant nicht gefunden" };
/** One body for a foreign and an unknown salon id (D-06, T-100-09): the lookup has one null path. */
const SALON_NOT_FOUND = { error: "Salon nicht gefunden" };
const NO_CHANGES = { error: "Keine Änderungen angegeben." };

/**
 * Every refusal the salon routes can answer, keyed by `code` (UI-SPEC "Reason texts"). The bodies
 * carry exactly `{ error, code }` and never a count (D-14a).
 */
const OPERATOR_SALON_REPLIES = {
  FEDERAL_STATE_IN_USE: {
    status: 409,
    body: {
      error:
        "Das Bundesland ist durch Zeiteinträge oder Zuordnungen festgelegt. Ein Umzug ist ein neuer Salon.",
      code: "FEDERAL_STATE_IN_USE",
    },
  },
  SALON_INACTIVE: {
    status: 422,
    body: {
      error: "Deaktivierte Salons können nicht gekoppelt werden.",
      code: "SALON_INACTIVE",
    },
  },
  SALON_ALREADY_COUPLED: {
    status: 409,
    body: { error: "Der Salon ist bereits gekoppelt.", code: "SALON_ALREADY_COUPLED" },
  },
  BRANCH_ALREADY_COUPLED: {
    status: 409,
    body: {
      error: "Diese Filialkennung ist bereits einem anderen Salon zugeordnet.",
      code: "BRANCH_ALREADY_COUPLED",
    },
  },
  HOME_SALON_IN_USE: {
    status: 409,
    body: {
      error:
        "Der Salon ist noch Stammsalon von Mitarbeitenden. Die Mitarbeitenden müssen zuerst einem anderen Stammsalon zugeordnet werden.",
      code: "HOME_SALON_IN_USE",
    },
  },
  LAST_ACTIVE_SALON: {
    status: 409,
    body: {
      error:
        "Das ist der letzte aktive Salon des Mandanten. Ein Mandant braucht mindestens einen aktiven Salon.",
      code: "LAST_ACTIVE_SALON",
    },
  },
  ALREADY_INACTIVE: {
    status: 409,
    body: { error: "Der Salon ist bereits deaktiviert.", code: "ALREADY_INACTIVE" },
  },
  ALREADY_ACTIVE: {
    status: 409,
    body: { error: "Der Salon ist bereits aktiv.", code: "ALREADY_ACTIVE" },
  },
  TENANT_DEACTIVATED: {
    status: 409,
    body: {
      error: "Der Mandant ist deaktiviert. Änderungen sind erst nach der Reaktivierung möglich.",
      code: "TENANT_DEACTIVATED",
    },
  },
} as const;

type OperatorSalonReplyCode = keyof typeof OPERATOR_SALON_REPLIES;

/**
 * A refusal found after the transaction already wrote something. Thrown so the transaction rolls
 * back (nothing of the request persists, D-16) and caught outside to send the mapped reply.
 */
class OperatorSalonRejection extends Error {
  readonly code: OperatorSalonReplyCode;
  constructor(code: OperatorSalonReplyCode) {
    super(code);
    this.name = "OperatorSalonRejection";
    this.code = code;
  }
}

/**
 * The reply code of a rejection or of the coupling facade's typed unique-index conflict, `null` for
 * anything else. The conflict error is matched by name and code, not by class, because the Unterbau
 * imports no business context.
 */
function replyCodeOf(err: unknown): OperatorSalonReplyCode | null {
  if (err instanceof OperatorSalonRejection) return err.code;
  if (err instanceof Error && err.name === "SalonCouplingConflictError") {
    const code = (err as Error & { code?: unknown }).code;
    if (code === "SALON_ALREADY_COUPLED" || code === "BRANCH_ALREADY_COUPLED") return code;
  }
  return null;
}

type TenantGate = "NOT_FOUND" | "TENANT_DEACTIVATED" | "OK";

/** Tenant check first (D-06): unknown tenant, deactivated tenant, or writable. */
async function tenantGate(tx: Prisma.TransactionClient, tenantId: string): Promise<TenantGate> {
  const tenant = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: { deactivatedAt: true },
  });
  if (!tenant) return "NOT_FOUND";
  return tenant.deactivatedAt ? "TENANT_DEACTIVATED" : "OK";
}

type SalonRow = Awaited<ReturnType<typeof listSalons>>[number];

/**
 * A salon's own fields without its coupling. The audit rows of a salon edit use this shape: the
 * coupling is a separate entity with separate SALON_COUPLING_SET / SALON_COUPLING_REMOVED rows,
 * and a coupling value on a SALON_UPDATED row would be the pre-request state on both sides of the
 * append-only record (misleading).
 */
export function toOperatorSalonFields(row: SalonRow, extra: { isDefault: boolean }) {
  return {
    id: row.id,
    name: row.name,
    street: row.street,
    postalCode: row.postalCode,
    city: row.city,
    openingHours: row.openingHours,
    federalState: row.federalState,
    isActive: row.isActive,
    deactivatedAt: row.deactivatedAt,
    createdAt: row.createdAt,
    isDefault: extra.isDefault,
  };
}

/** The one operator-facing shape of a salon: exactly these keys, never more (T-89-02). */
export function toOperatorSalonDto(
  row: SalonRow,
  extra: {
    isDefault: boolean;
    coupling: { provider: string; externalBranchId: string } | null;
  },
) {
  return { ...toOperatorSalonFields(row, extra), coupling: extra.coupling };
}

/**
 * Create body: the facade's strict create schema without `isActive` (a new salon is always active),
 * with the Bundesland REQUIRED (D-07a) and the optional embedded coupling (D-12a). No `provider`
 * key exists (D-11).
 */
const createOperatorSalonSchema = createSalonSchema.omit({ isActive: true }).extend({
  federalState: z.nativeEnum(FederalState),
  coupling: z
    .object({ externalBranchId: z.string().trim().min(1).max(100) })
    .strict()
    .nullable()
    .optional(),
});

/**
 * Edit body: the facade's strict update schema plus the embedded coupling. `coupling` absent keeps
 * the coupling, an object sets or replaces it, `null` removes it (D-12a). `isActive` is not part of
 * the schema, so activation stays on its own routes (T-89-30b).
 */
const updateOperatorSalonSchema = updateSalonSchema.extend({
  coupling: z
    .object({ externalBranchId: z.string().trim().min(1).max(100) })
    .strict()
    .nullable()
    .optional(),
});

type StateChangeResult =
  | { status: "NOT_FOUND" | "SALON_NOT_FOUND" | "TENANT_DEACTIVATED" }
  | { status: "ALREADY_INACTIVE" | "ALREADY_ACTIVE" | "LAST_ACTIVE_SALON" | "HOME_SALON_IN_USE" }
  | { status: "OK"; dto: ReturnType<typeof toOperatorSalonDto> };

/**
 * Maps the outcome of a deactivate / activate transaction to its reply. The handlers return only
 * the status of a refusal, so the facade's `HOME_SALON_IN_USE` count never reaches the body (D-14a).
 */
function replyForStateChange(reply: FastifyReply, result: StateChangeResult) {
  switch (result.status) {
    case "NOT_FOUND":
      return reply.code(404).send(TENANT_NOT_FOUND);
    case "SALON_NOT_FOUND":
      return reply.code(404).send(SALON_NOT_FOUND);
    case "OK":
      return result.dto;
    default: {
      const refusal = OPERATOR_SALON_REPLIES[result.status];
      return reply.code(refusal.status).send(refusal.body);
    }
  }
}

export async function operatorSalonRoutes(app: FastifyInstance, opts: OperatorSalonRoutesOptions) {
  // GET /api/v1/operator/tenants/:id/salons
  app.get("/", {
    config: readRateLimit,
    schema: {
      tags: ["Betreiber"],
      description: "All salons of a tenant (inactive included) with their Phorest coupling.",
    },
    preHandler: requireOperator,
    handler: async (req, reply) => {
      const { id } = tenantParamSchema.parse(req.params);
      const tenant = await app.prisma.tenant.findUnique({ where: { id }, select: { id: true } });
      if (!tenant) return reply.code(404).send(TENANT_NOT_FOUND);

      const salons = await listSalons(app.prisma, id, { includeInactive: true });
      const couplings = await opts.ports.coupling.list(app.prisma, id);
      const couplingBySalon = new Map(couplings.map((c) => [c.salonId, c]));
      // Same rule as the facade's default salon: the first ACTIVE salon in listing order.
      const defaultSalonId = salons.find((s) => s.isActive)?.id ?? null;

      return salons.map((salon) => {
        const coupling = couplingBySalon.get(salon.id);
        return toOperatorSalonDto(salon, {
          isDefault: salon.id === defaultSalonId,
          coupling: coupling
            ? { provider: coupling.provider, externalBranchId: coupling.externalBranchId }
            : null,
        });
      });
    },
  });

  // POST /api/v1/operator/tenants/:id/salons
  app.post("/", {
    config: mutationRateLimit,
    schema: {
      tags: ["Betreiber"],
      description:
        "Creates a salon (Bundesland and opening hours required) with an optional Phorest coupling.",
    },
    preHandler: requireOperator,
    handler: async (req, reply) => {
      const { id: tenantId } = tenantParamSchema.parse(req.params);
      const { coupling, ...fields } = createOperatorSalonSchema.parse(req.body);
      const operatorId = req.operator.sub;
      const writeTenantAudit = operatorTenantAudit(app, { operatorId, tenantId, request: req });

      let result;
      try {
        result = await app.prisma.$transaction(async (tx) => {
          const gate = await tenantGate(tx, tenantId);
          if (gate !== "OK") return { status: gate } as const;

          const created = await createSalon(tx, tenantId, fields);
          // The default salon is the first ACTIVE salon of the tenant (same rule as the listing).
          const [firstActive] = await listSalons(tx, tenantId, { includeInactive: false });
          const isDefault = firstActive?.id === created.id;

          await recordOperatorAudit(tx, {
            action: OPERATOR_AUDIT_ACTIONS.SALON_CREATED,
            operatorId,
            subjectTenantId: tenantId,
            entity: "Salon",
            entityId: created.id,
            newValue: toOperatorSalonDto(created, { isDefault, coupling: null }),
            request: req,
          });
          await writeTenantAudit(
            { action: "CREATE", entity: "Salon", entityId: created.id, newValue: created },
            tx,
          );

          let appliedCoupling: { provider: string; externalBranchId: string } | null = null;
          if (coupling) {
            const outcome = await opts.ports.coupling.set(
              tx,
              tenantId,
              { id: created.id, isActive: created.isActive },
              coupling.externalBranchId,
            );
            if (
              outcome.status === "BRANCH_ALREADY_COUPLED" ||
              outcome.status === "SALON_INACTIVE"
            ) {
              throw new OperatorSalonRejection(outcome.status);
            }
            // A brand-new salon has no coupling to keep or replace; anything but CREATED is a bug.
            if (outcome.status !== "CREATED") {
              throw new Error(`Unexpected coupling outcome ${outcome.status} for a new salon`);
            }
            const row = outcome.coupling;
            appliedCoupling = { provider: row.provider, externalBranchId: row.externalBranchId };
            const couplingValue = {
              salonId: row.salonId,
              provider: row.provider,
              externalBranchId: row.externalBranchId,
            };
            await recordOperatorAudit(tx, {
              action: OPERATOR_AUDIT_ACTIONS.SALON_COUPLING_SET,
              operatorId,
              subjectTenantId: tenantId,
              entity: "SalonCoupling",
              entityId: row.id,
              newValue: couplingValue,
              request: req,
            });
            await writeTenantAudit(
              {
                action: "CREATE",
                entity: "SalonCoupling",
                entityId: row.id,
                newValue: couplingValue,
              },
              tx,
            );
          }

          return {
            status: "OK",
            dto: toOperatorSalonDto(created, { isDefault, coupling: appliedCoupling }),
          } as const;
        });
      } catch (err) {
        const code = replyCodeOf(err);
        if (code) {
          const refusal = OPERATOR_SALON_REPLIES[code];
          return reply.code(refusal.status).send(refusal.body);
        }
        throw err;
      }

      if (result.status === "NOT_FOUND") return reply.code(404).send(TENANT_NOT_FOUND);
      if (result.status === "TENANT_DEACTIVATED") {
        const refusal = OPERATOR_SALON_REPLIES.TENANT_DEACTIVATED;
        return reply.code(refusal.status).send(refusal.body);
      }
      return reply.code(201).send(result.dto);
    },
  });

  // PATCH /api/v1/operator/tenants/:id/salons/:salonId
  app.patch("/:salonId", {
    config: mutationRateLimit,
    schema: {
      tags: ["Betreiber"],
      description:
        "Edits a salon's master data, opening hours, Bundesland and Phorest coupling in one audited request.",
    },
    preHandler: requireOperator,
    handler: async (req, reply) => {
      const { id: tenantId, salonId } = salonParamSchema.parse(req.params);
      const parsed = updateOperatorSalonSchema.parse(req.body);
      // The facade writes the rest of the patch straight into Prisma: the coupling must not reach it.
      const { coupling, ...patch } = parsed;
      const operatorId = req.operator.sub;
      const writeTenantAudit = operatorTenantAudit(app, { operatorId, tenantId, request: req });

      let result;
      try {
        result = await app.prisma.$transaction(async (tx) => {
          const gate = await tenantGate(tx, tenantId);
          if (gate !== "OK") return { status: gate } as const;

          const existing = await findSalon(tx, tenantId, salonId);
          if (!existing) return { status: "SALON_NOT_FOUND" } as const;

          if (Object.keys(patch).length === 0 && coupling === undefined) {
            return { status: "NO_CHANGES" } as const;
          }
          if (coupling && !existing.isActive) {
            return { status: "REFUSED", code: "SALON_INACTIVE" } as const;
          }

          const [firstActive] = await listSalons(tx, tenantId, { includeInactive: false });
          const isDefault = firstActive?.id === salonId;

          let current = existing;
          if (Object.keys(patch).length > 0) {
            const outcome = await updateSalon(tx, tenantId, salonId, patch, (countDb) =>
              opts.ports.countTimeEntriesForSalon(countDb, tenantId, salonId),
            );
            // The facade writes nothing for these two, so the plain return commits nothing.
            if (outcome.status === "NOT_FOUND") return { status: "SALON_NOT_FOUND" } as const;
            if (outcome.status === "FEDERAL_STATE_IN_USE") {
              return { status: "REFUSED", code: "FEDERAL_STATE_IN_USE" } as const;
            }
            current = outcome.updated;
            // No coupling key: coupling changes carry their own SALON_COUPLING_* rows.
            await recordOperatorAudit(tx, {
              action: OPERATOR_AUDIT_ACTIONS.SALON_UPDATED,
              operatorId,
              subjectTenantId: tenantId,
              entity: "Salon",
              entityId: salonId,
              oldValue: toOperatorSalonFields(outcome.existing, { isDefault }),
              newValue: toOperatorSalonFields(outcome.updated, { isDefault }),
              request: req,
            });
            await writeTenantAudit(
              {
                action: "UPDATE",
                entity: "Salon",
                entityId: salonId,
                oldValue: outcome.existing,
                newValue: outcome.updated,
              },
              tx,
            );
          }

          const couplingAudit = async (
            kind: "SET" | "REMOVED",
            row: PortCouplingRow,
          ): Promise<void> => {
            const value = {
              salonId: row.salonId,
              provider: row.provider,
              externalBranchId: row.externalBranchId,
            };
            await recordOperatorAudit(tx, {
              action:
                kind === "SET"
                  ? OPERATOR_AUDIT_ACTIONS.SALON_COUPLING_SET
                  : OPERATOR_AUDIT_ACTIONS.SALON_COUPLING_REMOVED,
              operatorId,
              subjectTenantId: tenantId,
              entity: "SalonCoupling",
              entityId: row.id,
              ...(kind === "SET" ? { newValue: value } : { oldValue: value }),
              request: req,
            });
            await writeTenantAudit(
              kind === "SET"
                ? { action: "CREATE", entity: "SalonCoupling", entityId: row.id, newValue: value }
                : { action: "DELETE", entity: "SalonCoupling", entityId: row.id, oldValue: value },
              tx,
            );
          };

          if (coupling) {
            const outcome = await opts.ports.coupling.set(
              tx,
              tenantId,
              { id: current.id, isActive: current.isActive },
              coupling.externalBranchId,
            );
            // A salon update may already be written: throw so the transaction rolls it back.
            if (
              outcome.status === "BRANCH_ALREADY_COUPLED" ||
              outcome.status === "SALON_INACTIVE"
            ) {
              throw new OperatorSalonRejection(outcome.status);
            }
            if (outcome.status === "CREATED") await couplingAudit("SET", outcome.coupling);
            if (outcome.status === "REPLACED") {
              await couplingAudit("REMOVED", outcome.removed);
              await couplingAudit("SET", outcome.created);
            }
          } else if (coupling === null) {
            const outcome = await opts.ports.coupling.remove(tx, tenantId, salonId);
            if (outcome.status === "REMOVED") await couplingAudit("REMOVED", outcome.removed);
          }

          const couplingNow = (await opts.ports.coupling.list(tx, tenantId)).find(
            (c) => c.salonId === salonId,
          );
          const fresh = (await findSalon(tx, tenantId, salonId)) ?? current;
          return {
            status: "OK",
            dto: toOperatorSalonDto(fresh, {
              isDefault,
              coupling: couplingNow
                ? { provider: couplingNow.provider, externalBranchId: couplingNow.externalBranchId }
                : null,
            }),
          } as const;
        });
      } catch (err) {
        const code = replyCodeOf(err);
        if (code) {
          const refusal = OPERATOR_SALON_REPLIES[code];
          return reply.code(refusal.status).send(refusal.body);
        }
        throw err;
      }

      switch (result.status) {
        case "NOT_FOUND":
          return reply.code(404).send(TENANT_NOT_FOUND);
        case "SALON_NOT_FOUND":
          return reply.code(404).send(SALON_NOT_FOUND);
        case "TENANT_DEACTIVATED": {
          const refusal = OPERATOR_SALON_REPLIES.TENANT_DEACTIVATED;
          return reply.code(refusal.status).send(refusal.body);
        }
        case "NO_CHANGES":
          return reply.code(400).send(NO_CHANGES);
        case "REFUSED": {
          const refusal = OPERATOR_SALON_REPLIES[result.code];
          return reply.code(refusal.status).send(refusal.body);
        }
        default:
          return result.dto;
      }
    },
  });

  // POST /api/v1/operator/tenants/:id/salons/:salonId/deactivate — never deletes (D-08)
  app.post("/:salonId/deactivate", {
    config: mutationRateLimit,
    schema: {
      tags: ["Betreiber"],
      description:
        "Deactivates a salon (never deletes it) and ends its Einsatzsalon assignments, audited on both sides.",
    },
    preHandler: requireOperator,
    handler: async (req, reply) => {
      const { id: tenantId, salonId } = salonParamSchema.parse(req.params);
      const operatorId = req.operator.sub;
      const writeTenantAudit = operatorTenantAudit(app, { operatorId, tenantId, request: req });

      const result = await app.prisma.$transaction(async (tx) => {
        const gate = await tenantGate(tx, tenantId);
        if (gate !== "OK") return { status: gate } as const;

        const [defaultBefore] = await listSalons(tx, tenantId, { includeInactive: false });
        const change = await deactivateSalon(tx, tenantId, salonId);
        // The facade writes nothing for a refusal, so returning here commits nothing.
        if (change.status === "NOT_FOUND") return { status: "SALON_NOT_FOUND" } as const;
        if (change.status !== "OK") return { status: change.status } as const;

        const [defaultAfter] = await listSalons(tx, tenantId, { includeInactive: false });
        await recordOperatorAudit(tx, {
          action: OPERATOR_AUDIT_ACTIONS.SALON_DEACTIVATED,
          operatorId,
          subjectTenantId: tenantId,
          entity: "Salon",
          entityId: salonId,
          oldValue: toOperatorSalonFields(change.existing, {
            isDefault: defaultBefore?.id === salonId,
          }),
          newValue: toOperatorSalonFields(change.updated, {
            isDefault: defaultAfter?.id === salonId,
          }),
          request: req,
        });
        await writeTenantAudit(
          {
            action: "DEACTIVATE",
            entity: "Salon",
            entityId: salonId,
            oldValue: change.existing,
            newValue: change.updated,
          },
          tx,
        );
        // One END row per Einsatzsalon assignment the deactivation ended or voided, next to the
        // salon's own DEACTIVATE row (same shapes as the tenant's own route).
        for (const { before, after } of change.endedAssignments) {
          await writeTenantAudit(
            {
              action: "END",
              entity: "EmployeeSalonAssignment",
              entityId: before.id,
              oldValue: toAssignmentDto(before),
              newValue: { ...toAssignmentDto(after), trigger: "SALON_DEACTIVATED" },
            },
            tx,
          );
        }

        const couplingNow = (await opts.ports.coupling.list(tx, tenantId)).find(
          (c) => c.salonId === salonId,
        );
        return {
          status: "OK",
          dto: toOperatorSalonDto(change.updated, {
            isDefault: defaultAfter?.id === salonId,
            coupling: couplingNow
              ? { provider: couplingNow.provider, externalBranchId: couplingNow.externalBranchId }
              : null,
          }),
        } as const;
      });

      return replyForStateChange(reply, result);
    },
  });

  // POST /api/v1/operator/tenants/:id/salons/:salonId/activate — ended assignments stay ended
  app.post("/:salonId/activate", {
    config: mutationRateLimit,
    schema: {
      tags: ["Betreiber"],
      description: "Reactivates an inactive salon, audited on both sides.",
    },
    preHandler: requireOperator,
    handler: async (req, reply) => {
      const { id: tenantId, salonId } = salonParamSchema.parse(req.params);
      const operatorId = req.operator.sub;
      const writeTenantAudit = operatorTenantAudit(app, { operatorId, tenantId, request: req });

      const result = await app.prisma.$transaction(async (tx) => {
        const gate = await tenantGate(tx, tenantId);
        if (gate !== "OK") return { status: gate } as const;

        const [defaultBefore] = await listSalons(tx, tenantId, { includeInactive: false });
        const change = await activateSalon(tx, tenantId, salonId);
        if (change.status === "NOT_FOUND") return { status: "SALON_NOT_FOUND" } as const;
        if (change.status !== "OK") return { status: change.status } as const;

        const [defaultAfter] = await listSalons(tx, tenantId, { includeInactive: false });
        await recordOperatorAudit(tx, {
          action: OPERATOR_AUDIT_ACTIONS.SALON_ACTIVATED,
          operatorId,
          subjectTenantId: tenantId,
          entity: "Salon",
          entityId: salonId,
          oldValue: toOperatorSalonFields(change.existing, {
            isDefault: defaultBefore?.id === salonId,
          }),
          newValue: toOperatorSalonFields(change.updated, {
            isDefault: defaultAfter?.id === salonId,
          }),
          request: req,
        });
        await writeTenantAudit(
          {
            action: "ACTIVATE",
            entity: "Salon",
            entityId: salonId,
            oldValue: change.existing,
            newValue: change.updated,
          },
          tx,
        );

        const couplingNow = (await opts.ports.coupling.list(tx, tenantId)).find(
          (c) => c.salonId === salonId,
        );
        return {
          status: "OK",
          dto: toOperatorSalonDto(change.updated, {
            isDefault: defaultAfter?.id === salonId,
            coupling: couplingNow
              ? { provider: couplingNow.provider, externalBranchId: couplingNow.externalBranchId }
              : null,
          }),
        } as const;
      });

      return replyForStateChange(reply, result);
    },
  });
}
