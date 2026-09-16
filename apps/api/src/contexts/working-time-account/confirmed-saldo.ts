/**
 * confirmed-saldo.ts
 *
 * Phase 97-01 (TRACER) — single source of truth for the "Bestätigt" figure: the
 * carry-over from the most recently CLOSED month, read directly from the active
 * SaldoSnapshot chain. This is the SAME datum Phase 98's audit walks and verifies,
 * so the saldo-display split and the chain-integrity audit share one source of
 * truth (97-CONTEXT). Explicitly NOT `OvertimeAccount.balanceHours`, which is
 * known to go stale (v1.8.24 already overrides it at read time in overtime.ts).
 *
 * PURE READ (no DB write, no tenant argument). Callers MUST already have a
 * tenant-scoped employeeId / employeeIds list — mirrors how the sibling snapshot
 * query in dashboard.ts (GET /overtime-overview) is already tenant-scoped before
 * it reaches its SaldoSnapshot query.
 *
 * Both exports deliberately do NOT bound the query by a date window (contrast
 * dashboard.ts's `overtime-overview`, which windows to the last 6 months for its
 * own trend display): an employee whose last close is older than six months must
 * not read as a new hire (no closed month yet) here.
 */

import type { FastifyInstance } from "fastify";

// ── Public types ──────────────────────────────────────────────────────────────

export type ConfirmedCarryOver = {
  /** Bestätigt — the closed-month carry-over, in minutes. 0 when no closed month exists yet. */
  minutes: number;
  /** true when a non-superseded MONTHLY SaldoSnapshot exists (governs the "noch kein
   *  Monatsabschluss" vs "ausgeglichen" caption on a genuine 0-minute confirmed figure). */
  hasClosedMonth: boolean;
};

// ── Single-employee lookup ──────────────────────────────────────────────────────

/**
 * Resolve the confirmed carry-over for ONE employee from the active SaldoSnapshot
 * chain (the most recent non-superseded MONTHLY snapshot's `carryOver`).
 *
 * @param app        - Fastify instance (access to prisma)
 * @param employeeId - already tenant-verified by the caller
 */
export async function getConfirmedCarryOver(
  app: FastifyInstance,
  employeeId: string,
): Promise<ConfirmedCarryOver> {
  const snapshot = await app.prisma.saldoSnapshot.findFirst({
    where: { employeeId, periodType: "MONTHLY", superseded: false },
    orderBy: { periodStart: "desc" },
    select: { carryOver: true },
  });

  if (!snapshot) return { minutes: 0, hasClosedMonth: false };
  return { minutes: snapshot.carryOver, hasClosedMonth: true };
}

// ── Bulk lookup (N+1-free) ───────────────────────────────────────────────────────

/**
 * Resolve the confirmed carry-over for MANY employees with exactly ONE unbounded
 * `findMany` (never one query per employee — see the "Known N+1 risk" note in
 * 97-CONTEXT for `GET /dashboard/overtime-overview`, the intended future caller).
 *
 * @param app         - Fastify instance (access to prisma)
 * @param employeeIds - already tenant-scoped by the caller (matches the sibling
 *                      snapshot query pattern in dashboard.ts's overtime-overview)
 * @returns a Map keyed by employeeId. Employees with no closed month at all are
 *          simply absent from the Map — callers fall back the same way the
 *          single-employee lookup does: `map.get(id) ?? { minutes: 0, hasClosedMonth: false }`.
 */
export async function getConfirmedCarryOverBulk(
  app: FastifyInstance,
  employeeIds: string[],
): Promise<Map<string, ConfirmedCarryOver>> {
  const result = new Map<string, ConfirmedCarryOver>();
  if (employeeIds.length === 0) return result;

  const rows = await app.prisma.saldoSnapshot.findMany({
    where: { employeeId: { in: employeeIds }, periodType: "MONTHLY", superseded: false },
    orderBy: { periodStart: "desc" },
    select: { employeeId: true, carryOver: true },
  });

  // Ordered periodStart desc → the FIRST row seen per employee is their most recent
  // closed month. Skip any further (older) rows for an employee already resolved.
  for (const row of rows) {
    if (result.has(row.employeeId)) continue;
    result.set(row.employeeId, { minutes: row.carryOver, hasClosedMonth: true });
  }

  return result;
}
