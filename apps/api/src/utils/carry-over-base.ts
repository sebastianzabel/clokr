/**
 * Phase 99 (OB-02) — the single resolution point for a carry-over chain's STARTING value.
 *
 * Locked contract (99-CONTEXT.md, D-07):
 *     prevSnapshot?.carryOver ?? openingBalance?.minutes ?? 0
 *
 * The opening balance applies ONLY at the HEAD of the chain — i.e. only when there is no
 * preceding snapshot at all. It is explicitly NOT additive per link, NOT re-consulted
 * mid-chain, and NOT injected as a synthetic SaldoSnapshot row. Re-consulting it anywhere a
 * predecessor exists would double-apply it; that is the failure mode this file exists to
 * make impossible by having exactly one implementation.
 *
 * "Head of chain" is decided by `prevSnapshot === null`, independent of the opening balance's
 * own `effectiveFrom`: the partial unique index guarantees at most ONE active row per
 * employee, so no date disambiguation is needed or wanted.
 *
 * Degrades to today's exact behaviour when no OpeningBalance row exists (returns 0), which is
 * OB-02's "provable no-op" requirement — structural, not merely tested.
 */

/**
 * Narrow structural reader type so this helper accepts the real PrismaClient,
 * a Prisma.TransactionClient, AND a plain hand-rolled test stub without casts.
 */
export type OpeningBalanceReader = {
  openingBalance: {
    findFirst(args: {
      where: { employeeId: string; superseded: boolean };
    }): Promise<{ minutes: number } | null>;
  };
};

export async function getCarryOverBase(
  prisma: OpeningBalanceReader,
  employeeId: string,
  prevSnapshot: { carryOver: number } | null | undefined,
): Promise<number> {
  if (prevSnapshot) return prevSnapshot.carryOver;
  const ob = await prisma.openingBalance.findFirst({
    where: { employeeId, superseded: false },
  });
  return ob?.minutes ?? 0;
}
