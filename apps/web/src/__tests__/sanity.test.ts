// Phase 76-01 — Infrastructure sanity check.
//
// This test exists to prove the stack works:
//   Vite + svelte plugin + jsdom + @testing-library/svelte + @testing-library/jest-dom
//
// If THIS test passes, every component test in 76-02 + 76-03 can rely on the same
// pipeline. If THIS test fails, the failure is in the infrastructure (config),
// not in the component-under-test. Keep this test trivial — never gate behavior
// on it that's covered by a real component test.

import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import Card from "$components/ui/Card.svelte";
import { renderWithTheme } from "./test-utils";

describe("Phase 76-01 sanity: Svelte 5 + jsdom + testing-library", () => {
  it("renders Card.svelte with a child snippet (component pipeline OK)", () => {
    const children = createRawSnippet(() => ({
      render: () => `<p data-testid="card-child">hello from card</p>`,
    }));

    renderWithTheme(Card, { children });

    expect(screen.getByTestId("card-child")).toBeInTheDocument();
    expect(screen.getByTestId("card-child")).toHaveTextContent("hello from card");
  });

  it("Card.svelte applies the .card class (Svelte compiler reachable)", () => {
    const children = createRawSnippet(() => ({ render: () => `<span>x</span>` }));
    const { container } = renderWithTheme(Card, { children });
    const section = container.querySelector("section");
    expect(section).not.toBeNull();
    expect(section).toHaveClass("card");
  });

  it("renderWithTheme propagates data-theme to document.body (D-06)", () => {
    const children = createRawSnippet(() => ({ render: () => `<span>y</span>` }));
    renderWithTheme(Card, { children }, "nacht");
    expect(document.body.getAttribute("data-theme")).toBe("nacht");
  });
});
