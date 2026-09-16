import type { Prisma } from "@clokr/db";

/** A `tenantId` PARAMETER used directly in `where` — depth-0 principal field (G3). */
export async function getShiftByTenantId(
  db: Prisma.TransactionClient,
  tenantId: string,
  id: string,
) {
  return db.shift.findUnique({ where: { id, tenantId } });
}
