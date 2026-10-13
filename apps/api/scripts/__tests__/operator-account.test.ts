/**
 * Phase 88 (#88, D-03) — operator account CLI: argument parsing, import safety, and the audited
 * reset-mfa / deactivate paths it drives.
 *
 * `pg` is mocked and `process.exit` spied for the import-safety case, modelled on
 * script-import-safety.test.ts (Issue #203): the red state of a regressed run-guard is a constructed pool,
 * never a live connection or a killed worker.
 */
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestApp, seedOperator } from "../../src/__tests__/setup";
import { decrypt } from "../../src/utils/crypto";
import {
  deactivateOperatorAccount,
  resetOperatorMfa,
} from "../../src/contexts/platform/operator-credentials";

const poolCtor = vi.fn();

// `pg` is mocked only inside the import-safety case (vi.doMock, fresh module graph): the DB-backed cases
// below drive the real test app and need the real driver.
function mockPg(): void {
  vi.doMock("pg", () => ({
    default: {
      Pool: class {
        constructor(...args: unknown[]) {
          poolCtor(...args);
        }
        connect() {
          return Promise.resolve();
        }
        query() {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        end() {
          return Promise.resolve();
        }
      },
    },
  }));
}

const ACTOR = { type: "SCRIPT" as const, user: "vitest", host: "test" };

describe("parseOperatorAccountArgs", () => {
  it("parses a create invocation with optional --apply", async () => {
    const { parseOperatorAccountArgs } = await import("../operator-account");
    expect(parseOperatorAccountArgs(["--create", "--email", "a@example.invalid"])).toMatchObject({
      mode: "create",
      email: "a@example.invalid",
      apply: false,
    });
    expect(
      parseOperatorAccountArgs([
        "--create",
        "--email",
        "a@example.invalid",
        "--display-name",
        "A",
        "--apply",
      ]),
    ).toMatchObject({ mode: "create", displayName: "A", apply: true });
  });

  it("parses the reset-mfa and deactivate modes", async () => {
    const { parseOperatorAccountArgs } = await import("../operator-account");
    expect(parseOperatorAccountArgs(["--reset-mfa", "--email", "a@example.invalid"]).mode).toBe(
      "reset-mfa",
    );
    expect(parseOperatorAccountArgs(["--deactivate", "--email", "a@example.invalid"]).mode).toBe(
      "deactivate",
    );
  });

  it("rejects zero or two mode flags", async () => {
    const { parseOperatorAccountArgs } = await import("../operator-account");
    expect(() => parseOperatorAccountArgs(["--email", "a@example.invalid"])).toThrow(/mode/i);
    expect(() =>
      parseOperatorAccountArgs(["--create", "--deactivate", "--email", "a@example.invalid"]),
    ).toThrow(/mode/i);
  });

  it("rejects a missing --email and an unknown flag", async () => {
    const { parseOperatorAccountArgs } = await import("../operator-account");
    expect(() => parseOperatorAccountArgs(["--create"])).toThrow(/email/i);
    expect(() =>
      parseOperatorAccountArgs(["--create", "--email", "a@example.invalid", "--password", "x"]),
    ).toThrow();
  });
});

describe("importing scripts/operator-account.ts (Issue #203 class)", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    poolCtor.mockClear();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code}) during script import`);
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("constructs no database pool and never exits the process", async () => {
    // Arrange a complete --apply invocation: without the run-guard, main() would read it from argv and
    // construct a pool. With the guard, argv[1] is not this module, so nothing runs.
    const originalArgv = process.argv;
    const originalExitCode = process.exitCode;
    const originalDbUrl = process.env.DATABASE_URL;
    process.argv = [
      "node",
      "/somewhere/else.ts",
      "--create",
      "--email",
      "import-safety@example.invalid",
      "--display-name",
      "Import Safety",
      "--apply",
    ];
    process.env.DATABASE_URL = "postgresql://unused:unused@127.0.0.1:1/unused";
    vi.resetModules();
    mockPg();
    try {
      await import("../operator-account");
      // main() is asynchronous; give a regressed guard the chance to reach the pool constructor.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      vi.doUnmock("pg");
      vi.resetModules();
      process.argv = originalArgv;
      process.env.DATABASE_URL = originalDbUrl;
    }
    const exitCodeAfter = process.exitCode;
    process.exitCode = originalExitCode;
    expect(poolCtor).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(exitCodeAfter).toBe(originalExitCode);
  });
});

describe("resetOperatorMfa", () => {
  it("replaces secret and recovery codes, clears lockout and replay state, and audits once", async () => {
    const app = await getTestApp();
    const operator = await seedOperator(app);
    await app.prisma.operatorAccount.update({
      where: { id: operator.id },
      data: {
        lastTotpStep: 12345,
        failedLoginAttempts: 4,
        lockedUntil: new Date(Date.now() + 600_000),
      },
    });
    const before = await app.prisma.operatorAccount.findUniqueOrThrow({
      where: { id: operator.id },
    });

    const result = await resetOperatorMfa(app.prisma, { email: operator.email, actor: ACTOR });
    expect(result.status).toBe("OK");
    if (result.status !== "OK") return;
    expect(result.recoveryCodes).toHaveLength(10);

    const after = await app.prisma.operatorAccount.findUniqueOrThrow({
      where: { id: operator.id },
    });
    expect(after.totpSecretEnc).not.toBe(before.totpSecretEnc);
    expect(decrypt(after.totpSecretEnc!)).toBe(result.enrollment.secretBase32);
    expect(decrypt(after.totpSecretEnc!)).not.toBe(operator.secretBase32);
    expect(after.recoveryCodeHashes).toHaveLength(10);
    expect(after.recoveryCodeHashes).not.toEqual(before.recoveryCodeHashes);
    expect(after.lastTotpStep).toBeNull();
    expect(after.failedLoginAttempts).toBe(0);
    expect(after.lockedUntil).toBeNull();

    const audits = await app.prisma.operatorAuditLog.findMany({
      where: { entityId: operator.id, action: "OPERATOR_MFA_RESET" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].operatorId).toBeNull();
    expect(JSON.stringify(audits[0].newValue)).not.toContain(result.enrollment.secretBase32);
  });

  it("answers NOT_FOUND for an unknown email and writes no audit row", async () => {
    const app = await getTestApp();
    const email = `op-missing-${randomBytes(6).toString("hex")}@example.invalid`;
    const result = await resetOperatorMfa(app.prisma, { email, actor: ACTOR });
    expect(result).toEqual({ status: "NOT_FOUND" });
  });
});

describe("deactivateOperatorAccount", () => {
  it("deactivates once with one audit row; a second call is ALREADY_INACTIVE without a second row", async () => {
    const app = await getTestApp();
    const operator = await seedOperator(app);

    expect(
      await deactivateOperatorAccount(app.prisma, { email: operator.email, actor: ACTOR }),
    ).toEqual({
      status: "OK",
    });
    const row = await app.prisma.operatorAccount.findUniqueOrThrow({ where: { id: operator.id } });
    expect(row.isActive).toBe(false);

    expect(
      await deactivateOperatorAccount(app.prisma, { email: operator.email, actor: ACTOR }),
    ).toEqual({
      status: "ALREADY_INACTIVE",
    });
    const audits = await app.prisma.operatorAuditLog.findMany({
      where: { entityId: operator.id, action: "OPERATOR_DEACTIVATED" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].operatorId).toBeNull();
  });

  it("answers NOT_FOUND for an unknown email", async () => {
    const app = await getTestApp();
    const email = `op-missing-${randomBytes(6).toString("hex")}@example.invalid`;
    expect(await deactivateOperatorAccount(app.prisma, { email, actor: ACTOR })).toEqual({
      status: "NOT_FOUND",
    });
  });
});

describe("seedOperator", () => {
  it("returns a usable operator whose totpFor() codes verify and differ per offset", async () => {
    const app = await getTestApp();
    const operator = await seedOperator(app);
    const row = await app.prisma.operatorAccount.findUniqueOrThrow({ where: { id: operator.id } });
    const { verifyOperatorTotp } = await import("../../src/contexts/platform/operator-credentials");

    const now = Date.now();
    const verified = verifyOperatorTotp(row.totpSecretEnc!, operator.totpFor(0), null, now);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    // The +1 code is the next step: acceptable inside the window and not a replay of step 0.
    expect(verifyOperatorTotp(row.totpSecretEnc!, operator.totpFor(1), verified.step, now).ok).toBe(
      true,
    );
    expect(operator.recoveryCodes).toHaveLength(10);
    expect(operator.email).toMatch(/@example\.invalid$/);
  });
});
