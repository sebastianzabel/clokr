// Issue #576 (D-576-06) — the dashboard polls at most every 30 s and never while the tab is hidden.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DASHBOARD_POLL_INTERVAL_MS, startVisiblePoll } from "../visible-poll";

function fakeDoc(hidden = false) {
  const listeners: Array<() => void> = [];
  return {
    hidden,
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    removeEventListener: (_: string, fn: () => void) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    fire() {
      listeners.forEach((fn) => fn());
    },
    listeners,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("startVisiblePoll", () => {
  it("polls every 30 s at the earliest", async () => {
    expect(DASHBOARD_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(30_000);
    const refresh = vi.fn().mockResolvedValue(undefined);
    const stop = startVisiblePoll(refresh, DASHBOARD_POLL_INTERVAL_MS, fakeDoc() as never);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });

  it("pauses while hidden and refreshes once right away on return", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const doc = fakeDoc();
    const stop = startVisiblePoll(refresh, 30_000, doc as never);
    doc.hidden = true;
    doc.fire();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(refresh).not.toHaveBeenCalled();
    doc.hidden = false;
    doc.fire();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
  });

  it("never runs two refreshes at once and survives a failed one", async () => {
    let resolveFirst: () => void = () => {};
    const refresh = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((r) => (resolveFirst = r)))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const stop = startVisiblePoll(refresh, 30_000, fakeDoc() as never);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    resolveFirst();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    stop();
  });

  it("stop clears the timer and the listener", async () => {
    const refresh = vi.fn();
    const doc = fakeDoc();
    const stop = startVisiblePoll(refresh, 30_000, doc as never);
    stop();
    expect(doc.listeners).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not start while the tab is hidden at mount", async () => {
    const refresh = vi.fn();
    const stop = startVisiblePoll(refresh, 30_000, fakeDoc(true) as never);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(refresh).not.toHaveBeenCalled();
    stop();
  });
});

describe("the dashboard uses it", () => {
  it("polls through startVisiblePoll, never through a raw interval", () => {
    const page = readFileSync(
      resolve(process.cwd(), "src/routes/(app)/dashboard/+page.svelte"),
      "utf8",
    );
    expect(page.length).toBeGreaterThan(50_000);
    expect(page).toContain("stopPoll = startVisiblePoll(pollDashboard);");
    expect(page).not.toMatch(/setInterval\(pollDashboard/);
  });
});
