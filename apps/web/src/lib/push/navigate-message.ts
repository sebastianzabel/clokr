// The app side of a notification tap (Issue #608 review WR-05).
//
// The service worker does not navigate an open window (that would bypass the unsaved-changes guard
// of the app layout); it focuses the window and posts the target. This listener, installed once by
// the `(app)` layout, re-validates the target with the same rule and navigates through the SvelteKit
// router (`goto`), so `beforeNavigate` guards apply.
import { PUSH_NAVIGATE_MESSAGE, safePushPath } from "./payload";

type Navigate = (path: string) => unknown;

/** Installs the message listener; returns a function that removes it. A no-op without a worker API. */
export function installPushNavigateListener(navigate: Navigate): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => {};
  const container = navigator.serviceWorker;

  const onMessage = (event: MessageEvent) => {
    // Messages from the worker are same-origin by construction; refuse anything else defensively.
    if (event.origin !== "" && event.origin !== location.origin) return;
    const data: unknown = event.data;
    if (data === null || typeof data !== "object") return;
    const { type, url } = data as { type?: unknown; url?: unknown };
    if (type !== PUSH_NAVIGATE_MESSAGE) return;
    // A refused navigation (the router rejects the target) must not become an unhandled rejection
    // that the client logger would forward to the API.
    try {
      Promise.resolve(navigate(safePushPath(url))).catch(() => {});
    } catch {
      /* a synchronous throw of the router is ignored the same way */
    }
  };

  container.addEventListener("message", onMessage);
  return () => container.removeEventListener("message", onMessage);
}
