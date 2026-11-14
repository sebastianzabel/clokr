// Issue #939 - the Vertrag tab over a stored FIXED_SCHEDULE row whose weeklyHours / workDays contradict
// its day hours (pre-#848 data): a calm hint names both values, and a save is confirmed first, never
// silent. Nothing is corrected without the person's explicit save.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/svelte";

const apiGet = vi.fn();
const apiPut = vi.fn();

vi.mock("$api/client", () => ({
  api: {
    get: (...a: unknown[]) => apiGet(...a),
    put: (...a: unknown[]) => apiPut(...a),
    patch: vi.fn(),
  },
}));
vi.mock("$stores/toast", () => ({
  toasts: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { renderWithTheme } from "$tests/test-utils";
import VertragTab from "../VertragTab.svelte";
import type { ContractSchedule } from "$lib/employees/vertrag-form";

const CONSISTENT: ContractSchedule = {
  id: "s1",
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
  validFrom: "2026-11-01T00:00:00.000Z",
  workDays: [1, 2, 3, 4, 5],
};
const CONTRADICTORY: ContractSchedule = {
  ...CONSISTENT,
  weeklyHours: "32.00",
  workDays: [2, 3, 4, 5],
};

function mount(schedule: ContractSchedule) {
  return renderWithTheme(VertragTab, {
    employeeId: "emp-1",
    schedule,
    employee: { classification: "VOLLZEIT" },
    canEdit: true,
    canDiscardShifts: true,
    today: "2026-11-14",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  apiGet.mockResolvedValue([]);
  apiPut.mockImplementation((_url: string, body: Record<string, unknown>) =>
    Promise.resolve({ ...CONSISTENT, ...body, workDays: [1, 2, 3, 4], fridayHours: 0 }),
  );
});

describe("VertragTab - stored contradiction (#939)", () => {
  it("shows no hint for a consistent contract", () => {
    mount(CONSISTENT);
    expect(screen.queryByTestId("vertrag-mismatch-hint")).toBeNull();
  });

  it("names both values, says the day hours count, and how to clean it up", () => {
    mount(CONTRADICTORY);
    const hint = screen.getByTestId("vertrag-mismatch-hint").textContent ?? "";
    expect(hint).toContain("32:00 h pro Woche an Di, Mi, Do, Fr");
    expect(hint).toContain("40:00 h pro Woche an Mo, Di, Mi, Do, Fr");
    expect(hint).toContain("Für Soll und Urlaub zählen die Stunden je Tag");
    expect(hint).toContain("Monatsersten");
    // The form shows the stored day hours as they are - nothing is pre-filled as a "fix".
    expect((screen.getByLabelText("Montag") as HTMLInputElement).value).toBe("8");
    expect(screen.queryByRole("region", { name: "Speicherleiste" })).toBeNull();
  });

  it("a save asks first and sends nothing until confirmed", async () => {
    mount(CONTRADICTORY);
    await fireEvent.input(screen.getByLabelText("Freitag"), { target: { value: "0" } });
    const bar = await screen.findByRole("region", { name: "Speicherleiste" });
    await fireEvent.click(within(bar).getByRole("button", { name: "Vertrag speichern" }));
    const dialog = await screen.findByRole("dialog", { name: "Vertrag so speichern?" });
    expect(dialog.textContent).toContain(
      "Ab 01.12.2026 gelten 32:00 h pro Woche an Mo, Di, Mi, Do",
    );
    expect(dialog.textContent).toContain("Gespeichert sind 32:00 h pro Woche an Di, Mi, Do, Fr.");
    expect(apiPut).not.toHaveBeenCalled();

    await fireEvent.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(apiPut).not.toHaveBeenCalled();

    await fireEvent.click(within(bar).getByRole("button", { name: "Vertrag speichern" }));
    const again = await screen.findByRole("dialog", { name: "Vertrag so speichern?" });
    await fireEvent.click(within(again).getByRole("button", { name: "Vertrag speichern" }));
    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
    expect(apiPut.mock.calls[0][1]).toMatchObject({ weeklyHours: 32, fridayHours: 0 });
    // The PUT answer is the new stored row; a consistent one clears the hint.
    await waitFor(() => expect(screen.queryByTestId("vertrag-mismatch-hint")).toBeNull());
  });

  it("a consistent contract saves without the confirmation", async () => {
    mount(CONSISTENT);
    await fireEvent.input(screen.getByLabelText("Montag"), { target: { value: "6" } });
    const bar = await screen.findByRole("region", { name: "Speicherleiste" });
    await fireEvent.click(within(bar).getByRole("button", { name: "Vertrag speichern" }));
    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog", { name: "Vertrag so speichern?" })).toBeNull();
  });
});
