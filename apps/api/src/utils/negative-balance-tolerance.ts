/**
 * negative-balance-tolerance.ts
 *
 * Phase 100 (OTC-01/OTC-02, D-01) — the single shared precedence chain for
 * `maxNegativeBalanceMinutes`, extracted verbatim from
 * `apps/api/src/routes/overtime.ts:161-165` (per-employee `WorkSchedule` override
 * > `TenantConfig` default > null) so the OVERTIME_COMP booking gate (`leave.ts`)
 * and `GET /leave/overtime-balance` can never read two different figures for the
 * same employee (D-15) — they have already diverged once (Phase 97) and were
 * reunited onto one source; this module is that "one function" going forward.
 *
 * D-00b DISAMBIGUATION — read this before touching either call site:
 * `TenantConfig.maxNegativeBalanceMinutes`'s schema comment reads
 * „null = unbegrenzt" (`packages/db/prisma/schema.prisma`). That is the
 * ALERTING reading: `isNegativeLimitExceeded` (`overtime.ts:173`, and the field
 * of the same name this phase mirrors onto `GET /leave/overtime-balance`) only
 * ever fires when a limit is EXPLICITLY configured — an unconfigured tenant
 * never sees a negative-limit warning, no matter how negative the balance gets.
 * That reading is untouched by this file.
 *
 * For the OVERTIME_COMP BOOKING gate (`leave.ts`, `POST /leave/requests`), `null`
 * means a tolerance of ZERO instead — the opposite reading. An unbounded BOOKING
 * limit would let an employee book arbitrarily far into minus the moment nobody
 * configured a value, which is not what "nothing configured" should mean for a
 * write path that moves real entitlement. `toleranceMinutes` below is therefore
 * always a number, never null — this comment is half of OTC-02's deliverable,
 * the other half is the resolution site itself.
 */

import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";

// ── Public types ──────────────────────────────────────────────────────────────

export type ResolvedNegativeBalanceTolerance = {
  /** The raw configured value (schedule override ?? tenant default), or `null`
   *  when NEITHER is set. This is the "unbegrenzt" / ALERTING reading (D-00b) —
   *  use this for any future alerting consumer, never for a booking comparison. */
  configuredMinutes: number | null;
  /** `configuredMinutes ?? 0` — the BOOKING reading (D-00b). Always a number.
   *  This is the figure the OVERTIME_COMP gate adds to the confirmed carry-over. */
  toleranceMinutes: number;
};

/** A Prisma client that may be either the top-level app.prisma or an interactive
 *  transaction client — mirrors the `DbClient` union already declared locally in
 *  `leave.ts` so a future transactional caller (e.g. a leave-correction flow)
 *  compiles against this helper without a cast. */
type NegativeBalanceToleranceDbClient = FastifyInstance["prisma"] | Prisma.TransactionClient;

// ── Pure resolution ──────────────────────────────────────────────────────────

/**
 * THE precedence chain (D-01), verbatim from `overtime.ts:161-165`: per-employee
 * `WorkSchedule` override beats the `TenantConfig` default; an EXPLICIT `0`
 * override beats a non-zero tenant default because this uses nullish coalescing
 * (`??`), not `||` — `0` is a meaningful configured value, not falsy noise to
 * skip over.
 *
 * PURE — no I/O. Callers resolve both inputs first (see `loadNegativeBalanceTolerance`
 * below for the DB-aware wrapper).
 */
export function resolveNegativeBalanceTolerance(
  scheduleMinutes: number | null | undefined,
  tenantConfigMinutes: number | null | undefined,
): ResolvedNegativeBalanceTolerance {
  const configuredMinutes = scheduleMinutes ?? tenantConfigMinutes ?? null;
  return {
    configuredMinutes,
    toleranceMinutes: configuredMinutes ?? 0,
  };
}

// ── DB-aware resolution ───────────────────────────────────────────────────────

/**
 * Loads the two inputs to the precedence chain and delegates to the pure
 * resolver above. Mirrors `confirmed-saldo.ts`'s contract: PURE READ (no write),
 * caller MUST already have a tenant-scoped `employeeId` / `tenantId` pair.
 *
 * `WorkSchedule` carries NO `tenantId` column of its own (see
 * `packages/db/prisma/schema.prisma`) — the only tenant path is the `employee`
 * relation. The nested `tenantId` filter on that relation below is therefore
 * load-bearing (threat T-100-03): without it, a caller could pass a
 * foreign-tenant `employeeId` and pull a foreign per-employee override into
 * THIS tenant's entitlement decision. `tenantConfig` is read by the
 * CALLER-supplied `tenantId` directly, so it always resolves to the caller's
 * own tenant default regardless of which `employeeId` was passed — a foreign
 * `employeeId` can therefore never contribute more than the caller's own
 * tenant default, and never a foreign per-employee override.
 */
export async function loadNegativeBalanceTolerance(
  prisma: NegativeBalanceToleranceDbClient,
  employeeId: string,
  tenantId: string,
): Promise<ResolvedNegativeBalanceTolerance> {
  const [schedule, tenantConfig] = await Promise.all([
    prisma.workSchedule.findFirst({
      where: { employeeId, employee: { tenantId }, validFrom: { lte: new Date() } },
      orderBy: { validFrom: "desc" },
      select: { maxNegativeBalanceMinutes: true },
    }),
    prisma.tenantConfig.findUnique({
      where: { tenantId },
      select: { maxNegativeBalanceMinutes: true },
    }),
  ]);

  return resolveNegativeBalanceTolerance(
    schedule?.maxNegativeBalanceMinutes,
    tenantConfig?.maxNegativeBalanceMinutes,
  );
}
