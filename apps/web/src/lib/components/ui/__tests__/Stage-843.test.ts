// Issue #843 (D-843-01 block 4) - the Bühne: four states, surfaces, the 350 ms background
// transition and its reduced-motion override, the stage-high action buttons.
import { describe, expect, it } from "vitest";
import { createRawSnippet, type ComponentProps } from "svelte";
import { screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import { STATE_MS } from "$lib/motion";
import Stage from "../Stage.svelte";
import source from "../Stage.svelte?raw";

// #843: plain tsc resolves a .svelte import through the ambient default-only shim, so the type of a
// module-script export is taken from the component props instead.
type StageState = ComponentProps<typeof Stage>["state"];

const body = createRawSnippet(() => ({ render: () => "<span>Arbeitet seit 08:02</span>" }));
const actions = createRawSnippet(() => ({
  render: () => '<button type="button">Pause starten</button>',
}));

/** The declaration block of a selector in the component's style block. */
function rule(selector: string): string {
  const style = source.slice(source.indexOf("<style>"));
  const start = style.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return style.slice(start, style.indexOf("}", start));
}

describe("Stage states", () => {
  it.each<StageState>(["ruhig", "arbeitet", "pause", "fertig"])(
    "carries data-state=%s",
    (state) => {
      const { container } = renderWithTheme(Stage, { state, children: body });
      expect(container.querySelector(".stage")).toHaveAttribute("data-state", state);
    },
  );

  it("paints ruhig and fertig with the card, arbeitet brand-soft, pause warn-soft", () => {
    expect(rule(".stage")).toMatch(/background:\s*var\(--card\)/);
    // no override for ruhig / fertig: they keep the base surface
    expect(source).not.toMatch(/data-state="ruhig"\]/);
    expect(source).not.toMatch(/data-state="fertig"\]/);
    expect(rule('.stage[data-state="arbeitet"]')).toMatch(/background:\s*var\(--brand-soft\)/);
    expect(rule('.stage[data-state="pause"]')).toMatch(/background:\s*var\(--warn-soft\)/);
  });

  it("uses a text colour that is a proven pair on each surface (--text on card/brand-soft, --warn on warn-soft)", () => {
    expect(rule(".stage")).toMatch(/color:\s*var\(--text\)/);
    expect(rule('.stage[data-state="pause"]')).toMatch(/color:\s*var\(--warn\)/);
    expect(rule('.stage[data-state="arbeitet"]')).not.toMatch(/color:/);
  });

  it("renders children and the optional actions row", () => {
    const { container, unmount } = renderWithTheme(Stage, {
      state: "arbeitet",
      children: body,
      actions,
      ariaLabel: "Zeiterfassung",
    });
    expect(screen.getByText("Arbeitet seit 08:02")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause starten" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Zeiterfassung" })).toBeInTheDocument();
    unmount();
    const bare = renderWithTheme(Stage, { state: "ruhig", children: body });
    expect(bare.container.querySelector(".stage-actions")).toBeNull();
    expect(container).toBeDefined();
  });
});

describe("Stage style block", () => {
  it("transitions the background for exactly STATE_MS", () => {
    const m = /transition:\s*background-color\s+(\d+)ms\s+var\(--ease-out\)/.exec(rule(".stage"));
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(STATE_MS);
  });

  it("switches the transition off under prefers-reduced-motion", () => {
    const at = source.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(at).toBeGreaterThan(source.indexOf("<style>"));
    const block = source.slice(at, source.indexOf("</style>"));
    expect(block).toMatch(/\.stage\s*\{\s*transition:\s*none/);
  });

  it("gives action buttons at least --h-stage height and uses the stage radius", () => {
    expect(source).toMatch(
      /\.stage-actions :global\(button\)[\s\S]*?min-height:\s*var\(--h-stage\)/,
    );
    expect(rule(".stage")).toMatch(/border-radius:\s*var\(--r-stage\)/);
  });
});
