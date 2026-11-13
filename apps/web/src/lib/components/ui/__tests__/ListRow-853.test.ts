// Issue #853 (D-853-06) - the additive props of ListRow and List for the Team pages: meta, rowId,
// testId, kind, highlight, onPrimary (and List.testId). Unset, none of them leaves a trace.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { renderWithTheme } from "$tests/test-utils";
import List from "../List.svelte";
import ListRow from "../ListRow.svelte";
import rowSource from "../ListRow.svelte?raw";

afterEach(() => cleanup());

const meta = createRawSnippet(() => ({
  render: () => '<span data-testid="chip">Frühschicht</span>',
}));
const actions = createRawSnippet(() => ({
  render: () => '<button type="button">Annehmen</button>',
}));
const trailing = createRawSnippet(() => ({ render: () => "<span>Offen</span>" }));

describe("ListRow - additive props (unset = no trace)", () => {
  it("renders no id, test id, kind, meta or highlight by default", () => {
    const { container } = renderWithTheme(ListRow, { title: "Person A", subtitle: "Salon Nord" });
    const li = container.querySelector("li")!;
    expect(li.hasAttribute("id")).toBe(false);
    expect(li.hasAttribute("data-testid")).toBe(false);
    expect(li.hasAttribute("data-kind")).toBe(false);
    expect(li.classList.contains("list-row--highlight")).toBe(false);
    expect(li.classList.contains("list-row--stretched")).toBe(false);
    expect(container.querySelector(".list-meta")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });
});

describe("ListRow - rowId, testId, kind, highlight", () => {
  it("puts them on the li", () => {
    const { container } = renderWithTheme(ListRow, {
      title: "Hinweis",
      rowId: "case-17",
      testId: "notice-17",
      kind: "OPEN_SHIFT",
      highlight: true,
    });
    const li = container.querySelector("li")!;
    expect(li.id).toBe("case-17");
    expect(li.getAttribute("data-testid")).toBe("notice-17");
    expect(li.getAttribute("data-kind")).toBe("OPEN_SHIFT");
    expect(li.classList.contains("list-row--highlight")).toBe(true);
  });

  it("tints a highlighted row with --brand-tint", () => {
    const style = rowSource.slice(rowSource.indexOf("<style>"));
    expect(style).toMatch(/\.list-row--highlight \{[^}]*background:\s*var\(--brand-tint\)/);
  });
});

describe("ListRow - meta", () => {
  it("renders the meta snippet under the subtitle in the default variant", () => {
    const { container } = renderWithTheme(ListRow, { title: "A", subtitle: "S", meta });
    const text = container.querySelector(".list-text")!;
    const kids = [...text.children].map((c) => c.className.split(" ")[0]);
    expect(kids).toEqual(["list-title", "list-subtitle", "list-meta"]);
    expect(text.querySelector('.list-meta [data-testid="chip"]')).not.toBeNull();
  });

  it("task variant: meta sits between the subtitle and the actions", () => {
    const { container } = renderWithTheme(ListRow, {
      title: "A",
      subtitle: "S",
      variant: "task",
      meta,
      actions,
    });
    const li = container.querySelector("li")!;
    const metaEl = li.querySelector(".list-meta")!;
    const subtitle = li.querySelector(".list-subtitle")!;
    const actionsEl = li.querySelector(".list-actions")!;
    expect(
      subtitle.compareDocumentPosition(metaEl) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      metaEl.compareDocumentPosition(actionsEl) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("ListRow - onPrimary", () => {
  it("makes the title the one native button and calls onPrimary once per click", async () => {
    const onPrimary = vi.fn();
    const { container } = renderWithTheme(ListRow, {
      title: "Offene Schicht",
      onPrimary,
      actions,
      variant: "task",
    });
    const primary = screen.getByRole("button", { name: "Offene Schicht" });
    // A native <button type="button">: Enter and Space activate it in a browser (jsdom does not
    // synthesise that click, the same limit as the ApprovalRow onPrimary test).
    expect(primary.tagName).toBe("BUTTON");
    expect(primary.getAttribute("type")).toBe("button");
    expect(primary.tabIndex).toBe(0);
    await fireEvent.click(primary);
    expect(onPrimary).toHaveBeenCalledTimes(1);
    expect(container.querySelector("li")!.classList.contains("list-row--stretched")).toBe(true);
  });

  it("nests no interactive element in another; actions and trailing stay siblings", () => {
    const { container } = renderWithTheme(ListRow, {
      title: "Offene Schicht",
      onPrimary: () => {},
      actions,
      variant: "task",
    });
    expect(container.querySelectorAll("button button, button a, a button, a a")).toHaveLength(0);
    expect(container.querySelectorAll("button")).toHaveLength(2);
    expect(
      screen
        .getByRole("button", { name: "Offene Schicht" })
        .contains(screen.getByRole("button", { name: "Annehmen" })),
    ).toBe(false);
  });

  it("a click on an action does not call onPrimary", async () => {
    const onPrimary = vi.fn();
    renderWithTheme(ListRow, { title: "X", onPrimary, actions, variant: "task" });
    await fireEvent.click(screen.getByRole("button", { name: "Annehmen" }));
    expect(onPrimary).not.toHaveBeenCalled();
  });

  it("is ignored when href is set: the title stays a link", () => {
    const onPrimary = vi.fn();
    const { container } = renderWithTheme(ListRow, {
      title: "Person A",
      href: "/team/1",
      onPrimary,
      trailing,
    });
    expect(screen.getByRole("link", { name: "Person A" }).getAttribute("href")).toBe("/team/1");
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("li")!.classList.contains("list-row--stretched")).toBe(false);
  });
});

describe("List - testId", () => {
  const children = createRawSnippet(() => ({ render: () => "<li>x</li>" }));

  it("puts data-testid on the ul when set", () => {
    renderWithTheme(List, { ariaLabel: "Hinweise", children, testId: "shift-notice-list" });
    expect(screen.getByRole("list", { name: "Hinweise" }).getAttribute("data-testid")).toBe(
      "shift-notice-list",
    );
  });

  it("renders no data-testid when unset", () => {
    renderWithTheme(List, { ariaLabel: "Hinweise", children });
    expect(screen.getByRole("list", { name: "Hinweise" }).hasAttribute("data-testid")).toBe(false);
  });
});

describe("ListRow - task variant subtitle (plan 853-10)", () => {
  it("lets the subtitle of a task wrap, because it carries decision facts (periods, a notice text)", () => {
    // jsdom computes no layout, so the rule is pinned in the source: the default variant keeps the
    // single-line ellipsis, the task variant overrides it.
    expect(rowSource).toMatch(/\.list-row--task \.list-subtitle\s*\{[^}]*white-space:\s*normal/);
    expect(rowSource).toMatch(/\.list-title,\s*\.list-subtitle\s*\{[^}]*white-space:\s*nowrap/);
  });
});
