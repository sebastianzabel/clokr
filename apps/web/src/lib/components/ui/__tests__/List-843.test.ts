// Issue #843 (D-843-01 block 5) - List and ListRow: structure, the stable avatar colour, the task
// variant's DOM order, rows without avatar and the 44 px row height.
import { describe, expect, it } from "vitest";
import { createRawSnippet } from "svelte";
import { screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import List from "../List.svelte";
import ListRow, { AVATAR_COLOURS, avatarIndex, initialsOf } from "../ListRow.svelte";
import rowSource from "../ListRow.svelte?raw";
import listSource from "../List.svelte?raw";

const trailing = createRawSnippet(() => ({ render: () => '<span data-testid="tr">Offen</span>' }));
const actions = createRawSnippet(() => ({
  render: () => '<button type="button">Genehmigen</button>',
}));

describe("avatar helpers", () => {
  it("gives the same key the same colour index, always within 1..6", () => {
    for (const key of ["Person A", "Person B", "x", "", "Ünïcode"]) {
      const first = avatarIndex(key);
      expect(avatarIndex(key)).toBe(first);
      expect(first).toBeGreaterThanOrEqual(1);
      expect(first).toBeLessThanOrEqual(AVATAR_COLOURS);
    }
  });

  it("spreads different keys over more than one colour", () => {
    const used = new Set(["A", "B", "C", "D", "E", "F", "G", "H"].map(avatarIndex));
    expect(used.size).toBeGreaterThan(1);
  });

  it("builds up to two initials", () => {
    expect(initialsOf("Person A")).toBe("PA");
    expect(initialsOf("  anna   maria  lang ")).toBe("AM");
    expect(initialsOf("Solo")).toBe("S");
    expect(initialsOf("")).toBe("");
  });
});

describe("List", () => {
  it("renders a labelled ul with li rows", () => {
    const children = createRawSnippet(() => ({ render: () => "<li>x</li>" }));
    renderWithTheme(List, { ariaLabel: "Team", children });
    expect(screen.getByRole("list", { name: "Team" })).toBeInTheDocument();
  });
});

describe("ListRow", () => {
  it("renders an li with an aria-hidden avatar, title, subtitle and the trailing snippet", () => {
    const { container } = renderWithTheme(ListRow, {
      title: "Person A",
      subtitle: "Salon Nord",
      trailing,
    });
    const li = container.querySelector("li.list-row");
    expect(li).not.toBeNull();
    const avatar = li!.querySelector(".list-avatar");
    expect(avatar).toHaveAttribute("aria-hidden", "true");
    expect(avatar?.textContent).toBe("PA");
    expect(li!.querySelector(".list-title")?.textContent).toBe("Person A");
    expect(li!.querySelector(".list-subtitle")?.textContent).toBe("Salon Nord");
    expect(li!.querySelector(".list-trailing [data-testid=tr]")).not.toBeNull();
  });

  it("uses the avatar colour of avatarKey, not of the title", () => {
    const a = renderWithTheme(ListRow, { title: "X", avatarKey: "key-1" });
    const b = renderWithTheme(ListRow, { title: "Y", avatarKey: "key-1" });
    const styleOf = (c: HTMLElement) => c.querySelector(".list-avatar")?.getAttribute("style");
    expect(styleOf(a.container)).toBe(styleOf(b.container));
    expect(styleOf(a.container)).toContain(`--a${avatarIndex("key-1")}`);
  });

  it("renders no avatar element without avatar", () => {
    const { container } = renderWithTheme(ListRow, { title: "Person A", avatar: false });
    expect(container.querySelector(".list-avatar")).toBeNull();
  });

  it("renders the subtitle only when given", () => {
    const { container } = renderWithTheme(ListRow, { title: "Person A" });
    expect(container.querySelector(".list-subtitle")).toBeNull();
  });

  it("makes the title a link when href is set", () => {
    renderWithTheme(ListRow, { title: "Person A", href: "/team/1" });
    expect(screen.getByRole("link", { name: "Person A" })).toHaveAttribute("href", "/team/1");
  });

  it("task variant puts the actions after the text, not into a trailing cell", () => {
    const { container } = renderWithTheme(ListRow, {
      title: "Urlaubsantrag",
      variant: "task",
      trailing,
      actions,
    });
    const li = container.querySelector("li.list-row")!;
    expect(li).toHaveClass("list-row--task");
    const kids = [...li.children].map((c) => [...c.classList].find((n) => n.startsWith("list-")));
    expect(kids.indexOf("list-text")).toBeGreaterThanOrEqual(0);
    expect(kids.indexOf("list-text")).toBeLessThan(kids.indexOf("list-actions"));
    expect(li.querySelector(".list-trailing")).toBeNull();
    expect(screen.getByRole("button", { name: "Genehmigen" })).toBeInTheDocument();
  });

  it("is 44 px high through the row token", () => {
    const style = rowSource.slice(rowSource.indexOf("<style>"));
    expect(style).toMatch(/\.list-row \{[^}]*min-height:\s*var\(--h-row\)/);
  });

  it("renders text only", () => {
    expect(rowSource).not.toContain("{@html");
    expect(listSource).not.toContain("{@html");
  });
});
