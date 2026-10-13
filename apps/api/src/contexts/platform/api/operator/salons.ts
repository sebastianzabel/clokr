/**
 * Operator salon management (Phase 89, #89, D-05/D-06/D-07/D-12/D-16).
 *
 *   GET  /    all salons of one tenant (inactive included), master data plus the Phorest coupling
 *
 * Mounted at `/api/v1/operator/tenants/:id/salons`; `:id` is the tenant. The route is guarded by
 * `requireOperator`; a tenant token is refused with 403 and an audit row. The response is the
 * metadata-only `toOperatorSalonDto` shape (D-06): no counts, no employee data (D-14a).
 *
 * Salons are read only through the Unterbau facade (`listSalons`). The coupling belongs to
 * Schichtplanung and the Unterbau must not import a business context, so it comes in through the
 * `ports` option that the composition root fills (`composition/operator-salon-ports.ts`).
 * Request parameters are parsed inside the handler, after the guard.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Prisma } from "@clokr/db";
import { config } from "../../../../config";
import { requireOperator } from "../../operator-auth";
import { listSalons } from "../../facade/salons";

/** Structural shape of the composition port; declared here so the Unterbau imports no context. */
export interface OperatorSalonRoutesOptions {
  ports: {
    countTimeEntriesForSalon(
      db: Prisma.TransactionClient,
      tenantId: string,
      salonId: string,
    ): Promise<number>;
    coupling: {
      list(
        db: Prisma.TransactionClient,
        tenantId: string,
      ): Promise<Array<{ salonId: string; provider: string; externalBranchId: string }>>;
    };
  };
}

const readRateLimit = {
  rateLimit: { max: config.NODE_ENV === "test" ? 1000 : 60, timeWindow: "1 minute" },
};

const tenantParamSchema = z.object({ id: z.string().uuid() });

const TENANT_NOT_FOUND = { error: "Mandant nicht gefunden" };

type SalonRow = Awaited<ReturnType<typeof listSalons>>[number];

/** The one operator-facing shape of a salon: exactly these keys, never more (T-89-02). */
export function toOperatorSalonDto(
  row: SalonRow,
  extra: {
    isDefault: boolean;
    coupling: { provider: string; externalBranchId: string } | null;
  },
) {
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
    coupling: extra.coupling,
  };
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
}
