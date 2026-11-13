// Issue #854 (plan 854-07) - „Standard-Arbeitszeit“, mounted, with the guarded bulk apply of Issue #568
// (AC-2) at its new place: a plain save sends the defaults and NO bulk key and never opens the preview;
// the button opens the server's preview; nothing is written before the confirmation; the confirmation
// sends the server's own selection and effective date unchanged; with nothing affected only the
// defaults are saved; a refusal stays inside the dialog.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/svelte";

const put = vi.fn();
const post = vi.fn();
const success = vi.fn();
const error = vi.fn();

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
  return {
    ApiError,
    api: { put: (...a: unknown[]) => put(...a), post: (...a: unknown[]) => post(...a) },
  };
});
vi.mock("$stores/toast", () => ({
  toasts: { success: (m: string) => success(m), error: (m: string) => error(m), info: vi.fn() },
}));

import { renderWithTheme } from "$tests/test-utils";
import { settingsSection } from "$lib/settings/settings-pages";
import type { BulkApplyPreview, ContractValues } from "$lib/api/bulk-apply";
import { ApiError } from "$api/client";
import DefaultHoursSection from "../DefaultHoursSection.svelte";

const KEYS = [...settingsSection("arbeitszeit-standard").keys].sort();
const BULK_KEYS = ["applyToExisting", "applyEmployeeIds", "previewFingerprint", "effectiveFrom"];

const CONFIG = {
  defaultMondayHours: "8.00",
  defaultTuesdayHours: "8.00",
  defaultWednesdayHours: "8.00",
  defaultThursdayHours: "8.00",
  defaultFridayHours: "8.00",
  defaultSaturdayHours: "0.00",
  defaultSundayHours: "0.00",
  overtimeThreshold: "60.00",
  allowOvertimePayout: false,
};

const AFTER: ContractValues = {
  weeklyHours: 40,
  mondayHours: 8,
  tuesdayHours: 8,
  wednesdayHours: 8,
  thursdayHours: 8,
  fridayHours: 8,
  saturdayHours: 0,
  sundayHours: 0,
  workDays: [1, 2, 3, 4, 5],
  overtimeThreshold: 60,
  allowOvertimePayout: false,
};

function preview(over: Partial<BulkApplyPreview> = {}): BulkApplyPreview {
  return {
    effectiveFrom: "2026-12-01",
    earliestEffectiveFrom: "2026-12-01",
    latestEffectiveFrom: "2027-11-01",
    allowedEffectiveFrom: ["2026-12-01", "2027-01-01"],
    fingerprint: "f".repeat(64),
    proposed: AFTER,
    candidates: [
      {
        employeeId: "e-1",
        name: "Probe Eins",
        employeeNumber: "M-001",
        category: "MATCHES_DEFAULTS",
        defaultSelected: true,
        before: { ...AFTER, weeklyHours: 38, type: "FIXED_SCHEDULE", validFrom: "2026-01-01" },
        after: AFTER,
      },
    ],
    nonCandidates: [],
    ...over,
  };
}

const bar = () => screen.queryByRole("region", { name: "Speicherleiste" });
const mondayField = () => screen.getByLabelText("Montag") as HTMLInputElement;

function mount() {
  return renderWithTheme(DefaultHoursSection, { config: CONFIG, canEdit: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  put.mockResolvedValue({});
  post.mockResolvedValue(preview());
});

describe("DefaultHoursSection - plain save", () => {
  it("shows the stored hours and their sum; the string decimals of the API are read as numbers", () => {
    mount();
    expect(mondayField().value).toBe("8");
    expect(screen.getByText("40:00 h")).toBeTruthy();
    expect(bar()).toBeNull();
  });

  it("sends exactly the section's keys, with no bulk key, and never opens the preview", async () => {
    mount();
    await fireEvent.input(mondayField(), { target: { value: "7.5" } });
    expect(screen.getByText("39:30 h")).toBeTruthy();
    await fireEvent.click(
      await screen.findByRole("button", { name: "Standard-Arbeitszeit speichern" }),
    );
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const [path, body] = put.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/settings/work");
    // JSON drops the undefined bulk values; what is left are the defaults and applyToExisting: false.
    const sent = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(
      KEYS.filter((k) => !["applyEmployeeIds", "previewFingerprint", "effectiveFrom"].includes(k)),
    );
    expect(sent).toMatchObject({
      defaultWeeklyHours: 39.5,
      defaultMondayHours: 7.5,
      overtimeThreshold: 60,
      allowOvertimePayout: false,
      applyToExisting: false,
    });
    expect(post).not.toHaveBeenCalled();
    await waitFor(() => expect(bar()).toBeNull());
  });

  it("blocks the save for a day outside 0..24 and for a weekly total above 60 hours", async () => {
    mount();
    await fireEvent.input(mondayField(), { target: { value: "25" } });
    const region = await screen.findByRole("region", { name: "Speicherleiste" });
    expect(region.textContent).toContain("1 Fehler");
    await fireEvent.input(mondayField(), { target: { value: "24" } });
    for (const day of ["Dienstag", "Mittwoch"]) {
      await fireEvent.input(screen.getByLabelText(day), { target: { value: "24" } });
    }
    expect(
      await screen.findByText(/Die Wochensumme muss zwischen 1 und 60 Stunden liegen/),
    ).toBeTruthy();
    expect(put).not.toHaveBeenCalled();
  });
});

describe("DefaultHoursSection - bulk apply to existing contracts (#568)", () => {
  async function openDialog() {
    await fireEvent.click(screen.getByRole("button", { name: "Auf bestehende Verträge anwenden" }));
    await screen.findByText("Probe Eins");
  }

  it("loads the server preview with the proposed values and writes nothing before the confirmation", async () => {
    mount();
    await fireEvent.input(mondayField(), { target: { value: "7" } });
    await openDialog();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe("/settings/work/apply-defaults/preview");
    expect(post.mock.calls[0][1]).toMatchObject({ defaultMondayHours: 7, defaultWeeklyHours: 39 });
    expect(put).not.toHaveBeenCalled();
  });

  it("the confirmation sends the defaults with the server's own selection and date", async () => {
    mount();
    await openDialog();
    await fireEvent.click(screen.getByRole("button", { name: "Änderungen übernehmen" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const body = put.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(JSON.parse(JSON.stringify(body))).sort()).toEqual(KEYS);
    expect(body).toMatchObject({
      applyToExisting: true,
      applyEmployeeIds: ["e-1"],
      previewFingerprint: "f".repeat(64),
      effectiveFrom: "2026-12-01",
    });
    await waitFor(() => expect(success).toHaveBeenCalledWith("1 Vertrag ab 01.12.2026 angepasst"));
  });

  it("with nothing affected only the defaults are saved, without any bulk key", async () => {
    post.mockResolvedValue(preview({ candidates: [] }));
    mount();
    await fireEvent.click(screen.getByRole("button", { name: "Auf bestehende Verträge anwenden" }));
    await fireEvent.click(await screen.findByRole("button", { name: "Nur Vorgaben speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const sent = JSON.parse(JSON.stringify(put.mock.calls[0][1])) as Record<string, unknown>;
    expect(sent.applyToExisting).toBe(false);
    for (const key of BULK_KEYS.filter((k) => k !== "applyToExisting"))
      expect(sent).not.toHaveProperty(key);
  });

  it("a refused apply stays inside the dialog and shows the server's text", async () => {
    put.mockRejectedValueOnce(new ApiError(400, "Der Zeitpunkt ist nicht erlaubt."));
    mount();
    await openDialog();
    await fireEvent.click(screen.getByRole("button", { name: "Änderungen übernehmen" }));
    expect(await screen.findByText("Der Zeitpunkt ist nicht erlaubt.")).toBeTruthy();
    expect(success).not.toHaveBeenCalled();
  });

  it("is not offered while a field is invalid", async () => {
    mount();
    await fireEvent.input(mondayField(), { target: { value: "30" } });
    expect(
      (
        screen.getByRole("button", {
          name: "Auf bestehende Verträge anwenden",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
