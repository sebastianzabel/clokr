import type { Prisma } from "@clokr/db";

/** No tenant constraint at all — the D-10 live-probe UNSCOPED shape. */
export async function getShiftUnscoped(db: Prisma.TransactionClient, id: string) {
  return db.shift.findUnique({ where: { id } });
}
