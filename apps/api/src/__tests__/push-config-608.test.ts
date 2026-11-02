/**
 * Issue #608 (D-01, OWNER-608-VAPID) - the VAPID configuration contract.
 *
 * The three variables are optional as a SET: all unset (or blank) means push is off and every
 * existing deployment boots unchanged; any other combination must be complete and consistent or the
 * start is refused. `config.ts` evaluates the environment at import time and calls `process.exit(1)`
 * on an invalid one, so each case resets the module graph and re-imports it (operator-config-88).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TEST_VAPID } from "./push-fixtures-608";

const BASE_ENV: Record<string, string> = {
  DATABASE_URL: "postgresql://clokr:password@localhost:5432/clokr_test",
  JWT_SECRET: "config-test-jwt-secret-min-32-characters",
  JWT_REFRESH_SECRET: "config-test-refresh-secret-min-32-chars",
  ENCRYPTION_KEY: "config-test-encryption-key-min-32-characters",
};

// TEST ONLY - a second, valid pair whose public half does not belong to TEST_VAPID's private key.
const OTHER_PAIR = {
  publicKey:
    "BMkz7_uKXouLjR9Def1YeyxxcnMUlSE9F7zSm6RKg09dCbPRZ9pT8Wd7YcoMkkqgZchB5lyXEDTnXId2MnjIvaQ",
  privateKey: "kilq3UFqGt7vwhXDm6gbpooGGmJweyAXBHODsLoQt7s",
};

const VAPID_KEYS = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"];
const MANAGED_KEYS = [...Object.keys(BASE_ENV), ...VAPID_KEYS];

const FULL_SET: Record<string, string | undefined> = {
  VAPID_PUBLIC_KEY: TEST_VAPID.publicKey,
  VAPID_PRIVATE_KEY: TEST_VAPID.privateKey,
  VAPID_SUBJECT: TEST_VAPID.subject,
};

let savedEnv: Record<string, string | undefined>;
let exitSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

/** Sets a complete environment (VAPID unset unless overridden), then imports a fresh config.ts. */
async function loadConfig(overrides: Record<string, string | undefined>) {
  const env = {
    ...BASE_ENV,
    VAPID_PUBLIC_KEY: undefined,
    VAPID_PRIVATE_KEY: undefined,
    VAPID_SUBJECT: undefined,
    ...overrides,
  } as Record<string, string | undefined>;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  return (await import("../config")) as typeof import("../config");
}

function printedErrors(): string {
  return errorSpy.mock.calls.map((call: unknown[]) => JSON.stringify(call)).join("\n");
}

async function expectRefused(overrides: Record<string, string | undefined>) {
  await expect(loadConfig(overrides)).rejects.toThrow("process.exit(1)");
  expect(exitSpy).toHaveBeenCalledWith(1);
  // The private key (and any other value) never reaches the printed errors.
  expect(printedErrors()).not.toContain(TEST_VAPID.privateKey);
  expect(printedErrors()).not.toContain(OTHER_PAIR.privateKey);
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

describe("Issue #608: VAPID configuration", () => {
  it("is off when none of the three variables is set", async () => {
    const { config } = await loadConfig({});
    expect(config.VAPID_PUBLIC_KEY).toBeUndefined();
    expect(config.VAPID_PRIVATE_KEY).toBeUndefined();
    expect(config.VAPID_SUBJECT).toBeUndefined();
  });

  it("treats blank and whitespace-only values as unset (compose renders unset variables as empty)", async () => {
    const { config } = await loadConfig({
      VAPID_PUBLIC_KEY: "",
      VAPID_PRIVATE_KEY: "   ",
      VAPID_SUBJECT: "",
    });
    expect(config.VAPID_PUBLIC_KEY).toBeUndefined();
    expect(config.VAPID_PRIVATE_KEY).toBeUndefined();
    expect(config.VAPID_SUBJECT).toBeUndefined();
  });

  it("loads a valid pair and subject and returns the exact values", async () => {
    const { config } = await loadConfig(FULL_SET);
    expect(config.VAPID_PUBLIC_KEY).toBe(TEST_VAPID.publicKey);
    expect(config.VAPID_PRIVATE_KEY).toBe(TEST_VAPID.privateKey);
    expect(config.VAPID_SUBJECT).toBe(TEST_VAPID.subject);
  });

  it("accepts an https subject", async () => {
    const { config } = await loadConfig({
      ...FULL_SET,
      VAPID_SUBJECT: "https://clokr.example.invalid",
    });
    expect(config.VAPID_SUBJECT).toBe("https://clokr.example.invalid");
  });

  it("refuses a set with only one variable", async () => {
    await expectRefused({ VAPID_PUBLIC_KEY: TEST_VAPID.publicKey });
    expect(printedErrors()).toContain("must be set together or not at all");
  });

  it("refuses a set with only two variables", async () => {
    await expectRefused({
      VAPID_PUBLIC_KEY: TEST_VAPID.publicKey,
      VAPID_PRIVATE_KEY: TEST_VAPID.privateKey,
    });
    expect(printedErrors()).toContain("must be set together or not at all");
  });

  it("refuses a public key of 86 characters", async () => {
    await expectRefused({ ...FULL_SET, VAPID_PUBLIC_KEY: TEST_VAPID.publicKey.slice(0, 86) });
    expect(printedErrors()).toContain("VAPID_PUBLIC_KEY");
  });

  it("refuses a private key of 44 characters", async () => {
    await expectRefused({ ...FULL_SET, VAPID_PRIVATE_KEY: `${TEST_VAPID.privateKey}A` });
    expect(printedErrors()).toContain("VAPID_PRIVATE_KEY");
  });

  it("refuses a key with a character outside base64url", async () => {
    await expectRefused({
      ...FULL_SET,
      VAPID_PUBLIC_KEY: `${TEST_VAPID.publicKey.slice(0, 86)}+`,
    });
  });

  it.each([
    ["http URL", "http://clokr.example.invalid"],
    ["localhost", "https://localhost"],
    ["loopback address", "https://127.0.0.1"],
    ["mailto without @", "mailto:no-at-sign"],
    ["free text", "ops team"],
  ])("refuses the subject %s", async (_name, subject) => {
    await expectRefused({ ...FULL_SET, VAPID_SUBJECT: subject });
    expect(printedErrors()).toContain("VAPID_SUBJECT");
  });

  it("refuses a well-formed public key that does not belong to the private key", async () => {
    await expectRefused({ ...FULL_SET, VAPID_PUBLIC_KEY: OTHER_PAIR.publicKey });
    expect(printedErrors()).toContain("does not belong to");
  });
});
