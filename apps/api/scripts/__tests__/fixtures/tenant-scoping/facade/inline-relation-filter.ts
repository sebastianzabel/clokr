import type { Prisma } from "@clokr/db";

/** A `tenantId` PARAMETER reached through a relation filter — depth-1 (G3), the D-10 live-probe
 * SCOPED shape. */
export async function getShiftScoped(db: Prisma.TransactionClient, tenantId: string, id: string) {
  return db.shift.findUnique({ where: { id, employee: { tenantId } } });
}
