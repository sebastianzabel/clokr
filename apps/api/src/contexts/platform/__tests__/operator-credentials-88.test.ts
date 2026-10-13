/**
 * Phase 88 (#88, D-03/D-03a) — operator account creation, TOTP and recovery codes.
 *
 * DB-backed through the shared test app. Operator rows are never deleted (audit rows reference them
 * with onDelete Restrict and the audit table is append-only), so every test uses a unique synthetic
 * email.
 */
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { TOTP, Secret } from "otpauth";
import { describe, it, expect, afterEach } from "vitest";
import { getTestApp } from "../../../__tests__/setup";
import { decrypt } from "../../../utils/crypto";
import {
  OPERATOR_PASSWORD_POLICY,
  OPERATOR_RECOVERY_CODE_COUNT,
  consumeRecoveryCode,
  createOperatorAccount,
  generateRecoveryCodes,
  hashOperatorEmail,
  verifyOperatorTotp,
} from "../operator-credentials";

const ACTOR = { type: "SCRIPT" as const, user: "vitest", host: "test" };
const PASSWORD = "Op-Test-Passw0rd!2026";
const STEP_MS = 30_000;

function uniqueEmail(): string {
  return `op-cred-${randomBytes(6).toString("hex")}@example.invalid`;
}

async function createOk() {
  const app = await getTestApp();
  const email = uniqueEmail();
  const result = await createOperatorAccount(app.prisma, {
    email,
    displayName: "Test Operator",
    password: PASSWORD,
    actor: ACTOR,
  });
  if (result.status !== "OK") throw new Error(`create failed: ${result.status}`);
  return { app, email, result };
}

function codeAt(secretBase32: string, timestamp: number): string {
  return new TOTP({
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  }).generate({ timestamp });
}

describe("createOperatorAccount (D-03/D-03a)", () => {
  it("stores the TOTP secret encrypted, 10 recovery hashes and a lower-cased email", async () => {
    const app = await getTestApp();
    const email = uniqueEmail().toUpperCase().replace("@EXAMPLE.INVALID", "@example.invalid");
    const result = await createOperatorAccount(app.prisma, {
      email: `  ${email}  `,
      displayName: "Test Operator",
      password: PASSWORD,
      actor: ACTOR,
    });
    expect(result.status).toBe("OK");
    if (result.status !== "OK") return;

    const row = await app.prisma.operatorAccount.findUniqueOrThrow({
      where: { id: result.account.id },
    });
    expect(row.email).toBe(email.toLowerCase());
    expect(row.totpSecretEnc).not.toBeNull();
    expect(row.totpSecretEnc).not.toBe(result.enrollment.secretBase32);
    expect(decrypt(row.totpSecretEnc!)).toBe(result.enrollment.secretBase32);
    expect(row.totpEnabledAt).not.toBeNull();
    expect(row.recoveryCodeHashes).toHaveLength(OPERATOR_RECOVERY_CODE_COUNT);
    for (const code of result.recoveryCodes) {
      expect(row.recoveryCodeHashes).not.toContain(code);
    }
    expect(await bcrypt.compare(PASSWORD, row.passwordHash)).toBe(true);
    expect(row.isActive).toBe(true);
  });

  it("writes exactly one OPERATOR_CREATED audit row with a SCRIPT actor and no operator id", async () => {
    const { app, result } = await createOk();
    const rows = await app.prisma.operatorAuditLog.findMany({
      where: { entityId: result.account.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("OPERATOR_CREATED");
    expect(rows[0].operatorId).toBeNull();
    expect(rows[0].entity).toBe("OperatorAccount");
    expect((rows[0].newValue as { actor: { type: string } }).actor.type).toBe("SCRIPT");
    // No credential material in the audit row.
    const serialized = JSON.stringify(rows[0].newValue);
    expect(serialized).not.toContain(result.enrollment.secretBase32);
  });

  it("rejects a duplicate email with EMAIL_TAKEN and writes no second audit row", async () => {
    const { app, email, result } = await createOk();
    const second = await createOperatorAccount(app.prisma, {
      email,
      displayName: "Other",
      password: PASSWORD,
      actor: ACTOR,
    });
    expect(second.status).toBe("EMAIL_TAKEN");
    const audits = await app.prisma.operatorAuditLog.count({
      where: { entityId: result.account.id },
    });
    expect(audits).toBe(1);
  });

  it("rejects a password below the operator policy with the German policy errors", async () => {
    const app = await getTestApp();
    const result = await createOperatorAccount(app.prisma, {
      email: uniqueEmail(),
      displayName: "Weak",
      password: "Short1!",
      actor: ACTOR,
    });
    expect(result.status).toBe("INVALID");
    if (result.status !== "INVALID") return;
    expect(OPERATOR_PASSWORD_POLICY.passwordMinLength).toBe(16);
    expect(result.errors.join(" ")).toMatch(/16/);
  });

  it("rejects an invalid email address", async () => {
    const app = await getTestApp();
    const result = await createOperatorAccount(app.prisma, {
      email: "not-an-email",
      displayName: "Bad",
      password: PASSWORD,
      actor: ACTOR,
    });
    expect(result.status).toBe("INVALID");
  });
});

describe("verifyOperatorTotp (replay guard, window 1)", () => {
  it("accepts the current code with its step and refuses the same step again", async () => {
    const { result } = await createOk();
    const row = await (
      await getTestApp()
    ).prisma.operatorAccount.findUniqueOrThrow({
      where: { id: result.account.id },
    });
    const now = Date.now();
    const code = codeAt(result.enrollment.secretBase32, now);

    const first = verifyOperatorTotp(row.totpSecretEnc!, code, null, now);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.step).toBe(Math.floor(now / STEP_MS));

    const replay = verifyOperatorTotp(row.totpSecretEnc!, code, first.step, now);
    expect(replay).toEqual({ ok: false, reason: "REPLAY" });
  });

  it("accepts the previous step inside the window and refuses a code two steps old", async () => {
    const { result } = await createOk();
    const row = await (
      await getTestApp()
    ).prisma.operatorAccount.findUniqueOrThrow({
      where: { id: result.account.id },
    });
    const now = Date.now();
    const previous = verifyOperatorTotp(
      row.totpSecretEnc!,
      codeAt(result.enrollment.secretBase32, now - STEP_MS),
      null,
      now,
    );
    expect(previous.ok).toBe(true);
    if (previous.ok) expect(previous.step).toBe(Math.floor(now / STEP_MS) - 1);

    const stale = verifyOperatorTotp(
      row.totpSecretEnc!,
      codeAt(result.enrollment.secretBase32, now - 3 * STEP_MS),
      null,
      now,
    );
    expect(stale).toEqual({ ok: false, reason: "INVALID" });
  });

  it("accepts a later step after an earlier one was consumed", async () => {
    const { result } = await createOk();
    const row = await (
      await getTestApp()
    ).prisma.operatorAccount.findUniqueOrThrow({
      where: { id: result.account.id },
    });
    const now = Date.now();
    const current = verifyOperatorTotp(
      row.totpSecretEnc!,
      codeAt(result.enrollment.secretBase32, now),
      null,
      now,
    );
    if (!current.ok) throw new Error("current code must verify");
    const next = verifyOperatorTotp(
      row.totpSecretEnc!,
      codeAt(result.enrollment.secretBase32, now + STEP_MS),
      current.step,
      now,
    );
    expect(next.ok).toBe(true);
  });

  it("refuses a wrong code", async () => {
    const { result } = await createOk();
    const row = await (
      await getTestApp()
    ).prisma.operatorAccount.findUniqueOrThrow({
      where: { id: result.account.id },
    });
    const now = Date.now();
    const right = codeAt(result.enrollment.secretBase32, now);
    const wrong = right === "000000" ? "000001" : "000000";
    expect(verifyOperatorTotp(row.totpSecretEnc!, wrong, null, now)).toEqual({
      ok: false,
      reason: "INVALID",
    });
  });
});

describe("recovery codes", () => {
  it("accepts a valid code once, leaves 9 hashes, and refuses it a second time", () => {
    const { codes, hashes } = generateRecoveryCodes();
    expect(codes).toHaveLength(OPERATOR_RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(OPERATOR_RECOVERY_CODE_COUNT);

    const used = consumeRecoveryCode(hashes, codes[3]);
    expect(used.ok).toBe(true);
    if (!used.ok) return;
    expect(used.remainingHashes).toHaveLength(OPERATOR_RECOVERY_CODE_COUNT - 1);

    expect(consumeRecoveryCode(used.remainingHashes, codes[3])).toEqual({ ok: false });
  });

  it("normalises case and separators of the typed code", () => {
    const { codes, hashes } = generateRecoveryCodes();
    const typed = codes[0].toLowerCase().replace(/-/g, " ");
    expect(consumeRecoveryCode(hashes, typed).ok).toBe(true);
  });

  it("refuses a random code", () => {
    const { hashes } = generateRecoveryCodes();
    expect(consumeRecoveryCode(hashes, "AAAA-BBBB-CCCC-DDDD")).toEqual({ ok: false });
  });
});

describe("hashOperatorEmail", () => {
  const original = process.env.ENCRYPTION_KEY;
  afterEach(() => {
    process.env.ENCRYPTION_KEY = original;
  });

  it("is stable per input, case/whitespace-insensitive, keyed, and not a plain SHA-256", () => {
    const email = "Someone@Example.invalid";
    const value = hashOperatorEmail(email);
    expect(hashOperatorEmail("  someone@example.invalid ")).toBe(value);
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(value).not.toBe(createHash("sha256").update("someone@example.invalid").digest("hex"));

    process.env.ENCRYPTION_KEY = "another-encryption-key-with-more-than-32-chars!!";
    expect(hashOperatorEmail(email)).not.toBe(value);
  });
});
