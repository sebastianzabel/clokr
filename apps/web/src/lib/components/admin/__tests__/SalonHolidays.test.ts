// Issue #579 - the „Feiertage“ section of the salon detail page, mounted. The page itself cannot be
// mounted (no `$app` alias), so this mount test is the component's gate: the two lists, the year
// reload, the add body, client-side refusals, the remove confirmation and the read-only state.
// Issue #854: the lists are DataTables, adding goes through a Dialog with the DatePicker.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/svelte";

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
const success = vi.fn();
const error = vi.fn();

vi.mock("$api/client", () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    delete: (...a: unknown[]) => del(...a),
  },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));
vi.mock("$stores/toast", () => ({
  toasts: { success: (m: string) => success(m), error: (m: string) => error(m), info: vi.fn() },
}));

import { renderWithTheme } from "$tests/test-utils";
import { ApiError } from "$api/client";
import SalonHolidays from "../SalonHolidays.svelte";

const YEAR = new Date().getFullYear();
const CALENDAR = [
  { id: `computed-${YEAR}-01-01`, date: `${YEAR}-01-01`, name: "Neujahr", isManual: false },
  { id: "m-1", date: `${YEAR}-03-10`, name: "Salonjubiläum", isManual: true },
  {
    id: `company-${YEAR}-12-24`,
    date: `${YEAR}-12-24`,
    name: "Heiligabend (frei)",
    isManual: false,
  },
];

/** Types a calendar day into the DatePicker's three segments (Tag, Monat, Jahr). */
async function typeDate(day: string, month: string, year: string) {
  const [d, m, y] = screen.getAllByRole("spinbutton");
  for (const [segment, digits] of [
    [d, day],
    [m, month],
    [y, year],
  ] as const) {
    segment.focus();
    for (const digit of digits) await fireEvent.keyDown(segment, { key: digit });
  }
}

async function openAddDialog() {
  await fireEvent.click(screen.getByRole("button", { name: "Feiertag hinzufügen" }));
  return screen.findByRole("dialog");
}

function mount(canManage: boolean) {
  return renderWithTheme(SalonHolidays, { salonId: "salon-1", canManage });
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue(CALENDAR);
  post.mockResolvedValue({});
  del.mockResolvedValue(undefined);
});

describe("SalonHolidays", () => {
  it("loads the salon's calendar for this year and splits it into manual and statutory lists", async () => {
    mount(true);
    await screen.findByText("Salonjubiläum");
    expect(get).toHaveBeenCalledWith(`/holidays?salonId=salon-1&year=${YEAR}`);
    const manual = screen.getByRole("table", { name: `Zusätzliche Feiertage ${YEAR}` });
    const statutory = screen.getByRole("table", { name: `Gesetzliche Feiertage ${YEAR}` });
    expect(manual.textContent).toContain("Salonjubiläum");
    expect(manual.textContent).not.toContain("Neujahr");
    expect(statutory.textContent).toContain("Neujahr");
    expect(statutory.textContent).toContain("Heiligabend (frei)");
    // Statutory rows are read-only: the only remove button belongs to the manual row.
    expect(screen.getAllByRole("button", { name: /entfernen/ })).toHaveLength(1);
  });

  it("reloads when the year changes", async () => {
    mount(true);
    await screen.findByText("Salonjubiläum");
    await fireEvent.change(screen.getByLabelText("Jahr"), { target: { value: String(YEAR + 1) } });
    await waitFor(() =>
      expect(get).toHaveBeenLastCalledWith(`/holidays?salonId=salon-1&year=${YEAR + 1}`),
    );
  });

  it("posts salonId, date and trimmed name from the dialog, then reloads and closes it", async () => {
    mount(true);
    await screen.findByText("Salonjubiläum");
    const dialog = await openAddDialog();
    await typeDate("02", "05", String(YEAR));
    await fireEvent.input(within(dialog).getByLabelText(/^Bezeichnung/), {
      target: { value: "  Betriebsfest " },
    });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Hinzufügen" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith("/holidays", {
      salonId: "salon-1",
      date: `${YEAR}-05-02`,
      name: "Betriebsfest",
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(success).toHaveBeenCalledWith("Feiertag hinzugefügt.");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("refuses an empty name without calling the API and keeps the dialog open", async () => {
    mount(true);
    await screen.findByText("Salonjubiläum");
    const dialog = await openAddDialog();
    await typeDate("02", "05", String(YEAR));
    await fireEvent.click(within(dialog).getByRole("button", { name: "Hinzufügen" }));
    expect(await screen.findByText("Bitte gib eine Bezeichnung ein.")).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("refuses a missing date without calling the API", async () => {
    mount(true);
    await screen.findByText("Salonjubiläum");
    const dialog = await openAddDialog();
    await fireEvent.input(within(dialog).getByLabelText(/^Bezeichnung/), {
      target: { value: "Ohne Datum" },
    });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Hinzufügen" }));
    expect(await screen.findByText("Bitte wähle ein Datum.")).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it("shows the API's own message on a 409 and does no duplicate check of its own", async () => {
    post.mockRejectedValue(new ApiError(409, "Für diesen Tag existiert bereits ein Feiertag."));
    mount(true);
    await screen.findByText("Salonjubiläum");
    const dialog = await openAddDialog();
    await typeDate("10", "03", String(YEAR));
    await fireEvent.input(within(dialog).getByLabelText(/^Bezeichnung/), {
      target: { value: "Doppelt" },
    });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Hinzufügen" }));
    expect(await screen.findByText("Für diesen Tag existiert bereits ein Feiertag.")).toBeTruthy();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("removes a manual holiday only after the confirmation", async () => {
    mount(true);
    await screen.findByText("Salonjubiläum");
    await fireEvent.click(screen.getByRole("button", { name: /Salonjubiläum.*entfernen/ }));
    expect(del).not.toHaveBeenCalled();
    await fireEvent.click(await screen.findByRole("button", { name: "Entfernen" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/holidays/m-1"));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it("shows the lists but no add form and no remove buttons without the manage right", async () => {
    mount(false);
    await screen.findByText("Salonjubiläum");
    expect(screen.queryByRole("button", { name: "Feiertag hinzufügen" })).toBeNull();
    expect(screen.queryByRole("button", { name: /entfernen/ })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says so with an empty state when the salon has no manual holidays", async () => {
    get.mockResolvedValue([CALENDAR[0]]);
    mount(true);
    expect(await screen.findByText("Noch keine eigenen Feiertage")).toBeTruthy();
    expect(
      screen.getByText(`Für ${YEAR} sind keine zusätzlichen Feiertage eingetragen.`),
    ).toBeTruthy();
    expect(screen.queryByRole("table", { name: `Zusätzliche Feiertage ${YEAR}` })).toBeNull();
    // The computed holidays stay listed, read-only.
    expect(screen.getByRole("table", { name: `Gesetzliche Feiertage ${YEAR}` })).toBeTruthy();
  });

  it("says so when the calendar cannot be loaded", async () => {
    get.mockRejectedValue(new Error("boom"));
    mount(true);
    expect(await screen.findByText("Die Feiertage konnten nicht geladen werden.")).toBeTruthy();
  });
});
