// Issue #610 (review WR-06) - the address-bar clean-up against a router that, like SvelteKit's, throws
// until its first hydration has finished. The fake router becomes ready after a chain of microtasks,
// exactly where SvelteKit sets `started` (after `await Promise.resolve()` inside hydration).
import { describe, expect, it, vi } from "vitest";

import { stripCodeFromAddress } from "../strip-code";

function fakeRouter() {
  let started = false;
  const calls: string[] = [];
  const replaceState = vi.fn((url: string) => {
    if (!started) throw new Error("Cannot call replaceState(...) before router is initialized");
    calls.push(url);
  });
  // The hydration: component code (onMount) runs synchronously inside it, the router is ready only
  // after the microtasks that follow.
  async function hydrate(onMount: () => void) {
    onMount();
    await Promise.resolve();
    started = true;
  }
  return { replaceState, calls, hydrate };
}

describe("stripCodeFromAddress", () => {
  it("does nothing when the URL carries no code (the missing-code landing)", async () => {
    const router = fakeRouter();
    let result: Promise<string> | undefined;
    await router.hydrate(() => {
      result = stripCodeFromAddress({
        hasCode: () => false,
        strip: () => router.replaceState("/settings/geraet-koppeln"),
      });
    });
    expect(await result).toBe("skipped");
    expect(router.replaceState).not.toHaveBeenCalled();
  });

  it("called synchronously during hydration it neither throws nor strips too early", async () => {
    const router = fakeRouter();
    let result: Promise<string> | undefined;
    await router.hydrate(() => {
      // A malformed code reports "handled" from onMount: this must not throw.
      result = stripCodeFromAddress({
        hasCode: () => true,
        strip: () => router.replaceState("/settings/geraet-koppeln"),
      });
    });
    expect(router.replaceState).not.toHaveBeenCalled();
    expect(await result).toBe("stripped");
    expect(router.calls).toEqual(["/settings/geraet-koppeln"]);
  });

  it("swallows a router that is still not ready - the code stays, the page keeps working", async () => {
    const strip = vi.fn(() => {
      throw new Error("Cannot call replaceState(...) before router is initialized");
    });
    await expect(
      stripCodeFromAddress({ hasCode: () => true, strip, defer: async () => undefined }),
    ).resolves.toBe("failed");
    expect(strip).toHaveBeenCalledTimes(1);
  });
});
