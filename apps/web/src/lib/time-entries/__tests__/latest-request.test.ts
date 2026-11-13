// Issue #660 (WR-03) - the request token that drops an out-of-order loader response.

import { describe, expect, it } from "vitest";

import { createLatestRequestGuard } from "../latest-request";

describe("createLatestRequestGuard (#660)", () => {
  it("accepts the only run", () => {
    const guard = createLatestRequestGuard();
    expect(guard.isCurrent(guard.begin())).toBe(true);
  });

  it("invalidates an earlier run as soon as a later one begins", () => {
    const guard = createLatestRequestGuard();
    const first = guard.begin();
    const second = guard.begin();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });

  it("drops the response of person A that resolves after person B was selected", async () => {
    const guard = createLatestRequestGuard();
    let shown: string | null = null;
    // A page-like loader: remember the token, await the response, apply only if still current.
    async function load(person: string, response: Promise<string>) {
      const token = guard.begin();
      const data = await response;
      if (!guard.isCurrent(token)) return;
      shown = data;
    }
    let releaseA: (v: string) => void = () => {};
    const slowA = new Promise<string>((resolve) => (releaseA = resolve));
    const loadA = load("A", slowA);
    const loadB = load("B", Promise.resolve("checks of B"));
    await loadB;
    releaseA("checks of A");
    await loadA;
    expect(shown).toBe("checks of B");
  });
});
