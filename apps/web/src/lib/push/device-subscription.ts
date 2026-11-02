// The browser side of a device opt-in (Issue #608, D-14 consent per device, D-11 withdrawal as easy
// as giving it). Everything the browser decides - permission, subscription, key rotation, rollback -
// is a function returning a state here; the Svelte component only presents the state.
//
// Results are discriminated unions, never thrown errors, so every outcome has a calm presentation.
import {
  removePushDevice,
  subscribePushDevice,
  type PushDevice,
  type PushSubscriptionBody,
} from "$lib/api/push";

import { PUSH_FALLBACK_ERROR, isNotFound, pushErrorMessage } from "./error-message";

export { PUSH_FALLBACK_ERROR };
export const PUSH_NOT_READY_ERROR =
  "Der Dienst für Benachrichtigungen ist nicht bereit. Lade die Seite neu.";

const READY_TIMEOUT_MS = 10_000;

export type EnableResult =
  | { status: "enabled"; device: PushDevice }
  | { status: "denied" }
  | { status: "error"; message: string };

export type DisableResult = { status: "disabled" } | { status: "error"; message: string };

export type ThisDeviceState = { state: "on"; deviceId: string } | { state: "off"; deviceId: null };

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** VAPID public key (base64url) to the byte array `pushManager.subscribe` wants. */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** SHA-256 of a string as lower-case hex - the same digest the server stores as `endpointHash`. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function sameBytes(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (!a) return false;
  const left = new Uint8Array(a);
  if (left.length !== b.length) return false;
  return left.every((value, i) => value === b[i]);
}

// ── Browser state ─────────────────────────────────────────────────────────────

/** This browser's push subscription, or null (no worker, no registration, no subscription). */
export async function browserSubscription(): Promise<PushSubscription | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    return (await registration?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

/** Waits for the worker, but never longer than the bound - `ready` may never settle. */
async function readyRegistration(): Promise<ServiceWorkerRegistration | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), READY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([navigator.serviceWorker.ready, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * "On" only when the browser holds a subscription AND the server list knows its endpoint hash;
 * either side alone means this device receives nothing (or is not ours to claim).
 */
export async function thisDeviceState(devices: PushDevice[]): Promise<ThisDeviceState> {
  const subscription = await browserSubscription();
  if (subscription) {
    const hash = await sha256Hex(subscription.endpoint);
    const match = devices.find((device) => device.endpointHash === hash);
    if (match) return { state: "on", deviceId: match.id };
  }
  return { state: "off", deviceId: null };
}

// ── Enable / disable ──────────────────────────────────────────────────────────

/**
 * Asks for permission, subscribes this browser and registers it. Must run inside the click that
 * the person made: the permission request is the FIRST await.
 */
export async function enableThisDevice(publicKey: string): Promise<EnableResult> {
  // iOS and Chrome require the permission request in the direct user gesture; nothing may be
  // awaited before it.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { status: "denied" };

  let subscription: PushSubscription | null = null;
  let created = false;
  try {
    const registration = await readyRegistration();
    if (!registration) return { status: "error", message: PUSH_NOT_READY_ERROR };

    const key = urlBase64ToUint8Array(publicKey);
    const existing = await registration.pushManager.getSubscription();
    if (existing && sameBytes(existing.options.applicationServerKey, key)) {
      subscription = existing;
    } else {
      // A subscription made with another key (key rotation) can never receive our pushes.
      if (existing) await existing.unsubscribe();
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
      created = true;
    }

    const device = await subscribePushDevice(subscription.toJSON() as PushSubscriptionBody);
    return { status: "enabled", device };
  } catch (error) {
    // No orphan browser subscription when the server did not accept it.
    if (subscription && created) {
      try {
        await subscription.unsubscribe();
      } catch {
        /* the rollback is best effort */
      }
    }
    return { status: "error", message: pushErrorMessage(error) };
  }
}

/** Removes this device on the server first, then in the browser; a network failure keeps both. */
export async function disableThisDevice(): Promise<DisableResult> {
  const subscription = await browserSubscription();
  if (!subscription) return { status: "disabled" };
  try {
    await removePushDevice({ endpoint: subscription.endpoint });
  } catch (error) {
    // 404: the server already forgot the device, the goal is reached.
    if (!isNotFound(error)) return { status: "error", message: pushErrorMessage(error) };
  }
  try {
    await subscription.unsubscribe();
  } catch {
    return { status: "error", message: PUSH_FALLBACK_ERROR };
  }
  return { status: "disabled" };
}
