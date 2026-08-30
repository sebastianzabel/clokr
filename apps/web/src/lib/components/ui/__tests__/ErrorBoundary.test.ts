// Phase 127 (Issue #127), Task 2 — behaviour proof for the one error boundary (D-08).
//
// Covers both scopes ("view" / "app") and both throw sites (render, onMount) from #115's
// failure class: a render error used to kill the subtree silently, leaving no visible
// difference from "this month is empty". This test proves a caught throw now renders a
// German, honest message instead, and reports exactly once to clientLogger per throw.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import BoundaryHarness from "$tests/fixtures/BoundaryHarness.svelte";

const errorMock = vi.fn();

vi.mock("$lib/utils/logger", () => ({
  clientLogger: {
    error: (...args: unknown[]) => errorMock(...args),
    warn: vi.fn(),
    install: vi.fn(),
  },
}));

describe("ErrorBoundary — one boundary, two messages (Issue #127)", () => {
  beforeEach(() => {
    errorMock.mockClear();
  });

  it("without a throw: children render, no .callout appears", () => {
    renderWithTheme(BoundaryHarness, { scope: "view", when: "never" });
    expect(screen.getByTestId("throwing-child")).toBeInTheDocument();
    expect(document.querySelector(".callout")).toBeNull();
    expect(errorMock).not.toHaveBeenCalled();
  });

  it('scope="view" + render throw: shows the view message, child is not in the DOM', () => {
    renderWithTheme(BoundaryHarness, { scope: "view", when: "render" });
    const callout = document.querySelector(".callout.error");
    expect(callout).not.toBeNull();
    expect(callout?.textContent).toContain("Diese Ansicht konnte nicht geladen werden.");
    expect(screen.queryByTestId("throwing-child")).toBeNull();
  });

  it('scope="app" + render throw: shows the app message', () => {
    renderWithTheme(BoundaryHarness, { scope: "app", when: "render" });
    const callout = document.querySelector(".callout.error");
    expect(callout).not.toBeNull();
    expect(callout?.textContent).toContain("Die Anwendung konnte nicht geladen werden.");
  });

  it("D-02: the two scope titles are different strings, not the same message twice", () => {
    renderWithTheme(BoundaryHarness, { scope: "view", when: "render" });
    const viewText = document.querySelector(".callout.error")?.textContent ?? "";
    expect(viewText).toContain("Diese Ansicht konnte nicht geladen werden.");
    expect(viewText).not.toContain("Die Anwendung konnte nicht geladen werden.");
  });

  it('scope="view" + onMount throw (the #115 failure class): also shows the replacement, not an empty tree', () => {
    renderWithTheme(BoundaryHarness, { scope: "view", when: "mount" });
    const callout = document.querySelector(".callout.error");
    expect(callout).not.toBeNull();
    expect(callout?.textContent).toContain("Diese Ansicht konnte nicht geladen werden.");
  });

  it("clientLogger.error is called exactly once per throw, with the boundary scope and a stack", () => {
    renderWithTheme(BoundaryHarness, { scope: "view", when: "render" });
    expect(errorMock).toHaveBeenCalledTimes(1);
    const [message, extra] = errorMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain("BOOM-127-render");
    expect(extra.boundary).toBe("view");
    expect(extra.stack).toBeDefined();
  });

  it('clientLogger.error receives boundary: "app" for the outer scope', () => {
    renderWithTheme(BoundaryHarness, { scope: "app", when: "render" });
    expect(errorMock).toHaveBeenCalledTimes(1);
    const [, extra] = errorMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(extra.boundary).toBe("app");
  });

  it("T-127-01: the raw error text never reaches the rendered replacement", () => {
    renderWithTheme(BoundaryHarness, { scope: "view", when: "render" });
    const callout = document.querySelector(".callout.error");
    expect(callout?.textContent).not.toContain("BOOM-127-render");
  });

  it('a "Seite neu laden" button is offered as a plain button, not a link', () => {
    renderWithTheme(BoundaryHarness, { scope: "view", when: "render" });
    const button = screen.getByRole("button", { name: "Seite neu laden" });
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    // Not clicked here: jsdom does not cleanly stub window.location.reload, and a
    // click would only produce "Not implemented: navigation" test noise.
  });
});
