/**
 * Deterministic resolver for the annual-vacation `LeaveType` row.
 *
 * Fixes Issue #196: `settings.ts`'s GET/PUT /vacation/:employeeId handlers used to resolve
 * the vacation LeaveType with `findFirst({ name: { contains: "Urlaub", mode: "insensitive" } } })`
 * and no `orderBy`. Postgres guarantees no row order without `ORDER BY`, and four of the nine
 * `LEAVE_TYPE_DEFS` names in `leave.ts` match that `contains`: "Urlaub" (meant), "Sonderurlaub",
 * "Unbezahlter Urlaub", "Bildungsurlaub" (all not meant). Once a tenant has more than one of
 * those rows, GET and PUT could resolve DIFFERENT rows on different requests, and PUT could
 * silently write the annual entitlement onto the wrong one.
 *
 * This module duplicates the relevant slice of `leave.ts`'s `LEAVE_TYPE_DEFS.VACATION.name` /
 * `LEGACY_ALIASES.VACATION` DELIBERATELY. Issue #97 will replace both this list and that one
 * with a stable `code` column on `LeaveType`; this file is meant to be deleted when #97 lands.
 * `leave.ts` is intentionally NOT touched or exported from by this fix (out of scope, see #97).
 */
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";

/**
 * Known vacation-type names, in priority order. Mirrors `ensureLeaveType()` in `leave.ts`:
 * the canonical `LEAVE_TYPE_DEFS.VACATION.name` first, then `LEGACY_ALIASES.VACATION` in its
 * own array order.
 */
export const VACATION_LEAVE_TYPE_NAMES = [
  "Urlaub",
  "Jahresurlaub",
  "Urlaub (Jahresurlaub)",
] as const;

type Db = FastifyInstance["prisma"] | Prisma.TransactionClient;

/**
 * Resolves the single `LeaveType` row that GET/PUT /vacation/:employeeId must operate on,
 * for a given tenant, deterministically.
 *
 * Resolution order:
 *   1. Each name in `VACATION_LEAVE_TYPE_NAMES`, in turn, via an exact (case-insensitive)
 *      match, ordered by `createdAt` then `id` so even multiple case-variant rows resolve
 *      the same way every time. `equals` (not `contains`) is what excludes Sonderurlaub /
 *      Unbezahlter Urlaub / Bildungsurlaub.
 *   2. Only if step 1 found nothing: the old `contains: "Urlaub"` query, but returned ONLY if
 *      it matches EXACTLY ONE row — preserving old behaviour for a tenant whose single urlaub
 *      row has an arbitrary name (e.g. "Erholungsurlaub"). If it matches two or more rows, the
 *      old code was effectively a coin flip; this returns `null` (→ the existing 404) instead
 *      of silently writing an annual leave entitlement onto an unintended row (CLAUDE.md: no
 *      silent failures).
 */
export async function findVacationLeaveType(
  db: Db,
  tenantId: string,
): Promise<{ id: string; name: string } | null> {
  for (const name of VACATION_LEAVE_TYPE_NAMES) {
    const hit = await db.leaveType.findFirst({
      where: { tenantId, name: { equals: name, mode: "insensitive" } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, name: true },
    });
    if (hit) return hit;
  }

  const decoys = await db.leaveType.findMany({
    where: { tenantId, name: { contains: "Urlaub", mode: "insensitive" } },
    select: { id: true, name: true },
  });
  return decoys.length === 1 ? decoys[0] : null;
}
