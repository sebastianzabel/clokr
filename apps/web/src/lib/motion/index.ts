// Issue #843 (D-843-01 block 12, "Bewegung") - the ONE motion module of the design system.
//
// Everything that moves is a no-op under `prefers-reduced-motion: reduce` and wherever the
// preference cannot be read (SSR, jsdom): the safe answer to "unknown" is "do not move"
// (T-843-12). The CSS side of the same rules lives in app.css (`.card-animate`) and pins its
// delay steps to STAGGER_MS in motion-843.test.ts.
import { readable, get } from "svelte/store";
import { fade as svelteFade, type FadeParams, type TransitionConfig } from "svelte/transition";

/** Duration of a state change (crossfade, surface tint of the Stage). */
export const STATE_MS = 350;
/** Duration of a number counting up to its figure. */
export const COUNT_MS = 500;
/** Delay between two neighbours of a staggered reveal. */
export const STAGGER_MS = 35;

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * True when motion must be off. The query is read when the first subscriber arrives, never at
 * module scope, and without `window.matchMedia` (SSR, jsdom) the value is true.
 */
export const reducedMotion = readable<boolean>(true, (set) => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    set(true);
    return;
  }
  const query = window.matchMedia(REDUCE_QUERY);
  set(query.matches);
  const onChange = (event: { matches: boolean }) => set(event.matches);
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }
  return undefined;
});

/** Crossfade of a state change: STATE_MS, or 0 under reduced motion. */
export function fade(node: Element, params: FadeParams = {}): TransitionConfig {
  const duration = get(reducedMotion) ? 0 : STATE_MS;
  return svelteFade(node, { ...params, duration });
}

export interface CountUpParams {
  /** A number is counted up to; a string (already formatted by the caller) is written as-is. */
  value: number | string;
  /** Formats the number for display; default is the plain number. */
  format?: (n: number) => string;
}

function formatted(params: CountUpParams, n: number): string {
  return params.format ? params.format(n) : String(n);
}

function finalText(params: CountUpParams): string {
  return typeof params.value === "number"
    ? formatted(params, params.value)
    : String(params.value ?? "");
}

/**
 * Writes into the node's FIRST text node when there is one (keeps the framework's reference and
 * any sibling element, e.g. a unit span after the figure); an empty node gets a text node.
 */
function write(node: HTMLElement, text: string): void {
  const first = node.firstChild;
  if (first && first.nodeType === 3) {
    if (first.nodeValue !== text) first.nodeValue = text;
  } else if (first) {
    node.insertBefore(document.createTextNode(text), first);
  } else {
    node.textContent = text;
  }
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Counts the element's text up to `format(value)` over COUNT_MS (ease-out). The final text is
 * ALWAYS exactly `format(value)` - no intermediate figure stays on screen or with assistive
 * technology (T-843-11). Reduced motion, a non-numeric value and a missing requestAnimationFrame
 * write the final text at once.
 */
export function countUp(node: HTMLElement, initial: CountUpParams) {
  let params = initial;
  let frame: number | null = null;
  let shown: number | null = null; // the number the node currently displays, null when unknown

  const cancel = () => {
    if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    frame = null;
  };

  const run = () => {
    cancel();
    const target = params.value;
    const instant =
      typeof target !== "number" ||
      !Number.isFinite(target) ||
      get(reducedMotion) ||
      typeof requestAnimationFrame !== "function";
    if (instant) {
      write(node, finalText(params));
      shown = typeof target === "number" && Number.isFinite(target) ? target : null;
      return;
    }
    const from = shown ?? 0;
    if (from === target) {
      write(node, finalText(params));
      return;
    }
    const started = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, Math.max(0, (now - started) / COUNT_MS));
      if (progress >= 1) {
        frame = null;
        shown = target;
        write(node, finalText(params));
        return;
      }
      const current = from + (target - from) * easeOutCubic(progress);
      shown = current;
      write(node, formatted(params, current));
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  };

  run();

  return {
    update(next: CountUpParams) {
      params = next;
      run();
    },
    destroy: cancel,
  };
}

export interface StaggerParams {
  index: number;
}

/**
 * Sets `--card-idx` (the position in a staggered reveal, see `.card-animate` in app.css) on the
 * node. Under reduced motion nothing is set, so the reveal has no delay to wait for.
 */
export function stagger(node: HTMLElement, initial: StaggerParams) {
  const apply = (params: StaggerParams) => {
    if (get(reducedMotion)) return;
    node.style.setProperty("--card-idx", String(params.index));
  };
  apply(initial);
  return {
    update: apply,
    destroy() {
      node.style.removeProperty("--card-idx");
    },
  };
}
