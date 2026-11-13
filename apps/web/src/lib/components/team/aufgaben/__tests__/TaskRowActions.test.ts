// Issue #853-19 - the in-row decision of an open leave or Zeitnachtrag task: „Ablehnen“ (ghost) and
// „Genehmigen“ (primary), the four-eyes note for the caller's own request, and accessible names that
// say whom the button concerns.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import TaskRowActions from "../TaskRowActions.svelte";

afterEach(() => cleanup());

function props(over: Record<string, unknown> = {}) {
  return {
    kind: "urlaub",
    sourceId: "r1",
    personName: "Mia Muster",
    onApprove: vi.fn(),
    onReject: vi.fn(),
    ...over,
  };
}

describe("TaskRowActions", () => {
  it("shows Ablehnen (ghost) before Genehmigen (primary), both small", () => {
    renderWithTheme(TaskRowActions, props());
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["Ablehnen", "Genehmigen"]);
    expect(buttons[0].classList.contains("btn-ghost")).toBe(true);
    expect(buttons[1].classList.contains("btn-primary")).toBe(true);
    expect(buttons.every((b) => b.classList.contains("btn-sm"))).toBe(true);
  });

  it("each button calls back once; Genehmigen asks for nothing else", async () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    renderWithTheme(TaskRowActions, props({ onApprove, onReject }));
    await fireEvent.click(screen.getByTestId("task-approve-urlaub-r1"));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByTestId("task-reject-urlaub-r1"));
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it("the accessible name starts with the visible word and names the person (label in name)", () => {
    renderWithTheme(TaskRowActions, props());
    expect(screen.getByRole("button", { name: "Ablehnen: Antrag von Mia Muster" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Genehmigen: Antrag von Mia Muster" })).toBeTruthy();
  });

  it("a cancellation request is named as such for assistive technology, the words stay the same", () => {
    renderWithTheme(TaskRowActions, props({ cancellation: true }));
    expect(
      screen.getByRole("button", { name: "Genehmigen: Stornierung von Mia Muster" }).textContent,
    ).toContain("Genehmigen");
  });

  it("a decision under way disables both buttons; the deciding row shows an ellipsis", () => {
    renderWithTheme(TaskRowActions, props({ busy: true, deciding: true }));
    const reject = screen.getByTestId("task-reject-urlaub-r1") as HTMLButtonElement;
    const approve = screen.getByTestId("task-approve-urlaub-r1") as HTMLButtonElement;
    expect(reject.disabled).toBe(true);
    expect(approve.disabled).toBe(true);
    expect(approve.textContent?.trim()).toBe("…");
  });

  it("another row's decision disables the buttons but keeps the words", () => {
    renderWithTheme(TaskRowActions, props({ busy: true, deciding: false }));
    expect((screen.getByTestId("task-approve-urlaub-r1") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("task-approve-urlaub-r1").textContent?.trim()).toBe("Genehmigen");
  });

  it("the caller's own request shows the four-eyes note and no button", () => {
    renderWithTheme(
      TaskRowActions,
      props({ own: true, ownNote: "Hinweis des Vier-Augen-Prinzips" }),
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByTestId("task-own-urlaub-r1").textContent?.trim()).toBe(
      "Hinweis des Vier-Augen-Prinzips",
    );
  });

  it("has no Prüfen button", () => {
    renderWithTheme(TaskRowActions, props());
    expect(screen.queryByText("Prüfen")).toBeNull();
  });
});
