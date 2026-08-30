/**
 * Phase 110-07 checkpoint fix (orchestrator live-acceptance, mobile viewport).
 *
 * Measured live at 390x844 (iPhone-class): the auto-opening What's-New drawer covered 92% of the
 * viewport width and its full height, sitting directly over the "Einstempeln" button —
 * `document.elementFromPoint()` at the button's centre resolved into `aside.whats-new`. N-07
 * promises the drawer never sits between a user and clocking in; that held on desktop (400px
 * drawer on a 1512px viewport leaves room beside it) but not on a phone. Decision: below the
 * app's mobile breakpoint, the drawer must not AUTO-open — the unread dot on the version line
 * stays the entry point, and manual opening stays available everywhere.
 *
 * 960px is not a new number — it is the SAME breakpoint the app already switches its chrome on:
 * `BottomTabBar.svelte`'s `display: none` -> `display: grid` toggle (the point where the desktop
 * Sidebar hands off navigation to the bottom tab bar / "Mehr" sheet) and
 * `(app)/+layout.svelte`'s own `.app` grid-template switch from sidebar+main to a single column.
 */
export const MOBILE_BREAKPOINT_PX = 960;

/**
 * True at or below the app's mobile chrome breakpoint. Reads `window.innerWidth` directly rather
 * than `matchMedia` — jsdom's `matchMedia` support is inconsistent across environments without a
 * polyfill, while `innerWidth` is a plain, always-present property that's trivial and reliable to
 * stub per-test via `Object.defineProperty`. `max-width: 960px` semantics are inclusive, so this
 * mirrors that with `<=`.
 */
export function isMobileViewport(): boolean {
  if (typeof window === "undefined") return false;
  return window.innerWidth <= MOBILE_BREAKPOINT_PX;
}
