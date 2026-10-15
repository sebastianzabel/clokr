/**
 * Issue #564 — whole-page geometry probe shared by the narrow-viewport specs.
 *
 * `document.scrollWidth` alone is vacuous in the modern skin (`.card { overflow: hidden }` clips
 * the overflow instead of scrolling), so the probe measures every element's box. An element
 * counts as overflowing when its right edge lies beyond the viewport and no ancestor that clips
 * (overflow other than `visible`) ends inside the viewport — a horizontally scrolling table
 * wrapper is legitimate, a clipped button is not.
 */
import type { Page } from "@playwright/test";

export interface PageOverflow {
  innerWidth: number;
  scrollWidth: number;
  /** `tag.class#id` of each element whose right edge exceeds the viewport, unclipped. */
  overflowing: string[];
}

export async function measurePageOverflow(page: Page, tolerance = 0.5): Promise<PageOverflow> {
  return page.evaluate((tol) => {
    const iw = window.innerWidth;
    const describe = (e: Element) =>
      `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ""}${[...e.classList].map((c) => `.${c}`).join("")}`;
    const clippedInside = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox !== "visible" && p.getBoundingClientRect().right <= iw + tol) return true;
      }
      return false;
    };
    const overflowing = [...document.body.querySelectorAll("*")]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        if (getComputedStyle(e).position === "fixed") return false;
        return r.right > iw + tol && !clippedInside(e);
      })
      .map(describe);
    return { innerWidth: iw, scrollWidth: document.documentElement.scrollWidth, overflowing };
  }, tolerance);
}
