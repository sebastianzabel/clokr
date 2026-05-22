import type { PrismaClient } from "@clokr/db";

/**
 * Phase 47.3 — Feature toggle for the Verfügbarkeits-System.
 * Returns true (default) when no TenantConfig row exists, matching the
 * @default(true) in schema.prisma so brand-new tenants get the feature.
 */
export async function isAvailabilityEnabled(
  prisma: PrismaClient,
  tenantId: string,
): Promise<boolean> {
  const cfg = await prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: { availabilityEnabled: true },
  });
  return cfg?.availabilityEnabled ?? true;
}
