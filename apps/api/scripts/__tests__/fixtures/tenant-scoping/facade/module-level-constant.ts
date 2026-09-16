import type { Prisma } from "@clokr/db";

/** `where` reads a module-level constant, never a declared parameter — must NOT be
 * client-supplied even inside a facade module (G2 only seeds the function's OWN parameters). */
const FIXED_SHIFT_ID = "fixed-shift-id";

export async function getFixedShift(db: Prisma.TransactionClient) {
  return db.shift.findUnique({ where: { id: FIXED_SHIFT_ID } });
}
