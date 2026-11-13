// Issue #854 (D-854-09) - DataTable row selection, an additive prop set of the block: a leading
// checkbox column (table and card layout share one DOM), a header checkbox for the shown rows with
// an indeterminate state, a row click that still opens the row while the checkbox click does not,
// and an unchanged table when `selectable` is off. The card geometry itself is the container query
// of the block (proven in the e2e); here the card layout is the same DOM with a data-labelled cell.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import DataTable from "../DataTable.svelte";
import tableSource from "../DataTable.svelte?raw";

afterEach(() => cleanup());

const columns = [
  { key: "name", label: "Name", primary: true },
  { key: "email", label: "E-Mail" },
];

const rows = [
  { id: 1, name: "Person A", email: "a@beispiel.test" },
  { id: 2, name: "Person B", email: "b@beispiel.test" },
  { id: 3, name: "Person C", email: "c@beispiel.test" },
];

function render(props: Record<string, unknown> = {}) {
  return renderWithTheme(DataTable, {
    columns,
    rows,
    rowKey: (r: { id: number }) => r.id,
    caption: "Personen",
    selectable: true,
    ...props,
  });
}

const rowBox = (name: string) => screen.getByRole("checkbox", { name });
const headerBox = () => screen.getByRole("checkbox", { name: "Alle angezeigten Zeilen auswählen" });

describe("DataTable - selection", () => {
  it("renders no checkbox without `selectable` and leaves the cells as before", () => {
    const { container } = render({ selectable: false });
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    const cells = container.querySelectorAll("tbody tr:first-child td");
    expect([...cells].map((c) => c.getAttribute("data-label"))).toEqual(["Name", "E-Mail"]);
  });

  it("puts a labelled checkbox first in every row, named after the primary cell", () => {
    const { container } = render();
    expect(screen.getAllByRole("checkbox")).toHaveLength(rows.length + 1);
    expect(rowBox("Person A auswählen")).toBeInTheDocument();
    const first = container.querySelector("tbody tr:first-child td:first-child");
    expect(first).toHaveClass("dt-select-cell");
    expect(first?.getAttribute("data-label")).toBe("Auswahl");
  });

  it("uses `selectionLabel` as the accessible name when given", () => {
    render({ selectionLabel: (r: { name: string }) => `Wähle ${r.name}` });
    expect(rowBox("Wähle Person B")).toBeInTheDocument();
  });

  it("selects one row and reports the keys", async () => {
    const onSelectionChange = vi.fn();
    render({ onSelectionChange });
    await fireEvent.click(rowBox("Person B auswählen"));
    expect(onSelectionChange).toHaveBeenLastCalledWith([2]);
    expect(rowBox("Person B auswählen")).toBeChecked();
    expect(rowBox("Person A auswählen")).not.toBeChecked();
  });

  it("shows the header checkbox as indeterminate for a partial selection", async () => {
    render({ selectedKeys: [1] });
    expect(headerBox()).not.toBeChecked();
    expect((headerBox() as HTMLInputElement).indeterminate).toBe(true);
    await fireEvent.click(rowBox("Person B auswählen"));
    await fireEvent.click(rowBox("Person C auswählen"));
    expect(headerBox()).toBeChecked();
    expect((headerBox() as HTMLInputElement).indeterminate).toBe(false);
  });

  it("selects all shown rows with the header checkbox and deselects them again", async () => {
    const onSelectionChange = vi.fn();
    render({ onSelectionChange });
    await fireEvent.click(headerBox());
    expect(onSelectionChange).toHaveBeenLastCalledWith([1, 2, 3]);
    for (const name of ["Person A", "Person B", "Person C"]) {
      expect(rowBox(`${name} auswählen`)).toBeChecked();
    }
    await fireEvent.click(headerBox());
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);
    expect(rowBox("Person A auswählen")).not.toBeChecked();
  });

  it("deselects a single row again", async () => {
    const onSelectionChange = vi.fn();
    render({ onSelectionChange, selectedKeys: [1, 2] });
    await fireEvent.click(rowBox("Person A auswählen"));
    expect(onSelectionChange).toHaveBeenLastCalledWith([2]);
  });

  it("keeps the keys of rows that are not shown when the header checkbox acts", async () => {
    const onSelectionChange = vi.fn();
    render({ onSelectionChange, selectedKeys: [99] });
    await fireEvent.click(headerBox());
    expect(onSelectionChange).toHaveBeenLastCalledWith([99, 1, 2, 3]);
    await fireEvent.click(headerBox());
    expect(onSelectionChange).toHaveBeenLastCalledWith([99]);
  });

  it("uses native, focusable checkboxes, so Space toggles them in the browser", async () => {
    const onSelectionChange = vi.fn();
    render({ onSelectionChange });
    const box = rowBox("Person C auswählen") as HTMLInputElement;
    expect(box.tagName).toBe("INPUT");
    expect(box.type).toBe("checkbox");
    expect(box.tabIndex).toBeGreaterThanOrEqual(0);
    box.focus();
    expect(box).toHaveFocus();
    // A browser turns Space on a focused checkbox into this click (jsdom does not synthesise it).
    await fireEvent.click(box);
    expect(onSelectionChange).toHaveBeenLastCalledWith([3]);
  });

  it("opens the row on a row click but not on a checkbox click", async () => {
    const onRowClick = vi.fn();
    const { container } = render({ onRowClick });
    await fireEvent.click(rowBox("Person A auswählen"));
    expect(onRowClick).not.toHaveBeenCalled();
    const cell = container.querySelector("tbody tr:first-child td:nth-child(3)") as HTMLElement;
    await fireEvent.click(cell);
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick).toHaveBeenCalledWith(rows[0]);
  });

  it("renders the checkbox on the row cards too: one DOM, a data-labelled select cell", () => {
    // The card layout restyles the same cells below 760 px of container width; the select cell is
    // part of that DOM and declares its card rule (jsdom has no container queries).
    expect(tableSource).toMatch(/@container \(max-width: 759\.98px\)/);
    const card = tableSource.slice(tableSource.indexOf("@container (max-width: 759.98px)"));
    expect(card).toContain(".dt-table td.dt-select-cell");
    const { container } = render();
    expect(container.querySelectorAll("tbody td.dt-select-cell")).toHaveLength(rows.length);
  });

  it("does not select anything while the table is loading", () => {
    render({ loading: true });
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });
});
