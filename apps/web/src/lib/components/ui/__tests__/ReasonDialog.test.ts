// ReasonDialog composes on ConfirmDialog: a refusal from the caller is shown inline,
// the dialog stays open and nothing leaks as an unhandled rejection.

import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import ReasonDialog from "../ReasonDialog.svelte";

describe("ReasonDialog - refusals", () => {
  it("onConfirm rejects → message shown inline, dialog open, no unhandled rejection", async () => {
    const windowEvents: unknown[] = [];
    const processEvents: unknown[] = [];
    const onWindow = (e: Event) => windowEvents.push(e);
    const onProcess = (reason: unknown) => processEvents.push(reason);
    window.addEventListener("unhandledrejection", onWindow);
    process.on("unhandledRejection", onProcess);

    try {
      const onConfirm = vi.fn().mockRejectedValue(new Error("Abgelehnt."));
      renderWithTheme(ReasonDialog, {
        open: true,
        title: "Grund erfassen",
        confirmLabel: "Speichern",
        onConfirm,
      });
      await fireEvent.input(screen.getByLabelText(/Begründung/), {
        target: { value: "Ein Grund" },
      });
      await fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Abgelehnt."));
      await new Promise((r) => setTimeout(r, 20));
      expect(onConfirm).toHaveBeenCalledWith("Ein Grund");
      expect(screen.queryByRole("dialog")).not.toBeNull();
      expect(windowEvents).toHaveLength(0);
      expect(processEvents).toHaveLength(0);
    } finally {
      window.removeEventListener("unhandledrejection", onWindow);
      process.off("unhandledRejection", onProcess);
    }
  });

  it("blank reason → required message inline, onConfirm not called, no unhandled rejection", async () => {
    const processEvents: unknown[] = [];
    const onProcess = (reason: unknown) => processEvents.push(reason);
    process.on("unhandledRejection", onProcess);
    try {
      const onConfirm = vi.fn();
      renderWithTheme(ReasonDialog, {
        open: true,
        title: "Grund erfassen",
        confirmLabel: "Speichern",
        onConfirm,
      });
      await fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("erforderlich"));
      await new Promise((r) => setTimeout(r, 20));
      expect(onConfirm).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).not.toBeNull();
      expect(processEvents).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onProcess);
    }
  });
});
