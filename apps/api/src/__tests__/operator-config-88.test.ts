/**
 * Phase 88 (#88, D-02a) — OPERATOR_JWT_SECRET configuration contract.
 *
 * The secret is optional: unset or blank means the operator surface is off and every existing
 * deployment boots unchanged. When set it must be at least 32 characters and must differ from the
 * tenant secrets. `config.ts` evaluates `process.env` at import time and calls `process.exit(1)`
 * on an invalid environment, so each case resets the module graph, sets a complete environment
 * and re-imports the module (same pattern as test-bootstrap.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const BASE_ENV: Record<string, string> = {
  DATABASE_URL: "postgresql://clokr:password@localhost:5432/clokr_test",
  JWT_SECRET: "config-test-jwt-secret-min-32-characters",
  JWT_REFRESH_SECRET: "config-test-refresh-secret-min-32-chars",
  ENCRYPTION_KEY: "config-test-encryption-key-min-32-characters",
};

const VALID_OPERATOR_SECRET = "config-test-operator-secret-min-32-chars!";

const MANAGED_KEYS = [...Object.keys(BASE_ENV), "OPERATOR_JWT_SECRET"];

let savedEnv: Record<string, string | undefined>;
let exitSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

/** Set a complete environment, then import a fresh copy of config.ts. */
async function loadConfig(overrides: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  return (await import("../config")) as typeof import("../config");
}

/** Everything config.ts printed through console.error, flattened to one string. */
function printedErrors(): string {
  return errorSpy.mock.calls.map((call: unknown[]) => JSON.stringify(call)).join("\n");
}

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_KEYS) savedEnv[key] = process.env[key];
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const key of MANAGED_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  exitSpy.mockRestore();
  errorSpy.mockRestore();
  vi.resetModules();
});

describe("Phase 88: OPERATOR_JWT_SECRET configuration", () => {
  it("is undefined when the variable is unset (operator surface off)", async () => {
    const { config } = await loadConfig({ OPERATOR_JWT_SECRET: undefined });
    expect(config.OPERATOR_JWT_SECRET).toBeUndefined();
  });

  it("maps an empty string to undefined (compose renders unset variables as empty)", async () => {
    const { config } = await loadConfig({ OPERATOR_JWT_SECRET: "" });
    expect(config.OPERATOR_JWT_SECRET).toBeUndefined();
  });

  it("maps a whitespace-only value to undefined", async () => {
    const { config } = await loadConfig({ OPERATOR_JWT_SECRET: "   " });
    expect(config.OPERATOR_JWT_SECRET).toBeUndefined();
  });

  it("fails boot with exit code 1 for a 31-character value", async () => {
    await expect(loadConfig({ OPERATOR_JWT_SECRET: "x".repeat(31) })).rejects.toThrow(
      "process.exit(1)",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(printedErrors()).toContain("OPERATOR_JWT_SECRET");
  });

  it("returns the exact value for a valid 32+ character secret", async () => {
    const { config } = await loadConfig({ OPERATOR_JWT_SECRET: VALID_OPERATOR_SECRET });
    expect(config.OPERATOR_JWT_SECRET).toBe(VALID_OPERATOR_SECRET);
  });

  /** A collision with a tenant secret must abort boot and name only the variable, never a value. */
  async function expectCollisionRejected(collidingKey: keyof typeof BASE_ENV) {
    const shared = BASE_ENV[collidingKey];
    await expect(loadConfig({ OPERATOR_JWT_SECRET: shared })).rejects.toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const output = printedErrors();
    expect(output).toContain("OPERATOR_JWT_SECRET must differ from");
    expect(output).not.toContain(shared);
  }

  it("fails boot when OPERATOR_JWT_SECRET equals JWT_SECRET", async () => {
    await expectCollisionRejected("JWT_SECRET");
  });

  it("fails boot when OPERATOR_JWT_SECRET equals JWT_REFRESH_SECRET", async () => {
    await expectCollisionRejected("JWT_REFRESH_SECRET");
  });

  it("fails boot when OPERATOR_JWT_SECRET equals ENCRYPTION_KEY", async () => {
    await expectCollisionRejected("ENCRYPTION_KEY");
  });
});
