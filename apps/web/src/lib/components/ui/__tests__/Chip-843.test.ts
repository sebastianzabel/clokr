// Issue #843 (D-843-01 block 8) - Chip and Note: structure per tone, the 22 px pill recipe and the
// shared tone pairs, parsed from the real app.css.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createRawSnippet } from "svelte";
import { renderWithTheme } from "$tests/test-utils";
import Chip from "../Chip.svelte";
import type { ChipTone } from "../Chip.svelte";
import Note from "../Note.svelte";
import type { NoteTone } from "../Note.svelte";
import chipSource from "../Chip.svelte?raw";
import noteSource from "../Note.svelte?raw";

// Comments stripped so a selector list never starts inside prose.
const css = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

const text = createRawSnippet(() => ({ render: () => "<span>Genehmigt</span>" }));

/** The declaration block of the rule whose selector list contains `selector`. */
function ruleOf(selector: string): string {
  const re = /([^{}]+)\{([^}]*)\}/g;
  const hits: string[] = [];
  for (const m of css.matchAll(re)) {
    const list = m[1].split(",").map((s) => s.trim());
    if (list.includes(selector)) hits.push(m[2]);
  }
  expect(hits.length, selector).toBeGreaterThan(0);
  return hits.join("\n");
}

const CHIP_PAIRS: Array<[ChipTone, string, string]> = [
  ["ok", "ok", "ok-soft"],
  ["warn", "warn", "warn-soft"],
  ["bad", "bad", "bad-soft"],
  ["info", "info", "info-soft"],
  ["brand", "brand", "brand-soft"],
  ["neutral", "text-2", "sunk"],
];

describe("Chip", () => {
  it.each(CHIP_PAIRS.map(([tone]) => tone))(
    "renders span.chip.chip-%s with an aria-hidden dot",
    (tone) => {
      const { container } = renderWithTheme(Chip, { tone, children: text });
      const chip = container.querySelector("span.chip");
      expect(chip).toHaveClass(`chip-${tone}`);
      const dot = chip?.querySelector(".dot");
      expect(dot).toHaveAttribute("aria-hidden", "true");
      expect(chip?.textContent).toBe("Genehmigt");
    },
  );

  it("defaults to the neutral tone and passes the title through", () => {
    const { container } = renderWithTheme(Chip, { title: "Status", children: text });
    const chip = container.querySelector("span.chip");
    expect(chip).toHaveClass("chip-neutral");
    expect(chip).toHaveAttribute("title", "Status");
  });

  it("declares the 22 px pill recipe", () => {
    const base = ruleOf(".chip");
    expect(base).toMatch(/min-height:\s*22px/);
    expect(base).toMatch(/border-radius:\s*var\(--r-pill\)/);
    expect(base).toMatch(/font-size:\s*var\(--fs-xs\)/);
    expect(base).toMatch(/white-space:\s*nowrap/);
    expect(ruleOf(".chip .dot")).toMatch(/width:\s*6px/);
  });

  it.each(CHIP_PAIRS)("tone %s uses the pair %s on %s", (tone, fg, bg) => {
    const rule = ruleOf(`.chip-${tone}`);
    expect(rule).toMatch(new RegExp(`color:\\s*var\\(--${fg}\\)`));
    expect(rule).toMatch(new RegExp(`background:\\s*var\\(--${bg}\\)`));
  });

  it("keeps the legacy selector and the badge pairs identical to the chip pairs", () => {
    expect(ruleOf(".chip-good")).toMatch(/color:\s*var\(--ok\)/);
    const badge: Array<[string, string, string]> = [
      ["badge-green", "ok", "ok-soft"],
      ["badge-yellow", "warn", "warn-soft"],
      ["badge-red", "bad", "bad-soft"],
      ["badge-blue", "info", "info-soft"],
      ["badge-purple", "brand", "brand-soft"],
      ["badge-gray", "text-2", "sunk"],
    ];
    for (const [name, fg, bg] of badge) {
      const rule = ruleOf(`.${name}`);
      expect(rule, name).toMatch(new RegExp(`color:\\s*var\\(--${fg}\\)`));
      expect(rule, name).toMatch(new RegExp(`background-color:\\s*var\\(--${bg}\\)`));
    }
  });

  it("renders text only", () => {
    expect(chipSource).not.toContain("{@html");
  });
});

describe("Note", () => {
  const NOTE_TONES: NoteTone[] = ["ok", "warn", "bad", "info", "brand"];

  it.each(NOTE_TONES)("renders p.note.note-%s with an aria-hidden dot", (tone) => {
    const { container } = renderWithTheme(Note, { tone, children: text });
    const note = container.querySelector("p.note");
    expect(note).toHaveClass(`note-${tone}`);
    expect(note?.querySelector(".note-dot")).toHaveAttribute("aria-hidden", "true");
  });

  it("omits the dot with icon=false", () => {
    const { container } = renderWithTheme(Note, { tone: "warn", icon: false, children: text });
    expect(container.querySelector(".note-dot")).toBeNull();
  });

  it.each(NOTE_TONES)("tone %s paints the status colour on its soft partner", (tone) => {
    const rule = ruleOf(`.note-${tone}`);
    expect(rule).toMatch(new RegExp(`color:\\s*var\\(--${tone}\\)`));
    expect(rule).toMatch(new RegExp(`background:\\s*var\\(--${tone}-soft\\)`));
  });

  it("renders text only", () => {
    expect(noteSource).not.toContain("{@html");
  });
});
