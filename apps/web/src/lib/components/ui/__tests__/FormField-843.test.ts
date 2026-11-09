// Issue #843 (D-843-01 block 7) - FormField: label, field, help and error with the ARIA wiring.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { renderWithTheme } from "$tests/test-utils";
import FormField from "../FormField.svelte";
import fieldSource from "../FormField.svelte?raw";

afterEach(() => cleanup());

// The field snippet receives { id, describedBy, invalid } and renders the real control.
const field = createRawSnippet(
  (ctx: () => { id: string; describedBy: string | undefined; invalid: boolean }) => ({
    render: () => {
      const c = ctx();
      const desc = c.describedBy ? ` aria-describedby="${c.describedBy}"` : "";
      const inv = c.invalid ? ' aria-invalid="true"' : "";
      return `<input id="${c.id}" class="form-input"${desc}${inv} />`;
    },
  }),
);

function mount(props: Record<string, unknown> = {}) {
  return renderWithTheme(FormField, { label: "Wochenstunden", field, ...props });
}

describe("FormField", () => {
  it("label points at the field id", () => {
    const { container } = mount();
    const label = container.querySelector("label") as HTMLLabelElement;
    const input = container.querySelector("input") as HTMLInputElement;
    expect(label.textContent).toContain("Wochenstunden");
    expect(input.id).toBeTruthy();
    expect(label.htmlFor).toBe(input.id);
    expect(screen.getByLabelText("Wochenstunden")).toBe(input);
  });

  it("without help and error: no description, no aria-invalid", () => {
    const { container } = mount();
    const input = container.querySelector("input") as HTMLInputElement;
    expect(input.hasAttribute("aria-describedby")).toBe(false);
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });

  it("help only: described by the help line", () => {
    const { container } = mount({ help: "Zum Beispiel 39,5" });
    const input = container.querySelector("input") as HTMLInputElement;
    const help = screen.getByText("Zum Beispiel 39,5");
    expect(input.getAttribute("aria-describedby")).toBe(help.id);
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });

  it("error: aria-invalid and a description listing help and error", () => {
    const { container } = mount({ help: "Zum Beispiel 39,5", error: "Gib eine Zahl ein." });
    const input = container.querySelector("input") as HTMLInputElement;
    const help = screen.getByText("Zum Beispiel 39,5");
    const error = screen.getByText("Gib eine Zahl ein.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(`${help.id} ${error.id}`);
    expect(help.id).not.toBe(error.id);
  });

  it("error only: described by the error line", () => {
    const { container } = mount({ error: "Pflichtfeld" });
    const input = container.querySelector("input") as HTMLInputElement;
    expect(input.getAttribute("aria-describedby")).toBe(screen.getByText("Pflichtfeld").id);
  });

  it("the error line carries a hidden dot", () => {
    const { container } = mount({ error: "Pflichtfeld" });
    expect(container.querySelector(".ff-error-dot")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("required marks the label visually without extra accessible text", () => {
    const { container } = mount({ required: true });
    const mark = container.querySelector(".ff-required");
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
  });

  it("two instances get different ids (several frames on one page)", () => {
    const a = mount();
    const b = mount();
    const ids = [...document.querySelectorAll("input")].map((i) => i.id);
    expect(new Set(ids).size).toBe(2);
    a.unmount();
    b.unmount();
  });

  it("uses tokens only: label 600 on --text-2, error --bad, no colour literal", () => {
    const style = fieldSource.slice(fieldSource.lastIndexOf("<style>"));
    const rules = style.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).toMatch(/\.ff-label\s*\{[^}]*font-weight:\s*600[^}]*color:\s*var\(--text-2\)/);
    expect(rules).toMatch(/var\(--bad\)/);
    expect(rules).toMatch(/var\(--h-control\)/);
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(rules).not.toMatch(/italic|oblique|uppercase|letter-spacing/);
    expect(fieldSource).not.toContain("{@html");
  });
});
