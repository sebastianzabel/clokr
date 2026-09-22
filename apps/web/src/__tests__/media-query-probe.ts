// Shared measuring instrument for "is this information distinguishable below a breakpoint"
// claims (WCAG 1.4.1). It is the single instrument behind the below-the-breakpoint claims of
// GitHub issues #265 and #303 — it MUST stay fail-closed, and a consumer is expected to run both
// controls (see INVENTED_CLASS below) alongside its own measurements rather than trusting a bare
// value.
//
// Why this exists at all, and why it is not a convenience wrapper: the obvious instruments lie.
// jsdom evaluates NO `@media` rule at all, so a naive `getComputedStyle` under a fixed jsdom
// viewport silently reads only the non-media-gated rules. And `toBeVisible()` answers "is this in
// the layout", not "what does a phone actually compute" — an unstyled element is visible. This
// module reads a page's raw `<style>` text, flattens it for a given viewport width itself
// (`cssForViewport`, via the fail-closed `mediaMatches`), injects the result as a real `<style>`
// tag, and only then asks `getComputedStyle` (`probeAt`). Two hand-copied instruments answering
// the same measuring question can drift into disagreement, and the drifted one still reports
// success — which is the exact defect class this module exists to remove, one layer down in test
// code (see Phase 303's extraction rationale).
//
// Mechanical notes for a new consumer:
// - `probeAt` appends a `<style>` element to `document.head` and elements to `document.body`. It
//   does NOT clean up after itself — the CONSUMER's own `afterEach` must remove them, or a later
//   test in the same file (or a later file, if teardown is skipped) inherits this sheet.
// - `styleBlockOf` takes the page source text as an explicit argument. A shared helper cannot know
//   which page a consumer is testing, so it is deliberately not page-aware: no module-level page
//   constant lives here. Each consumer supplies its own page source and, if it wants the
//   `probeAt(width)` shorthand, defines a one-line local wrapper that flattens its own style block
//   and delegates to `probeAt`.

// ── A fail-closed media evaluator ───────────────────────────────────────────
// Only width-in-px conditions are understood. Anything else THROWS, so a future
// `@media (hover: hover)` cannot be quietly skipped into a green test.
export function mediaMatches(condition: string, viewportPx: number): boolean {
  const parts = condition.split(/\s+and\s+/).map((p) => p.trim());
  return parts.every((part) => {
    const m = /^\((max|min)-width:\s*(\d+)px\)$/.exec(part);
    if (!m) {
      throw new Error(`cssForViewport cannot evaluate media condition: ${condition}`);
    }
    const px = Number(m[2]);
    return m[1] === "max" ? viewportPx <= px : viewportPx >= px;
  });
}

/** The page's CSS as a browser at `viewportPx` would see it: matching `@media` blocks inlined,
 *  non-matching ones dropped. */
export function cssForViewport(css: string, viewportPx: number): string {
  let out = "";
  let i = 0;
  for (;;) {
    const at = css.indexOf("@media", i);
    if (at === -1) {
      out += css.slice(i);
      return out;
    }
    out += css.slice(i, at);
    const braceOpen = css.indexOf("{", at);
    if (braceOpen === -1) throw new Error("unterminated @media condition");
    const condition = css.slice(at + "@media".length, braceOpen).trim();
    let depth = 0;
    let j = braceOpen;
    for (; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) throw new Error("unbalanced @media block");
    if (mediaMatches(condition, viewportPx)) out += css.slice(braceOpen + 1, j);
    i = j + 1;
  }
}

// ── The page's own <style> block ─────────────────────────────────────────────
/** Extracts the last `<style>` … `</style>` block from a page's source text. Throws when the
 *  block is absent or inverted (fail-closed, same discipline as `mediaMatches`). */
export function styleBlockOf(source: string): string {
  const open = source.lastIndexOf("<style>");
  const close = source.lastIndexOf("</style>");
  if (open === -1 || close <= open) throw new Error("no <style> block found in the page");
  return source.slice(open + "<style>".length, close);
}

// ── Measuring harness ───────────────────────────────────────────────────────
// The negative control's class name. What it is FOR: an unstyled element is visible, so every
// measurement needs a negative control that computes exactly like a class-less element of the
// same tag, alongside a positive control proving the injected sheet is in effect at all. The
// class must appear in no stylesheet in the repository — that is what makes it a control.
export const INVENTED_CLASS = "media-query-probe-invented-class-no-such-selector-exists";

export interface Probe {
  styles(className: string, tag?: string): CSSStyleDeclaration;
}

export function probeAt(viewportPx: number, css: string): Probe {
  Object.defineProperty(window, "innerWidth", {
    value: viewportPx,
    configurable: true,
    writable: true,
  });
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  const probe: Probe = {
    styles(className, tag = "span") {
      const el = document.createElement(tag);
      el.className = className;
      document.body.appendChild(el);
      return getComputedStyle(el);
    },
  };
  return probe;
}
