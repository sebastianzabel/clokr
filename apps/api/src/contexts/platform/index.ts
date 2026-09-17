/**
 * Phase 100b Plan 01 (AC-1/AC-2, D-06) — Unterbau's public surface.
 *
 * What is exported here is this context's public surface — ADR 0001 rule 3 (no direct table
 * access across foreign schemas; access only through the owning context's public interface) is
 * why this file exists at all. Anything NOT exported here is
 * module-internal and may change at any time without notice — a caller outside this context that
 * needs a new question answered gets a new named export, never a reach-around import of an
 * internal module.
 *
 * Empty today (`export {}` below), and it CARRIES NO FACADE OF ITS OWN — unlike the other four
 * contexts, Unterbau (Tenant/Employee/User and the rest of the shared substrate) is readable from
 * every context per ADR 0001: it is the ground every context stands on, not a peer context another
 * peer must go through a facade to reach. This file exists purely so all five contexts have
 * exactly one `index.ts` (AC-1) and carry the same D-06 comment — not because a Prisma-call
 * boundary is being drawn here the way it is for the other four.
 *
 * Should a genuine Unterbau facade need to exist later (a compliance-only surface, say), it would
 * live in `./facade/` like the others, never directly in this file — this file is a PURE
 * re-export surface and must contain no Prisma call, because it deliberately sits outside
 * `SCOPED_DIRS` (`apps/api/scripts/lint-tenant-scoping-types.ts`) — only `./facade/**` is walked
 * by plan 100B-04's tenant-gate extension, and a query placed directly here would be invisible to
 * that gate.
 *
 * D-02/D-07/D-08 apply the same way here as in every other context's `index.ts`, should a facade
 * ever be added: purpose-named functions answering the caller's question, `db:
 * Prisma.TransactionClient` as the first parameter, and a non-uniform soft-delete guard (reading
 * functions carry `deletedAt: null`; named compliance functions — DSGVO Art. 17 anonymisation,
 * hard delete, retention archival — deliberately omit it and say so in their own docblock).
 */
export {};
