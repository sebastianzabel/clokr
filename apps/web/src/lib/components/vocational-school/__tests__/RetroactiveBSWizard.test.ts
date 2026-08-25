// Phase 103 plan 04 — component-level coverage for the 3-step wizard. Mirrors the
// mount/query idiom of ui/__tests__/ConfirmDialog.test.ts. All copy assertions were
// already pinned exact-string in retroactive.test.ts — these tests exercise wiring,
// step navigation, the bulk/override interaction, and the double-submit guard.

import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import RetroactiveBSWizard from "../RetroactiveBSWizard.svelte";
import type { RetroactivePreview } from "../retroactive";

function basePreview(overrides: Partial<RetroactivePreview> = {}): RetroactivePreview {
  return {
    created: 1,
    removed: 0,
    skipped: {
      schoolHoliday: 0,
      existing: 0,
      locked: 0,
      removalLocked: 0,
      timeEntryConflict: 0,
      preHire: 0,
      postExit: 0,
      outOfWindow: 0,
    },
    details: [],
    windowStart: "2026-08-12",
    windowEnd: "2026-11-12",
    ...overrides,
  };
}

function conflictPreview(overrides: Partial<RetroactivePreview> = {}): RetroactivePreview {
  return basePreview({
    created: 1,
    skipped: {
      schoolHoliday: 0,
      existing: 0,
      locked: 0,
      removalLocked: 0,
      timeEntryConflict: 2,
      preHire: 0,
      postExit: 0,
      outOfWindow: 0,
    },
    details: [
      { employeeId: "emp-1", date: "2026-08-10", action: "skipped", reason: "timeEntryConflict" },
      { employeeId: "emp-1", date: "2026-08-11", action: "skipped", reason: "timeEntryConflict" },
    ],
    ...overrides,
  });
}

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    preview: basePreview(),
    onConfirm: vi.fn().mockResolvedValue(basePreview({ created: 1 })),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe("RetroactiveBSWizard — no-conflict path (D-02: two clicks)", () => {
  it("shows bs-retro-step-1, and step-2 never enters the DOM at any step", async () => {
    const props = baseProps({ preview: basePreview() });
    renderWithTheme(RetroactiveBSWizard, props);

    expect(screen.getByTestId("bs-retro-step-1")).toBeTruthy();
    expect(screen.queryByTestId("bs-retro-step-2")).toBeNull();

    await fireEvent.click(screen.getByTestId("bs-retro-next"));

    expect(screen.getByTestId("bs-retro-step-3")).toBeTruthy();
    expect(screen.queryByTestId("bs-retro-step-2")).toBeNull();
  });

  it('eyebrow reads "Schritt 1 von 2" without conflicts', () => {
    renderWithTheme(RetroactiveBSWizard, baseProps({ preview: basePreview() }));
    expect(screen.getByText("Schritt 1 von 2")).toBeTruthy();
  });

  it("primary button on step 1 reads Weiter and confirm on step 3 writes via onConfirm", async () => {
    const onConfirm = vi.fn().mockResolvedValue(basePreview({ created: 1 }));
    renderWithTheme(RetroactiveBSWizard, baseProps({ preview: basePreview(), onConfirm }));

    expect(screen.getByTestId("bs-retro-next").textContent?.trim()).toBe("Weiter");
    await fireEvent.click(screen.getByTestId("bs-retro-next"));
    await fireEvent.click(screen.getByTestId("bs-retro-confirm"));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledWith([]);
  });
});

describe("RetroactiveBSWizard — conflict path (D-05/D-06/D-07)", () => {
  it('eyebrow reads "Schritt 1 von 3" with conflicts', () => {
    renderWithTheme(RetroactiveBSWizard, baseProps({ preview: conflictPreview() }));
    expect(screen.getByText("Schritt 1 von 3")).toBeTruthy();
  });

  it("step 1 renders bs-retro-locked-note only when monthLabelsFromDetails is non-null", () => {
    const withLocked = conflictPreview({
      details: [
        { employeeId: "emp-1", date: "2026-08-10", action: "skipped", reason: "timeEntryConflict" },
        { employeeId: "emp-1", date: "2026-07-06", action: "skipped", reason: "locked" },
      ],
    });
    renderWithTheme(RetroactiveBSWizard, baseProps({ preview: withLocked }));
    expect(screen.getByTestId("bs-retro-locked-note")).toBeTruthy();
  });

  it("step 1 renders no locked note when there is nothing locked", () => {
    renderWithTheme(RetroactiveBSWizard, baseProps({ preview: conflictPreview() }));
    expect(screen.queryByTestId("bs-retro-locked-note")).toBeNull();
  });

  it("step 2 renders one row per conflict day, each starting on Überspringen", async () => {
    renderWithTheme(RetroactiveBSWizard, baseProps({ preview: conflictPreview() }));
    await fireEvent.click(screen.getByTestId("bs-retro-next"));

    const row1 = screen.getByTestId("bs-retro-conflict-row-2026-08-10");
    const row2 = screen.getByTestId("bs-retro-conflict-row-2026-08-11");
    expect(row1).toBeTruthy();
    expect(row2).toBeTruthy();

    const toggle1 = within(screen.getByTestId("bs-retro-conflict-toggle-2026-08-10"));
    expect(toggle1.getByRole("radio", { name: "Überspringen" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("bulk-apply sets every row to Übernehmen; an individual toggle afterwards flips only that row", async () => {
    renderWithTheme(RetroactiveBSWizard, baseProps({ preview: conflictPreview() }));
    await fireEvent.click(screen.getByTestId("bs-retro-next"));

    await fireEvent.click(screen.getByTestId("bs-retro-bulk-apply"));

    const toggle1 = within(screen.getByTestId("bs-retro-conflict-toggle-2026-08-10"));
    const toggle2 = within(screen.getByTestId("bs-retro-conflict-toggle-2026-08-11"));
    expect(toggle1.getByRole("radio", { name: "Übernehmen" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(toggle2.getByRole("radio", { name: "Übernehmen" }).getAttribute("aria-checked")).toBe(
      "true",
    );

    // Flip only the first row back to skip.
    await fireEvent.click(toggle1.getByRole("radio", { name: "Überspringen" }));

    expect(toggle1.getByRole("radio", { name: "Überspringen" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    // Second row is untouched — still on Übernehmen.
    expect(toggle2.getByRole("radio", { name: "Übernehmen" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("bulk-skip returns every row to Überspringen", async () => {
    renderWithTheme(RetroactiveBSWizard, baseProps({ preview: conflictPreview() }));
    await fireEvent.click(screen.getByTestId("bs-retro-next"));

    await fireEvent.click(screen.getByTestId("bs-retro-bulk-apply"));
    await fireEvent.click(screen.getByTestId("bs-retro-bulk-skip"));

    const toggle1 = within(screen.getByTestId("bs-retro-conflict-toggle-2026-08-10"));
    const toggle2 = within(screen.getByTestId("bs-retro-conflict-toggle-2026-08-11"));
    expect(toggle1.getByRole("radio", { name: "Überspringen" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(toggle2.getByRole("radio", { name: "Überspringen" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("override warning appears only while at least one row is on Übernehmen", async () => {
    renderWithTheme(RetroactiveBSWizard, baseProps({ preview: conflictPreview() }));
    await fireEvent.click(screen.getByTestId("bs-retro-next"));

    expect(screen.queryByTestId("bs-retro-override-warning")).toBeNull();

    await fireEvent.click(screen.getByTestId("bs-retro-bulk-apply"));
    expect(screen.getByTestId("bs-retro-override-warning")).toBeTruthy();

    await fireEvent.click(screen.getByTestId("bs-retro-bulk-skip"));
    expect(screen.queryByTestId("bs-retro-override-warning")).toBeNull();
  });

  it("confirming from step 3 posts effectiveOverrideDates() — only the applied date", async () => {
    const onConfirm = vi.fn().mockResolvedValue(conflictPreview({ created: 1 }));
    renderWithTheme(RetroactiveBSWizard, baseProps({ preview: conflictPreview(), onConfirm }));

    await fireEvent.click(screen.getByTestId("bs-retro-next")); // step 2
    const toggle1 = within(screen.getByTestId("bs-retro-conflict-toggle-2026-08-10"));
    await fireEvent.click(toggle1.getByRole("radio", { name: "Übernehmen" }));
    await fireEvent.click(screen.getByTestId("bs-retro-next")); // step 3
    await fireEvent.click(screen.getByTestId("bs-retro-confirm"));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledWith(["2026-08-10"]);
  });
});

describe("RetroactiveBSWizard — double-submit guard (D-01, T-103-REPLAY)", () => {
  it("a second click on bs-retro-confirm while the first promise is unresolved does not increase the onConfirm call count", async () => {
    let resolveConfirm!: (v: RetroactivePreview) => void;
    const onConfirm = vi.fn(
      () =>
        new Promise<RetroactivePreview>((r) => {
          resolveConfirm = r;
        }),
    );
    renderWithTheme(RetroactiveBSWizard, baseProps({ preview: basePreview(), onConfirm }));

    await fireEvent.click(screen.getByTestId("bs-retro-next")); // -> step 3
    const confirmBtn = screen.getByTestId("bs-retro-confirm") as HTMLButtonElement;
    await fireEvent.click(confirmBtn);
    expect(confirmBtn.disabled).toBe(true);

    // A second click while pending must be a no-op.
    await fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    resolveConfirm(basePreview({ created: 1 }));
    await waitFor(() => expect(screen.getByTestId("bs-retro-result")).toBeTruthy());
  });
});

describe("RetroactiveBSWizard — post-apply result (D-01, T-103-STALE)", () => {
  it("bs-retro-result renders the RESOLVED server result, not the preview", async () => {
    const preview = basePreview({ created: 1, removed: 0 });
    const serverResult = basePreview({ created: 5, removed: 3 });
    const onConfirm = vi.fn().mockResolvedValue(serverResult);
    renderWithTheme(RetroactiveBSWizard, baseProps({ preview, onConfirm }));

    await fireEvent.click(screen.getByTestId("bs-retro-next"));
    await fireEvent.click(screen.getByTestId("bs-retro-confirm"));

    await waitFor(() => expect(screen.getByTestId("bs-retro-result")).toBeTruthy());
    const resultText = screen.getByTestId("bs-retro-result").textContent ?? "";
    expect(resultText).toContain("5 Tage angelegt");
    expect(resultText).toContain("3 Tage entfernt");
    // Not the preview's numbers.
    expect(resultText).not.toContain("1 Tag angelegt");
  });
});

describe("RetroactiveBSWizard — cancel/back never write (D-01)", () => {
  it("bs-retro-cancel never calls onConfirm", async () => {
    const props = baseProps({ preview: basePreview() });
    renderWithTheme(RetroactiveBSWizard, props);
    await fireEvent.click(screen.getByTestId("bs-retro-cancel"));
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it("bs-retro-back never calls onConfirm", async () => {
    const props = baseProps({ preview: conflictPreview() });
    renderWithTheme(RetroactiveBSWizard, props);
    await fireEvent.click(screen.getByTestId("bs-retro-next")); // step 2
    await fireEvent.click(screen.getByTestId("bs-retro-back")); // back to step 1
    expect(props.onConfirm).not.toHaveBeenCalled();
    expect(screen.getByTestId("bs-retro-step-1")).toBeTruthy();
  });
});
