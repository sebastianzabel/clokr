// Issue #840 — the `onPrimary` mode of ApprovalRow: the name is the row's one button, the actions are
// its siblings. The inbox rows use it, so axe `nested-interactive` has nothing to report.

import { describe, it, expect, vi } from "vitest";
import { createRawSnippet } from "svelte";
import { screen, fireEvent } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import ApprovalRow from "../ApprovalRow.svelte";
import rowSource from "../ApprovalRow.svelte?raw";

function actionSnippet(onAction: () => void) {
  return createRawSnippet(() => ({
    render: () => '<button type="button" data-testid="row-action">Prüfen</button>',
    setup: (el) => {
      el.addEventListener("click", onAction);
    },
  }));
}

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    avatar: "AM",
    name: "Anna Muster",
    meta: "Urlaub",
    dates: "12.04. – 14.04. · 3 Tage",
    ...overrides,
  };
}

describe("ApprovalRow — onPrimary mode", () => {
  it("nests no interactive element in another", () => {
    const { container } = renderWithTheme(
      ApprovalRow,
      baseProps({ onPrimary: () => {}, actions: actionSnippet(() => {}) }),
    );
    expect(container.querySelectorAll("button button, button a, a button, a a").length).toBe(0);
    expect(container.querySelectorAll("button")).toHaveLength(2);
  });

  it("renders a div root, never a button, with the name as the one row button", () => {
    const { container } = renderWithTheme(
      ApprovalRow,
      baseProps({ onPrimary: () => {}, actions: actionSnippet(() => {}) }),
    );
    const root = container.querySelector(".approval-row")!;
    expect(root.tagName).toBe("DIV");
    expect(root.classList.contains("approval-row--stretched")).toBe(true);
    expect(container.querySelector("button.approval-row")).toBeNull();
    const primary = container.querySelector("button.approval-primary")!;
    expect(primary.getAttribute("type")).toBe("button");
    expect(primary.textContent).toBe("Anna Muster");
    expect(primary.contains(screen.getByTestId("row-action"))).toBe(false);
  });

  // jsdom does not turn Enter/Space on a button into a click (a browser does), so the keyboard
  // activation itself is proven in the real browser (e2e `leave-area-840` 5b: Enter on the name opens
  // the review dialog). Here: the name is a native, tabbable `<button type="button">` that hands its click
  // to onPrimary.
  it("is a native tabbable button that calls onPrimary", async () => {
    const onPrimary = vi.fn();
    renderWithTheme(ApprovalRow, baseProps({ onPrimary }));
    const name = screen.getByRole("button", { name: "Anna Muster" });
    expect(name.tagName).toBe("BUTTON");
    expect(name.getAttribute("tabindex")).toBeNull();
    name.focus();
    expect(name).toHaveFocus();
    await fireEvent.click(name);
    expect(onPrimary).toHaveBeenCalledTimes(1);
  });

  it("keeps the actions clickable without triggering the primary", async () => {
    const onPrimary = vi.fn();
    const onAction = vi.fn();
    renderWithTheme(ApprovalRow, baseProps({ onPrimary, actions: actionSnippet(onAction) }));
    await fireEvent.click(screen.getByTestId("row-action"));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onPrimary).not.toHaveBeenCalled();
  });

  it("puts the action after the name button in tab order and outside it", () => {
    const { container } = renderWithTheme(
      ApprovalRow,
      baseProps({ onPrimary: () => {}, actions: actionSnippet(() => {}) }),
    );
    const name = container.querySelector("button.approval-primary")!;
    const action = screen.getByTestId("row-action");
    expect(name.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const tabbable = Array.from(container.querySelectorAll("a[href], button")).filter(
      (el) => el.getAttribute("tabindex") !== "-1",
    );
    expect(tabbable).toEqual([name, action]);
  });

  it("names the button by primaryLabel when given", () => {
    renderWithTheme(ApprovalRow, baseProps({ onPrimary: () => {}, primaryLabel: "Antrag prüfen" }));
    expect(screen.getByRole("button", { name: "Antrag prüfen" })).toBeInTheDocument();
  });

  it("ranks primaryHref over onPrimary over onclick", () => {
    const onclick = vi.fn();
    const both = renderWithTheme(
      ApprovalRow,
      baseProps({ primaryHref: "/x", onPrimary: () => {}, onclick }),
    );
    expect(both.container.querySelector("a.approval-primary")).not.toBeNull();
    expect(both.container.querySelector("button.approval-primary")).toBeNull();
    both.unmount();

    const rest = renderWithTheme(ApprovalRow, baseProps({ onPrimary: () => {}, onclick }));
    expect(rest.container.querySelector("button.approval-primary")).not.toBeNull();
    expect(rest.container.querySelector("button.approval-row")).toBeNull();
  });

  it("declares the button reset in the component's own <style>", () => {
    const style = rowSource.slice(rowSource.lastIndexOf("<style>"));
    expect(style).toContain(".approval-primary--button");
  });
});
