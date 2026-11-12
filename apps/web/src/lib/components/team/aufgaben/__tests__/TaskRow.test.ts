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

describe("TaskRow - plan 10 kinds", () => {
  const noticeRow: TaskRowModel = {
    ...leaveRow,
    key: "pausenbefund:p1",
    kind: "pausenbefund",
    sourceId: "p1",
    personName: "Pausenbefund",
    title: "Pausenbefund",
    subtitle: "Am 10.11.2026 liegt keine Pause vor.",
    status: "OPEN",
    typeCode: null,
  };

  it("a Pausenbefund row has no avatar (its title is the notice's, not a person) and no status chip", () => {
    const { container } = renderWithTheme(TaskRow, { row: noticeRow });
    expect(container.querySelector(".list-avatar")).toBeNull();
    expect(screen.getAllByText("Pausenbefund").length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".chip").length).toBe(1);
  });

  it("an open-task row shows the label the server worded in its kind chip", () => {
    renderWithTheme(TaskRow, {
      row: {
        ...noticeRow,
        key: "ausstempeln:t1",
        kind: "ausstempeln",
        sourceId: "t1",
        personName: "Tom Offen",
        title: "Tom Offen",
        label: "Ausstempeln fehlt",
      },
    });
    expect(screen.getByText("Ausstempeln fehlt")).toBeTruthy();
  });

  it("a § 9 row shows the AU status in words", () => {
    renderWithTheme(TaskRow, {
      row: {
        ...noticeRow,
        kind: "paragraf9",
        key: "paragraf9:s1",
        sourceId: "s1",
        status: "AU_PENDING",
      },
    });
    expect(screen.getByText("AU ausstehend")).toBeTruthy();
    cleanup();
    renderWithTheme(TaskRow, {
      row: {
        ...noticeRow,
        kind: "paragraf9",
        key: "paragraf9:s2",
        sourceId: "s2",
        status: "AU_REJECTED",
      },
    });
    expect(screen.getByText("AU abgelehnt")).toBeTruthy();
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
