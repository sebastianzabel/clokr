// Issue #854 (plan 854-26, D-854-10, T-854-66/67) - the Monatsabschluss page, mounted: the stepper stays,
// the year is a PeriodPicker, the status filter lives in the URL, the month list and the persons of a
// month are tables, closing and unlocking are Dialogs with their unchanged rules, and a reader without
// time-entry reach sees counts instead of dates.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/svelte";

const get = vi.fn();
const post = vi.fn();
const success = vi.fn();
const error = vi.fn();
const goto = vi.fn();
const urlHolder = vi.hoisted(() => ({ search: "" }));

vi.mock("$api/client", () => ({
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));
vi.mock("$stores/toast", () => ({
  toasts: { success: (m: string) => success(m), error: (m: string) => error(m), info: vi.fn() },
}));
vi.mock("$app/state", () => ({
  page: {
    get url() {
      return new URL(`http://localhost/admin/month-close${urlHolder.search}`);
    },
  },
}));
vi.mock("$app/navigation", () => ({
  goto: (...a: unknown[]) => goto(...a),
  afterNavigate: vi.fn(),
  replaceState: vi.fn(),
}));

import { renderWithTheme } from "$tests/test-utils";
import Page from "../routes/(app)/admin/month-close/+page.svelte";

const YEAR = new Date().getFullYear();

const months = [
  { month: 1, name: "Januar", status: "closed", closedCount: 3, totalCount: 3 },
  { month: 2, name: "Februar", status: "ready", closedCount: 0, totalCount: 3 },
  {
    month: 3,
    name: "März",
    status: "open",
    closedCount: 0,
    totalCount: 3,
    missing: [
      {
        employeeName: "Anna Probe",
        employeeNumber: "1",
        missingDates: ["2026-03-05"],
        missingDateCount: 1,
      },
    ],
  },
  ...Array.from({ length: 9 }, (_, i) => ({
    month: i + 4,
    name: `Monat ${i + 4}`,
    status: "future",
    closedCount: 0,
    totalCount: 0,
  })),
];

let detail: unknown[] = [];
let deferred: unknown = { employeeCount: 0, employees: [], severity: "NONE" };

function route(url: string): unknown {
  if (url.startsWith("/overtime/close-month/year-status")) {
    return { year: YEAR, months, autoCloseDeadline: 10, earliestYear: YEAR - 1 };
  }
  if (url.startsWith("/overtime/close-month/status"))
    return { year: YEAR, month: 3, employees: detail };
  if (url.startsWith("/overtime/close-month/deferred")) return deferred;
  throw new Error(`unexpected GET ${url}`);
}

const anna = {
  employeeId: "e-anna",
  employeeName: "Anna Probe",
  employeeNumber: "1",
  status: "missing",
  missingDates: ["2026-03-05"],
  missingDateCount: 1,
  breakFindingDays: ["2026-03-06"],
  breakFindingDayCount: 1,
};
const ben = {
  employeeId: "e-ben",
  employeeName: "Ben Bereit",
  employeeNumber: "2",
  status: "ready",
  missingDates: [],
};
const cleo = {
  employeeId: "e-cleo",
  employeeName: "Cleo Zu",
  employeeNumber: "3",
  status: "closed",
  exitDate: "2026-03-20",
  missingDates: [],
};

async function openMarch() {
  const row = await screen.findByTestId("month-close-row-3");
  await fireEvent.click(within(row).getByRole("button", { name: /März/ }));
  return screen.findByTestId("month-close-detail");
}

describe("Monatsabschluss page (#854)", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    success.mockReset();
    error.mockReset();
    goto.mockReset();
    urlHolder.search = "";
    detail = [anna, ben, cleo];
    deferred = { employeeCount: 0, employees: [], severity: "NONE" };
    get.mockImplementation(async (url: string) => route(url));
    post.mockResolvedValue({});
  });

  it("keeps the four steps, picks the year with a PeriodPicker and lists the twelve months", async () => {
    renderWithTheme(Page, {});
    expect(await screen.findByTestId("month-close-row-12")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Monatsabschluss" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Schritte des Monatsabschlusses" });
    expect(within(nav).getAllByRole("listitem")).toHaveLength(4);
    // The first actionable month is Februar (ready): step 3 (Bestätigen) is current.
    expect(document.querySelector('[aria-current="step"]')?.textContent).toContain("Bestätigen");
    expect(screen.getByTestId("month-close-year-label").textContent).toBe(String(YEAR));
    for (let m = 1; m <= 12; m++) expect(screen.getByTestId(`month-close-row-${m}`)).toBeTruthy();
    expect(screen.getByRole("group", { name: new RegExp(`${YEAR}`) })).toBeTruthy();
  });

  it("steps the year back, never into the future, and not before the first year with data", async () => {
    renderWithTheme(Page, {});
    await screen.findByTestId("month-close-row-1");
    expect((screen.getByTestId("month-close-year-next") as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.click(screen.getByTestId("month-close-year-prev"));
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(`/overtime/close-month/year-status?year=${YEAR - 1}`),
    );
    await waitFor(() =>
      expect(screen.getByTestId("month-close-year-label").textContent).toBe(String(YEAR - 1)),
    );
    await screen.findByTestId("month-close-row-1");
    // earliestYear is YEAR - 1: the previous arrow is now off.
    expect((screen.getByTestId("month-close-year-prev") as HTMLButtonElement).disabled).toBe(true);
    expect(goto).toHaveBeenCalled();
  });

  it("takes year, month and status filter from the URL (the notification deep link)", async () => {
    urlHolder.search = `?year=${YEAR - 1}&month=3&status=open`;
    renderWithTheme(Page, {});
    await screen.findByTestId("month-close-detail");
    expect(get).toHaveBeenCalledWith(`/overtime/close-month/year-status?year=${YEAR - 1}`);
    expect(get).toHaveBeenCalledWith(`/overtime/close-month/status?year=${YEAR - 1}&month=3`);
    // status=open: only the open/partial/ready/blocked months stay in the list
    expect(screen.queryByTestId("month-close-row-1")).toBeNull();
    expect(screen.getByTestId("month-close-row-3")).toBeTruthy();
  });

  it("writes the status filter to the URL and filters the months", async () => {
    renderWithTheme(Page, {});
    await screen.findByTestId("month-close-row-1");
    await fireEvent.click(screen.getByRole("radio", { name: "Abgeschlossen" }));
    expect(screen.getByTestId("month-close-row-1")).toBeTruthy();
    expect(screen.queryByTestId("month-close-row-2")).toBeNull();
    expect(goto).toHaveBeenCalledWith(
      expect.stringContaining("status=closed"),
      expect.objectContaining({ replaceState: true }),
    );
  });

  it("shows the persons of a month with status chips, hints and the exit label", async () => {
    renderWithTheme(Page, {});
    const section = await openMarch();
    const table = await within(section).findByRole("table");
    expect(within(table).getByText("Anna Probe")).toBeTruthy();
    expect(within(table).getByText("Fehlend")).toBeTruthy();
    expect(within(table).getByText("Bereit")).toBeTruthy();
    expect(within(table).getByText("Abgeschlossen")).toBeTruthy();
    expect(within(table).getByText("Austritt am 20.03.2026")).toBeTruthy();
    expect(within(table).getByText("05.03.")).toBeTruthy();
    expect(within(table).getByTestId("break-finding-hint")).toBeTruthy();
    expect(within(table).getAllByRole("button", { name: "Abschließen" })).toHaveLength(2);
    expect(within(table).getByRole("button", { name: "Entsperren" })).toBeTruthy();
  });

  it("renders counts, never dates, for a reader without reach, plus the one neutral hint", async () => {
    detail = [
      {
        ...anna,
        missingDates: [],
        missingDateCount: 4,
        breakFindingDays: [],
        dayDetailsWithheld: true,
      },
    ];
    renderWithTheme(Page, {});
    const section = await openMarch();
    const table = await within(section).findByRole("table");
    expect(within(table).getByText("4 Tage ohne Eintrag")).toBeTruthy();
    expect(table.textContent).not.toMatch(/\d{2}\.\d{2}\./);
    expect(screen.getByTestId("month-close-withheld-hint")).toBeTruthy();
  });

  it("shows the deferred note with its list and jumps to the oldest open month", async () => {
    deferred = {
      employeeCount: 1,
      oldestOpenMonth: { year: YEAR, month: 3 },
      monthsBehind: 2,
      gapCount: 4,
      severity: "WARNING",
      employees: [
        {
          employeeId: "e-anna",
          employeeName: "Anna Probe",
          oldestOpenMonth: { year: YEAR, month: 3 },
          monthsBehind: 2,
          reason: "GAPS",
          gapDates: [],
          gapCount: 4,
          dayDetailsWithheld: true,
        },
      ],
    };
    renderWithTheme(Page, {});
    const note = await screen.findByTestId("month-close-deferred");
    expect(note.textContent).toContain("4 Tage ohne Eintrag");
    await fireEvent.click(screen.getByTestId("month-close-deferred-jump"));
    await screen.findByTestId("month-close-detail");
    expect(get).toHaveBeenCalledWith(`/overtime/close-month/status?year=${YEAR}&month=3`);
  });

  describe("closing", () => {
    it("asks for the gap acknowledgement and posts confirmGaps by the count", async () => {
      renderWithTheme(Page, {});
      const section = await openMarch();
      const annaRow = within(section).getByTestId("month-close-person-e-anna");
      await fireEvent.click(within(annaRow).getByRole("button", { name: "Abschließen" }));

      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByTestId("month-close-gap-warning").textContent).toContain(
        "1 Tag ohne Eintrag",
      );
      const confirm = within(dialog).getByTestId("month-close-confirm") as HTMLButtonElement;
      expect(confirm.disabled).toBe(true);
      await fireEvent.click(within(dialog).getByTestId("month-close-gap-ack"));
      expect(confirm.disabled).toBe(false);

      await fireEvent.click(confirm);
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      expect(post).toHaveBeenCalledWith("/overtime/close-month", {
        employeeId: "e-anna",
        year: YEAR,
        month: 3,
        confirmGaps: true,
      });
      await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("needs no acknowledgement for a person without a gap", async () => {
      renderWithTheme(Page, {});
      const section = await openMarch();
      const benRow = within(section).getByTestId("month-close-person-e-ben");
      await fireEvent.click(within(benRow).getByRole("button", { name: "Abschließen" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).queryByTestId("month-close-gap-warning")).toBeNull();
      expect(
        (within(dialog).getByTestId("month-close-confirm") as HTMLButtonElement).disabled,
      ).toBe(false);
      await fireEvent.click(within(dialog).getByTestId("month-close-cancel"));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(post).not.toHaveBeenCalled();
    });

    it("keeps the dialog open with the server's text when the close is refused", async () => {
      post.mockRejectedValue(
        Object.assign(new Error("x"), { data: { error: "Monat ist gesperrt." } }),
      );
      renderWithTheme(Page, {});
      const section = await openMarch();
      const benRow = within(section).getByTestId("month-close-person-e-ben");
      await fireEvent.click(within(benRow).getByRole("button", { name: "Abschließen" }));
      const dialog = await screen.findByRole("dialog");
      await fireEvent.click(within(dialog).getByTestId("month-close-confirm"));
      await within(dialog).findByText("Monat ist gesperrt.");
      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(success).not.toHaveBeenCalled();
    });

    it("closes a whole month person by person, loading their status first and honouring the ack", async () => {
      renderWithTheme(Page, {});
      // Februar is the first month still open: its row carries the close button.
      const monthRow = await screen.findByTestId("month-close-row-2");
      await fireEvent.click(within(monthRow).getByTestId("month-close-row-2-trigger"));

      const dialog = await screen.findByRole("dialog");
      expect(get).toHaveBeenCalledWith(`/overtime/close-month/status?year=${YEAR}&month=2`);
      expect(within(dialog).getByTestId("month-close-gap-warning")).toBeTruthy();
      const confirm = within(dialog).getByTestId("month-close-confirm") as HTMLButtonElement;
      expect(confirm.disabled).toBe(true);
      await fireEvent.click(within(dialog).getByTestId("month-close-gap-ack"));
      await fireEvent.click(confirm);

      await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
      expect(post).toHaveBeenNthCalledWith(1, "/overtime/close-month", {
        employeeId: "e-anna",
        year: YEAR,
        month: 2,
        confirmGaps: true,
      });
      expect(post).toHaveBeenNthCalledWith(2, "/overtime/close-month", {
        employeeId: "e-ben",
        year: YEAR,
        month: 2,
        confirmGaps: false,
      });
      await waitFor(() =>
        expect(success).toHaveBeenCalledWith(expect.stringContaining("2 abgeschlossen")),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });
  });

  describe("unlocking", () => {
    it("needs a reason, posts it trimmed and shows a refusal inside the dialog", async () => {
      renderWithTheme(Page, {});
      const section = await openMarch();
      const cleoRow = within(section).getByTestId("month-close-person-e-cleo");
      await fireEvent.click(within(cleoRow).getByRole("button", { name: "Entsperren" }));

      const dialog = await screen.findByRole("dialog");
      const confirm = within(dialog).getByTestId("month-close-unlock-confirm") as HTMLButtonElement;
      expect(confirm.disabled).toBe(true);
      await fireEvent.input(within(dialog).getByRole("textbox", { name: /Grund/ }), {
        target: { value: "  Fehlbuchung  " },
      });
      expect(confirm.disabled).toBe(false);

      post.mockRejectedValueOnce(new Error("Dieser Monat ist nicht gesperrt."));
      await fireEvent.click(confirm);
      await within(dialog).findByText("Dieser Monat ist nicht gesperrt.");
      expect(screen.getByRole("dialog")).toBeTruthy();

      await fireEvent.click(confirm);
      await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
      expect(post).toHaveBeenLastCalledWith("/overtime/unlock-month", {
        employeeId: "e-cleo",
        year: YEAR,
        month: 3,
        reason: "Fehlbuchung",
      });
      await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
    });
  });

  it("shows a retry state when the year status cannot be read", async () => {
    get.mockImplementation(async (url: string) => {
      if (url.startsWith("/overtime/close-month/year-status")) throw new Error("down");
      return route(url);
    });
    renderWithTheme(Page, {});
    expect(await screen.findByText(/Der Jahresstatus konnte nicht geladen werden/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Erneut versuchen" })).toBeTruthy();
  });
});
