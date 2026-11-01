/**
 * Issue #608 - shared fixtures of the web-push tests (a helper, not a test file).
 *
 * Every push test mocks `web-push` itself (`vi.hoisted` + `vi.mock("web-push", ...)`), so no test
 * ever reaches the network. A push-enabled test builds its OWN app through `buildPushEnabledApp()`
 * because the VAPID set is read once, when `config.ts` loads; the suite default stays "push off".
 */
import { randomBytes } from "node:crypto";
import { vi } from "vitest";
import type { FastifyInstance } from "fastify";

// TEST ONLY - never configure this pair on any stage. It exists to satisfy the boot-time pair check
// of config.ts; the private half is public knowledge by being in the repository.
export const TEST_VAPID = {
  publicKey:
    "BAu57iP39TQJuPIh_AVkodlSC-gxZD376ztBgX4J8u6bbe-zzEc5nmdxHgb7uosPB6M5VPIS9Dx4LSzRWdW2Q7Q",
  privateKey: "gZCaBgvibUKLRBFXDMQ4z2KKZ42OTAn3VzC9YQOxPr0",
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

/** A browser PushSubscription.toJSON() body with random endpoint path and correctly shaped keys. */
export function fakeDeviceSubscription(host = "fcm.googleapis.com"): {
  endpoint: string;
  expirationTime: null;
  keys: { p256dh: string; auth: string };
} {
  const p256dh = Buffer.concat([Buffer.from([0x04]), randomBytes(64)]).toString("base64url");
  return {
    endpoint: `https://${host}/fcm/send/${randomBytes(24).toString("base64url")}`,
    expirationTime: null,
    keys: { p256dh, auth: randomBytes(16).toString("base64url") },
  };
}

export const CHROME_ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
