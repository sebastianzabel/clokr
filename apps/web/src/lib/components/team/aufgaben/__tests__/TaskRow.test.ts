// Issue #853 (D-853-06) - the Aufgaben row: person as title, period as subtitle, the type as the one
// LeaveTypeChip (dashed while the request waits), the status as a Chip, test id and kind on the li.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { renderWithTheme } from "$tests/test-utils";
import TaskRow from "../TaskRow.svelte";
import type { TaskRowModel } from "$lib/team/task-model";

afterEach(() => cleanup());

const leaveRow: TaskRowModel = {
  key: "urlaub:r1",
  kind: "urlaub",
  sourceId: "r1",
  personName: "Mia Muster",
  title: "Mia Muster",
  subtitle: "14.12.2026 – 18.12.2026 · 4 Arbeitstage",
  createdAt: "2026-11-02T08:00:00.000Z",
  status: "PENDING",
  decided: false,
  typeCode: "VACATION",
};

const retroRow: TaskRowModel = {
  ...leaveRow,
  key: "nachtrag:n1",
  kind: "nachtrag",
  sourceId: "n1",
  subtitle: "Eintrag vom 30.10.2026 · Alter: 4 Tage",
  typeCode: null,
};

const actions = createRawSnippet(() => ({
  render: () => '<button type="button" data-testid="act">Prüfen</button>',
}));

describe("TaskRow - leave row", () => {
  it("shows title, subtitle, the type chip with the passed label and the status chip", () => {
    const { container } = renderWithTheme(TaskRow, { row: leaveRow, typeLabel: "Urlaub" });
    expect(screen.getByText("Mia Muster")).toBeTruthy();
    expect(screen.getByText("14.12.2026 – 18.12.2026 · 4 Arbeitstage")).toBeTruthy();
    const chip = container.querySelector(".leave-type-chip")!;
    expect(chip.textContent).toBe("Urlaub");
    expect(screen.getByText("Ausstehend")).toBeTruthy();
  });

  it("draws a waiting request dashed and a cancellation request as such", () => {
    const { container } = renderWithTheme(TaskRow, { row: leaveRow, typeLabel: "Urlaub" });
    expect(container.querySelector(".leave-type-chip--requested")).not.toBeNull();
    cleanup();
    const cancel = renderWithTheme(TaskRow, {
      row: { ...leaveRow, status: "CANCELLATION_REQUESTED" },
      typeLabel: "Urlaub",
    });
    expect(cancel.container.querySelector(".leave-type-chip--requested")).toBeNull();
    expect(screen.getByText("Stornierung beantragt")).toBeTruthy();
  });

  it("falls back to the code when no label is passed", () => {
    const { container } = renderWithTheme(TaskRow, { row: leaveRow });
    expect(container.querySelector(".leave-type-chip")!.textContent).toBe("VACATION");
  });

  it("puts a decided status chip on a decided row", () => {
    renderWithTheme(TaskRow, {
      row: { ...leaveRow, status: "APPROVED", decided: true },
      typeLabel: "Urlaub",
    });
    expect(screen.getByText("Genehmigt")).toBeTruthy();
    expect(screen.queryByText("Ausstehend")).toBeNull();
  });
});

describe("TaskRow - other kinds", () => {
  it("shows the kind as a chip instead of a leave type chip", () => {
    const { container } = renderWithTheme(TaskRow, { row: retroRow });
    expect(container.querySelector(".leave-type-chip")).toBeNull();
    expect(screen.getByText("Nachtrag")).toBeTruthy();
  });
});

describe("TaskRow - test id, kind, row id, highlight, actions", () => {
  it("puts a test id with kind and source id, the kind and the row id on the li", () => {
    const { container } = renderWithTheme(TaskRow, { row: leaveRow, rowId: "task-1" });
    const li = container.querySelector("li")!;
    expect(li.getAttribute("data-testid")).toBe("task-row-urlaub-r1");
    expect(li.getAttribute("data-kind")).toBe("urlaub");
    expect(li.id).toBe("task-1");
    expect(li.classList.contains("list-row--task")).toBe(true);
  });

  it("tints a highlighted row", () => {
    const { container } = renderWithTheme(TaskRow, { row: leaveRow, highlight: true });
    expect(container.querySelector("li")!.classList.contains("list-row--highlight")).toBe(true);
  });

  it("renders the passed buttons under the text and makes the title the open button", async () => {
    const onOpen = vi.fn();
    renderWithTheme(TaskRow, { row: leaveRow, actions, onOpen });
    expect(screen.getByTestId("act").textContent).toBe("Prüfen");
    await fireEvent.click(screen.getByRole("button", { name: "Mia Muster" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("renders no button of its own without actions and without an open handler", () => {
    const { container } = renderWithTheme(TaskRow, { row: leaveRow });
    expect(container.querySelector("button")).toBeNull();
  });
});
