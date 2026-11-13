// Issue #853 (D-853-18) - TeamSection: heading text and level, the act snippet, the children, and
// the section is a plain surface (no card).
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { renderWithTheme } from "$tests/test-utils";
import TeamSection from "../TeamSection.svelte";
import source from "../TeamSection.svelte?raw";

afterEach(() => cleanup());

const children = createRawSnippet(() => ({ render: () => '<p data-testid="body">Inhalt</p>' }));
const action = createRawSnippet(() => ({
  render: () => '<a href="/team/zeiten">Alle ansehen →</a>',
}));

describe("TeamSection", () => {
  it("renders a section with an h2 by default and the children after it", () => {
    const { container } = renderWithTheme(TeamSection, { title: "Heute im Salon", children });
    const heading = screen.getByRole("heading", { level: 2, name: "Heute im Salon" });
    const body = screen.getByTestId("body");
    expect(container.querySelector("section")!.contains(heading)).toBe(true);
    expect(heading.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders an h3 for headingLevel 3 and no h2", () => {
    renderWithTheme(TeamSection, { title: "Unterabschnitt", children, headingLevel: 3 });
    expect(screen.getByRole("heading", { level: 3, name: "Unterabschnitt" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });

  it("renders the act snippet inside the heading line", () => {
    renderWithTheme(TeamSection, { title: "Heute", children, action });
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.querySelector("a")!.getAttribute("href")).toBe("/team/zeiten");
  });

  it("renders no act element without the snippet", () => {
    const { container } = renderWithTheme(TeamSection, { title: "Heute", children });
    expect(container.querySelector(".team-section-act")).toBeNull();
  });

  it("renders the title as text, never as markup", () => {
    renderWithTheme(TeamSection, { title: "<b>x</b>", children });
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.querySelector(".team-section-title")!.textContent).toBe("<b>x</b>");
    expect(heading.querySelector("b")).toBeNull();
    expect(source).not.toContain("{@html");
  });

  it("is a plain section: a top rule, no card surface", () => {
    const style = source.slice(source.indexOf("<style>"));
    expect(style).toMatch(/\.team-section \{[^}]*border-top:\s*1px solid var\(--line\)/);
    expect(style).not.toMatch(/--card\b|box-shadow|border-radius/);
  });
});
