/**
 * Issue #608 - shared fixtures of the web-push tests (a helper, not a test file).
 *
 * Every push test mocks `web-push` itself (`vi.hoisted` + `vi.mock("web-push", ...)`), so no test
 * ever reaches the network. A push-enabled test builds its OWN app through `buildPushEnabledApp()`
 * because the VAPID set is read once, when `config.ts` loads; the suite default stays "push off".
 */
import { createECDH, randomBytes } from "node:crypto";
import { vi } from "vitest";
import type { FastifyInstance } from "fastify";

/** A fresh P-256 VAPID pair (base64url), generated per test process — no key material in the repo. */
export function generateTestVapidPair(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const raw = ecdh.getPrivateKey();
  // A private scalar with leading zero bytes comes back shorter than 32 bytes; VAPID needs exactly 32.
  const privateKey = Buffer.concat([Buffer.alloc(32 - raw.length), raw]);
  return {
    publicKey: ecdh.getPublicKey().toString("base64url"),
    privateKey: privateKey.toString("base64url"),
  };
}

// TEST ONLY - generated at load time so no private key is committed (gitleaks generic-api-key).
export const TEST_VAPID = {
  ...generateTestVapidPair(),
  subject: "mailto:push-test@example.invalid",
} as const;

const VAPID_ENV_KEYS = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const;
const savedEnv = new Map<string, string | undefined>();

/** Sets the TEST VAPID pair, resets the module registry and builds a fresh app (operator-surface-off pattern). */
export async function buildPushEnabledApp(): Promise<FastifyInstance> {
  for (const key of VAPID_ENV_KEYS) savedEnv.set(key, process.env[key]);
  process.env.VAPID_PUBLIC_KEY = TEST_VAPID.publicKey;
  process.env.VAPID_PRIVATE_KEY = TEST_VAPID.privateKey;
  process.env.VAPID_SUBJECT = TEST_VAPID.subject;
  vi.resetModules();
  const { buildApp } = await import("../app");
  const app = await buildApp();
  await app.ready();
  return app;
}

/** Restores the environment and the module registry; call in `afterAll` after closing the app. */
export function restorePushEnv(): void {
  for (const key of VAPID_ENV_KEYS) {
    const previous = savedEnv.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  savedEnv.clear();
  vi.resetModules();
}

/** A browser PushSubscription.toJSON() body with random endpoint path and valid keys. */
export function fakeDeviceSubscription(host = "fcm.googleapis.com"): {
  endpoint: string;
  expirationTime: null;
  keys: { p256dh: string; auth: string };
} {
  // A real P-256 public key: the API refuses a value that is not a point on the curve.
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const p256dh = ecdh.getPublicKey().toString("base64url");
  return {
    endpoint: `https://${host}/fcm/send/${randomBytes(24).toString("base64url")}`,
    expirationTime: null,
    keys: { p256dh, auth: randomBytes(16).toString("base64url") },
  };
}

export const CHROME_ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
