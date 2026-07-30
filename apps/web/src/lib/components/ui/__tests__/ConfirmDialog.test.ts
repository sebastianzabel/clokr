// Phase 76.13 (UI-V19-05) — ConfirmDialog backdrop/ESC dismiss regression.
// Reproduces M-01 from .planning/milestones/v1.8.3-phases/76.7-tracking-exemption-arbzg/76.7-REVIEW.md:
// dismissing via ESC or backdrop click MUST invoke onCancel so parent state can revert.
// Without the fix, parents like the /admin/employees/[id] Tracking-Exemption toggle
// stay in a "phantom-on" half-state.

import { describe, it, expect, vi } from "vitest";
import { createRawSnippet } from "svelte";
import { screen, fireEvent, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import ConfirmDialog from "../ConfirmDialog.svelte";

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    title: "Test-Bestätigung",
    description: "Wirklich fortfahren?",
    onConfirm: vi.fn().mockResolvedValue(undefined),
    onCancel: vi.fn(),
    ...overrides,
  };
}

describe("ConfirmDialog — dismiss paths (Phase 76.13 UI-V19-05)", () => {
  it("Cancel button → onCancel called once, modal closes", async () => {
    const props = baseProps();
    renderWithTheme(ConfirmDialog, props);
    await fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("ESC key → onCancel called once, modal closes (M-01 regression)", async () => {
    const props = baseProps();
    renderWithTheme(ConfirmDialog, props);
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Backdrop click → onCancel called once, modal closes (M-01 regression)", async () => {
    const props = baseProps();
    renderWithTheme(ConfirmDialog, props);
    const scrim = document.querySelector(".scrim");
    expect(scrim).toBeTruthy();
    await fireEvent.click(scrim!);
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Successful confirm → onConfirm called, onCancel NEVER called", async () => {
    const props = baseProps();
    renderWithTheme(ConfirmDialog, props);
    await fireEvent.click(screen.getByRole("button", { name: "Bestätigen" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it("Confirm pending → ESC / backdrop / Cancel do NOT fire onCancel", async () => {
    let resolveConfirm!: () => void;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveConfirm = r;
        }),
    );
    const props = baseProps({ onConfirm });
    renderWithTheme(ConfirmDialog, props);

    // Start the confirm flow — promise stays pending.
    await fireEvent.click(screen.getByRole("button", { name: "Bestätigen" }));

    // While pending, attempt all three dismiss paths.
    await fireEvent.keyDown(window, { key: "Escape" });
    const scrim = document.querySelector(".scrim");
    if (scrim) await fireEvent.click(scrim);
    // Cancel button is disabled while pending (existing behaviour) — click is a no-op.
    const cancelBtn = screen.queryByRole("button", { name: "Abbrechen" });
    if (cancelBtn) await fireEvent.click(cancelBtn);

    expect(props.onCancel).not.toHaveBeenCalled();

    // Tidy up the pending promise so the test does not leak.
    resolveConfirm();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("onConfirm throws → dialog stays open, onCancel NEVER called (then ESC fires onCancel)", async () => {
    // Regression guard for the subtle invariant in ConfirmDialog.svelte:65-78:
    // `confirming = true` MUST be set AFTER `await onConfirm()` resolves, so a
    // throwing handler short-circuits both `confirming = true` and `open = false`.
    // If someone refactors handleConfirm and moves `confirming = true` before
    // the await, the dialog would silently fire onCancel on every failure,
    // which contradicts the documented contract on ConfirmDialog.svelte:71-72.
    // Svelte's onclick handler does NOT await async handlers, so when
    // `handleConfirm` rejects (because `await onConfirm()` throws), the
    // returned promise's rejection leaks as an unhandled rejection in vitest.
    // Suppress it at the Node process level for the duration of this test.
    const expected = new Error("boom");
    const onUnhandled = (reason: unknown) => {
      if (reason === expected) return; // swallow the expected leak only.
      throw reason; // re-surface any unexpected rejection.
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const onConfirm = vi.fn().mockRejectedValue(expected);
      const props = baseProps({ onConfirm });
      renderWithTheme(ConfirmDialog, props);

      await fireEvent.click(screen.getByRole("button", { name: "Bestätigen" }));
      // Dialog stays open after rejection — confirm called once, no cancel.
      await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole("dialog")).not.toBeNull();
      expect(props.onCancel).not.toHaveBeenCalled();

      // Subsequent ESC SHOULD fire onCancel — failure path resets to a normal
      // dismiss cycle (per the comment at ConfirmDialog.svelte:71-72).
      await fireEvent.keyDown(window, { key: "Escape" });
      expect(props.onCancel).toHaveBeenCalledTimes(1);

      // Drain any pending microtasks so the expected unhandled rejection
      // fires while our listener is still attached.
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  // ── Phase 87: additive `body?: Snippet` prop (backward-compatible) ──────────

  it("body omitted → existing dismiss behavior is unchanged (backward-compat)", async () => {
    const props = baseProps(); // no `body`
    renderWithTheme(ConfirmDialog, props);
    // Description still renders; no extra body content leaks in.
    expect(screen.getByText("Wirklich fortfahren?")).toBeTruthy();
    // Cancel path behaves exactly as before.
    await fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("body snippet → its content renders after the description, before the footer", async () => {
    const body = createRawSnippet(() => ({
      render: () => `<p data-testid="collision-body">COLLISION-BODY-MARKER</p>`,
    }));
    const props = baseProps({ body });
    renderWithTheme(ConfirmDialog, props);
    // Both the description and the injected body are present.
    expect(screen.getByText("Wirklich fortfahren?")).toBeTruthy();
    expect(screen.getByText("COLLISION-BODY-MARKER")).toBeTruthy();
    // Footer buttons still render — body sits between description and footer.
    expect(screen.getByRole("button", { name: "Bestätigen" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Abbrechen" })).toBeTruthy();
  });

  it("Re-open after dismiss → effect re-arms, no stale onCancel", async () => {
    const props = baseProps();
    const { rerender } = renderWithTheme(ConfirmDialog, props);
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    // Parent re-opens the dialog (open: false → true).
    await rerender({ ...props, open: true });
    // The effect must NOT fire onCancel just because we re-rendered.
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    // Dismiss again — confirms the effect re-armed.
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onCancel).toHaveBeenCalledTimes(2);
  });
});
