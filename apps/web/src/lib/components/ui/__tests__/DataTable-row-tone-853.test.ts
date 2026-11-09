// Issue #853 (D-853-10) - `rowTone` tints a row through `data-tone`, in the block's own CSS, and
// leaves every row untouched when it is not passed.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import DataTable from "../DataTable.svelte";
import tableSource from "../DataTable.svelte?raw";

afterEach(() => cleanup());

const columns = [
  { key: "name", label: "Name", primary: true },
  { key: "status", label: "Status" },
];
const rows = [
  { id: 1, name: "Person A", status: "fehlt" },
  { id: 2, name: "Person B", status: "ok" },
  { id: 3, name: "Person C", status: "geplant" },
  { id: 4, name: "Person D", status: "heute" },
];

function render(props: Record<string, unknown> = {}) {
  return renderWithTheme(DataTable, {
    columns,
    rows,
    rowKey: (r: { id: number }) => r.id,
    rowTestId: (r: { id: number }) => `row-${r.id}`,
    caption: "Team",
    ...props,
  });
}

const tone = (r: { id: number }) =>
  r.id === 1 ? "warn" : r.id === 3 ? "info" : r.id === 4 ? "highlight" : undefined;

function toneOf(container: HTMLElement, id: number): string | null {
  return container.querySelector(`[data-testid="row-${id}"]`)!.getAttribute("data-tone");
}

describe("DataTable - rowTone", () => {
  it("sets data-tone on tinted rows and nothing on the others", () => {
    const { container } = render({ rowTone: tone });
    expect(toneOf(container, 1)).toBe("warn");
    expect(toneOf(container, 2)).toBeNull();
    expect(toneOf(container, 3)).toBe("info");
    expect(toneOf(container, 4)).toBe("highlight");
  });

  it("sets it on clickable rows too", () => {
    const { container } = render({ rowTone: tone, onRowClick: () => {} });
    expect(toneOf(container, 1)).toBe("warn");
    expect(toneOf(container, 2)).toBeNull();
  });

  it("renders no data-tone without rowTone", () => {
    const { container } = render();
    expect(container.querySelector("[data-tone]")).toBeNull();
  });

  it("tints with the three soft tokens in the block's scoped CSS", () => {
    const style = tableSource.slice(tableSource.indexOf("<style>"));
    expect(style).toMatch(/\[data-tone="warn"\][^{]*\{[^}]*var\(--warn-soft\)/);
    expect(style).toMatch(/\[data-tone="info"\][^{]*\{[^}]*var\(--info-soft\)/);
    expect(style).toMatch(/\[data-tone="highlight"\][^{]*\{[^}]*var\(--brand-tint\)/);
  });
});
