// Issue #843 (D-843-01 block 7 "Segment") - SegmentedControl stays the ONE Segment implementation.
// The first half pins the prop and keyboard surface its seven callers rely on (written before the
// restyle, so the restyle is proven to change style only); the second half pins the v2 token recipe.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import SegmentedControl from "../SegmentedControl.svelte";
import segmentSource from "../SegmentedControl.svelte?raw";

afterEach(() => cleanup());

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta", glyph: "B" },
  { value: "c", label: "Gamma", ariaLabel: "Gamma lang" },
];

function mount(overrides: Record<string, unknown> = {}) {
  const onchange = vi.fn();
  const view = renderWithTheme(SegmentedControl, {
    options: OPTIONS,
    value: "a",
    ariaLabel: "Auswahl",
    onchange,
    ...overrides,
  });
  return { onchange, ...view };
}

const radios = () => screen.getAllByRole("radio") as HTMLButtonElement[];
const checked = () => radios().findIndex((r) => r.getAttribute("aria-checked") === "true");

describe("SegmentedControl - prop surface", () => {
  it("renders a radiogroup named by ariaLabel (falls back to name) with one radio per option", () => {
    mount();
    expect(screen.getByRole("radiogroup", { name: "Auswahl" })).toBeTruthy();
    expect(radios().map((r) => r.textContent?.trim())).toEqual(["Alpha", "B Beta", "Gamma"]);
  });

  it("falls back to the name prop for the group label", () => {
    mount({ ariaLabel: undefined, name: "zoom" });
    expect(screen.getByRole("radiogroup", { name: "zoom" })).toBeTruthy();
  });

  it("marks the selected option and gives only it a tab stop; ariaLabel of an option wins", () => {
    mount({ value: "b" });
    expect(checked()).toBe(1);
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    expect(screen.getByRole("radio", { name: "Gamma lang" })).toBeTruthy();
  });

  it("size maps to a modifier class", () => {
    const { container } = mount({ size: "sm" });
    expect(container.querySelector(".seg-control--sm")).toBeTruthy();
  });

  it("a click selects and fires onchange once", async () => {
    const { onchange } = mount();
    await fireEvent.click(radios()[2]);
    expect(onchange).toHaveBeenCalledTimes(1);
    expect(onchange).toHaveBeenCalledWith("c");
    expect(checked()).toBe(2);
  });

  it("disabled blocks click and keyboard", async () => {
    const { onchange } = mount({ disabled: true });
    await fireEvent.click(radios()[1]);
    await fireEvent.keyDown(radios()[0], { key: "ArrowRight" });
    expect(onchange).not.toHaveBeenCalled();
    expect(checked()).toBe(0);
  });
});

describe("SegmentedControl - radiogroup keyboard", () => {
  it.each([
    ["ArrowRight", "a", 1, "b"],
    ["ArrowDown", "a", 1, "b"],
    ["ArrowLeft", "b", 0, "a"],
    ["ArrowUp", "b", 0, "a"],
    ["End", "a", 2, "c"],
    ["Home", "c", 0, "a"],
    ["ArrowRight", "c", 0, "a"],
    ["ArrowLeft", "a", 2, "c"],
  ])("%s from %s selects index %i once", async (key, from, index, value) => {
    const { onchange } = mount({ value: from });
    await fireEvent.keyDown(radios()[["a", "b", "c"].indexOf(from)], { key });
    expect(onchange).toHaveBeenCalledTimes(1);
    expect(onchange).toHaveBeenCalledWith(value);
    expect(checked()).toBe(index);
  });

  it("moves focus to the newly selected radio and ignores other keys", async () => {
    const { onchange } = mount();
    await fireEvent.keyDown(radios()[0], { key: "x" });
    expect(onchange).not.toHaveBeenCalled();
    await fireEvent.keyDown(radios()[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(radios()[1]);
  });
});

describe("SegmentedControl - v2 token recipe (D-843-01 item 7)", () => {
  const style = segmentSource.slice(segmentSource.lastIndexOf("<style>"));

  it("track: pill on --sunk, control height from the size tokens", () => {
    expect(style).toMatch(/\.seg-control\s*\{[^}]*background:\s*var\(--sunk\)/);
    expect(style).toMatch(/\.seg-control\s*\{[^}]*border-radius:\s*var\(--r-pill\)/);
    expect(style).toMatch(/\.seg-control--md\s*\{[^}]*var\(--h-control\)/);
    expect(style).toMatch(/\.seg-control--sm\s*\{[^}]*var\(--h-control-sm\)/);
  });

  it("selected option on --card with --text, the others --text-2", () => {
    expect(style).toMatch(/\.seg-btn\s*\{[^}]*color:\s*var\(--text-2\)/);
    expect(style).toMatch(
      /\.seg-btn\[aria-checked="true"\]\s*\{[^}]*background:\s*var\(--card\)[^}]*color:\s*var\(--text\)/,
    );
  });

  it("carries no italic, uppercase or letter-spacing and no colour literal", () => {
    const rules = style.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).not.toMatch(/italic|oblique|uppercase|letter-spacing/);
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });

  it("keeps a focus ring drawn from a token", () => {
    expect(style).toMatch(/\.seg-btn:focus-visible\s*\{[^}]*outline:[^;]*var\(--brand\)/);
  });
});
