// Issue #843 (D-843-01 block 7) - BulkPreviewDialog is the bulk-change pattern helper: count
// sentence, the caller's list, an effective date shown (never computed), Abbrechen + confirm.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { renderWithTheme } from "$tests/test-utils";
import BulkPreviewDialog from "../BulkPreviewDialog.svelte";
import source from "../BulkPreviewDialog.svelte?raw";

const list = createRawSnippet(() => ({
  render: () => "<ul><li>Person A</li><li>Person B</li><li>Person C</li></ul>",
}));
const intro = createRawSnippet(() => ({ render: () => "<p>Gilt nie rückwirkend.</p>" }));
const extra = createRawSnippet(() => ({
  render: () => '<button type="button">Nur Vorgaben speichern</button>',
}));

afterEach(() => cleanup());

function mount(props: Record<string, unknown> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const result = renderWithTheme(BulkPreviewDialog, {
    open: true,
    title: "Vorschau der Änderungen",
    count: 12,
    effectiveDate: "2026-12-01",
    confirmLabel: "Änderungen übernehmen",
    onConfirm,
    onCancel,
    list,
    ...props,
  });
  return { ...result, onConfirm, onCancel };
}

const confirmButton = () => screen.getByRole("button", { name: "Änderungen übernehmen" });

describe("BulkPreviewDialog", () => {
  it("states the count, shows the caller's list and the formatted effective date", () => {
    mount();
    expect(screen.getByRole("dialog", { name: "Vorschau der Änderungen" })).toBeTruthy();
    expect(screen.getByText("Betrifft 12 Personen")).toBeTruthy();
    expect(screen.getByText("Gilt ab 01.12.2026")).toBeTruthy();
    expect(screen.getByText("Person B")).toBeTruthy();
  });

  it("uses the singular for one person", () => {
    mount({ count: 1 });
    expect(screen.getByText("Betrifft 1 Person")).toBeTruthy();
  });

  it("renders the optional intro and extra footer action", () => {
    mount({ intro, extraActions: extra });
    expect(screen.getByText("Gilt nie rückwirkend.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Nur Vorgaben speichern" })).toBeTruthy();
  });

  it("confirm calls onConfirm exactly once", async () => {
    const { onConfirm, onCancel } = mount();
    await fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("is disabled at count 0 and while pending", async () => {
    const zero = mount({ count: 0 });
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.click(confirmButton());
    expect(zero.onConfirm).not.toHaveBeenCalled();
    cleanup();

    const pending = mount({ pending: true });
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Abbrechen" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await fireEvent.click(confirmButton());
    expect(pending.onConfirm).not.toHaveBeenCalled();
  });

  it("loading shows the Skeleton in place of count and list and blocks confirm", () => {
    mount({ loading: true });
    expect(screen.getByRole("status", { name: "Wird geladen" })).toBeTruthy();
    expect(screen.queryByText("Person A")).toBeNull();
    expect(screen.queryByText(/Betrifft/)).toBeNull();
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it("Abbrechen closes the dialog and reports the cancellation once", async () => {
    const { onCancel, onConfirm } = mount();
    await fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Escape is a cancellation too", async () => {
    const { onCancel } = mount();
    await fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows no date line without an effective date and never computes one", () => {
    mount({ effectiveDate: undefined });
    expect(screen.queryByText(/Gilt ab/)).toBeNull();
    // The date is only formatted from the caller's ISO day; no clock or date arithmetic here.
    expect(source).not.toMatch(/new Date|Date\.now|setMonth|setDate|addMonths/);
  });

  it("renders the bare panel in place in static mode (example page frames)", () => {
    const { container } = mount({ static: true });
    expect(container.querySelector(".modal--static")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Betrifft 12 Personen")).toBeTruthy();
  });
});
