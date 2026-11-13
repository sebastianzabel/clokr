// Issue #608 review WR-05: the app-side listener of a tapped push notification. The worker only
// focuses the window and posts a target; this listener validates it and navigates via the router.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installPushNavigateListener } from "../navigate-message";
import { isAppWindowPath, safePushPath } from "../payload";

type Listener = (event: Partial<MessageEvent>) => void;

let listeners: Listener[];
const container = {
  addEventListener: vi.fn((_type: string, listener: Listener) => listeners.push(listener)),
  removeEventListener: vi.fn((_type: string, listener: Listener) => {
    listeners = listeners.filter((l) => l !== listener);
  }),
};

beforeEach(() => {
  listeners = [];
  container.addEventListener.mockClear();
  container.removeEventListener.mockClear();
  vi.stubGlobal("navigator", { serviceWorker: container });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function deliver(data: unknown, origin = "") {
  for (const listener of [...listeners]) listener({ data, origin });
}

describe("installPushNavigateListener", () => {
  it("navigates through the given router function with a validated path", () => {
    const navigate = vi.fn();
    installPushNavigateListener(navigate);
    deliver({ type: "clokr:navigate", url: "/team/leave?request=1#top" });
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/team/leave?request=1#top");
  });

  it.each([
    ["a foreign absolute URL", "https://evil.example/x"],
    ["a protocol-relative URL", "//evil.example/x"],
    ["a backslash path", "/\\evil.example"],
    ["a traversal", "/a/../../x"],
    // Review 2, WR-03: a `.` segment is removed by normalisation and leaves a protocol-relative path.
    ["a dot segment before a host", "/.//evil.example"],
    ["dot segments before a host", "/.///evil.example/x"],
    ["a dot segment before a backslash host", "/./\\evil.example"],
    ["a non-string", 42],
    ["nothing", undefined],
  ])("falls back to the dashboard for %s", (_name, url) => {
    const navigate = vi.fn();
    installPushNavigateListener(navigate);
    deliver({ type: "clokr:navigate", url });
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/dashboard");
  });

  it("swallows a rejected or throwing navigation instead of leaving an unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      installPushNavigateListener(() => Promise.reject(new Error("goto: invalid URL")));
      installPushNavigateListener(() => {
        throw new Error("router not ready");
      });
      expect(() => deliver({ type: "clokr:navigate", url: "/inbox" })).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("ignores other message types, non-objects and foreign origins", () => {
    const navigate = vi.fn();
    installPushNavigateListener(navigate);
    deliver({ type: "something-else", url: "/inbox" });
    deliver("clokr:navigate");
    deliver(null);
    deliver({ type: "clokr:navigate", url: "/inbox" }, "https://evil.example");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("removes the listener again", () => {
    const navigate = vi.fn();
    const remove = installPushNavigateListener(navigate);
    expect(listeners).toHaveLength(1);
    remove();
    expect(listeners).toHaveLength(0);
    deliver({ type: "clokr:navigate", url: "/inbox" });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("is a no-op in a browser without service workers", () => {
    vi.stubGlobal("navigator", {});
    const navigate = vi.fn();
    expect(() => installPushNavigateListener(navigate)(), "install + remove").not.toThrow();
    expect(container.addEventListener).not.toHaveBeenCalled();
  });
});

describe("safePushPath / isAppWindowPath", () => {
  it("normalises a safe relative path and keeps query and hash", () => {
    expect(safePushPath("/a/./b?x=1#y")).toBe("/a/b?x=1#y");
  });

  it.each(["/.//evil.example", "/.///evil.example/x", "/./\\evil.example"])(
    "never returns a protocol-relative path: %s",
    (raw) => {
      const path = safePushPath(raw);
      expect(path).toBe("/dashboard");
      expect(new URL(path, "https://clokr.example/x").origin).toBe("https://clokr.example");
    },
  );

  it("keeps a dot segment that stays a normal path", () => {
    expect(safePushPath("/.")).toBe("/");
    expect(safePushPath("/./team/leave")).toBe("/team/leave");
  });

  it("refuses the operator console and the auth pages as navigation windows", () => {
    expect(isAppWindowPath("/betreiber")).toBe(false);
    expect(isAppWindowPath("/betreiber/mandanten")).toBe(false);
    expect(isAppWindowPath("/login")).toBe(false);
    expect(isAppWindowPath("/reset-password/abc")).toBe(false);
    expect(isAppWindowPath("/dashboard")).toBe(true);
    expect(isAppWindowPath("/loginx")).toBe(true);
  });
});

describe("(app) layout wiring", () => {
  const layout = readFileSync(join(__dirname, "../../../routes/(app)/+layout.svelte"), "utf8");

  it("installs the listener once with the router's goto and removes it on destroy", () => {
    expect(layout.length).toBeGreaterThan(0);
    expect(layout.match(/installPushNavigateListener\(/g)).toHaveLength(1);
    expect(layout).toMatch(/installPushNavigateListener\(\(path\) => goto\(path\)\)/);
    expect(layout).toMatch(/removePushNavigateListener\?\.\(\)/);
  });
});
