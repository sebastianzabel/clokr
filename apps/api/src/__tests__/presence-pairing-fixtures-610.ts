/**
 * Issue #610 (Phase 610-01) - shared fixtures of the WLAN pairing tests.
 *
 * The pairing code only ever travels in the JSON body of the requests below - the same form the
 * routes accept - so a test cannot accidentally depend on a code in a URL.
 */
import { createHash, randomBytes } from "crypto";
import type { FastifyInstance } from "fastify";

/** A random locally-administered MAC ("02:" + five random octets) so no two test files collide. */
export function randomTestMac(): string {
  const octets = Array.from({ length: 5 }, () => randomBytes(1).toString("hex"));
  return ["02", ...octets].join(":");
}

export interface PresenceSourceOverrides {
  name?: string;
  isActive?: boolean;
  revokedAt?: Date | null;
  deletedAt?: Date | null;
}

/** Creates a presence source with a fresh raw key `clk_p610_<random>` (only its SHA-256 is stored). */
export async function createPresenceSourceWithKey(
  app: FastifyInstance,
  tenantId: string,
  overrides: PresenceSourceOverrides = {},
): Promise<{ rawKey: string; sourceId: string }> {
  const rawKey = `clk_p610_${randomBytes(12).toString("hex")}`;
  const source = await app.prisma.presenceSource.create({
    data: {
      tenantId,
      name: overrides.name ?? "Test FritzBox 610",
      keyHash: createHash("sha256").update(rawKey).digest("hex"),
      keyPrefix: rawKey.slice(0, 8),
      isActive: overrides.isActive ?? true,
      revokedAt: overrides.revokedAt ?? null,
      deletedAt: overrides.deletedAt ?? null,
    },
  });
  return { rawKey, sourceId: source.id };
}

/** POST /api/v1/presence/pairing-codes with the source key. `authorization` overrides the header. */
export async function issueCode(
  app: FastifyInstance,
  rawKey: string | null,
  mac: string,
  hostname?: string | null,
  extraBody: Record<string, unknown> = {},
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/presence/pairing-codes",
    headers: rawKey === null ? {} : { authorization: `Bearer ${rawKey}` },
    payload: { mac, ...(hostname === undefined ? {} : { hostname }), ...extraBody },
  });
}

/** POST /api/v1/employees/me/wifi/pairing/preview - the code in the body, never in the URL. */
export async function previewCode(
  app: FastifyInstance,
  token: string,
  code: string,
  options: { extraBody?: Record<string, unknown>; query?: string } = {},
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/employees/me/wifi/pairing/preview${options.query ?? ""}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { code, ...(options.extraBody ?? {}) },
  });
}

/** POST /api/v1/employees/me/wifi/pairing with consent - the code in the body, never in the URL. */
export async function confirmCode(
  app: FastifyInstance,
  token: string,
  code: string,
  options: { extraBody?: Record<string, unknown>; query?: string; consent?: boolean | null } = {},
) {
  const consent = options.consent === undefined ? true : options.consent;
  return app.inject({
    method: "POST",
    url: `/api/v1/employees/me/wifi/pairing${options.query ?? ""}`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      code,
      ...(consent === null ? {} : { consent }),
      ...(options.extraBody ?? {}),
    },
  });
}
