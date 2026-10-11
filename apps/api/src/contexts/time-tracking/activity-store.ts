// Issue #81 — the Zeiterfassung-internal reads of the activity dimension of time entries: the
// entry's remainder kind, its salon and its stored shares.
//
// This is NOT a facade: no foreign context calls it. Foreign callers go through
// `contexts/time-tracking/index.ts`. Every read carries `deletedAt: null` (soft delete) and binds
// the entry to the tenant (`employee: { tenantId }`), so a row of another tenant can never surface
// even if a caller passes a foreign entry id.
//
// It never widens the saldo's T1 select: `facade/time-entries.ts` `getValidWorkedEntriesInRange`
// stays the saldo input and does not know the activity fields (D-12).
import type { ActivityKind, Prisma } from "@clokr/db";
import type { ActivityShareInput } from "./activity-minutes";

/** What the evaluation needs of one entry besides its times. */
export type ActivityRow = {
  salonId: string;
  activityKind: ActivityKind;
  shares: ActivityShareInput[];
};

/**
 * The activity fields of the given entries, keyed by entry id. An id that is unknown, soft-deleted
 * or belongs to another tenant is simply absent from the map. An empty id list returns an empty map
 * without a query.
 */
export async function loadActivityRowsForEntries(
  db: Prisma.TransactionClient,
  tenantId: string,
  entryIds: readonly string[],
): Promise<Map<string, ActivityRow>> {
  const rows = new Map<string, ActivityRow>();
  if (entryIds.length === 0) return rows;
  const entries = await db.timeEntry.findMany({
    where: { id: { in: [...entryIds] }, deletedAt: null, employee: { tenantId } },
    select: {
      id: true,
      salonId: true,
      activityKind: true,
      activityShares: { select: { kind: true, minutes: true }, orderBy: { kind: "asc" } },
    },
  });
  for (const e of entries) {
    rows.set(e.id, {
      salonId: e.salonId,
      activityKind: e.activityKind,
      shares: e.activityShares,
    });
  }
  return rows;
}
