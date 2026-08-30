// Phase 127 (Issue #127), Task 1 — Charakterisierungstest / characterization test for D-05.
//
// D-05 asks a factual question before ErrorBoundary.svelte is wired to clientLogger: does a
// Svelte render/effect throw, with NO <svelte:boundary> in the tree, ever reach the handlers
// that `clientLogger.install()` registers on `window` ("error" / "unhandledrejection")? If it
// does, wiring a second report path from inside the boundary would double-log. If it does not,
// render errors have been entirely invisible to `POST /api/v1/logs/client` until this phase.
//
// This file is a characterization test, not a specification: it records what was OBSERVED,
// not what "should" happen. Do not read these expectations as an API contract of Svelte's
// error handling — read them as evidence for the D-05 answer written up in
// .planning/phases/127-svelte-boundary/127-01-SUMMARY.md.
//
// Two lines of evidence, because neither carries the answer alone:
//
// Line A (below): observe in jsdom whether `window.addEventListener("error", ...)` fires when
// ThrowingChild is mounted WITHOUT a boundary. This line is expected to be INCONCLUSIVE for the
// real browser: in jsdom the component mount sits directly in the test's own call stack, so an
// uncaught throw propagates synchronously back into the test call (`render()` throws) rather
// than being dispatched as a global "error" event the way a truly top-level, un-caught script
// error would be. jsdom does not reproduce the browser's task/microtask-boundary reporting path.
//
// Line B: read the installed Svelte package's own error-handling source. See
// `node_modules/svelte/src/internal/client/error-handling.js`, function `invoke_error_boundary`
// (lines 47-75, checked against svelte 5.56.10 as installed in this repo). It walks the effect
// tree from the throw site upward (`effect = effect.parent`) looking for an effect flagged
// `BOUNDARY_EFFECT` whose reaction has already run. If it finds one, it calls
// `effect.b.error(error)` and RETURNS (line 60-61) — no rethrow, nothing further happens on this
// call stack. If it walks all the way to `effect === null` without finding one, it falls through
// to `throw error` (line 74) — i.e. a boundary-less render/effect error is simply RE-THROWN on
// whatever JS call stack triggered the render/update. Svelte itself never calls
// `window.dispatchEvent` or anything reporting-related; it is purely a rethrow. Whether that
// rethrow is later seen by `window.onerror` depends entirely on where the browser's own call
// stack that triggered the render sits — not on anything Svelte does.
//
// Combined answer (see SUMMARY for the full writeup): a Svelte render/effect throw does NOT
// proactively reach `window.onerror` through any Svelte-owned mechanism. Today, with zero
// boundaries anywhere in apps/web, a render throw already propagated as a raw JS exception with
// no guaranteed path to `clientLogger.install()`'s "error" listener — so wiring `clientLogger`
// directly from inside ErrorBoundary.svelte's `onerror` (Task 2) is the ONLY reliable path, on
// both the (app) and root layout, and introduces no double-entry risk.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import ThrowingChild from "$tests/fixtures/ThrowingChild.svelte";

describe("boundary-onerror-reach — D-05 characterization (Issue #127)", () => {
  let errorSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Rebuild what clientLogger.install() does to `window`, WITHOUT touching the real
    // logger (no fetch, no queue) — we only care whether the event fires at all.
    errorSpy = vi.fn();
    window.addEventListener("error", errorSpy);
  });

  afterEach(() => {
    window.removeEventListener("error", errorSpy);
    cleanup();
  });

  it("Line A — a render-time throw (no boundary) rethrows synchronously into the test's own call, it does NOT reach window's 'error' listener in jsdom", () => {
    // Observed: render() itself throws. The mount happens directly in this call frame,
    // so the exception never becomes a "global uncaught error" jsdom would report via
    // the 'error' event — it comes straight back up the JS call stack instead.
    expect(() => render(ThrowingChild, { props: { when: "render" } })).toThrow("BOOM-127-render");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("Line A — an onMount-time throw (no boundary) behaves the same way: no 'error' event observed in jsdom", () => {
    // @testing-library/svelte flushes onMount effects synchronously as part of mount(),
    // which itself runs inside this render() call — same call-stack situation as above.
    expect(() => render(ThrowingChild, { props: { when: "mount" } })).toThrow("BOOM-127-mount");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("control — rendering without a throw fires neither path", () => {
    expect(() => render(ThrowingChild, { props: { when: "never" } })).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
