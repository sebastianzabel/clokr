// Phase 109 (Issue #35, D-12 / AK-07) — unit tests for the in-memory unsaved-section registry.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { clearUnsaved, hasUnsaved, markUnsaved, unsavedSections } from "../unsaved";

describe("unsaved store (Phase 109, D-12)", () => {
  beforeEach(() => {
    clearUnsaved();
  });

  it("is false on a fresh registry", () => {
    expect(hasUnsaved()).toBe(false);
  });

  it("marks a section dirty", () => {
    markUnsaved("admin-system", true);
    expect(hasUnsaved()).toBe(true);
  });

  it("is idempotent — marking the same id dirty twice keeps one entry", () => {
    markUnsaved("admin-system", true);
    markUnsaved("admin-system", true);
    let ids: string[] = [];
    const unsub = unsavedSections.subscribe((v) => (ids = v));
    unsub();
    expect(ids).toEqual(["admin-system"]);
  });

  it("clears a single id and hasUnsaved goes back to false", () => {
    markUnsaved("admin-system", true);
    markUnsaved("admin-system", false);
    expect(hasUnsaved()).toBe(false);
  });

  it("tracks two ids independently — clearing A leaves B dirty", () => {
    markUnsaved("admin-system", true);
    markUnsaved("admin-employees", true);
    markUnsaved("admin-system", false);
    expect(hasUnsaved()).toBe(true);
  });

  it("clearUnsaved empties the registry regardless of entry count", () => {
    markUnsaved("admin-system", true);
    markUnsaved("admin-employees", true);
    clearUnsaved();
    expect(hasUnsaved()).toBe(false);
  });

  it("markUnsaved(id, false) for an unknown id is a no-op and does not throw", () => {
    expect(() => markUnsaved("never-marked", false)).not.toThrow();
    expect(hasUnsaved()).toBe(false);
  });

  it("subscribers of unsavedSections see the id array change", () => {
    const seen: string[][] = [];
    const unsub = unsavedSections.subscribe((v) => seen.push(v));
    markUnsaved("admin-system", true);
    unsub();
    expect(seen.at(-1)).toEqual(["admin-system"]);
  });

  it("never persists to web storage (T-109-05)", () => {
    const src = readFileSync(resolve(process.cwd(), "src/lib/stores/unsaved.ts"), "utf8");
    expect(src).not.toContain("localStorage");
    expect(src).not.toContain("sessionStorage");
  });
});
