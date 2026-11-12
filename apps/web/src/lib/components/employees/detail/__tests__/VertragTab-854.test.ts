// Issue #854 (plan 854-21) - the Vertrag tab of the employee detail, mounted: the contract change with a
// month-first-only „Gültig ab“ (default: the next month-first), the PUT body per model, the server's
// refusals as text, the pending-shift dialog, the Minijob hint, the timeline and the Nachtrag.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/svelte";

const apiGet = vi.fn();
const apiPut = vi.fn();
const apiPatch = vi.fn();
const success = vi.fn();
const error = vi.fn();

vi.mock("$api/client", () => ({
  api: {
    get: (...a: unknown[]) => apiGet(...a),
    put: (...a: unknown[]) => apiPut(...a),
    patch: (...a: unknown[]) => apiPatch(...a),
  },
}));
vi.mock("$stores/toast", () => ({
  toasts: { success: (m: string) => success(m), error: (m: string) => error(m), info: vi.fn() },
}));

import { renderWithTheme } from "$tests/test-utils";
import VertragTab from "../VertragTab.svelte";
import type { ContractSchedule } from "$lib/employees/vertrag-form";

const FIXED: ContractSchedule = {
  id: "s3",
  type: "FIXED_SCHEDULE",
  weeklyHours: "40.00",
  monthlyHours: null,
  mondayHours: "8.00",
  tuesdayHours: "8.00",
  wednesdayHours: "8.00",
  thursdayHours: "8.00",
  fridayHours: "8.00",
  saturdayHours: "0.00",
  sundayHours: "0.00",
  overtimeThreshold: "60.00",
  allowOvertimePayout: false,
  validFrom: "2026-06-01T00:00:00.000Z",
  workDays: [1, 2, 3, 4, 5],
};

/** Three versions: a Gleitzeit from 2025, the Feste Arbeitszeit from June 2026 and a planned change. */
const HISTORY = [
  { id: "s1", type: "FLEXTIME", validFrom: "2025-01-01T00:00:00.000Z", weeklyHours: "30" },
  { id: "s2", type: "FIXED_SCHEDULE", validFrom: "2026-06-01T00:00:00.000Z", weeklyHours: "40" },
  { id: "s3", type: "MONTHLY_HOURS", validFrom: "2026-12-01T00:00:00.000Z", monthlyHours: "40" },
];

type Props = Partial<{
  schedule: ContractSchedule | null;
  employee: { classification?: string | null };
  canEdit: boolean;
  canDiscardShifts: boolean;
  onSaved: (s: ContractSchedule) => void;
  today: string;
}>;

function mount(props: Props = {}) {
  return renderWithTheme(VertragTab, {
    employeeId: "emp-1",
    schedule: FIXED,
    employee: { classification: "VOLLZEIT" },
    canEdit: true,
    canDiscardShifts: true,
    today: "2026-11-12",
    ...props,
  });
}

function segmentTexts(): string[] {
  const field = document.querySelector('[aria-label="Gültig ab"]') as HTMLElement;
  return Array.from(field.querySelectorAll('[role="spinbutton"]')).map(
    (el) => el.textContent ?? "",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  apiGet.mockResolvedValue(HISTORY);
  apiPut.mockResolvedValue({ ...FIXED, validFrom: "2026-12-01T00:00:00.000Z" });
  apiPatch.mockResolvedValue({});
});

describe("VertragTab - the form", () => {
  it("shows the stored contract, no SaveBar, and „Gültig ab“ at the next month-first", () => {
    mount();
    expect(screen.getByRole("heading", { name: "Vertrag" })).toBeTruthy();
    expect(
      screen.getByRole("radio", { name: "Feste Arbeitszeit" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect((screen.getByLabelText("Montag") as HTMLInputElement).value).toBe("8");
    expect(segmentTexts()).toEqual(["01", "12", "2026"]);
    expect(screen.queryByRole("region", { name: "Speicherleiste" })).toBeNull();
  });

  it("offers the next month-first even on the 1st (never the day it is entered)", () => {
    mount({ today: "2026-12-01" });
    expect(segmentTexts()).toEqual(["01", "01", "2027"]);
  });

  it("an edit counts one change and the PUT carries the day sum and the default start", async () => {
    const onSaved = vi.fn();
    mount({ onSaved });
    await fireEvent.input(screen.getByLabelText("Montag"), { target: { value: "6" } });
    const bar = await screen.findByRole("region", { name: "Speicherleiste" });
    expect(bar.textContent).toContain("1 Änderung");
    await fireEvent.click(within(bar).getByRole("button", { name: "Vertrag speichern" }));
    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
    expect(apiPut.mock.calls[0][0]).toBe("/settings/work/emp-1");
    expect(apiPut.mock.calls[0][1]).toMatchObject({
      type: "FIXED_SCHEDULE",
      mondayHours: 6,
      weeklyHours: 38,
      validFrom: "2026-12-01",
      contractWorkDaysPerWeek: null,
      overtimeMode: "CARRY_FORWARD",
    });
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("Vertrag gespeichert · gilt ab 01.12.2026"),
    );
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Speicherleiste" })).toBeNull(),
    );
    expect(onSaved).toHaveBeenCalledTimes(1);
    // The timeline is read again after the save.
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  it("a „Gültig ab“ that is not a month-first is named and blocks the save (no snapping)", async () => {
    mount();
    const day = document.querySelector(
      '[aria-label="Gültig ab"] [role="spinbutton"]',
    ) as HTMLElement;
    day.focus();
    await fireEvent.keyDown(day, { key: "ArrowUp" });
    expect(
      await screen.findByText(/Vertragswechsel gelten ab dem Monatsersten\. Wähle/),
    ).toBeTruthy();
    expect(segmentTexts()[0]).toBe("02");
    const save = screen.getByRole("button", { name: "Vertrag speichern" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(apiPut).not.toHaveBeenCalled();
  });

  it("Verwerfen restores the stored contract and the default start", async () => {
    mount();
    await fireEvent.input(screen.getByLabelText("Montag"), { target: { value: "3" } });
    await fireEvent.click(await screen.findByRole("button", { name: "Verwerfen" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Montag") as HTMLInputElement).value).toBe("8"),
    );
    expect(screen.queryByRole("region", { name: "Speicherleiste" })).toBeNull();
  });

  it("without a stored schedule the form starts on the defaults", () => {
    mount({ schedule: null });
    expect((screen.getByLabelText("Montag") as HTMLInputElement).value).toBe("8");
    expect(
      screen.getByRole("radio", { name: "Feste Arbeitszeit" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("read-only without the right to change the contract", async () => {
    mount({ canEdit: false });
    expect((screen.getByLabelText("Montag") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("radio", { name: "Gleitzeit" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole("region", { name: "Speicherleiste" })).toBeNull();
  });
});

describe("VertragTab - the models", () => {
  it("MONTHLY_HOURS: the locked overtime mode is displayed, the stored mode is sent unchanged", async () => {
    mount({
      schedule: {
        ...FIXED,
        type: "MONTHLY_HOURS",
        monthlyHours: "0",
        overtimeMode: "CARRY_FORWARD",
      },
    });
    expect((screen.getByLabelText("Überstunden-Modus") as HTMLSelectElement).value).toBe(
      "TRACK_ONLY",
    );
    expect(
      screen.getByText("Ohne Monatsstunden werden Stunden nur erfasst, nicht übertragen."),
    ).toBeTruthy();
    await fireEvent.input(screen.getByLabelText("Überstunden-Warnschwelle"), {
      target: { value: "50" },
    });
    await fireEvent.click(await screen.findByRole("button", { name: "Vertrag speichern" }));
    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
    expect(apiPut.mock.calls[0][1]).toMatchObject({
      type: "MONTHLY_HOURS",
      overtimeMode: "CARRY_FORWARD",
      weeklyHours: null,
      overtimeThreshold: 50,
    });
  });

  it("switching to SHIFT_BASED requires the übliche Arbeitstage before the save (#481)", async () => {
    mount();
    await fireEvent.click(screen.getByRole("radio", { name: "Nach Schichtplan" }));
    expect(
      await screen.findByRole("group", { name: /Übliche Arbeitstage \(Pflicht\)/ }),
    ).toBeTruthy();
    expect(await screen.findByText(/bei Schichtbetrieb Pflicht/)).toBeTruthy();
    const save = screen.getByRole("button", { name: "Vertrag speichern" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    await fireEvent.input(screen.getByLabelText(/^Arbeitstage pro Woche/), {
      target: { value: "2" },
    });
    await fireEvent.click(screen.getByLabelText("Montag", { selector: "input[type=checkbox]" }));
    await fireEvent.click(screen.getByLabelText("Dienstag", { selector: "input[type=checkbox]" }));
    await waitFor(() => expect(save.disabled).toBe(false));
    await fireEvent.click(save);
    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
    const body = apiPut.mock.calls[0][1];
    expect(body).toMatchObject({
      type: "SHIFT_BASED",
      contractWorkDaysPerWeek: 2,
      usualWorkDays: [1, 2],
    });
    expect(body).not.toHaveProperty("workDays");
  });
});

describe("VertragTab - refusals stay visible as text", () => {
  it.each([
    ["MONTH_FIRST_ERROR", "Vertragswechsel sind nur zum Monats-1. erlaubt."],
    ["WEEKLY_HOURS_MISMATCH", "Die Wochenstunden müssen der Summe der Tagesstunden entsprechen."],
    ["usualWorkDays", "Bei Schichtbetrieb sind mindestens 4 übliche Arbeitstage Pflicht."],
  ])("%s", async (_code, text) => {
    apiPut.mockRejectedValue(new Error(text));
    mount();
    await fireEvent.input(screen.getByLabelText("Montag"), { target: { value: "6" } });
    await fireEvent.click(await screen.findByRole("button", { name: "Vertrag speichern" }));
    const alert = await screen.findByTestId("vertrag-save-error");
    expect(alert.textContent).toContain(text);
    // The SaveBar stays: nothing was saved, the person fixes the value and tries again.
    expect(screen.getByRole("region", { name: "Speicherleiste" })).toBeTruthy();
    expect(success).not.toHaveBeenCalled();
  });
});

describe("VertragTab - pending shifts (409 shiftPreview)", () => {
  const orphan = Object.assign(new Error("Geplante Schichten vorhanden"), {
    status: 409,
    data: {
      code: "ORPHAN_SHIFTS_PENDING",
      pendingShifts: 3,
      shiftPreview: [
        { date: "2026-12-03", startTime: "09:00", endTime: "17:00" },
        { date: "2026-12-04", startTime: "09:00", endTime: "17:00" },
      ],
    },
  });

  async function trigger(canDiscardShifts: boolean) {
    apiPut.mockRejectedValueOnce(orphan);
    mount({
      schedule: {
        ...FIXED,
        type: "SHIFT_BASED",
        contractWorkDaysPerWeek: 5,
        usualWorkDays: [1, 2, 3, 4, 5],
      },
      canDiscardShifts,
    });
    await fireEvent.click(screen.getByRole("radio", { name: "Gleitzeit" }));
    await fireEvent.click(await screen.findByRole("button", { name: "Vertrag speichern" }));
    return screen.findByRole("dialog", { name: "Geplante Schichten vorhanden" });
  }

  it("lists the shifts and offers Behalten, Stornieren (with the right) and Abbrechen", async () => {
    const dialog = await trigger(true);
    expect(dialog.textContent).toContain("sind 3 geplante Schichten");
    expect(dialog.textContent).toContain("03.12.2026");
    expect(dialog.textContent).toContain("… und 1 weitere");
    for (const name of ["Abbrechen", "Behalten", "Stornieren"]) {
      expect(within(dialog).getByRole("button", { name })).toBeTruthy();
    }
  });

  it("Behalten repeats the PUT with keepOrphanShifts", async () => {
    const dialog = await trigger(true);
    await fireEvent.click(within(dialog).getByRole("button", { name: "Behalten" }));
    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(2));
    expect(apiPut.mock.calls[1][1]).toMatchObject({ type: "FLEXTIME", keepOrphanShifts: true });
  });

  it("Stornieren repeats the PUT with cancelOrphanShifts", async () => {
    const dialog = await trigger(true);
    await fireEvent.click(within(dialog).getByRole("button", { name: "Stornieren" }));
    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(2));
    expect(apiPut.mock.calls[1][1]).toMatchObject({ cancelOrphanShifts: true });
  });

  it("without the shift right there is no Stornieren, only the explanation", async () => {
    const dialog = await trigger(false);
    expect(within(dialog).queryByRole("button", { name: "Stornieren" })).toBeNull();
    expect(dialog.textContent).toContain("Recht zur Schichtplanung");
  });

  it("Abbrechen returns the model to Nach Schichtplan and sends nothing more", async () => {
    const dialog = await trigger(true);
    await fireEvent.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    await waitFor(() =>
      expect(
        screen.getByRole("radio", { name: "Nach Schichtplan" }).getAttribute("aria-checked"),
      ).toBe("true"),
    );
    expect(apiPut).toHaveBeenCalledTimes(1);
  });
});

describe("VertragTab - Minijob hint (D-854-08)", () => {
  it("warns above the limit and never blocks the save", async () => {
    mount({ employee: { classification: "MINIJOB" } });
    expect(screen.getByText(/Prüfe die Minijob-Grenze/)).toBeTruthy();
    expect(screen.getByText(/Du kannst den Vertrag trotzdem speichern\./)).toBeTruthy();
    await fireEvent.input(screen.getByLabelText("Montag"), { target: { value: "7" } });
    const save = (await screen.findByRole("button", {
      name: "Vertrag speichern",
    })) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
  });

  it("goes away when the hours fit the limit", async () => {
    mount({ employee: { classification: "MINIJOB" } });
    for (const day of ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag"]) {
      await fireEvent.input(screen.getByLabelText(day), { target: { value: "1" } });
    }
    await waitFor(() => expect(screen.queryByText(/Prüfe die Minijob-Grenze/)).toBeNull());
  });

  it("is silent for a full-time person", () => {
    mount({ employee: { classification: "VOLLZEIT" } });
    expect(screen.queryByText(/Prüfe die Minijob-Grenze/)).toBeNull();
  });
});

describe("VertragTab - the timeline", () => {
  it("lists every version newest first with its validity and where it stands", async () => {
    mount();
    const timeline = await screen.findByTestId("contract-history");
    const rows = within(timeline).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("Monatsstunden");
    expect(rows[0].textContent).toContain("ab 01.12.2026 · geplant");
    expect(rows[0].textContent).toContain("Geplant");
    expect(rows[1].textContent).toContain("Feste Arbeitszeit");
    expect(rows[1].textContent).toContain("ab 01.06.2026 · bis 30.11.2026");
    expect(rows[1].textContent).toContain("Aktuell");
    expect(rows[2].textContent).toContain("ab 01.01.2025 · bis 31.05.2026");
    expect(rows[2].textContent).not.toContain("Aktuell");
    expect(screen.getByRole("heading", { name: "Vertragsverlauf" })).toBeTruthy();
  });

  it("is hidden fail-soft when the history cannot be read", async () => {
    apiGet.mockRejectedValue(new Error("403"));
    mount();
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(screen.queryByTestId("contract-history")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Vertragsverlauf" })).toBeNull();
  });
});

describe("VertragTab - Nachtrag of the übliche Arbeitstage (#481)", () => {
  const WITHOUT_ANGABE = [
    {
      id: "n1",
      type: "SHIFT_BASED",
      validFrom: "2025-03-01T00:00:00.000Z",
      weeklyHours: "32",
      contractWorkDaysPerWeek: 3,
      usualWorkDays: [],
    },
  ];

  it("appears only for SHIFT_BASED rows without the Angabe and saves in the existing row", async () => {
    apiGet.mockResolvedValue(WITHOUT_ANGABE);
    mount();
    const group = await screen.findByRole("heading", { name: "Übliche Arbeitstage nachtragen" });
    expect(group).toBeTruthy();
    expect(screen.getByText(/nicht automatisch neu berechnet/)).toBeTruthy();

    const row = screen.getByRole("group", {
      name: /Vertrag gültig ab 01\.03\.2025 · 3 Tage\/Woche/,
    });
    // One day is not enough for a contract of three days: an error blocks the save.
    await fireEvent.click(within(row).getByLabelText("Montag"));
    const bar = await screen.findAllByRole("region", { name: "Speicherleiste" });
    const nachtragBar = bar[bar.length - 1];
    expect(
      within(nachtragBar).getByRole("button", { name: "Übliche Arbeitstage speichern" }),
    ).toHaveProperty("disabled", true);
    await fireEvent.click(within(row).getByLabelText("Mittwoch"));
    await fireEvent.click(within(row).getByLabelText("Freitag"));
    const save = within(nachtragBar).getByRole("button", { name: "Übliche Arbeitstage speichern" });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    await fireEvent.click(save);
    await waitFor(() => expect(apiPatch).toHaveBeenCalledTimes(1));
    expect(apiPatch).toHaveBeenCalledWith("/settings/work/emp-1/usual-work-days", {
      workScheduleId: "n1",
      usualWorkDays: [1, 3, 5],
    });
    await waitFor(() => expect(success).toHaveBeenCalledWith("Übliche Arbeitstage gespeichert."));
  });

  it("is absent when every SHIFT_BASED row carries the Angabe", async () => {
    apiGet.mockResolvedValue([{ ...WITHOUT_ANGABE[0], usualWorkDays: [1, 2, 3] }]);
    mount();
    await screen.findByTestId("contract-history");
    expect(screen.queryByRole("heading", { name: "Übliche Arbeitstage nachtragen" })).toBeNull();
  });
});
