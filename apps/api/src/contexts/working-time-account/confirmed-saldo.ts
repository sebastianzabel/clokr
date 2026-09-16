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
 * Phase 100B Plan 07 (D-07): converted from a Fastify-instance-typed first parameter to
 * `db: Prisma.TransactionClient` — this file WAS the documented anti-pattern
 * `lint-facade-signatures.ts` names in its own module header ("the existing precedent for the
 * wrong shape"). It was the LAST Fastify-instance-typed facade in this tree; the two
 * grandfathering exceptions plan 03 seeded for it are removed in this same commit — there is no
 * longer a live example to point to as precedent.
 *
 * PURE READ (no DB write). `employeeId`/`employeeIds` are already tenant-scoped by the caller
 * before calling — `tenantId` is a declared parameter (D-10/G4) applied as `employee: { tenantId }`,
 * a proven no-op strengthening at every current caller (dashboard.ts, overtime.ts, leave.ts,
 * time-entries.ts's `computeOvertimeBalanceBreakdown` all fetch/validate `tenantId` before calling).
 *
 * Both exports deliberately do NOT bound the query by a date window (contrast
 * dashboard.ts's `overtime-overview`, which windows to the last 6 months for its
 * own trend display): an employee whose last close is older than six months must
 * not read as a new hire (no closed month yet) here.
 *
 * NOTE (D-10, coverage): this file stays at its pre-existing flat location, per this plan's own
 * `files_modified` list — it is NOT moved into `facade/`, and its two calls therefore stay OUTSIDE
 * `lint:tenant-scoping`'s `SCOPED_DIRS` (a named, accepted coverage loss, not an oversight; see
 * 100B-05-VALIDATION.md §3's gate-derivation note on this exact tradeoff).
 */

import type { Prisma } from "@clokr/db";

// ── Public types ──────────────────────────────────────────────────────────────

export type ConfirmedCarryOver = {
  /** Bestätigt — the closed-month carry-over, in minutes. 0 when no closed month exists yet. */
  minutes: number;
  /** true when a non-superseded MONTHLY SaldoSnapshot exists (governs the "noch kein
   *  Monatsabschluss" vs "ausgeglichen" caption on a genuine 0-minute confirmed figure). */
  hasClosedMonth: boolean;
  /** Phase 100B Plan 07 (W3 merge) — periodEnd of the same most-recent non-superseded MONTHLY
   *  snapshot this call already read. Folds `time-entries.ts`'s own "getLatestClosedMonth" query
   *  (identical where/orderBy, previously a SEPARATE direct SaldoSnapshot read) into this one, so
   *  the live-saldo "open period start" computation and the Bestätigt figure can never drift from
   *  two independent copies of the same underlying question. `null` when `hasClosedMonth` is
   *  `false`. */
  periodEnd: Date | null;
};

// ── Single-employee lookup ──────────────────────────────────────────────────────

/**
 * Resolve the confirmed carry-over for ONE employee from the active SaldoSnapshot
 * chain (the most recent non-superseded MONTHLY snapshot's `carryOver`/`periodEnd`).
 *
 * @param db         - Prisma client or an active `$transaction` client
 * @param employeeId - already tenant-verified by the caller
 * @param tenantId   - already tenant-verified by the caller; applied as `employee: { tenantId }`
 */
export async function getConfirmedCarryOver(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
): Promise<ConfirmedCarryOver> {
  const snapshot = await db.saldoSnapshot.findFirst({
    where: { employeeId, employee: { tenantId }, periodType: "MONTHLY", superseded: false },
    orderBy: { periodStart: "desc" },
    select: { carryOver: true, periodEnd: true },
  });

  if (!snapshot) return { minutes: 0, hasClosedMonth: false, periodEnd: null };
  return { minutes: snapshot.carryOver, hasClosedMonth: true, periodEnd: snapshot.periodEnd };
}

// ── Bulk lookup (N+1-free) ───────────────────────────────────────────────────────

/**
 * Resolve the confirmed carry-over for MANY employees with exactly ONE unbounded
 * `findMany` (never one query per employee — see the "Known N+1 risk" note in
 * 97-CONTEXT for `GET /dashboard/overtime-overview`, the intended future caller).
 *
 * @param db          - Prisma client or an active `$transaction` client
 * @param employeeIds - already tenant-scoped by the caller (matches the sibling
 *                      snapshot query pattern in dashboard.ts's overtime-overview)
 * @param tenantId    - already tenant-verified by the caller; applied as `employee: { tenantId }`
 * @returns a Map keyed by employeeId. Employees with no closed month at all are
 *          simply absent from the Map — callers fall back the same way the
 *          single-employee lookup does: `map.get(id) ?? { minutes: 0, hasClosedMonth: false, periodEnd: null }`.
 */
export async function getConfirmedCarryOverBulk(
  db: Prisma.TransactionClient,
  employeeIds: string[],
  tenantId: string,
): Promise<Map<string, ConfirmedCarryOver>> {
  const result = new Map<string, ConfirmedCarryOver>();
  if (employeeIds.length === 0) return result;

  const rows = await db.saldoSnapshot.findMany({
    where: {
      employeeId: { in: employeeIds },
      employee: { tenantId },
      periodType: "MONTHLY",
      superseded: false,
    },
    orderBy: { periodStart: "desc" },
    select: { employeeId: true, carryOver: true, periodEnd: true },
  });

  // Ordered periodStart desc → the FIRST row seen per employee is their most recent
  // closed month. Skip any further (older) rows for an employee already resolved.
  for (const row of rows) {
    if (result.has(row.employeeId)) continue;
    result.set(row.employeeId, {
      minutes: row.carryOver,
      hasClosedMonth: true,
      periodEnd: row.periodEnd,
    });
  }

  return result;
}
