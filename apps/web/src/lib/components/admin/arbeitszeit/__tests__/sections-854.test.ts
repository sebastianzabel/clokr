// Issue #854 (plan 854-07) - the four sections moved from the System page, mounted: each saves exactly
// the keys of its registry section through one SaveBar, an invalid value blocks the save, and the
// special cases survive the move (an empty Berufsschule field sends null and the server's warnings are
// shown, Arbeitstage need one day, the core times belong together).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/svelte";

const put = vi.fn();
const success = vi.fn();
const error = vi.fn();

vi.mock("$api/client", () => ({ api: { put: (...a: unknown[]) => put(...a) } }));
vi.mock("$stores/toast", () => ({
  toasts: { success: (m: string) => success(m), error: (m: string) => error(m), info: vi.fn() },
}));

import { renderWithTheme } from "$tests/test-utils";
import { settingsSection } from "$lib/settings/settings-pages";
import CoreHoursSection from "../CoreHoursSection.svelte";
import RetroWindowSection from "../RetroWindowSection.svelte";
import VocationalSlotsSection from "../VocationalSlotsSection.svelte";
import WorkDaysSection from "../WorkDaysSection.svelte";

const keysOf = (id: string) => [...settingsSection(id).keys].sort();
const bar = () => screen.queryByRole("region", { name: "Speicherleiste" });

beforeEach(() => {
  vi.clearAllMocks();
  put.mockResolvedValue({});
});

describe("RetroWindowSection", () => {
  it("saves retroEntryWindowDays alone", async () => {
    renderWithTheme(RetroWindowSection, { config: { retroEntryWindowDays: 10 } });
    const input = screen.getByLabelText("Selbstbearbeitungsfenster (Tage)") as HTMLInputElement;
    expect(input.value).toBe("10");
    expect(bar()).toBeNull();
    await fireEvent.input(input, { target: { value: "14" } });
    await fireEvent.click(await screen.findByRole("button", { name: "Frist speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith("/settings/work", { retroEntryWindowDays: 14 });
    expect(Object.keys(put.mock.calls[0][1]).sort()).toEqual(keysOf("arbeitszeit-rueckwirkend"));
    await waitFor(() => expect(bar()).toBeNull());
  });

  it("blocks a value outside 1..90", async () => {
    renderWithTheme(RetroWindowSection, { config: {} });
    await fireEvent.input(screen.getByLabelText("Selbstbearbeitungsfenster (Tage)"), {
      target: { value: "91" },
    });
    const region = await screen.findByRole("region", { name: "Speicherleiste" });
    expect(region.textContent).toContain("1 Fehler");
    expect(
      (screen.getByRole("button", { name: "Frist speichern" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("WorkDaysSection", () => {
  it("shows the stored days and saves the ascending index array", async () => {
    renderWithTheme(WorkDaysSection, { config: { defaultWorkDays: [1, 2, 3, 4, 5] } });
    expect((screen.getByLabelText("Montag") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Sonntag") as HTMLInputElement).checked).toBe(false);
    await fireEvent.click(screen.getByLabelText("Samstag"));
    await fireEvent.click(screen.getByLabelText("Sonntag"));
    await fireEvent.click(await screen.findByRole("button", { name: "Arbeitstage speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith("/settings/work", { defaultWorkDays: [0, 1, 2, 3, 4, 5, 6] });
    expect(Object.keys(put.mock.calls[0][1]).sort()).toEqual(keysOf("arbeitszeit-arbeitstage"));
  });

  it("refuses to save with no day at all", async () => {
    renderWithTheme(WorkDaysSection, { config: { defaultWorkDays: [3] } });
    await fireEvent.click(screen.getByLabelText("Mittwoch"));
    const region = await screen.findByRole("region", { name: "Speicherleiste" });
    expect(region.textContent).toContain("1 Fehler");
    expect(screen.getByText("Mindestens ein Arbeitstag muss aktiv sein.")).toBeTruthy();
    expect(put).not.toHaveBeenCalled();
  });
});

describe("CoreHoursSection", () => {
  it("saves times and days under the three registry keys, an emptied time as null", async () => {
    renderWithTheme(CoreHoursSection, {
      config: { defaultCoreStart: "09:00", defaultCoreEnd: "15:00", defaultCoreDays: [1] },
    });
    await fireEvent.click(screen.getByLabelText("Dienstag"));
    await fireEvent.click(await screen.findByRole("button", { name: "Kernzeit speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith("/settings/work", {
      defaultCoreStart: "09:00",
      defaultCoreEnd: "15:00",
      defaultCoreDays: [1, 2],
    });
    expect(Object.keys(put.mock.calls[0][1]).sort()).toEqual(keysOf("arbeitszeit-gleitzeit"));
  });

  it("blocks a begin without an end", async () => {
    renderWithTheme(CoreHoursSection, { config: {} });
    await fireEvent.input(screen.getByLabelText("Kernzeitbeginn"), { target: { value: "09:00" } });
    const region = await screen.findByRole("region", { name: "Speicherleiste" });
    expect(region.textContent).toContain("1 Fehler");
    expect(put).not.toHaveBeenCalled();
  });
});

describe("VocationalSlotsSection", () => {
  it("saves the four keys, an empty field as null, and shows the server's warnings", async () => {
    put.mockResolvedValueOnce({ warnings: ["Die Gutschrift übersteigt das Tages-Soll."] });
    renderWithTheme(VocationalSlotsSection, { config: {} });
    await fireEvent.input(screen.getByLabelText("Berufsschul-Kurztag (Minuten)"), {
      target: { value: "360" },
    });
    await fireEvent.click(await screen.findByRole("button", { name: "Zeitgutschrift speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith("/settings/work", {
      bsSlotFirstLongDayMinutes: null,
      bsSlotSecondLongDayMinutes: null,
      bsSlotShortDayMinutes: 360,
      bsSlotBlockWeekMinutes: null,
    });
    expect(Object.keys(put.mock.calls[0][1]).sort()).toEqual(keysOf("arbeitszeit-berufsschule"));
    expect(await screen.findByText("Die Gutschrift übersteigt das Tages-Soll.")).toBeTruthy();
    await waitFor(() => expect(bar()).toBeNull());
  });

  it("clears a stored value with „Leeren“ and sends null for it", async () => {
    renderWithTheme(VocationalSlotsSection, { config: { bsSlotShortDayMinutes: 300 } });
    await fireEvent.click(
      screen.getByRole("button", { name: "Kurztag leeren und aus dem Tages-Soll nehmen" }),
    );
    await fireEvent.click(await screen.findByRole("button", { name: "Zeitgutschrift speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0][1]).toMatchObject({ bsSlotShortDayMinutes: null });
  });

  it("blocks a value outside the bounds", async () => {
    renderWithTheme(VocationalSlotsSection, { config: {} });
    await fireEvent.input(screen.getByLabelText("Blockunterricht-Woche (Minuten)"), {
      target: { value: "100" },
    });
    const region = await screen.findByRole("region", { name: "Speicherleiste" });
    expect(region.textContent).toContain("1 Fehler");
    expect(put).not.toHaveBeenCalled();
  });
});
