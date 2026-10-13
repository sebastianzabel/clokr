/**
 * Operator sign-in (Phase 88, #88, D-02/D-03/D-03a/D-07/D-09).
 *
 *   POST /login   password           -> 5-minute second-factor challenge token
 *   POST /verify  challenge + TOTP code or one recovery code -> 15-minute access token
 *   GET  /me      the signed-in operator
 *
 * Registered only when `OPERATOR_JWT_SECRET` is configured (see `app.ts`). Nothing here reads `req.user`,
 * writes the tenant `AuditLog` or builds an access context: the operator is not a tenant principal
 * (`operator-auth.ts`). Every outcome lands in `OperatorAuditLog`; a failed attempt stores a keyed hash of
 * the typed address, never the string itself.
 *
 * No endpoint reveals why a sign-in failed: unknown address, wrong password, inactive, locked and
 * not-enrolled accounts all answer the identical 401 after a bcrypt comparison (a cached dummy hash stands
 * in for an unknown address). Request bodies are parsed with zod inside the handler, deliberately not with
 * a JSON schema, so the guard of the other operator routes always runs before any body validation.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { config } from "../../../../config";
import {
  OPERATOR_LOCKOUT_MINUTES,
  OPERATOR_LOGIN_MAX_ATTEMPTS,
  consumeRecoveryCode,
  hashOperatorEmail,
  normalizeOperatorEmail,
  verifyOperatorTotp,
} from "../../operator-credentials";
import { OPERATOR_AUDIT_ACTIONS, recordOperatorAudit } from "../../operator-audit";
import {
  OPERATOR_ACCESS_TOKEN_TTL_SECONDS,
  OPERATOR_CHALLENGE_TTL_SECONDS,
  requireOperator,
  signOperatorToken,
  verifyOperatorToken,
} from "../../operator-auth";

const GENERIC_FAILURE = { error: "Anmeldung fehlgeschlagen" };
const BCRYPT_COST = 12;

const loginSchema = z
  .object({
    email: z.string().max(254),
    password: z.string().min(1).max(1024),
  })
  .strict();

const verifySchema = z
  .object({
    challengeToken: z.string().min(1).max(4096),
    code: z.string().min(6).max(12).optional(),
    recoveryCode: z.string().min(1).max(64).optional(),
  })
  .strict()
  .refine((body) => (body.code === undefined) !== (body.recoveryCode === undefined), {
    message: "Genau ein zweiter Faktor ist erforderlich",
  });

let dummyHashPromise: Promise<string> | undefined;

/** Hash compared against when the address is unknown, so both outcomes cost one bcrypt comparison. */
function dummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= bcrypt.hash("operator-dummy-password-not-a-secret", BCRYPT_COST);
  return dummyHashPromise;
}

type AccountForFailure = {
  id: string;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
};

const rateLimitPerFifteenMinutes = {
  rateLimit: { max: config.NODE_ENV === "test" ? 1000 : 10, timeWindow: "15 minutes" },
};
const rateLimitPerMinute = {
  rateLimit: { max: config.NODE_ENV === "test" ? 1000 : 60, timeWindow: "1 minute" },
};

export async function operatorAuthRoutes(app: FastifyInstance) {
  /**
   * Counts one failed password or second-factor attempt and locks the account at the threshold.
   * The increment is atomic; the lock is set by a conditional update, so exactly one request writes
   * the single OPERATOR_LOCKED row even when failures arrive in parallel.
   */
  async function registerFailure(account: AccountForFailure, req: FastifyRequest) {
    const now = new Date();
    if (account.lockedUntil && account.lockedUntil <= now) {
      await app.prisma.operatorAccount.updateMany({
        where: { id: account.id, lockedUntil: { lte: now } },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    }
    const updated = await app.prisma.operatorAccount.update({
      where: { id: account.id },
      data: { failedLoginAttempts: { increment: 1 }, lastFailedLoginAt: now },
      select: { failedLoginAttempts: true },
    });
    if (updated.failedLoginAttempts < OPERATOR_LOGIN_MAX_ATTEMPTS) return;
    const lockedUntil = new Date(now.getTime() + OPERATOR_LOCKOUT_MINUTES * 60 * 1000);
    const { count } = await app.prisma.operatorAccount.updateMany({
      where: { id: account.id, lockedUntil: null },
      data: { lockedUntil },
    });
    if (count === 1) {
      await recordOperatorAudit(app.prisma, {
        operatorId: account.id,
        action: OPERATOR_AUDIT_ACTIONS.OPERATOR_LOCKED,
        entity: "OperatorAccount",
        entityId: account.id,
        newValue: {
          attempts: updated.failedLoginAttempts,
          lockoutMinutes: OPERATOR_LOCKOUT_MINUTES,
        },
        request: req,
      });
    }
  }

  // POST /api/v1/operator/auth/login
  app.post("/login", {
    config: rateLimitPerFifteenMinutes,
    schema: {
      tags: ["Betreiber"],
      description:
        "Operator sign-in, step 1: password. Returns a short-lived second-factor challenge.",
    },
    handler: async (req, reply) => {
      const body = loginSchema.parse(req.body);
      const email = normalizeOperatorEmail(body.email);
      const account = await app.prisma.operatorAccount.findUnique({ where: { email } });

      // One bcrypt comparison on every path (unknown address included) keeps the timing flat.
      const passwordMatches = await bcrypt.compare(
        body.password,
        account?.passwordHash ?? (await dummyPasswordHash()),
      );

      const fail = async (reason: string, operatorId?: string) => {
        await recordOperatorAudit(app.prisma, {
          operatorId,
          action: OPERATOR_AUDIT_ACTIONS.OPERATOR_LOGIN_FAILED,
          entity: "OperatorAccount",
          entityId: operatorId,
          newValue: { emailHash: hashOperatorEmail(email), stage: "password", reason },
          request: req,
        });
        return reply.code(401).send(GENERIC_FAILURE);
      };

      if (!account) return fail("UNKNOWN_ACCOUNT");
      if (!account.isActive) return fail("INACTIVE", account.id);
      if (account.lockedUntil && account.lockedUntil > new Date()) {
        return fail("LOCKED", account.id);
      }
      if (!account.totpSecretEnc || !account.totpEnabledAt) {
        return fail("NOT_ENROLLED", account.id);
      }
      if (!passwordMatches) {
        await registerFailure(account, req);
        return fail("WRONG_PASSWORD", account.id);
      }

      return {
        challengeToken: signOperatorToken(app, account.id, "mfa-challenge"),
        expiresIn: OPERATOR_CHALLENGE_TTL_SECONDS,
      };
    },
  });

  // POST /api/v1/operator/auth/verify
  app.post("/verify", {
    config: rateLimitPerFifteenMinutes,
    schema: {
      tags: ["Betreiber"],
      description:
        "Operator sign-in, step 2: TOTP code or one recovery code. Returns the access token.",
    },
    handler: async (req, reply) => {
      const body = verifySchema.parse(req.body);

      const auditFailure = (reason: string, operatorId?: string) =>
        recordOperatorAudit(app.prisma, {
          operatorId,
          action: OPERATOR_AUDIT_ACTIONS.OPERATOR_MFA_FAILED,
          entity: "OperatorAccount",
          entityId: operatorId,
          newValue: { reason },
          request: req,
        });

      const challenge = verifyOperatorToken(app, body.challengeToken, "mfa-challenge");
      if (!challenge) {
        await auditFailure("INVALID_CHALLENGE");
        return reply.code(401).send(GENERIC_FAILURE);
      }

      const account = await app.prisma.operatorAccount.findUnique({ where: { id: challenge.sub } });
      if (!account) {
        await auditFailure("UNKNOWN_ACCOUNT");
        return reply.code(401).send(GENERIC_FAILURE);
      }
      const now = new Date();
      if (!account.isActive || (account.lockedUntil && account.lockedUntil > now)) {
        await auditFailure(account.isActive ? "LOCKED" : "INACTIVE", account.id);
        return reply.code(401).send(GENERIC_FAILURE);
      }
      if (!account.totpSecretEnc || !account.totpEnabledAt) {
        await auditFailure("NOT_ENROLLED", account.id);
        return reply.code(401).send(GENERIC_FAILURE);
      }

      const success = {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastFailedLoginAt: null,
        lastLoginAt: now,
      };
      let method: "totp" | "recovery_code";
      let remainingRecoveryCodes: number | undefined;
      let consumed: boolean;

      if (body.code !== undefined) {
        method = "totp";
        const check = verifyOperatorTotp(
          account.totpSecretEnc,
          body.code,
          account.lastTotpStep,
          now.getTime(),
        );
        if (!check.ok) {
          await registerFailure(account, req);
          await auditFailure(check.reason, account.id);
          return reply.code(401).send(GENERIC_FAILURE);
        }
        // The step is consumed by a conditional update, so two parallel requests with one code cannot
        // both succeed: the loser matches zero rows.
        consumed = await app.prisma.$transaction(async (tx) => {
          const { count } = await tx.operatorAccount.updateMany({
            where: {
              id: account.id,
              OR: [{ lastTotpStep: null }, { lastTotpStep: { lt: check.step } }],
            },
            data: { ...success, lastTotpStep: check.step },
          });
          if (count !== 1) return false;
          await recordOperatorAudit(tx, {
            operatorId: account.id,
            action: OPERATOR_AUDIT_ACTIONS.OPERATOR_LOGIN,
            entity: "OperatorAccount",
            entityId: account.id,
            newValue: { method },
            request: req,
          });
          return true;
        });
      } else {
        method = "recovery_code";
        const check = consumeRecoveryCode(account.recoveryCodeHashes, body.recoveryCode ?? "");
        if (!check.ok) {
          await registerFailure(account, req);
          await auditFailure("INVALID", account.id);
          return reply.code(401).send(GENERIC_FAILURE);
        }
        remainingRecoveryCodes = check.remainingHashes.length;
        consumed = await app.prisma.$transaction(async (tx) => {
          const { count } = await tx.operatorAccount.updateMany({
            where: { id: account.id, recoveryCodeHashes: { equals: account.recoveryCodeHashes } },
            data: { ...success, recoveryCodeHashes: check.remainingHashes },
          });
          if (count !== 1) return false;
          await recordOperatorAudit(tx, {
            operatorId: account.id,
            action: OPERATOR_AUDIT_ACTIONS.OPERATOR_LOGIN,
            entity: "OperatorAccount",
            entityId: account.id,
            newValue: { method },
            request: req,
          });
          await recordOperatorAudit(tx, {
            operatorId: account.id,
            action: OPERATOR_AUDIT_ACTIONS.OPERATOR_RECOVERY_CODE_USED,
            entity: "OperatorAccount",
            entityId: account.id,
            newValue: { remaining: remainingRecoveryCodes },
            request: req,
          });
          return true;
        });
      }

      if (!consumed) {
        await registerFailure(account, req);
        await auditFailure("REPLAY", account.id);
        return reply.code(401).send(GENERIC_FAILURE);
      }

      return {
        accessToken: signOperatorToken(app, account.id, "access"),
        expiresIn: OPERATOR_ACCESS_TOKEN_TTL_SECONDS,
      };
    },
  });

  // GET /api/v1/operator/auth/me
  app.get("/me", {
    config: rateLimitPerMinute,
    schema: {
      tags: ["Betreiber"],
      description: "The signed-in operator account.",
    },
    preHandler: requireOperator,
    handler: async (req, reply) => {
      const account = await app.prisma.operatorAccount.findUnique({
        where: { id: req.operator.sub },
        select: { id: true, email: true, displayName: true, lastLoginAt: true },
      });
      if (!account) return reply.code(401).send({ error: "Unauthorized" });
      return account;
    },
  });
}
