/**
 * Issue #608 review IN-02 - the shared `notify({ type })` scanner fails on a call site it cannot
 * resolve instead of skipping it. Pure: synthetic sources, plus one real scan of the source tree.
 */
import { describe, it, expect } from "vitest";
import { scanNotifyEmitSites, scanNotifySource } from "./notify-emit-sites";

describe("scanNotifySource (IN-02)", () => {
  it("reads a plain literal", () => {
    expect(
      scanNotifySource(
        `await app.notify({\n  userId,\n  type: "LEAVE_REQUEST",\n  title: "t",\n});`,
        "x",
      ),
    ).toEqual(["LEAVE_REQUEST"]);
  });

  it("reads both branches of a ternary but never the comparison operand", () => {
    const src = `notify({ userId, type: body.status === "APPROVED" ? "LEAVE_APPROVED" : "LEAVE_REJECTED", title })`;
    expect(scanNotifySource(src, "x")).toEqual(["LEAVE_APPROVED", "LEAVE_REJECTED"]);
  });

  it("reads a ternary that spans several lines", () => {
    const src = `notify({\n  userId,\n  type:\n    body.status === "APPROVED"\n      ? "LEAVE_APPROVED"\n      : "LEAVE_REJECTED",\n  title,\n})`;
    expect(scanNotifySource(src, "x")).toEqual(["LEAVE_APPROVED", "LEAVE_REJECTED"]);
  });

  it("does not stop at a comma inside a string", () => {
    expect(
      scanNotifySource(`notify({ title: "a, b", type: "SHIFT_CHANGED", message })`, "x"),
    ).toEqual(["SHIFT_CHANGED"]);
  });

  it.each([
    ["a variable", `notify({ userId, type: kind, title })`],
    ["a shorthand property", `notify({ userId, type, title })`],
    ["a constant", `notify({ userId, type: NOTIFICATION_TYPE, title })`],
    ["a call", `notify({ userId, type: typeFor(row), title })`],
    ["a variable branch of a ternary", `notify({ type: ok ? "LEAVE_APPROVED" : fallback })`],
    ["a template literal", "notify({ type: `LEAVE_${x}` })"],
    ["no type at all", `notify({ userId, title })`],
  ])("throws for %s", (_name, src) => {
    expect(() => scanNotifySource(src, "synthetic.ts")).toThrow(/notify\(\) call at synthetic\.ts/);
  });

  it("ignores the declaration of notify() itself", () => {
    expect(
      scanNotifySource(`async function notify({ userId, type, title }: NotifyParams) {}`, "x"),
    ).toEqual([]);
  });
});

describe("scanNotifyEmitSites on the real source tree", () => {
  it("resolves every call site (no throw) and finds the registered types", () => {
    const scan = scanNotifyEmitSites();
    expect(scan.filesScanned).toBeGreaterThan(100);
    expect(scan.types.size).toBeGreaterThanOrEqual(20);
  });
});
