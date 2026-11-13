// Issue #161 — the error boundary resets itself when the path changes.
//
// Before the fix the failure view survived every in-app navigation: the layout only swaps the
// boundary's children, and Svelte keeps a boundary's failed state until the boundary is created
// anew. The test drives the page store the boundary reads: a failure stays while the path stays
// (even if the child would now render), and goes as soon as the path changes.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/svelte";
import { flushSync, tick } from "svelte";
import { writable } from "svelte/store";
import { renderWithTheme } from "$tests/test-utils";
import BoundaryHarness from "$tests/fixtures/BoundaryHarness.svelte";

const pageStore = vi.hoisted(() => ({ current: null as null | ReturnType<typeof makePage> }));
function makePage(path: string) {
  return writable({ url: new URL(`http://localhost${path}`), state: {} });
}

vi.mock("$app/stores", () => {
  pageStore.current = makePage("/time-entries");
  return { page: pageStore.current };
});

const errorMock = vi.fn();
vi.mock("$lib/utils/logger", () => ({
  clientLogger: {
    error: (...args: unknown[]) => errorMock(...args),
    warn: vi.fn(),
    install: vi.fn(),
  },
}));

function navigate(path: string) {
  // the store exists once the boundary imported `$app/stores` (the mock factory ran)
  pageStore.current?.set({ url: new URL(`http://localhost${path}`), state: {} });
  flushSync();
}

describe("ErrorBoundary — resets on navigation (Issue #161)", () => {
  beforeEach(() => {
    errorMock.mockClear();
    navigate("/time-entries");
  });

  it("keeps the failure while the path stays, and drops it when the path changes", async () => {
    const { rerender } = renderWithTheme(BoundaryHarness, { scope: "view", when: "render" });
    expect(document.querySelector("[data-boundary-failed]")).not.toBeNull();

    // The child would render now, but nothing navigated: the failure stays (no silent retry).
    await rerender({ scope: "view", when: "never" });
    expect(document.querySelector("[data-boundary-failed]")).not.toBeNull();
    expect(screen.queryByTestId("throwing-child")).toBeNull();

    navigate("/leave");
    await tick();
    expect(document.querySelector("[data-boundary-failed]")).toBeNull();
    expect(screen.getByTestId("throwing-child")).toBeInTheDocument();
  });

  it("fails again when the page reached by the navigation throws too", async () => {
    renderWithTheme(BoundaryHarness, { scope: "view", when: "render" });
    expect(errorMock).toHaveBeenCalledTimes(1);

    navigate("/leave");
    await tick();
    expect(document.querySelector("[data-boundary-failed]")).not.toBeNull();
    expect(errorMock).toHaveBeenCalledTimes(2);
  });

  it("a query-only change on the same path does not reset", async () => {
    const { rerender } = renderWithTheme(BoundaryHarness, { scope: "view", when: "render" });
    await rerender({ scope: "view", when: "never" });

    navigate("/time-entries?view=list");
    await tick();
    expect(document.querySelector("[data-boundary-failed]")).not.toBeNull();
  });
});
