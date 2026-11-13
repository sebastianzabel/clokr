// Issue #843 (D-843-01 block 7) - Combobox on bits-ui: first ArrowDown opens (RESEARCH P6), arrows
// move, Enter selects, the input filters through the one normaliser and an empty result says
// "Keine Treffer". Inside a FormField the input carries the field attrs.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { renderWithTheme } from "$tests/test-utils";
import Combobox from "../Combobox.svelte";
import FormField from "../FormField.svelte";
import comboboxSource from "../Combobox.svelte?raw";

afterEach(() => cleanup());

const items = [
  { value: "a", label: "Salon Nord" },
  { value: "b", label: "Salon Süd" },
  { value: "c", label: "Ärztehaus Mitte" },
];

function mount(props: Record<string, unknown> = {}) {
  return renderWithTheme(Combobox, { items, label: "Salon", ...props });
}

function input(): HTMLInputElement {
  return screen.getByRole("combobox") as HTMLInputElement;
}

async function openList() {
  await fireEvent.keyDown(input(), { key: "ArrowDown" });
  await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));
}

describe("Combobox - keyboard", () => {
  it("stays closed until the first ArrowDown, which opens the list without selecting", async () => {
    const onValueChange = vi.fn();
    mount({ onValueChange });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    await openList();
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("moves with ArrowDown/ArrowUp and selects the highlighted item with Enter", async () => {
    const onValueChange = vi.fn();
    mount({ onValueChange });
    await openList();
    // Open -> 1st option highlighted by the opening press or the next one (P6); two more downs and
    // one up land on a deterministic neighbour, whichever the opening highlight was.
    await fireEvent.keyDown(input(), { key: "ArrowDown" });
    await fireEvent.keyDown(input(), { key: "ArrowDown" });
    await fireEvent.keyDown(input(), { key: "ArrowUp" });
    await fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(onValueChange).toHaveBeenCalledTimes(1));
    const picked = onValueChange.mock.calls[0][0] as string;
    const label = items.find((i) => i.value === picked)!.label;
    await waitFor(() => expect(input().value).toBe(label));
  });

  it("updates the bound value on Enter", async () => {
    const onValueChange = vi.fn();
    mount({ onValueChange });
    await openList();
    await fireEvent.keyDown(input(), { key: "ArrowDown" });
    await fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(onValueChange).toHaveBeenCalled());
    expect(["a", "b", "c"]).toContain(onValueChange.mock.calls[0][0]);
  });
});

describe("Combobox - filtering", () => {
  it("selects the only remaining match with Enter and writes its value", async () => {
    const onValueChange = vi.fn();
    mount({ onValueChange });
    await openList();
    await fireEvent.input(input(), { target: { value: "süd" } });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    await fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(onValueChange).toHaveBeenCalledWith("b"));
    await waitFor(() => expect(input().value).toBe("Salon Süd"));
  });

  it("filters through the normaliser (case, spaces, umlauts)", async () => {
    mount();
    await openList();
    await fireEvent.input(input(), { target: { value: "  ÄRZTE " } });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    expect(screen.getByRole("option").textContent).toContain("Ärztehaus Mitte");
  });

  it("says Keine Treffer when nothing matches", async () => {
    mount();
    await openList();
    await fireEvent.input(input(), { target: { value: "zzz" } });
    await waitFor(() => expect(screen.getByText("Keine Treffer")).toBeTruthy());
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("shows the label of an initial value in the input", () => {
    mount({ value: "b" });
    expect(input().value).toBe("Salon Süd");
  });

  it("renders option labels as text, never as HTML", async () => {
    mount({ items: [{ value: "x", label: "<b>fett</b>" }] });
    await openList();
    const option = screen.getByRole("option");
    expect(option.querySelector("b")).toBeNull();
    expect(option.textContent).toContain("<b>fett</b>");
  });
});

describe("Combobox - FormField attrs", () => {
  it("takes id, describedby and invalid from the attrs", () => {
    mount({ id: "salon-field", describedBy: "salon-help", invalid: true });
    const el = input();
    expect(el.id).toBe("salon-field");
    expect(el.getAttribute("aria-describedby")).toBe("salon-help");
    expect(el.getAttribute("aria-invalid")).toBe("true");
  });

  it("is reachable by the label of a FormField that hands it the attrs", () => {
    // FormField's field snippet is a page-level seam; the same three attrs are rendered here by a
    // raw snippet so the label -> id wiring is proven end to end for the id.
    const field = createRawSnippet((ctx: () => { id: string }) => ({
      render: () => `<input role="combobox" id="${ctx().id}" />`,
    }));
    renderWithTheme(FormField, { label: "Salon", field });
    expect(screen.getByLabelText("Salon")).toBe(input());
  });
});

describe("Combobox - source", () => {
  it("filters through the one normaliser and keeps no lower-casing of its own", () => {
    expect(comboboxSource).toMatch(/matchesSearch/);
    expect(comboboxSource).not.toMatch(/toLowerCase|toLocaleLowerCase/);
    expect(comboboxSource).not.toMatch(/\{@html/);
  });

  // Issue #853: bits-ui copies the computed z-index of the CONTENT onto the floating wrapper (inline
  // style), so a value only on the wrapper class leaves the list under the Dialog it was opened from.
  it("carries its stacking value (above the Dialog's 1500/1501) on the content element", () => {
    const content = comboboxSource.match(/\.cb-content\s*\{[^}]*\}/)?.[0] ?? "";
    expect(content).toMatch(/z-index:\s*1600/);
  });
});
