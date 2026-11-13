// Issue #467 — the ONE Employee row lock of every writer that PRICES a SHIFT_BASED vacation
// request against the employee's other requests (create, /correct).
//
// `resolveLeaveDays()` prices a request by its marginal cost against the employee's earlier
// counted VACATION requests of the same ISO weeks. Without serialisation, two concurrent writers
// each read the other's absence and both price the week in full, deducting it twice — more leave
// than was taken, which shortens the statutory minimum leave (§ 13 Abs. 1 BUrlG).
//
// Call it as the FIRST statement of the writer's transaction, then price INSIDE the same
// transaction: under READ COMMITTED the pricing read that follows sees every request the previous
// lock holder committed. `FOR NO KEY UPDATE` conflicts with itself (writers queue) but not with
// the `FOR KEY SHARE` that foreign-key inserts take, so it never blocks unrelated writes. The
// tenant clause is part of the statement: a lock is never taken outside the caller's tenant.
// Same row-lock pattern as the time-tracking writers' `lockEmployeeForEntryWrite()`; kept as its
// own function because a context may not deep-import another context's internals.

import type { Prisma } from "@clokr/db";

export async function lockEmployeeForLeavePricing(
  tx: Prisma.TransactionClient,
  tenantId: string,
  employeeId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Employee" WHERE "id" = ${employeeId} AND "tenantId" = ${tenantId} FOR NO KEY UPDATE`;
}
