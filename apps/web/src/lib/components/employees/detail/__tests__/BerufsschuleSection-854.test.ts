// Issue #854 (plan 854-22) - the Berufsschule section of the Vertrag tab, mounted: the patterns with
// their own SaveBar (one PUT, the retroactive check after a save that touches the past) and the
// person's slot override (own keys, inheritance hint, bounds, over-credit notice).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/svelte";

const apiGet = vi.fn();
const apiPut = vi.fn();
const apiPatch = vi.fn();
const apiPost = vi.fn();
const success = vi.fn();
const error = vi.fn();

vi.mock("$api/client", () => ({
  api: {
    get: (...a: unknown[]) => apiGet(...a),
    put: (...a: unknown[]) => apiPut(...a),
    patch: (...a: unknown[]) => apiPatch(...a),
    post: (...a: unknown[]) => apiPost(...a),
  },
}));
vi.mock("$stores/toast", () => ({
  toasts: {
    success: (m: string) => success(m),
    error: (m: string) => error(m),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

import { renderWithTheme } from "$tests/test-utils";
import BerufsschuleSection from "../BerufsschuleSection.svelte";
import type { OverrideEmployee, OverrideTenant } from "$lib/employees/overrides-form";

const PATTERN = {
  id: "p1",
  dayOfWeek: 0,
  daysOfWeek: [0],
  blockWeeks: [],
  blockYear: null,
  validFrom: "2026-12-01",
  validUntil: null,
};
const PATTERN_URL = "/employees/emp-1/vocational-school-pattern";

type Props = Partial<{
  employee: OverrideEmployee;
  tenant: OverrideTenant | null;
  dailySollMin: number | null;
  canManagePattern: boolean;
  canEditSlots: boolean;
  onSlotsSaved: (written: Partial<OverrideEmployee>) => void;
  today: string;
}>;

function mount(props: Props = {}) {
  return renderWithTheme(BerufsschuleSection, {
    employeeId: "emp-1",
    employee: {},
    tenant: null,
    dailySollMin: 480,
    canManagePattern: true,
    canEditSlots: true,
    today: "2026-11-12",
    ...props,
  });
}

const patternBar = () => screen.getAllByRole("region", { name: "Speicherleiste" })[0];

beforeEach(() => {
  vi.clearAllMocks();
  apiGet.mockImplementation(async (url: string) => {
    if (url === PATTERN_URL) return [PATTERN];
    throw new Error(`unexpected GET ${url}`);
  });
  apiPut.mockImplementation(
    async (_url: string, body: { patterns: Record<string, unknown>[] }) => ({
      patterns: body.patterns.map((row, i) => ({ ...row, id: `saved-${i}`, dayOfWeek: null })),
    }),
  );
  apiPatch.mockResolvedValue({});
});

describe("BerufsschuleSection - Berufsschultage", () => {
  it("loads the patterns and shows the weekday of a weekly row, no SaveBar", async () => {
    mount();
    expect(await screen.findByText("Muster 1")).toBeTruthy();
    expect((screen.getByLabelText("Montag") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Dienstag") as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByRole("region", { name: "Speicherleiste" })).toBeNull();
    expect(apiGet).toHaveBeenCalledWith(PATTERN_URL);
  });

  it("an empty list says so and offers to add a day", async () => {
    apiGet.mockResolvedValue([]);
    mount();
    expect(await screen.findByText("Keine Berufsschultage eingerichtet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Berufsschultag hinzufügen" })).toBeTruthy();
  });

  it("a load failure is named as text", async () => {
    apiGet.mockRejectedValue(new Error("nope"));
    mount();
    const alert = await screen.findByText("Berufsschultage konnten nicht geladen werden.");
    expect(alert).toBeTruthy();
  });

  it("a new pattern needs a weekday: the SaveBar counts the error and blocks the save", async () => {
    apiGet.mockResolvedValue([]);
    mount();
    await fireEvent.click(await screen.findByRole("button", { name: "Berufsschultag hinzufügen" }));
    const bar = await screen.findByRole("region", { name: "Speicherleiste" });
    expect(bar.textContent).toContain("1 Fehler");
    expect(screen.getByText("Wähle mindestens einen Wochentag.")).toBeTruthy();
    const save = within(bar).getByRole("button", { name: "Berufsschultage speichern" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.click(screen.getByLabelText("Mittwoch"));
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
  });

  it("saves the whole list in one PUT without the editor-only fields, then toasts", async () => {
    mount();
    await screen.findByText("Muster 1");
    await fireEvent.click(screen.getByLabelText("Mittwoch"));
    expect(patternBar().textContent).toContain("1 Änderung");
    await fireEvent.click(
      within(patternBar()).getByRole("button", { name: "Berufsschultage speichern" }),
    );
    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
    const [url, body] = apiPut.mock.calls[0] as [string, { patterns: Record<string, unknown>[] }];
    expect(url).toBe(PATTERN_URL);
    expect(body.patterns).toHaveLength(1);
    expect(body.patterns[0].daysOfWeek).toEqual([0, 2]);
    expect(body.patterns[0]).not.toHaveProperty("key");
    expect(body.patterns[0]).not.toHaveProperty("mode");
    await waitFor(() => expect(success).toHaveBeenCalledWith("Berufsschultage gespeichert"));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Speicherleiste" })).toBeNull(),
    );
    // a purely forward pattern (starts after today) asks nothing about the past
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it("switching to Blockunterricht clears the days and asks for weeks and the year", async () => {
    mount();
    await screen.findByText("Muster 1");
    await fireEvent.click(screen.getByRole("radio", { name: "Blockunterricht" }));
    expect(screen.queryByLabelText("Montag")).toBeNull();
    expect(screen.getByText("Wähle mindestens eine Block-Woche.")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Kalenderwoche 41" }));
    expect(screen.queryByText("Wähle mindestens eine Block-Woche.")).toBeNull();
    // toggling the first week fills the year with the current one
    expect((screen.getByTestId("bs-block-year") as HTMLInputElement).value).toBe("2026");
    await fireEvent.click(screen.getByRole("button", { name: "Alle abwählen" }));
    expect(screen.getByText("Wähle mindestens eine Block-Woche.")).toBeTruthy();
  });

  it("a save that touches the past asks the retroactive check and opens the wizard when it matters", async () => {
    apiGet.mockImplementation(async (url: string) => {
      if (url === PATTERN_URL) return [{ ...PATTERN, validFrom: "2026-01-01" }];
      if (url.startsWith("/vocational-school/retroactive-preview")) {
        return {
          created: 3,
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
          windowStart: "2026-01-01",
          windowEnd: "2026-11-11",
        };
      }
      throw new Error(`unexpected GET ${url}`);
    });
    mount();
    await screen.findByText("Muster 1");
    await fireEvent.click(screen.getByLabelText("Mittwoch"));
    await fireEvent.click(
      within(patternBar()).getByRole("button", { name: "Berufsschultage speichern" }),
    );
    expect(await screen.findByTestId("bs-retro-dialog")).toBeTruthy();
    expect(apiGet).toHaveBeenCalledWith("/vocational-school/retroactive-preview?employeeId=emp-1");
    // nothing is applied before the person confirms
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("a failing retroactive check never reads as a failed save", async () => {
    apiGet.mockImplementation(async (url: string) => {
      if (url === PATTERN_URL) return [{ ...PATTERN, validFrom: "2026-01-01" }];
      throw new Error("preview down");
    });
    mount();
    await screen.findByText("Muster 1");
    await fireEvent.click(screen.getByLabelText("Mittwoch"));
    await fireEvent.click(
      within(patternBar()).getByRole("button", { name: "Berufsschultage speichern" }),
    );
    await waitFor(() => expect(success).toHaveBeenCalledWith("Berufsschultage gespeichert"));
    await waitFor(() => expect(error).toHaveBeenCalledWith("preview down"));
    expect(screen.queryByTestId("bs-retro-dialog")).toBeNull();
  });

  it("shows the server's refusal as text and keeps the SaveBar", async () => {
    apiPut.mockRejectedValueOnce(new Error("Der Monat ist abgeschlossen."));
    mount();
    await screen.findByText("Muster 1");
    await fireEvent.click(screen.getByLabelText("Mittwoch"));
    await fireEvent.click(
      within(patternBar()).getByRole("button", { name: "Berufsschultage speichern" }),
    );
    expect(await screen.findByText("Der Monat ist abgeschlossen.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Speicherleiste" })).toBeTruthy();
    expect((screen.getByLabelText("Mittwoch") as HTMLInputElement).checked).toBe(true);
  });

  it("Verwerfen restores the saved list; removing a row counts as one change", async () => {
    mount();
    await screen.findByText("Muster 1");
    await fireEvent.click(screen.getByRole("button", { name: "Muster 1 entfernen" }));
    expect(screen.queryByText("Muster 1")).toBeNull();
    expect(patternBar().textContent).toContain("1 Änderung");
    await fireEvent.click(within(patternBar()).getByRole("button", { name: "Verwerfen" }));
    expect(await screen.findByText("Muster 1")).toBeTruthy();
  });

  it("is read-only without vocational-school:manage", async () => {
    mount({ canManagePattern: false });
    await screen.findByText("Muster 1");
    expect((screen.getByLabelText("Mittwoch") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Berufsschultag hinzufügen" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Muster 1 entfernen" })).toBeNull();
  });
});

describe("BerufsschuleSection - Zeitgutschrift Berufsschule", () => {
  const slot = (name: string) => screen.getByTestId(`bs-slot-${name}`) as HTMLInputElement;

  it("says where an empty slot inherits from (Muster, Unternehmen, Tages-Soll)", async () => {
    apiGet.mockResolvedValue([{ ...PATTERN, bsSlotFirstLongDayMinutes: 450 }]);
    mount({ tenant: { bsSlotShortDayMinutes: 420 }, dailySollMin: 480 });
    await screen.findByText("Muster 1");
    expect(screen.getByText("Erbt aus: Muster = 450 Min (7,5 h)")).toBeTruthy();
    expect(screen.getByText("Erbt aus: Unternehmen = 420 Min (7 h)")).toBeTruthy();
    expect(screen.getByText("Erbt aus: Tages-Soll = 480 Min (8 h)")).toBeTruthy();
    expect(screen.getByText("Erbt aus: Wochenstunden-Soll der Person")).toBeTruthy();
  });

  it("an edit sends exactly the four slot keys; an empty one is an explicit null", async () => {
    const onSlotsSaved = vi.fn();
    mount({ onSlotsSaved });
    await screen.findByText("Muster 1");
    await fireEvent.input(slot("short-day"), { target: { value: "300" } });
    const bar = screen.getAllByRole("region", { name: "Speicherleiste" }).at(-1) as HTMLElement;
    await fireEvent.click(within(bar).getByRole("button", { name: "Zeitgutschrift speichern" }));
    await waitFor(() => expect(apiPatch).toHaveBeenCalledTimes(1));
    expect(apiPatch).toHaveBeenCalledWith("/employees/emp-1", {
      bsSlotFirstLongDayMinutes: null,
      bsSlotSecondLongDayMinutes: null,
      bsSlotShortDayMinutes: 300,
      bsSlotBlockWeekMinutes: null,
    });
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("Zeitgutschrift Berufsschule gespeichert."),
    );
    expect(onSlotsSaved).toHaveBeenCalledOnce();
  });

  it("a value outside the bounds is named and blocks the save", async () => {
    mount();
    await screen.findByText("Muster 1");
    await fireEvent.input(slot("block-week"), { target: { value: "100" } });
    await screen.findByText("Der Wert muss zwischen 1200 und 3000 Minuten liegen.");
    const bar = screen.getAllByRole("region", { name: "Speicherleiste" }).at(-1) as HTMLElement;
    const save = within(bar).getByRole("button", { name: "Zeitgutschrift speichern" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  it("warns when the 2nd long day credits more than the 1st one", async () => {
    mount({ dailySollMin: 480 });
    await screen.findByText("Muster 1");
    await fireEvent.input(slot("second-long"), { target: { value: "540" } });
    const warn = await screen.findByTestId("bs-slot-over-credit");
    expect(warn.textContent).toContain("übersteigt den 1. Langtag");
  });

  it("„Leeren“ gives the slot back to the next layer", async () => {
    mount({ employee: { bsSlotShortDayMinutes: 300 } });
    await screen.findByText("Muster 1");
    expect(slot("short-day").value).toBe("300");
    await fireEvent.click(screen.getByRole("button", { name: "Kurztag leeren und erben" }));
    expect(slot("short-day").value).toBe("");
    expect(screen.getAllByRole("region", { name: "Speicherleiste" }).length).toBeGreaterThan(0);
  });

  it("shows the server's refusal as text", async () => {
    apiPatch.mockRejectedValueOnce(new Error("Wert nicht erlaubt."));
    mount();
    await screen.findByText("Muster 1");
    await fireEvent.input(slot("first-long"), { target: { value: "300" } });
    const bar = screen.getAllByRole("region", { name: "Speicherleiste" }).at(-1) as HTMLElement;
    await fireEvent.click(within(bar).getByRole("button", { name: "Zeitgutschrift speichern" }));
    expect((await screen.findByTestId("bs-slot-error")).textContent).toContain(
      "Wert nicht erlaubt.",
    );
  });

  it("is read-only without employee:update", async () => {
    mount({ canEditSlots: false, employee: { bsSlotShortDayMinutes: 300 } });
    await screen.findByText("Muster 1");
    for (const name of ["first-long", "second-long", "short-day", "block-week"]) {
      expect(slot(name).disabled).toBe(true);
    }
    expect(screen.queryByRole("button", { name: "Kurztag leeren und erben" })).toBeNull();
  });
});
