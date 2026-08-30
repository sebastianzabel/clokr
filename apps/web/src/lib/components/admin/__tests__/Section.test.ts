// Phase 109 (Issue #35, D-11) — Section `dirty` prop: mounted regression test.
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import SectionWithFooter from "$tests/fixtures/SectionWithFooter.svelte";

describe("Section — dirty prop (Phase 109, D-11)", () => {
  it("dirty=true with a footer renders the 'Nicht gespeichert' hint", () => {
    renderWithTheme(SectionWithFooter, { dirty: true, withFooter: true });
    expect(screen.getByText("Nicht gespeichert")).toBeInTheDocument();
  });

  it("dirty=false with a footer renders no hint", () => {
    renderWithTheme(SectionWithFooter, { dirty: false, withFooter: true });
    expect(screen.queryByText("Nicht gespeichert")).toBeNull();
  });

  it("no dirty prop at all (14 existing consumers) renders no hint", () => {
    renderWithTheme(SectionWithFooter, { withFooter: true });
    expect(screen.queryByText("Nicht gespeichert")).toBeNull();
  });

  it("dirty=true with NO footer snippet renders no footer element at all", () => {
    const { container } = renderWithTheme(SectionWithFooter, { dirty: true, withFooter: false });
    expect(container.querySelector(".section-footer")).toBeNull();
    expect(screen.queryByText("Nicht gespeichert")).toBeNull();
  });

  it("the hint carries class unsaved-hint and role=status", () => {
    renderWithTheme(SectionWithFooter, { dirty: true, withFooter: true });
    const hint = screen.getByRole("status");
    expect(hint).toHaveClass("unsaved-hint");
    expect(hint).toHaveTextContent("Nicht gespeichert");
  });
});
