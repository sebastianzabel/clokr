/**
 * Operator principal and its HTTP guard (Phase 88, #88, D-01/D-02/D-02a/D-03).
 *
 * The operator account is a SEPARATE principal kind next to the tenant user. It is deliberately not a
 * `User` with a special role: a tenant-less principal that tenant code could receive would re-open exactly
 * the hazard #88 exists to close. The separation is enforced in four layers:
 *
 *   1. A second, namespaced `@fastify/jwt` registration with its own secret (`OPERATOR_JWT_SECRET`,
 *      registered in `app.ts` only when the secret is configured, research F6). A token signed with one
 *      secret never verifies with the other, so an operator token is not a tenant token and vice versa.
 *   2. The operator verifier writes `req.operator`, never `req.user`. On an operator request `req.user`
 *      stays null, so no tenant helper (`accessContextFromRequest`, permission checks, `app.audit()`)
 *      can ever mistake the operator for a tenant principal.
 *   3. `requireOperator` accepts only a payload that carries `kind: "operator"` AND the operator
 *      audience in the payload itself (defence in depth: it still refuses if the two secrets were ever
 *      configured equal, which `config.ts` additionally forbids).
 *   4. A valid TENANT token on an operator route is answered with 403 and audited
 *      (`TENANT_PRINCIPAL_REFUSED`, AC-88-10); the mirror guard for operator tokens on tenant routes
 *      belongs to `requireAuth` (plan 88-09).
 *
 * The 15-minute access token and the 5-minute second-factor challenge token share the secret and are told
 * apart by the `typ` claim; neither is ever accepted in the other's place.
 *
 * A fifth layer ends tokens on demand (Issue #557): every token carries the account's `tokenVersion` as the
 * claim `ver`, and an MFA reset or a deactivation increments it. `requireOperator` (every request, never
 * cached) and the `/verify` step (the pending challenge) compare it only through `operatorTokenIsCurrent()`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isBlankTenantId } from "./access-context-error";
import { OPERATOR_AUDIT_ACTIONS, recordPrincipalRefusal } from "./operator-audit";

export const OPERATOR_TOKEN_KIND = "operator";
export const OPERATOR_TOKEN_AUDIENCE = "clokr-operator";
export const OPERATOR_ACCESS_TOKEN_TTL = "15m";
export const OPERATOR_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const OPERATOR_CHALLENGE_TTL = "5m";
export const OPERATOR_CHALLENGE_TTL_SECONDS = 5 * 60;

export type OperatorTokenType = "access" | "mfa-challenge";

export type OperatorTokenPayload = {
  sub: string;
  kind: typeof OPERATOR_TOKEN_KIND;
  aud: typeof OPERATOR_TOKEN_AUDIENCE;
  typ: OperatorTokenType;
  /** The account's `tokenVersion` at signing time (Issue #557). */
  ver: number;
  iat?: number;
  exp?: number;
};

declare module "fastify" {
  interface FastifyRequest {
    /** Set by `operatorJwtVerify()`; null on every non-operator request. Never `req.user`. */
    operator: OperatorTokenPayload;
    operatorJwtVerify(): Promise<void>;
  }
  interface FastifyReply {
    operatorJwtSign(
      payload: OperatorTokenPayload,
      options?: { expiresIn?: string },
    ): Promise<string>;
  }
}

declare module "@fastify/jwt" {
  interface JWT {
    /** The namespaced operator signer/verifier; present only when `OPERATOR_JWT_SECRET` is configured. */
    operator?: import("@fastify/jwt").JWT;
  }
}

/** True only for a payload that carries the operator claims and the expected token type. */
export function isOperatorPayload(
  payload: unknown,
  typ: OperatorTokenType,
): payload is OperatorTokenPayload {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    p.kind === OPERATOR_TOKEN_KIND &&
    p.aud === OPERATOR_TOKEN_AUDIENCE &&
    p.typ === typ &&
    typeof p.sub === "string" &&
    p.sub.length > 0 &&
    Number.isInteger(p.ver)
  );
}

function operatorJwt(app: FastifyInstance) {
  const signer = app.jwt.operator;
  if (!signer) throw new Error("Operator JWT is not registered (OPERATOR_JWT_SECRET unset)");
  return signer;
}

/**
 * Signs an operator token. `kind` and `aud` go into the payload itself, independent of any plugin sign
 * option, so `requireOperator` can enforce them on whatever the verifier hands back. The account's
 * `tokenVersion` is a required parameter so no call site can forget it (Issue #557); a non-integer fails
 * closed at sign time.
 */
export function signOperatorToken(
  app: FastifyInstance,
  sub: string,
  typ: OperatorTokenType,
  tokenVersion: number,
): string {
  if (!Number.isInteger(tokenVersion)) {
    throw new Error("Operator token version must be an integer");
  }
  const payload: Omit<OperatorTokenPayload, "iat" | "exp"> = {
    sub,
    kind: OPERATOR_TOKEN_KIND,
    aud: OPERATOR_TOKEN_AUDIENCE,
    typ,
    ver: tokenVersion,
  };
  return operatorJwt(app).sign(payload as never, {
    expiresIn: typ === "access" ? OPERATOR_ACCESS_TOKEN_TTL : OPERATOR_CHALLENGE_TTL,
  });
}

/**
 * True only when the account exists, is active and the token's `ver` equals the stored `tokenVersion`
 * exactly. This is the ONE place the comparison lives (Issue #557): a lower and a higher version are both
 * refused, so neither an old token nor a forged future one passes.
 */
export function operatorTokenIsCurrent(
  payload: Pick<OperatorTokenPayload, "ver">,
  account: { isActive: boolean; tokenVersion: number } | null,
): boolean {
  return account !== null && account.isActive && payload.ver === account.tokenVersion;
}

/** Verifies signature, expiry, operator claims and token type; null on any failure. */
export function verifyOperatorToken(
  app: FastifyInstance,
  token: string,
  typ: OperatorTokenType,
): OperatorTokenPayload | null {
  try {
    const payload: unknown = operatorJwt(app).verify(token);
    return isOperatorPayload(payload, typ) ? payload : null;
  } catch {
    return null;
  }
}

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/** The tenant token's claims if (and only if) it verifies with the TENANT secret; never touches `req.user`. */
function verifiedTenantClaims(
  req: FastifyRequest,
): { sub: string; tenantId: string | null } | null {
  const token = bearerToken(req);
  if (!token) return null;
  try {
    const claims = req.server.jwt.verify<{ sub?: unknown; tenantId?: unknown }>(token);
    if (typeof claims.sub !== "string" || claims.sub.length === 0) return null;
    // The one blank-tenant rule (#551): a blank claim names no tenant for the audit subject.
    const tenantId =
      typeof claims.tenantId === "string" && !isBlankTenantId(claims.tenantId)
        ? claims.tenantId
        : null;
    return { sub: claims.sub, tenantId };
  } catch {
    return null;
  }
}

/**
 * preHandler of every operator route except login/verify. Operator access token -> continue with
 * `req.operator`; valid tenant token -> 403 and an audit row; anything else -> 401.
 */
export async function requireOperator(req: FastifyRequest, reply: FastifyReply) {
  try {
    await req.operatorJwtVerify();
  } catch {
    const tenantClaims = verifiedTenantClaims(req);
    if (tenantClaims) {
      await recordPrincipalRefusal(req.server.prisma, {
        action: OPERATOR_AUDIT_ACTIONS.TENANT_PRINCIPAL_REFUSED,
        principalSub: tenantClaims.sub,
        subjectTenantId: tenantClaims.tenantId,
        route: req.routeOptions?.url ?? req.url,
        method: req.method,
        request: req,
      });
      return reply.code(403).send({ error: "Forbidden" });
    }
    return reply.code(401).send({ error: "Unauthorized" });
  }

  // The signature verified with the operator secret; the payload must still be an operator access token.
  if (!isOperatorPayload(req.operator, "access")) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  const account = await req.server.prisma.operatorAccount.findUnique({
    where: { id: req.operator.sub },
    select: { isActive: true, tokenVersion: true },
  });
  // Read on every request and never cached, so a reset or deactivation takes effect in every process at once.
  if (!operatorTokenIsCurrent(req.operator, account)) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
}
