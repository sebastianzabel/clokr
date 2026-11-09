// Issue #843 (D-843-16, T-843-06): while a confirm is in flight the Dialog block's own dismiss
// paths (Escape on the document, a click on the scrim) are refused - the dialog stays open and
// onCancel stays silent. ConfirmDialog.test.ts proves the silence; this file proves the dialog is
// still there.

import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import ConfirmDialog from "../ConfirmDialog.svelte";

describe("ConfirmDialog - dismiss while pending (#843)", () => {
  it("Escape and a scrim click leave the dialog open until the confirm settles", async () => {
    let resolveConfirm!: () => void;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveConfirm = r;
        }),
    );
    const onCancel = vi.fn();
    renderWithTheme(ConfirmDialog, {
      open: true,
      title: "Test-Bestätigung",
      onConfirm,
      onCancel,
    });

    await fireEvent.click(screen.getByRole("button", { name: "Bestätigen" }));
    await fireEvent.keyDown(document, { key: "Escape" });
    const scrim = document.querySelector(".scrim");
    expect(scrim).toBeTruthy();
    await fireEvent.click(scrim!);
    await new Promise((r) => setTimeout(r, 20));

    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(onCancel).not.toHaveBeenCalled();

    resolveConfirm();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onCancel).not.toHaveBeenCalled();
  });
});
