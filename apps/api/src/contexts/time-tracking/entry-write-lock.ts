// Issue #70 (Phase 70b-02), D-10 — the ONE Employee row lock of every writer that creates or
// moves a TimeEntry interval.
//
// Several entries per day are allowed, so two concurrent writers of the same employee can each
// pass an application-level overlap check and then both insert. Two layers close that gap:
//
//  1. The database guarantee (exclusion constraint `TimeEntry_no_overlap_closed` over closed,
//     non-deleted entries and the partial unique index `TimeEntry_employeeId_date_open_unique`
//     for one open entry per employee and day) refuses an overlap that slips through — it is the
//     backstop.
//  2. This lock serialises the writers of one employee, so the in-transaction `checkOverlap(tx, …)`
//     that follows sees every committed row of the winner. It also closes the open-versus-closed
//     gap the constraint cannot see: an open entry has no end and is therefore not in the
//     exclusion constraint at all.
//
// Call it as the FIRST statement of the writer's transaction (uniform lock order: Employee row,
// then everything else). It uses the same lock mode (`FOR UPDATE`) as the clock resolver's
// existing lock (`services/clock/resolver.ts`), so manual writers, the clock paths, the import and
// the Nachtrag approval all queue on the same row. The tenant clause is part of the statement: a
// lock must never be taken on a row outside the caller's tenant.

import type { Prisma } from "@clokr/db";

export async function lockEmployeeForEntryWrite(
  tx: Prisma.TransactionClient,
  tenantId: string,
  employeeId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employeeId} AND "tenantId" = ${tenantId} FOR UPDATE`;
}
