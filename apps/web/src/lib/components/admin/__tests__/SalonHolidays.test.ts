// Issue #579 - the „Feiertage“ section of the salon detail page, mounted. The page itself cannot be
// mounted (no `$app` alias), so this mount test is the component's gate: the two lists, the year
// reload, the add body, client-side refusals, the remove confirmation and the read-only state.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/svelte";

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
    const manual = screen.getByRole("list", { name: `Zusätzliche Feiertage ${YEAR}` });
    const statutory = screen.getByRole("list", { name: `Gesetzliche Feiertage ${YEAR}` });
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

  it("posts salonId, date and trimmed name, then reloads", async () => {
    mount(true);
    await screen.findByText("Salonjubiläum");
    await fireEvent.input(screen.getByLabelText("Datum"), { target: { value: `${YEAR}-05-02` } });
    await fireEvent.input(screen.getByLabelText("Bezeichnung"), {
      target: { value: "  Betriebsfest " },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Feiertag hinzufügen" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith("/holidays", {
      salonId: "salon-1",
      date: `${YEAR}-05-02`,
      name: "Betriebsfest",
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(success).toHaveBeenCalledWith("Feiertag hinzugefügt.");
  });

  it("refuses an empty name without calling the API", async () => {
    mount(true);
    await screen.findByText("Salonjubiläum");
    await fireEvent.input(screen.getByLabelText("Datum"), { target: { value: `${YEAR}-05-02` } });
    await fireEvent.click(screen.getByRole("button", { name: "Feiertag hinzufügen" }));
    expect(await screen.findByText("Bitte gib eine Bezeichnung ein.")).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it("shows the API's own message on a 409 and does no duplicate check of its own", async () => {
    post.mockRejectedValue(new ApiError(409, "Für diesen Tag existiert bereits ein Feiertag."));
    mount(true);
    await screen.findByText("Salonjubiläum");
    await fireEvent.input(screen.getByLabelText("Datum"), { target: { value: `${YEAR}-03-10` } });
    await fireEvent.input(screen.getByLabelText("Bezeichnung"), { target: { value: "Doppelt" } });
    await fireEvent.click(screen.getByRole("button", { name: "Feiertag hinzufügen" }));
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
    expect(screen.queryByLabelText("Datum")).toBeNull();
  });

  it("says so when the calendar cannot be loaded", async () => {
    get.mockRejectedValue(new Error("boom"));
    mount(true);
    expect(await screen.findByText("Die Feiertage konnten nicht geladen werden.")).toBeTruthy();
  });
});
