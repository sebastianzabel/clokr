// Issue #843 (D-843-11, plan 843-26) - `rowTestId` puts a stable data-testid on every row, with and
// without a row click, so a page whose e2e addresses rows by id (/admin/employees) keeps working.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import DataTable from "../DataTable.svelte";

afterEach(() => cleanup());

const columns = [
  { key: "name", label: "Name", primary: true },
  { key: "email", label: "E-Mail" },
];
const rows = [
  { id: 1, name: "Person A", email: "person-a@beispiel.test" },
  { id: 2, name: "Person B", email: "person-b@beispiel.test" },
];

function render(props: Record<string, unknown>) {
  return renderWithTheme(DataTable, {
    columns,
    rows,
    rowKey: (r: { id: number }) => r.id,
    rowTestId: (r: { id: number }) => `row-${r.id}`,
    caption: "Team",
    ...props,
  });
}

describe("DataTable rowTestId", () => {
  it("[floor] the fixture renders two rows", () => {
    const { container } = render({});
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
  });

  it("sets the testid on a plain row", () => {
    const { container } = render({});
    expect(
      [...container.querySelectorAll("tbody tr")].map((r) => r.getAttribute("data-testid")),
    ).toEqual(["row-1", "row-2"]);
  });

  it("sets the testid on a clickable row", () => {
    const { container } = render({ onRowClick: () => {} });
    expect(
      [...container.querySelectorAll("tbody tr")].map((r) => r.getAttribute("data-testid")),
    ).toEqual(["row-1", "row-2"]);
  });

  it("emits no attribute without the prop", () => {
    const { container } = render({ rowTestId: undefined });
    expect(container.querySelector("tbody tr")?.hasAttribute("data-testid")).toBe(false);
  });
});
