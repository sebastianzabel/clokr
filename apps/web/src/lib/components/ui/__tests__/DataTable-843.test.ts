// Issue #843 (D-843-01 block 6) - DataTable and SortHeader: one table DOM with data-labelled cells,
// sortable heads with aria-sort, the two empty states, loading skeletons, row activation and a
// runtime column change. The 760 px card geometry is declared in the source and proven in the e2e
// of 843-26 (jsdom has no container queries).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import DataTable from "../DataTable.svelte";
import * as dataTableModule from "../DataTable.svelte";
import SortHeader from "../SortHeader.svelte";

// #843: plain tsc types a .svelte import by the ambient default-only shim, so the module-script
// exports are typed by hand here (vitest and svelte-check resolve the real module).
type Sort = { key: string; dir: "asc" | "desc" } | null;
const { nextSortState, sortDirectionOf } = dataTableModule as unknown as {
  nextSortState: (current: Sort, key: string) => Sort;
  sortDirectionOf: (current: Sort, key: string) => "none" | "ascending" | "descending";
};
import tableSource from "../DataTable.svelte?raw";

afterEach(() => cleanup());

const columns = [
  { key: "name", label: "Name", primary: true, sortable: true },
  { key: "email", label: "E-Mail" },
  { key: "status", label: "Status", sortable: true, align: "end" as const },
];

const rows = [
  { id: 1, name: "Person A", email: "person-a@beispiel.test", status: "Aktiv" },
  { id: 2, name: "Person B", email: "person-b@beispiel.test", status: "Aktiv" },
  { id: 3, name: "Person C", email: "person-c@beispiel.test", status: "Ausgetreten" },
];

function render(props: Record<string, unknown> = {}) {
  return renderWithTheme(DataTable, {
    columns,
    rows,
    rowKey: (r: { id: number }) => r.id,
    caption: "Team",
    ...props,
  });
}

describe("DataTable - structure", () => {
  it("renders one table in a scroll wrapper with a caption and data-labelled cells", () => {
    const { container } = render();
    const table = screen.getByRole("table", { name: "Team" });
    expect(table.closest(".dt-scroll")).not.toBeNull();
    expect(container.querySelectorAll("table")).toHaveLength(1);
    const cells = container.querySelectorAll("tbody tr:first-child td");
    expect([...cells].map((c) => c.getAttribute("data-label"))).toEqual([
      "Name",
      "E-Mail",
      "Status",
    ]);
    expect(cells[0].textContent?.trim()).toBe("Person A");
    expect(cells[0]).toHaveClass("dt-primary-cell");
  });

  it("declares the card layout as a 760 px container query and no viewport query", () => {
    expect(tableSource).toMatch(/@container \(max-width: 759\.98px\)/);
    expect(tableSource).not.toMatch(/@media \(max-width/);
    expect(tableSource).toMatch(/attr\(data-label\)/);
    expect(tableSource).not.toContain("{@html");
  });

  // Issue #843 (843-37): the table keeps a value on one line, only the card may wrap it. The wrap
  // rule sat at every width once and broke the 1440 px employee table ("VIS-/004", a clipped
  // Aktionen column); jsdom has no container queries, so the proof reads the stylesheet.
  describe("wrapping is a card-layout rule", () => {
    const style = tableSource
      .slice(tableSource.indexOf("<style>"))
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const cut = style.indexOf("@container (max-width: 759.98px)");
    const tableMode = style.slice(0, cut);
    const cardMode = style.slice(cut);

    // The declarations of every rule whose selector list ends in `selector`, with the rules of
    // nested blocks excluded: `selector {` up to the first closing brace.
    function bodies(css: string, selector: string): string[] {
      const out: string[] = [];
      const pattern = new RegExp(
        `(?:^|[\\s,}])${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
        "g",
      );
      for (const match of css.matchAll(pattern)) out.push(match[1]);
      return out;
    }

    it("finds the container query and the rules it is compared with", () => {
      expect(cut).toBeGreaterThan(0);
      expect(bodies(tableMode, ".dt-table td").length).toBeGreaterThan(0);
      expect(bodies(cardMode, ".dt-table td").length).toBeGreaterThan(0);
    });

    it("keeps a table cell on one line outside the container query", () => {
      const joined = bodies(tableMode, ".dt-table td").join("\n");
      expect(joined).toMatch(/white-space:\s*nowrap/);
      expect(tableMode).not.toMatch(/overflow-wrap/);
      expect(tableMode).not.toMatch(/flex-wrap/);
      // The only `white-space: normal` of table mode is the head, which carries no value.
      const normal = [...tableMode.matchAll(/([^{}]+)\{[^}]*white-space:\s*normal/g)].map((m) =>
        m[1].trim(),
      );
      expect(normal).toEqual([".dt-table :global(th)"]);
    });

    it("lets a cell, the primary cell and the name button wrap only inside the container query", () => {
      expect(bodies(cardMode, ".dt-table td").join("\n")).toMatch(/white-space:\s*normal/);
      expect(cardMode).toMatch(/overflow-wrap:\s*anywhere/);
      expect(cardMode).toMatch(/flex-wrap:\s*wrap/);
      expect(cardMode).toMatch(/\.dt-primary\s*\{[^}]*white-space:\s*normal/);
    });
  });
});

describe("DataTable - sorting", () => {
  it("cycles the sort state none -> ascending -> descending -> none", () => {
    expect(nextSortState(null, "name")).toEqual({ key: "name", dir: "asc" });
    expect(nextSortState({ key: "name", dir: "asc" }, "name")).toEqual({
      key: "name",
      dir: "desc",
    });
    expect(nextSortState({ key: "name", dir: "desc" }, "name")).toBeNull();
    expect(nextSortState({ key: "name", dir: "desc" }, "status")).toEqual({
      key: "status",
      dir: "asc",
    });
    expect(sortDirectionOf({ key: "name", dir: "asc" }, "name")).toBe("ascending");
    expect(sortDirectionOf({ key: "name", dir: "asc" }, "status")).toBe("none");
  });

  it("puts aria-sort on sortable heads only and calls onSort once with the next state", async () => {
    const onSort = vi.fn();
    render({ onSort, sort: { key: "name", dir: "asc" } });
    const heads = screen.getAllByRole("columnheader");
    expect(heads[0]).toHaveAttribute("aria-sort", "ascending");
    expect(heads[1]).not.toHaveAttribute("aria-sort");
    expect(heads[2]).toHaveAttribute("aria-sort", "none");
    await fireEvent.click(screen.getByRole("button", { name: "Nach Name sortieren" }));
    expect(onSort).toHaveBeenCalledTimes(1);
    expect(onSort).toHaveBeenCalledWith({ key: "name", dir: "desc" });
  });

  it("renders SortHeader with the three aria-sort values", async () => {
    for (const direction of ["none", "ascending", "descending"] as const) {
      const onSort = vi.fn();
      const { container } = renderWithTheme(SortHeader, { label: "Name", direction, onSort });
      expect(container.querySelector("th")).toHaveAttribute("aria-sort", direction);
      await fireEvent.click(screen.getByRole("button", { name: "Nach Name sortieren" }));
      expect(onSort).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });
});

describe("DataTable - empty and loading states", () => {
  it("shows the noData state without rows", () => {
    render({ rows: [] });
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("Noch keine Einträge")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Filter zurücksetzen" })).toBeNull();
  });

  it("shows the noMatches state with a reset action when filtered", async () => {
    const onResetFilters = vi.fn();
    render({ rows: [], filtered: true, onResetFilters });
    expect(screen.getByText("Keine Treffer")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Filter zurücksetzen" }));
    expect(onResetFilters).toHaveBeenCalledTimes(1);
  });

  it("renders skeleton rows instead of the body while loading", () => {
    render({ loading: true });
    expect(screen.getByRole("status", { name: "Wird geladen" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("Keine Treffer")).toBeNull();
  });
});

describe("DataTable - rows and columns", () => {
  it("activates a row on click and on Enter of its primary cell, once each", async () => {
    const onRowClick = vi.fn();
    render({ onRowClick });
    const row = screen.getByText("Person B").closest("tr")!;
    await fireEvent.click(row);
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick).toHaveBeenLastCalledWith(rows[1]);
    const control = within(row).getByRole("button", { name: "Person B" });
    await fireEvent.keyDown(control, { key: "Enter" });
    expect(onRowClick).toHaveBeenCalledTimes(2);
    await fireEvent.click(control);
    expect(onRowClick).toHaveBeenCalledTimes(3);
  });

  it("does not activate the row for a click on another control of the row", async () => {
    const onRowClick = vi.fn();
    const { createRawSnippet } = await import("svelte");
    const cell = createRawSnippet((row: () => { name: string }, column: () => { key: string }) => ({
      render: () =>
        column().key === "email"
          ? `<button type="button">Aktion ${row().name}</button>`
          : `<span>${row().name}</span>`,
    }));
    render({ onRowClick, cell });
    await fireEvent.click(screen.getByRole("button", { name: "Aktion Person A" }));
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("renders a table without row buttons when onRowClick is absent", () => {
    render();
    expect(screen.queryByRole("button", { name: "Person A" })).toBeNull();
  });

  it("re-renders head and cells when a column is removed at runtime", async () => {
    const { rerender } = render();
    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
    await rerender({
      columns: columns.filter((c) => c.key !== "email"),
      rows,
      rowKey: (r: { id: number }) => r.id,
      caption: "Team",
    });
    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
    expect(screen.queryByText("person-a@beispiel.test")).toBeNull();
  });
});

// Issue #851 (additive): an element id and a highlight per row.
describe("DataTable rowId and rowHighlight (#851)", () => {
  it("puts the id on the row and marks the highlighted one", () => {
    const { container } = renderWithTheme(DataTable, {
      caption: "Anträge",
      columns: [{ key: "name", label: "Name", primary: true }],
      rows: [
        { id: "a", name: "Erster" },
        { id: "b", name: "Zweiter" },
      ],
      rowKey: (r: { id: string }) => r.id,
      rowId: (r: { id: string }) => `request-${r.id}`,
      rowHighlight: (r: { id: string }) => r.id === "b",
    });
    expect(container.querySelector("#request-a")).not.toBeNull();
    expect(container.querySelector("#request-b")?.classList.contains("dt-row--highlight")).toBe(
      true,
    );
    expect(container.querySelector("#request-a")?.classList.contains("dt-row--highlight")).toBe(
      false,
    );
  });
});
