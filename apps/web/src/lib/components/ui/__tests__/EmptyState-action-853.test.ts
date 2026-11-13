// Issue #853 (D-853-10) - EmptyState `action` snippet: rendered in place of the action button.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { renderWithTheme } from "$tests/test-utils";
import EmptyState from "../EmptyState.svelte";

afterEach(() => cleanup());

const action = createRawSnippet(() => ({
  render: () => '<select aria-label="Person wählen" data-testid="picker"></select>',
}));

describe("EmptyState - action snippet", () => {
  it("renders the snippet", () => {
    const { container } = renderWithTheme(EmptyState, {
      title: "Wessen Zeiten?",
      description: "Wähle eine Person.",
      action,
    });
    expect(screen.getByTestId("picker")).toBeTruthy();
    expect(
      container.querySelector(".empty-state-custom-action [data-testid=picker]"),
    ).not.toBeNull();
  });

  it("takes the place of the action button when both are given", () => {
    const onaction = vi.fn();
    const { container } = renderWithTheme(EmptyState, {
      title: "T",
      actionLabel: "Neu",
      onaction,
      action,
    });
    expect(screen.getByTestId("picker")).toBeTruthy();
    expect(container.querySelector("button.empty-state-action")).toBeNull();
    expect(screen.queryByRole("button", { name: "Neu" })).toBeNull();
  });

  it("without it the output is unchanged: the button, no custom wrapper", () => {
    const { container } = renderWithTheme(EmptyState, {
      title: "T",
      actionLabel: "Neu",
      onaction: () => {},
    });
    expect(screen.getByRole("button", { name: "Neu" })).toBeTruthy();
    expect(container.querySelector(".empty-state-custom-action")).toBeNull();
  });
});
