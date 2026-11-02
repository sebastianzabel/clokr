// Issue #608 (D-14, research Pitfall 4): what a browser can do with push, decided by feature
// detection; the user agent only separates "iOS tab" from "no push at all".
import { describe, expect, it } from "vitest";

import { isStandalone, pushSupport, type PushEnv } from "../support";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const IPADOS_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const CHROME_UA =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";

function env(opts: {
  ua?: string;
  touch?: number;
  worker?: boolean;
  push?: boolean;
  notification?: boolean;
  standalone?: boolean;
  displayStandalone?: boolean;
}): PushEnv {
  const nav: Record<string, unknown> = {
    userAgent: opts.ua ?? CHROME_UA,
    maxTouchPoints: opts.touch ?? 0,
  };
  if (opts.worker !== false) nav.serviceWorker = {};
  if (opts.standalone !== undefined) nav.standalone = opts.standalone;
  const win: Record<string, unknown> = {
    matchMedia: (q: string) => ({ matches: !!opts.displayStandalone && q.includes("standalone") }),
  };
  if (opts.push !== false) win.PushManager = function PushManager() {};
  if (opts.notification !== false) win.Notification = function Notification() {};
  return { navigator: nav, window: win };
}

describe("pushSupport", () => {
  it("is supported with a worker, PushManager and Notification", () => {
    expect(pushSupport(env({}))).toBe("supported");
  });

  it("names an iPhone tab without PushManager as needing the Home Screen install", () => {
    expect(pushSupport(env({ ua: IPHONE_UA, push: false, notification: false }))).toBe(
      "ios-needs-install",
    );
  });

  it("recognises iPadOS by its desktop user agent plus touch points", () => {
    expect(pushSupport(env({ ua: IPADOS_UA, touch: 5, push: false }))).toBe("ios-needs-install");
  });

  it("does not take a touchless Macintosh for an iPad", () => {
    expect(pushSupport(env({ ua: IPADOS_UA, touch: 0, push: false }))).toBe("unsupported");
  });

  it("is unsupported without a service worker", () => {
    expect(pushSupport(env({ worker: false }))).toBe("unsupported");
  });

  it("is unsupported without PushManager on a non-iOS browser", () => {
    expect(pushSupport(env({ push: false }))).toBe("unsupported");
  });

  it("is unsupported without Notification on a non-iOS browser", () => {
    expect(pushSupport(env({ notification: false }))).toBe("unsupported");
  });

  it("calls an installed iOS app that still lacks PushManager unsupported, not 'install me'", () => {
    expect(pushSupport(env({ ua: IPHONE_UA, push: false, standalone: true }))).toBe("unsupported");
  });

  it("prefers the feature over the user agent: an iPhone with push is supported", () => {
    expect(pushSupport(env({ ua: IPHONE_UA }))).toBe("supported");
  });
});

describe("isStandalone", () => {
  it("is true for navigator.standalone", () => {
    expect(isStandalone(env({ standalone: true }))).toBe(true);
  });

  it("is true for display-mode standalone", () => {
    expect(isStandalone(env({ displayStandalone: true }))).toBe(true);
  });

  it("is false in a plain tab", () => {
    expect(isStandalone(env({ standalone: false }))).toBe(false);
    expect(isStandalone(env({}))).toBe(false);
  });
});
