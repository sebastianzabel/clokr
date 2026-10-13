// Issue #568 (D-07) — the bulk-apply preview dialog, mounted: explicit per-contract selection,
// individual contracts unticked by default, confirm blocked at zero, stale 409 reloads the
// preview, other server errors stay inside the dialog. No person names beyond fixtures.
vi.mock("$stores/auth", () => ({ authStore: { subscribe: () => () => {} } }));
vi.mock("$api/client", () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public data?: unknown,
    ) {
      super(message);
    }
  }
  return { ApiError, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } };
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import { ApiError } from "$api/client";
import type { BulkApplyPreview, ContractValues } from "$lib/api/bulk-apply";
import BulkApplyDialog from "../BulkApplyDialog.svelte";

function values(weeklyHours: number, workDays: number[]): ContractValues {
  return {
    weeklyHours,
    mondayHours: 8,
    tuesdayHours: 8,
    wednesdayHours: 8,
    thursdayHours: 8,
    fridayHours: 8,
    saturdayHours: 0,
    sundayHours: 0,
    workDays,
    overtimeThreshold: 40,
    allowOvertimePayout: false,
  };
}

const AFTER = values(40, [1, 2, 3, 4, 5]);

function preview(over: Partial<BulkApplyPreview> = {}): BulkApplyPreview {
  return {
    effectiveFrom: "2026-11-01",
    earliestEffectiveFrom: "2026-11-01",
    latestEffectiveFrom: "2027-10-01",
    allowedEffectiveFrom: ["2026-11-01", "2026-12-01"],
    fingerprint: "a".repeat(64),
    proposed: AFTER,
    candidates: [
      {
        employeeId: "e-match",
        name: "Probe Eins",
        employeeNumber: "M-001",
        category: "MATCHES_DEFAULTS",
        defaultSelected: true,
        before: { ...values(38, [1, 2, 3, 4, 5]), type: "FIXED_SCHEDULE", validFrom: "2026-01-01" },
        after: AFTER,
      },
      {
        employeeId: "e-indiv",
        name: "Probe Zwei",
        employeeNumber: "M-002",
        category: "INDIVIDUAL",
        defaultSelected: false,
        before: { ...values(16, [1, 2, 3, 4]), type: "FIXED_SCHEDULE", validFrom: "2026-01-01" },
        after: AFTER,
      },
      {
        employeeId: "e-none",
        name: "Probe Drei",
        employeeNumber: "M-003",
        category: "NO_CONTRACT",
        defaultSelected: true,
        before: null,
        after: AFTER,
      },
    ],
    nonCandidates: [
      {
        reason: "OTHER_SCHEDULE_TYPE",
        count: 1,
        employees: [{ employeeId: "e-mini", name: "Probe Vier", employeeNumber: "M-004" }],
      },
    ],
    ...over,
  };
}

const loadPreview = vi.fn();
const onConfirm = vi.fn();

function mount() {
  return renderWithTheme(BulkApplyDialog, { open: true, loadPreview, onConfirm });
}

function box(name: RegExp) {
  return screen.getByRole("checkbox", { name }) as HTMLInputElement;
}
const confirmButton = () => screen.getByRole("button", { name: "Änderungen übernehmen" });

beforeEach(() => {
  loadPreview.mockReset();
  onConfirm.mockReset();
  loadPreview.mockResolvedValue(preview());
  onConfirm.mockResolvedValue(undefined);
});

describe("BulkApplyDialog", () => {
  it("loads the preview once on open and pre-ticks exactly defaultSelected", async () => {
    mount();
    await screen.findByText("Probe Eins");
    expect(loadPreview).toHaveBeenCalledTimes(1);
    expect(loadPreview).toHaveBeenCalledWith(undefined);
    expect(box(/Probe Eins/).checked).toBe(true);
    expect(box(/Probe Drei/).checked).toBe(true);
    expect(box(/Probe Zwei/).checked).toBe(false);
    expect(screen.getByText("2 Verträge werden ab 01.11.2026 geändert")).toBeTruthy();
    expect(screen.getByText("Individueller Vertrag")).toBeTruthy();
    expect(screen.getByText("kein Vertrag hinterlegt → 40 h · Mo–Fr")).toBeTruthy();
  });

  it("blocks confirm at zero selected and counts a ticked individual contract", async () => {
    mount();
    await screen.findByText("Probe Eins");
    await fireEvent.click(box(/Probe Eins/));
    await fireEvent.click(box(/Probe Drei/));
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Kein Vertrag ausgewählt")).toBeTruthy();
    await fireEvent.click(box(/Probe Zwei/));
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("1 Vertrag wird ab 01.11.2026 geändert")).toBeTruthy();
  });

  it("offers exactly the server's allowed dates and reloads on change", async () => {
    mount();
    await screen.findByText("Probe Eins");
    const select = screen.getByLabelText("Gültig ab") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["2026-11-01", "2026-12-01"]);
    expect([...select.options].map((o) => o.text)).toEqual(["01.11.2026", "01.12.2026"]);
    // The new preview ticks only one row; the selection must follow it, not the old choice.
    loadPreview.mockResolvedValueOnce(
      preview({
        effectiveFrom: "2026-12-01",
        candidates: preview().candidates.map((c) => ({
          ...c,
          defaultSelected: c.employeeId === "e-indiv",
        })),
      }),
    );
    await fireEvent.change(select, { target: { value: "2026-12-01" } });
    await waitFor(() => expect(loadPreview).toHaveBeenCalledWith("2026-12-01"));
    await screen.findByText("1 Vertrag wird ab 01.12.2026 geändert");
    expect(box(/Probe Zwei/).checked).toBe(true);
    expect(box(/Probe Eins/).checked).toBe(false);
  });

  it("lists the non-candidates grouped by reason", async () => {
    mount();
    await screen.findByText("Probe Eins");
    expect(screen.getByText("Nicht betroffen")).toBeTruthy();
    expect(
      screen.getByText(/Anderes Arbeitszeitmodell \(z\. B\. Minijob, Schichtbetrieb\)/),
    ).toBeTruthy();
    expect(screen.getByText(/Probe Vier/)).toBeTruthy();
  });

  it("confirms with a sorted id list, the fingerprint and the date, then closes", async () => {
    mount();
    await screen.findByText("Probe Eins");
    await fireEvent.click(confirmButton());
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledWith({
      applyEmployeeIds: ["e-match", "e-none"],
      previewFingerprint: "a".repeat(64),
      effectiveFrom: "2026-11-01",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the dialog open on a stale 409, says so and reloads the preview", async () => {
    onConfirm.mockRejectedValueOnce(
      new ApiError(409, "veraltet", { code: "BULK_APPLY_PREVIEW_STALE" }),
    );
    mount();
    await screen.findByText("Probe Eins");
    await fireEvent.click(box(/Probe Zwei/));
    await fireEvent.click(confirmButton());
    await screen.findByText(/Die Vorschau ist veraltet/);
    expect(screen.getByRole("dialog")).toBeTruthy();
    await waitFor(() => expect(loadPreview).toHaveBeenCalledTimes(2));
    // The selection is reset to the reloaded preview's defaultSelected.
    expect(box(/Probe Zwei/).checked).toBe(false);
  });

  it("shows another server rejection inside the dialog", async () => {
    onConfirm.mockRejectedValueOnce(new ApiError(400, "Der Stichtag liegt in der Vergangenheit."));
    mount();
    await screen.findByText("Probe Eins");
    await fireEvent.click(confirmButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Der Stichtag liegt in der Vergangenheit.");
    expect(alert.className).toContain("error");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(loadPreview).toHaveBeenCalledTimes(1);
  });

  it("says there is nothing to change when there are no candidates", async () => {
    loadPreview.mockResolvedValue(preview({ candidates: [] }));
    mount();
    await screen.findByText("Keine Verträge zu ändern");
    expect(screen.getByText(/Haken bei „Auch auf bestehende Mitarbeiter anwenden“/)).toBeTruthy();
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
  });
});
