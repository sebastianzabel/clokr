// Issue #843 (D-843-01 block 10, D-843-07) - Skeleton: one status region per loading spot, one hidden
// „Wird geladen“, decorative shapes, no text prop, no shimmer under reduced motion.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderWithTheme } from "$tests/test-utils";
import Skeleton from "../Skeleton.svelte";
import skeletonSource from "../Skeleton.svelte?raw";

const css = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

function region(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('[role="status"]');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

describe("Skeleton (843-13)", () => {
  it("renders a labelled busy status region with three row shapes and one hidden text", () => {
    const { container, getByRole } = renderWithTheme(Skeleton, { shape: "row", count: 3 });
    const status = getByRole("status", { name: "Wird geladen" }) as HTMLElement;
    expect(status).toBe(region(container));
    expect(status.getAttribute("aria-busy")).toBe("true");
    const rows = status.querySelectorAll(".skeleton-row");
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.getAttribute("aria-hidden")).toBe("true");
    const hidden = status.querySelectorAll(".sr-only");
    expect(hidden).toHaveLength(1);
    expect(hidden[0].textContent).toBe("Wird geladen");
    // The only text node content of the region is that one hidden string.
    expect(status.textContent?.trim()).toBe("Wird geladen");
  });

  it.each([
    ["line", ".skeleton-line"],
    ["block", ".skeleton-block"],
    ["row", ".skeleton-row"],
    ["card", ".skeleton-card"],
  ] as const)("shape %s renders its class and no visible text", (shape, selector) => {
    const { container } = renderWithTheme(Skeleton, { shape });
    const status = region(container);
    expect(status.querySelectorAll(selector)).toHaveLength(1);
    expect(status.textContent?.trim()).toBe("Wird geladen");
    expect(status.querySelectorAll(".sr-only")).toHaveLength(1);
  });

  it("card renders the requested number of text lines", () => {
    const { container } = renderWithTheme(Skeleton, { shape: "card", lines: 4 });
    expect(container.querySelectorAll(".skeleton-card .skeleton-text")).toHaveLength(4);
  });

  it("block passes its height as a custom property", () => {
    const { container } = renderWithTheme(Skeleton, { shape: "block", height: "9rem" });
    const bar = container.querySelector<HTMLElement>(".skeleton-block");
    expect(bar?.getAttribute("style")).toContain("--skeleton-block-h: 9rem");
  });

  it("inline renders a span root with an inline bar of the given width", () => {
    const { container, getByRole } = renderWithTheme(Skeleton, {
      shape: "line",
      inline: true,
      width: 8,
    });
    const status = getByRole("status", { name: "Wird geladen" }) as HTMLElement;
    expect(status.tagName).toBe("SPAN");
    const bar = status.querySelector<HTMLElement>(".skeleton-inline");
    expect(bar?.getAttribute("style")).toContain("width: 8em");
    expect(container.querySelectorAll(".sr-only")).toHaveLength(1);
  });

  it("has no prop that changes the label or the hidden text", () => {
    // The wording is a literal in the file; there is no text or label prop.
    expect(skeletonSource).not.toMatch(/\b(label|text|message)\??:\s*string/);
    const { getByRole } = renderWithTheme(Skeleton, { shape: "line", label: "Anders" } as never);
    expect(getByRole("status", { name: "Wird geladen" })).toBeTruthy();
  });

  it("stops the shimmer under reduced motion", () => {
    // The one Reduced Motion block of app.css carries the rule (the motion test reads its first block).
    const start = css.indexOf("@media (prefers-reduced-motion: reduce) {");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = css.slice(start, css.indexOf("\n}\n", start));
    expect(body).toMatch(/\.skeleton[^{]*\{[^}]*animation:\s*none/);
  });
});
