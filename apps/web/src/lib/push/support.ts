// What this browser can do with web push (Issue #608, D-14, research Pitfall 4).
//
// Feature detection decides; the user agent is consulted only to tell "iOS Safari outside the
// Home Screen app" (which exposes no PushManager but works once installed) from a browser that
// cannot do push at all. Both functions take an injectable environment so tests need no globals.

export type PushSupport = "supported" | "ios-needs-install" | "unsupported";

export interface PushEnv {
  navigator: object & { userAgent?: string; maxTouchPoints?: number; standalone?: boolean };
  window: object & { matchMedia?: (query: string) => { matches: boolean } };
}

function defaultEnv(): PushEnv {
  return { navigator, window };
}

/** True when the app runs from the Home Screen / as an installed app. */
export function isStandalone(env: PushEnv = defaultEnv()): boolean {
  if (env.navigator.standalone === true) return true;
  return env.window.matchMedia?.("(display-mode: standalone)").matches === true;
}

function isIosDevice(nav: PushEnv["navigator"]): boolean {
  const ua = nav.userAgent ?? "";
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  // iPadOS reports a desktop Safari user agent; only the touch points give it away.
  return /Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1;
}

export function pushSupport(env: PushEnv = defaultEnv()): PushSupport {
  const complete =
    "serviceWorker" in env.navigator && "PushManager" in env.window && "Notification" in env.window;
  if (complete) return "supported";
  // An iOS tab lacks PushManager, an installed iOS app that still lacks it is simply too old.
  if (isIosDevice(env.navigator) && !isStandalone(env)) return "ios-needs-install";
  return "unsupported";
}
