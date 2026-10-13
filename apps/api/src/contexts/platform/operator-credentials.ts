/**
 * Operator account credentials and lifecycle (Phase 88, #88, D-03/D-03a).
 *
 * An operator account is the principal ABOVE the tenant. It is created only by the server CLI
 * (`scripts/operator-account.ts`, D-03) and always has a second factor from birth (D-03a):
 *   - a TOTP secret (RFC 6238 via `otpauth`, SHA1 / 6 digits / 30 s), stored only encrypted with
 *     `utils/crypto.ts`;
 *   - 10 single-use recovery codes, stored only as SHA-256 hashes.
 *
 * Why not the email OTP tenant users have: `OtpToken` has a foreign key onto `User` (an operator is
 * none) and the tenant's SMTP configuration is looked up per tenant, which an operator does not have.
 *
 * Every lifecycle step (create, MFA reset, deactivate) writes exactly one `OperatorAuditLog` row in the
 * SAME transaction as the change (D-07) — never a tenant `AuditLog` row. An MFA reset (and, since Issue
 * #557, a deactivation) increments `OperatorAccount.tokenVersion` in that same transaction, which ends every
 * operator token already issued. The constants below are the ONE place the operator password policy,
 * lockout thresholds and TOTP parameters live.
 */

import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { Secret, TOTP } from "otpauth";
import { z } from "zod";
import type { PrismaClient } from "@clokr/db";
import { decrypt, encrypt } from "../../utils/crypto";
import { OPERATOR_AUDIT_ACTIONS, recordOperatorAudit } from "./operator-audit";
import { validatePassword, type PasswordPolicy } from "./password-policy";

// ── Constants ──────────────────────────────────────────────────────────────

export const OPERATOR_LOGIN_MAX_ATTEMPTS = 5;
export const OPERATOR_LOCKOUT_MINUTES = 15;
export const OPERATOR_RECOVERY_CODE_COUNT = 10;

/** Constant policy for operator passwords — deliberately not tenant-configurable. */
export const OPERATOR_PASSWORD_POLICY: PasswordPolicy = {
  passwordMinLength: 16,
  passwordRequireUpper: true,
  passwordRequireLower: true,
  passwordRequireDigit: true,
  passwordRequireSpecial: true,
};

const BCRYPT_COST = 12;

export const OPERATOR_TOTP_ISSUER = "Clokr Betrieb";
export const OPERATOR_TOTP_PERIOD_SECONDS = 30;
const OPERATOR_TOTP_DIGITS = 6;
const OPERATOR_TOTP_WINDOW = 1;
const OPERATOR_TOTP_SECRET_BYTES = 20;

// ── Email normalisation and keyed hash ─────────────────────────────────────

export function normalizeOperatorEmail(email: string): string {
  return email.trim().toLowerCase();
}

let emailHmacKeyCache: { secret: string; key: Buffer } | undefined;

/** Server-side key for the email HMAC, derived once per `ENCRYPTION_KEY` value (HKDF-SHA256). */
function emailHmacKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error("ENCRYPTION_KEY must be set (min 32 chars)");
  }
  if (emailHmacKeyCache?.secret !== secret) {
    const key = Buffer.from(
      hkdfSync("sha256", secret, "clokr-salt", "clokr-operator-email-hmac", 32),
    );
    emailHmacKeyCache = { secret, key };
  }
  return emailHmacKeyCache.key;
}

/**
 * Keyed identifier of an attempted login address for failed-login audit rows. A keyed HMAC, not a plain
 * hash: without the server key the value cannot be confirmed by hashing a guessed address, and the
 * attempted string itself is never stored.
 */
export function hashOperatorEmail(email: string): string {
  return createHmac("sha256", emailHmacKey()).update(normalizeOperatorEmail(email)).digest("hex");
}

// ── TOTP ───────────────────────────────────────────────────────────────────

function totpFor(secretBase32: string, label: string): TOTP {
  return new TOTP({
    issuer: OPERATOR_TOTP_ISSUER,
    label,
    algorithm: "SHA1",
    digits: OPERATOR_TOTP_DIGITS,
    period: OPERATOR_TOTP_PERIOD_SECONDS,
    secret: Secret.fromBase32(secretBase32),
  });
}

export type TotpEnrollment = {
  secretBase32: string;
  otpauthUri: string;
  /** The secret encrypted for storage in `OperatorAccount.totpSecretEnc`. */
  secretEnc: string;
};

/** Fresh TOTP secret for `email`: the plain values are shown to the operator once, only `secretEnc` is stored. */
export function createTotpEnrollment(email: string): TotpEnrollment {
  const secretBase32 = new Secret({ size: OPERATOR_TOTP_SECRET_BYTES }).base32;
  const otpauthUri = totpFor(secretBase32, normalizeOperatorEmail(email)).toString();
  return { secretBase32, otpauthUri, secretEnc: encrypt(secretBase32) };
}

export type TotpVerification =
  { ok: true; step: number } | { ok: false; reason: "INVALID" | "REPLAY" };

/**
 * Checks a TOTP code (window 1 = the previous, current and next 30 s step). The matched step must be
 * greater than `lastTotpStep`, so a code is accepted at most once. Pure: persisting the returned step is
 * the caller's job.
 */
export function verifyOperatorTotp(
  secretEnc: string,
  code: string,
  lastTotpStep: number | null,
  nowMs: number,
): TotpVerification {
  const totp = totpFor(decrypt(secretEnc), "operator");
  const delta = totp.validate({
    token: code.replace(/\s+/g, ""),
    window: OPERATOR_TOTP_WINDOW,
    timestamp: nowMs,
  });
  if (delta === null) return { ok: false, reason: "INVALID" };
  const step = Math.floor(nowMs / (OPERATOR_TOTP_PERIOD_SECONDS * 1000)) + delta;
  if (lastTotpStep !== null && step <= lastTotpStep) return { ok: false, reason: "REPLAY" };
  return { ok: true, step };
}

// ── Recovery codes ─────────────────────────────────────────────────────────

/** 32 unambiguous characters (no 0/O/1/I), so `byte & 31` maps without modulo bias. */
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RECOVERY_GROUPS = 4;
const RECOVERY_GROUP_LENGTH = 4;

function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
}

function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_GROUPS * RECOVERY_GROUP_LENGTH);
  const groups: string[] = [];
  for (let g = 0; g < RECOVERY_GROUPS; g++) {
    let group = "";
    for (let i = 0; i < RECOVERY_GROUP_LENGTH; i++) {
      group += RECOVERY_ALPHABET[bytes[g * RECOVERY_GROUP_LENGTH + i] & 31];
    }
    groups.push(group);
  }
  return groups.join("-");
}

/** Ten recovery codes (shown once) and their SHA-256 hashes (stored). */
export function generateRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: OPERATOR_RECOVERY_CODE_COUNT }, generateRecoveryCode);
  return { codes, hashes: codes.map(hashRecoveryCode) };
}

/**
 * Consumes a recovery code: ok with the hashes that remain (the used one removed), or not ok. Every
 * stored hash is compared in constant time with no early exit.
 */
export function consumeRecoveryCode(
  hashes: string[],
  code: string,
): { ok: true; remainingHashes: string[] } | { ok: false } {
  const candidate = Buffer.from(hashRecoveryCode(code), "hex");
  let matchIndex = -1;
  hashes.forEach((stored, index) => {
    const storedBuf = Buffer.from(stored, "hex");
    if (storedBuf.length === candidate.length && timingSafeEqual(storedBuf, candidate)) {
      if (matchIndex === -1) matchIndex = index;
    }
  });
  if (matchIndex === -1) return { ok: false };
  return { ok: true, remainingHashes: hashes.filter((_, index) => index !== matchIndex) };
}

// ── Account lifecycle ──────────────────────────────────────────────────────

export type OperatorActor = { type: "SCRIPT"; user: string; host: string };

const createInputSchema = z.object({
  email: z.string().max(254).email(),
  displayName: z.string().trim().min(1).max(100),
});

export type CreateOperatorAccountInput = {
  email: string;
  displayName: string;
  password: string;
  actor: OperatorActor;
};

export type CreateOperatorAccountResult =
  | {
      status: "OK";
      account: { id: string; email: string; displayName: string };
      enrollment: { secretBase32: string; otpauthUri: string };
      recoveryCodes: string[];
    }
  | { status: "EMAIL_TAKEN" }
  | { status: "INVALID"; errors: string[] };

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002"
  );
}

export async function createOperatorAccount(
  db: PrismaClient,
  input: CreateOperatorAccountInput,
): Promise<CreateOperatorAccountResult> {
  const email = normalizeOperatorEmail(input.email);
  const parsed = createInputSchema.safeParse({ email, displayName: input.displayName });
  if (!parsed.success) {
    return { status: "INVALID", errors: parsed.error.issues.map((i) => i.message) };
  }
  const passwordCheck = validatePassword(input.password, OPERATOR_PASSWORD_POLICY);
  if (!passwordCheck.valid) return { status: "INVALID", errors: passwordCheck.errors };

  if (await db.operatorAccount.findUnique({ where: { email }, select: { id: true } })) {
    return { status: "EMAIL_TAKEN" };
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
  const enrollment = createTotpEnrollment(email);
  const recovery = generateRecoveryCodes();

  try {
    const account = await db.$transaction(async (tx) => {
      const created = await tx.operatorAccount.create({
        data: {
          email,
          displayName: parsed.data.displayName,
          passwordHash,
          totpSecretEnc: enrollment.secretEnc,
          totpEnabledAt: new Date(),
          recoveryCodeHashes: recovery.hashes,
        },
        select: { id: true, email: true, displayName: true },
      });
      await recordOperatorAudit(tx, {
        operatorId: null,
        action: OPERATOR_AUDIT_ACTIONS.OPERATOR_CREATED,
        entity: "OperatorAccount",
        entityId: created.id,
        newValue: {
          actor: input.actor,
          totpEnrolled: true,
          recoveryCodes: OPERATOR_RECOVERY_CODE_COUNT,
        },
      });
      return created;
    });
    return {
      status: "OK",
      account,
      enrollment: { secretBase32: enrollment.secretBase32, otpauthUri: enrollment.otpauthUri },
      recoveryCodes: recovery.codes,
    };
  } catch (error) {
    if (isUniqueViolation(error)) return { status: "EMAIL_TAKEN" };
    throw error;
  }
}

export type ResetOperatorMfaResult =
  | {
      status: "OK";
      enrollment: { secretBase32: string; otpauthUri: string };
      recoveryCodes: string[];
    }
  | { status: "NOT_FOUND" };

/**
 * Replaces the authenticator secret and all recovery codes of an operator (lost device) and clears lockout
 * state. Every token already issued for the account (access token and pending challenge) ends with it: the
 * token version is incremented in the same transaction as the audit row (Issue #557).
 */
export async function resetOperatorMfa(
  db: PrismaClient,
  input: { email: string; actor: OperatorActor },
): Promise<ResetOperatorMfaResult> {
  const email = normalizeOperatorEmail(input.email);
  const existing = await db.operatorAccount.findUnique({ where: { email }, select: { id: true } });
  if (!existing) return { status: "NOT_FOUND" };

  const enrollment = createTotpEnrollment(email);
  const recovery = generateRecoveryCodes();
  await db.$transaction(async (tx) => {
    // Incrementing the token version ends every token already issued for the account (Issue #557). The
    // old value is derived from the returned one: the increment is atomic, so it stays exact under
    // concurrent resets.
    const { tokenVersion } = await tx.operatorAccount.update({
      where: { id: existing.id },
      data: {
        totpSecretEnc: enrollment.secretEnc,
        totpEnabledAt: new Date(),
        lastTotpStep: null,
        recoveryCodeHashes: recovery.hashes,
        failedLoginAttempts: 0,
        lockedUntil: null,
        tokenVersion: { increment: 1 },
      },
      select: { tokenVersion: true },
    });
    await recordOperatorAudit(tx, {
      operatorId: null,
      action: OPERATOR_AUDIT_ACTIONS.OPERATOR_MFA_RESET,
      entity: "OperatorAccount",
      entityId: existing.id,
      oldValue: { tokenVersion: tokenVersion - 1 },
      newValue: {
        actor: input.actor,
        recoveryCodes: OPERATOR_RECOVERY_CODE_COUNT,
        sessionsRevoked: true,
        tokenVersion,
      },
    });
  });
  return {
    status: "OK",
    enrollment: { secretBase32: enrollment.secretBase32, otpauthUri: enrollment.otpauthUri },
    recoveryCodes: recovery.codes,
  };
}

export type DeactivateOperatorAccountResult =
  { status: "OK" } | { status: "NOT_FOUND" } | { status: "ALREADY_INACTIVE" };

/**
 * Offboarding: the account stays (audit rows reference it with onDelete Restrict) but can no longer sign in.
 * Every token already issued is refused from the next request on: the token version is incremented in the
 * same transaction as the audit row (Issue #557).
 */
export async function deactivateOperatorAccount(
  db: PrismaClient,
  input: { email: string; actor: OperatorActor },
): Promise<DeactivateOperatorAccountResult> {
  const email = normalizeOperatorEmail(input.email);
  const existing = await db.operatorAccount.findUnique({
    where: { email },
    select: { id: true, isActive: true },
  });
  if (!existing) return { status: "NOT_FOUND" };
  if (!existing.isActive) return { status: "ALREADY_INACTIVE" };

  await db.$transaction(async (tx) => {
    const { tokenVersion } = await tx.operatorAccount.update({
      where: { id: existing.id },
      data: { isActive: false, tokenVersion: { increment: 1 } },
      select: { tokenVersion: true },
    });
    await recordOperatorAudit(tx, {
      operatorId: null,
      action: OPERATOR_AUDIT_ACTIONS.OPERATOR_DEACTIVATED,
      entity: "OperatorAccount",
      entityId: existing.id,
      oldValue: { isActive: true, tokenVersion: tokenVersion - 1 },
      newValue: { isActive: false, actor: input.actor, sessionsRevoked: true, tokenVersion },
    });
  });
  return { status: "OK" };
}
