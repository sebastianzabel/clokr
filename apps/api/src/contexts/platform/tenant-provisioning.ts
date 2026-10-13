/**
 * Phase 88 (D-04/D-04a) — the ONE API-side place of the tenant-skeleton rule:
 * a tenant consists of the Tenant row, its TenantConfig and exactly one active default salon that
 * is named after the tenant, carries the requested Bundesland and
 * `DEFAULT_SALON_OPENING_HOURS`.
 *
 * Layers:
 * - L1 `createTenantWithConfig` — Tenant + TenantConfig (every other config column keeps its
 *   schema default).
 * - L2 `provisionTenant` — L1 + the default salon.
 * - L3 (first admin) arrives in plan 88-10, after the employee transaction is extracted.
 *
 * Every function takes the caller's transaction client, so the caller decides atomicity and an
 * audit row can land in the same transaction. The functions write no audit row themselves: they
 * have no request principal (the test bootstrap has none either).
 *
 * Why the seeds keep a pinned copy: `packages/db` cannot import `apps/api` (research F1,
 * `packages/db/src/default-salon.ts`), so `seed.ts` / `seed-demo.ts` carry their own bootstrap.
 * `tenant-provisioning-88.test.ts` pins them to this rule at source level — a change to one
 * without the other turns that test red.
 */
import type { FederalState, Prisma } from "@clokr/db";
import { DEFAULT_SALON_OPENING_HOURS, createSalon } from "./facade/salons.js";

export interface TenantProvisioningInput {
  /** Explicit tenant id (test fixtures only); omitted, the schema generates one. */
  id?: string;
  name: string;
  slug: string;
  /**
   * The Bundesland decides the statutory holidays of every employee of the tenant (#71). It is
   * REQUIRED and always taken from the caller — never silently from the Tenant column default.
   */
  federalState: FederalState;
  /** Tenant-local IANA zone; omitted, TenantConfig keeps its schema default. */
  timezone?: string;
}

/** L1: the Tenant row and its TenantConfig. */
export async function createTenantWithConfig(
  db: Prisma.TransactionClient,
  input: TenantProvisioningInput,
) {
  const tenant = await db.tenant.create({
    data: {
      ...(input.id !== undefined ? { id: input.id } : {}),
      name: input.name,
      slug: input.slug,
      federalState: input.federalState,
    },
  });
  const config = await db.tenantConfig.create({
    data: {
      tenantId: tenant.id,
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    },
  });
  return { tenant, config };
}

/** L2: L1 plus the tenant's active default salon, in the caller's Bundesland. */
export async function provisionTenant(
  db: Prisma.TransactionClient,
  input: TenantProvisioningInput,
) {
  const { tenant, config } = await createTenantWithConfig(db, input);
  const salon = await createSalon(db, tenant.id, {
    name: tenant.name,
    // Passed explicitly: createSalon would otherwise read the tenant column, which is the very
    // inheritance this function must not rely on (T-88-20).
    federalState: input.federalState,
    openingHours: DEFAULT_SALON_OPENING_HOURS,
    // CreateSalonInput is the parsed output type, so the address keys are spelled out.
    street: null,
    postalCode: null,
    city: null,
  });
  return { tenant, config, salon };
}
