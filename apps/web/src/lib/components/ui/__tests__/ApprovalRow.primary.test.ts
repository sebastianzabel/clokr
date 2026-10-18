// Issue #612 (UI-SPEC "ApprovalRow `primaryAction` mode") — the stretched primary link keeps
// every control a sibling: no link in a link, no button in a button, no button in a link.
// The `onclick` mode and the plain mode stay as they were (regression).

import { describe, it, expect, vi } from "vitest";
import { createRawSnippet } from "svelte";
import { screen, fireEvent } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import ApprovalRow from "../ApprovalRow.svelte";
import rowSource from "../ApprovalRow.svelte?raw";

function actionSnippet(onAction: () => void) {
  return createRawSnippet(() => ({
    render: () => '<button type="button" data-testid="row-action">Hinweis senden</button>',
    setup: (el) => {
      el.addEventListener("click", onAction);
    },
  }));
}

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    avatar: "AM",
    name: "Anna Muster",
    meta: "Anspruch 30",
    dates: "Rest 13 T.",
    ...overrides,
  };
}

describe("ApprovalRow — primaryAction mode", () => {
  it("nests no interactive element in another", () => {
    const { container } = renderWithTheme(
      ApprovalRow,
      baseProps({
        primaryHref: "/reports?person=1",
        primaryLabel: "Anna Muster – Personenansicht öffnen",
        actions: actionSnippet(() => {}),
      }),
    );
    expect(container.querySelectorAll("a button, button button, a a, button a").length).toBe(0);
  });

  it("renders a div root with approval-row--stretched, never a button", () => {
    const { container } = renderWithTheme(
      ApprovalRow,
      baseProps({ primaryHref: "/reports?person=1", actions: actionSnippet(() => {}) }),
    );
    const root = container.querySelector(".approval-row");
    expect(root!.tagName).toBe("DIV");
    expect(root!.classList.contains("approval-row--stretched")).toBe(true);
    expect(container.querySelector("button.approval-row")).toBeNull();
  });

  it("has exactly one link, named by primaryLabel", () => {
    renderWithTheme(
      ApprovalRow,
      baseProps({
        primaryHref: "/reports?person=1",
        primaryLabel: "Anna Muster – Personenansicht öffnen",
        actions: actionSnippet(() => {}),
      }),
    );
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName("Anna Muster – Personenansicht öffnen");
    expect(links[0]).toHaveAttribute("href", "/reports?person=1");
    expect(links[0].classList.contains("approval-primary")).toBe(true);
    expect(links[0]).toHaveAttribute("data-sveltekit-noscroll");
  });

  it("falls back to the name as the link's accessible name", () => {
    renderWithTheme(ApprovalRow, baseProps({ primaryHref: "/reports?person=1" }));
    expect(screen.getByRole("link")).toHaveAccessibleName("Anna Muster");
  });

  it("puts the action button after the link in tab order and outside it", () => {
    const { container } = renderWithTheme(
      ApprovalRow,
      baseProps({ primaryHref: "/reports?person=1", actions: actionSnippet(() => {}) }),
    );
    const link = container.querySelector("a")!;
    const button = screen.getByTestId("row-action");
    expect(link.contains(button)).toBe(false);
    expect(button.closest("a")).toBeNull();
    expect(link.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const tabbable = Array.from(container.querySelectorAll("a[href], button")).filter(
      (el) => el.getAttribute("tabindex") !== "-1",
    );
    expect(tabbable).toEqual([link, button]);
  });

  it("fires the action handler and not the link's", async () => {
    const onAction = vi.fn();
    const onPrimaryClick = vi.fn((e: MouseEvent) => e.preventDefault());
    renderWithTheme(
      ApprovalRow,
      baseProps({
        primaryHref: "/reports?person=1",
        onPrimaryClick,
        actions: actionSnippet(onAction),
      }),
    );
    await fireEvent.click(screen.getByTestId("row-action"));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onPrimaryClick).not.toHaveBeenCalled();
  });

  it("hands a click on the link to onPrimaryClick as a MouseEvent", async () => {
    const onPrimaryClick = vi.fn((e: MouseEvent) => e.preventDefault());
    renderWithTheme(ApprovalRow, baseProps({ primaryHref: "/reports?person=1", onPrimaryClick }));
    await fireEvent.click(screen.getByRole("link"));
    expect(onPrimaryClick).toHaveBeenCalledTimes(1);
    expect(onPrimaryClick.mock.calls[0][0]).toBeInstanceOf(MouseEvent);
  });

  it("lets `primaryHref` win over `onclick`", () => {
    const onclick = vi.fn();
    const { container } = renderWithTheme(
      ApprovalRow,
      baseProps({ primaryHref: "/reports?person=1", onclick }),
    );
    expect(container.querySelector("button.approval-row")).toBeNull();
    expect(screen.getByRole("link")).toBeInTheDocument();
  });

  it("declares the stretched and focus classes in the component's own <style>", () => {
    const style = rowSource.slice(rowSource.lastIndexOf("<style>"));
    expect(style).toContain(".approval-row--stretched");
    expect(style).toContain(".approval-primary");
    expect(style).toMatch(/\.approval-primary::after/);
    expect(style).toMatch(/\.approval-primary:focus-visible::after/);
  });
});

describe("ApprovalRow — existing modes (regression)", () => {
  it('renders `<button class="approval-row">` in the onclick mode', async () => {
    const onclick = vi.fn();
    const { container } = renderWithTheme(ApprovalRow, baseProps({ onclick }));
    const root = container.querySelector(".approval-row")!;
    expect(root.tagName).toBe("BUTTON");
    expect(root.classList.contains("approval-row--stretched")).toBe(false);
    expect(container.querySelector("a")).toBeNull();
    await fireEvent.click(root);
    expect(onclick).toHaveBeenCalledTimes(1);
  });

  it("renders a plain div without a link or button when neither is passed", () => {
    const { container } = renderWithTheme(ApprovalRow, baseProps());
    const root = container.querySelector(".approval-row")!;
    expect(root.tagName).toBe("DIV");
    expect(root.classList.contains("approval-row--stretched")).toBe(false);
    expect(container.querySelector("a, button")).toBeNull();
  });
});
