/**
 * Issue #610 (Phase 610-02, D-04, P-610-09) - Zeiterfassung's `PresencePairingCode` facade.
 *
 * The only foreign access path to the pairing-code table: the platform callers (the token cleanup
 * and the DSGVO anonymization) reach it through these two functions, never through
 * `prisma.presencePairingCode` directly (`PresencePairingCode` is in `convertedModels` of
 * `scripts/foreign-context-access-exceptions.json`).
 *
 * A pairing code is a short-lived token that names a device address (MAC), so it is no retention
 * record: it is hard-deleted after a day, and with the person who consumed it.
 *
 * D-07: every export's first parameter is `db: Prisma.TransactionClient` - `PrismaClient` is
 * assignable to it, so the SAME function runs inside or outside a `$transaction`
 * (`lint-facade-signatures`).
 */
import type { Prisma } from "@clokr/db";

/**
 * Hard-deletes every pairing code created before `cutoff` (consumed or not) and returns the number
 * of removed rows. It is the global token-cleanup job (like the OTP and refresh-token purge next to
 * it) and spans all tenants, but every delete still carries its own `tenantId`: the tenants that hold
 * a stale code are listed first and purged one by one.
 */
export async function purgeStalePairingCodes(
  db: Prisma.TransactionClient,
  cutoff: Date,
): Promise<number> {
  const tenants = await db.presencePairingCode.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { tenantId: true },
    distinct: ["tenantId"],
    orderBy: { tenantId: "asc" },
  });
  let purged = 0;
  for (const row of tenants) purged += await purgeTenantPairingCodes(db, row.tenantId, cutoff);
  return purged;
}

async function purgeTenantPairingCodes(
  db: Prisma.TransactionClient,
  tenantId: string,
  cutoff: Date,
): Promise<number> {
  const { count } = await db.presencePairingCode.deleteMany({
    where: { tenantId, createdAt: { lt: cutoff } },
  });
  return count;
}

/**
 * Hard-deletes the codes `userId` consumed, inside the anonymization transaction. Unconsumed codes
 * are attributed to nobody and expire on their own. No per-row audit (the auth-token group of the
 * anonymization): the ANONYMIZE audit of the caller stays the one trace. Returns the removed count.
 */
export async function deletePairingCodesOfUser(
  db: Prisma.TransactionClient,
  userId: string,
  tenantId: string,
): Promise<number> {
  const { count } = await db.presencePairingCode.deleteMany({
    where: { consumedByUserId: userId, tenantId },
  });
  return count;
}
