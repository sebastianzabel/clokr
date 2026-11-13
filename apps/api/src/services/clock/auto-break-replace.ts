// Issue #799 — a recorded pause replaces the automatic one.
//
// When an entry that carries an automatic break (its Break rows with `isAuto`, written only by
// `autoInsertBreak`) is reopened or merged into, the real gap is added as a Break. The automatic
// break of the earlier stop is removed first, so the next stop re-plans it
// (`applyAutoBreakAfterClockStop`: the existing-Break guard then sees the gap break and adds
// nothing). A manually confirmed break (any other status) is never removed.
import type { Prisma } from "@clokr/db";
import type { Actor } from "./types";
import { emitClockAudit } from "./audit-actor";
import type { FastifyRequest } from "fastify";

export const AUTO_BREAK_REPLACED_REASON = "Automatische Pause durch erfasste Pause ersetzt";

export type RemovedAutoBreak = { id: string; startTime: Date; endTime: Date };

/** Removes the Break rows of an AUTO entry and returns them (empty for any other entry). */
export async function removeAutoBreaksOfEntry(
  tx: Prisma.TransactionClient,
  entry: { id: string },
): Promise<RemovedAutoBreak[]> {
  // Row-level marker: only rows `autoInsertBreak` wrote (isAuto). Rows from before the marker
  // existed default to false and are never removed, so recorded history is untouched.
  const rows = await tx.break.findMany({
    where: { timeEntryId: entry.id, isAuto: true },
    select: { id: true, startTime: true, endTime: true },
  });
  if (rows.length === 0) return [];
  await tx.break.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  return rows;
}

export async function auditRemovedAutoBreaks(
  tx: Prisma.TransactionClient,
  params: { entryId: string; removed: RemovedAutoBreak[]; actor: Actor; req?: FastifyRequest },
): Promise<void> {
  for (const b of params.removed) {
    await emitClockAudit(tx, {
      action: "DELETE",
      entity: "Break",
      entityId: b.id,
      oldValue: {
        timeEntryId: params.entryId,
        startTime: b.startTime.toISOString(),
        endTime: b.endTime.toISOString(),
      },
      newValue: { reason: AUTO_BREAK_REPLACED_REASON },
      actor: params.actor,
      req: params.req,
    });
  }
}
