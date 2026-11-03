// Typed client for the person's own push devices (Issue #608, D-14). Every route lives under
// `/me/push`; the four routes after `/config` answer 404 when the instance has no VAPID keys, so
// the caller reads `getPushConfig()` first and never calls them while `enabled` is false.
import { api } from "$api/client";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PushConfig {
  enabled: boolean;
  /** VAPID public key (base64url) the browser subscribes with; null while push is off. */
  publicKey: string | null;
}

export interface PushDevice {
  id: string;
  deviceLabel: string;
  consentedAt: string;
  lastSuccessAt: string | null;
  /** SHA-256 hex of the endpoint - the endpoint itself (a capability URL) never reaches the web. */
  endpointHash: string;
}

/** What happened to one device of a test push: delivered, removed by the push service, or failed. */
export type PushTestOutcome = "SENT" | "REMOVED" | "FAILED";

export interface PushTestResult {
  devices: { id: string; deviceLabel: string; outcome: PushTestOutcome }[];
}

/** `PushSubscription.toJSON()` as the API expects it. */
export interface PushSubscriptionBody {
  endpoint?: string;
  expirationTime?: number | null;
  keys?: Record<string, string>;
}

/** A device is removed by the endpoint the browser knows, or by the id of the server list. */
export type PushDeviceTarget = { endpoint: string } | { id: string };

// ── API helpers ───────────────────────────────────────────────────────────────

export function getPushConfig(): Promise<PushConfig> {
  return api.get<PushConfig>("/me/push/config");
}

export async function listPushDevices(): Promise<PushDevice[]> {
  const res = await api.get<{ devices: PushDevice[] }>("/me/push/subscriptions");
  return res.devices;
}

export function subscribePushDevice(subscription: PushSubscriptionBody): Promise<PushDevice> {
  return api.post<PushDevice>("/me/push/subscriptions", subscription);
}

export async function removePushDevice(target: PushDeviceTarget): Promise<void> {
  await api.delete("/me/push/subscriptions", target);
}

export function sendTestPush(): Promise<PushTestResult> {
  return api.post<PushTestResult>("/me/push/test", {});
}
