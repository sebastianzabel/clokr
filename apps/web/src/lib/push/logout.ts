// An explicit logout takes this device's push registration with it (Issue #608, D-18, T-608-32).
//
// On a shared phone the next person must not receive the previous person's notifications, so the
// logout removes the device on the server and in the browser first, while the access token is
// still valid. The whole job is bounded and never throws: a hanging push service or a lost
// network must not hold the logout back. The inactivity timeout and the client's forced 401
// logout cannot do this (no valid token) - documented in the runbook.
import { removePushDevice } from "$lib/api/push";

const TIMED_OUT = Symbol("timed-out");

export async function removeThisDevicePush(timeoutMs = 3000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  const bounded = <T>(work: Promise<T>) => Promise.race([work, deadline]);

  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    const subscription = await bounded(
      navigator.serviceWorker
        .getRegistration()
        .then((registration) => registration?.pushManager.getSubscription() ?? null),
    );
    if (subscription === TIMED_OUT || !subscription) return;

    // A refusal or a timeout is fine: the browser side goes away below either way.
    await bounded(removePushDevice({ endpoint: subscription.endpoint }).catch(() => undefined));
    await bounded(subscription.unsubscribe().catch(() => false));
  } catch {
    /* the logout proceeds whatever happened here */
  } finally {
    clearTimeout(timer);
  }
}
