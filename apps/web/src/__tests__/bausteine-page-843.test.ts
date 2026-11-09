// Issue #843 (D-843-04) - the example page /admin/bausteine: six frames (three themes x light and
// dark, each carrying data-theme AND data-mode), every demo of the demos directory inside every
// frame, and the page head read from the one page-name table.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import Page from "../routes/(app)/admin/bausteine/+page.svelte";

afterEach(() => cleanup());

function webSrc(): string {
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    if (existsSync(join(root, "app.html"))) return root;
  } catch {
    // fall through to the cwd-based root
  }
  return resolve(process.cwd(), "src");
}

const SRC = webSrc();
const PAGE_SOURCE = readFileSync(join(SRC, "routes/(app)/admin/bausteine/+page.svelte"), "utf8");

// The demos the page renders, found by reading the directory (a literal "(app)" in an
// import.meta.glob is read as a glob group and matches nothing, and the vacuity gate cannot see a
// floor over a glob). The floor below fails the test if the demos directory ever empties, so the
// per-frame assertions can never pass over zero demos.
const DEMOS_DIR = join(SRC, "routes/(app)/admin/bausteine/demos");
const demoFiles = readdirSync(DEMOS_DIR).filter((name) => /^\d\d-.+\.svelte$/.test(name));
const demos = await Promise.all(
  demoFiles.map(async (name) => {
    const mod = (await import(/* @vite-ignore */ join(DEMOS_DIR, name))) as {
      block: { id: number; name: string; entries: string[] };
    };
    return { path: name, block: mod.block };
  }),
);

const COMBINATIONS = [
  ["pflaume", "light"],
  ["pflaume", "dark"],
  ["salz", "light"],
  ["salz", "dark"],
  ["petrol", "light"],
  ["petrol", "dark"],
] as const;

describe("example page /admin/bausteine", () => {
  it("finds at least one demo (non-vacuity)", () => {
    expect(demoFiles.length).toBeGreaterThanOrEqual(1);
    expect(demos).toHaveLength(demoFiles.length);
  });

  it("renders exactly six frames, each combination once, with both attributes", () => {
    const { container } = render(Page);
    const frames = [
      ...container.querySelectorAll<HTMLElement>('[data-testid^="bausteine-frame-"]'),
    ];
    expect(frames).toHaveLength(6);
    for (const frame of frames) {
      expect(frame.getAttribute("data-theme")).toBeTruthy();
      expect(frame.getAttribute("data-mode")).toBeTruthy();
    }
    const found = frames.map((f) => `${f.dataset.theme}/${f.dataset.mode}`).sort();
    expect(found).toEqual(COMBINATIONS.map(([t, m]) => `${t}/${m}`).sort());
  });

  it("renders every demo inside every frame", () => {
    const { container } = render(Page);
    const frames = [
      ...container.querySelectorAll<HTMLElement>('[data-testid^="bausteine-frame-"]'),
    ];
    for (const frame of frames) {
      for (const { block } of demos) {
        expect(
          frame.querySelector(`[data-block="${block.id}"]`),
          `${frame.dataset.testid}: block ${block.id}`,
        ).toBeTruthy();
      }
    }
  });

  it("reads the page name once for the heading and the tab title", () => {
    const { container } = render(Page);
    expect(container.querySelector("h1")?.textContent).toBe("Bausteine");
    expect(PAGE_SOURCE).toContain('title={pageLabel("/admin/bausteine")}');
    expect(PAGE_SOURCE).toContain('<title>{pageLabel("/admin/bausteine")} – Clokr</title>');
    expect(PAGE_SOURCE.match(/<PageHead\b/g)).toHaveLength(1);
  });
});

describe("example page demos", () => {
  it("every demo declares an integer block id 1..12 and entries that exist under src/lib", () => {
    for (const { path, block } of demos) {
      expect(Number.isInteger(block.id), path).toBe(true);
      expect(block.id, path).toBeGreaterThanOrEqual(1);
      expect(block.id, path).toBeLessThanOrEqual(12);
      expect(block.entries.length, path).toBeGreaterThan(0);
      for (const entry of block.entries) {
        expect(existsSync(join(SRC, "lib", entry)), `${path}: ${entry}`).toBe(true);
      }
    }
  });
});
