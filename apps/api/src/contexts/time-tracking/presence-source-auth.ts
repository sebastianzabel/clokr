// Issue #610 (D-16) — the ONE presence-source key check.
//
// The presence webhook (`POST /presence/events`) and the pairing-code issuer
// (`POST /presence/pairing-codes`) are both called by the FRITZ!Box adapter with the same machine
// credential, so both must apply the same three refusals with the same bytes. The check lived inline
// in `api/presence.ts`; it moved here unchanged so no second copy can drift
// (`presence-pairing-contract-610.test.ts` pins the three refusal bodies of the webhook).
//
// The caller turns a refusal into a response with `reply.code(r.status).send(r.body)`.

import { createHash } from "crypto";
import type { FastifyInstance } from "fastify";

export type PresenceSourceAuth =
  | { ok: true; source: { id: string; tenantId: string } }
  | {
      ok: false;
      status: 401 | 403;
      body: { error: string } | FastifyInstance["tenantDeactivatedError"];
    };

/**
 * Resolves `Authorization: Bearer <raw key>` to an active presence source of an active tenant.
 *
 * Refusals (byte-identical to the former inline check of the webhook):
 * - missing or non-Bearer header → 401 "Presence-Key erforderlich"
 * - unknown, revoked or inactive key → 401 "Ungültiger oder widerrufener Presence-Key"
 * - the source's tenant is not active → 403 `app.tenantDeactivatedError`
 */
export async function authenticatePresenceSource(
  app: FastifyInstance,
  authorization: string | undefined,
): Promise<PresenceSourceAuth> {
  if (!authorization?.startsWith("Bearer ")) {
    return { ok: false, status: 401, body: { error: "Presence-Key erforderlich" } };
  }
  const rawKey = authorization.slice(7);
  const keyHash = createHash("sha256").update(rawKey).digest("hex");

  const source = await app.prisma.presenceSource.findUnique({ where: { keyHash } });
  if (!source || source.revokedAt || !source.isActive) {
    return {
      ok: false,
      status: 401,
      body: { error: "Ungültiger oder widerrufener Presence-Key" },
    };
  }

  // Phase 88 (D-05): the device key stays valid for reactivation, but a deactivated tenant gets nothing.
  if (!(await app.tenantIsActive(source.tenantId))) {
    return { ok: false, status: 403, body: app.tenantDeactivatedError };
  }

  return { ok: true, source: { id: source.id, tenantId: source.tenantId } };
}
