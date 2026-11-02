/**
 * Issue #608 (D-10, P-608-09) - the ONLY file under apps/api/src that imports `web-push`.
 *
 * Keys come from `config` and are handed to the library per call (`vapidDetails`), never through
 * its global setter, so no other code path can send with credentials set elsewhere. The payload
 * string is built from a literal object with exactly the keys title, body and url. The error object
 * of a failed send is never logged: it can carry the endpoint (a capability URL) and response
 * headers - callers log `pushLogFields()` only.
 */
import webpush from "web-push";
import { config } from "../../config";
import { canonicalPushEndpoint, pushEndpointHost } from "./push-endpoint-guard";
import type { PushPayload } from "./notification-push-policy";

export type PushTarget = { endpoint: string; p256dh: string; auth: string };

export type PushSendOutcome =
  | { outcome: "SENT" }
  | { outcome: "GONE"; statusCode: number }
  | { outcome: "FAILED"; statusCode: number | null };

export type PushConfiguration = { publicKey: string; privateKey: string; subject: string };

const SEND_TIMEOUT_MS = 10_000;

/** The VAPID set when the instance has push configured, else null (D-01). Reads `config` only. */
export function pushConfiguration(): PushConfiguration | null {
  const publicKey = config.VAPID_PUBLIC_KEY;
  const privateKey = config.VAPID_PRIVATE_KEY;
  const subject = config.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

/** The only fields a push failure may put into a log line: the status and the host, never the URL. */
export function pushLogFields(
  endpoint: string,
  statusCode: number | null,
): { statusCode: number | null; host: string | null } {
  return { statusCode, host: pushEndpointHost(endpoint) };
}

function statusCodeOf(err: unknown): number | null {
  const code = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof code === "number" ? code : null;
}

export async function sendWebPush(
  target: PushTarget,
  payload: PushPayload,
  ttlSeconds: number,
): Promise<PushSendOutcome> {
  const vapid = pushConfiguration();
  if (!vapid) return { outcome: "FAILED", statusCode: null };
  // Re-checked at send time (CR-01): whatever reached the table, only the canonical allow-listed
  // string is ever handed to the library; anything else is refused without a network call.
  const endpoint = canonicalPushEndpoint(target.endpoint);
  if (endpoint === null) return { outcome: "FAILED", statusCode: null };
  const body = JSON.stringify({ title: payload.title, body: payload.body, url: payload.url });
  try {
    await webpush.sendNotification(
      { endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      body,
      {
        vapidDetails: {
          subject: vapid.subject,
          publicKey: vapid.publicKey,
          privateKey: vapid.privateKey,
        },
        TTL: ttlSeconds,
        urgency: "normal",
        timeout: SEND_TIMEOUT_MS,
      },
    );
    return { outcome: "SENT" };
  } catch (err) {
    const statusCode = statusCodeOf(err);
    if (statusCode === 404 || statusCode === 410) return { outcome: "GONE", statusCode };
    return { outcome: "FAILED", statusCode };
  }
}
