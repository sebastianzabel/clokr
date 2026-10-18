// Issue #612 (ADD-1, owner decision 1) - the tab „Heute“, mounted: the former „Heutige Anwesenheit“
// card moved unchanged in content (status labels from the one vocabulary of #587, the two action
// links of a „Fehlt“ row by permission, the salon badge of #542, the pagination), with the new sub
// title „Stand heute, unabhängig vom Zeitraum“. lib/components/reports/ is outside the
// lint:ui-classes gate, so the rendering is proven here.

import { describe, it, expect, vi } from "vitest";
import { screen, within, fireEvent } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import { DAY_STATUS_LABEL } from "$lib/dashboard/day-status-label";
import { SALON_VIEW_UNAVAILABLE_TEXT } from "$lib/salons/page-scope";
import type { TodayAttendanceData, TodayEmployee } from "$lib/reports/today-attendance";
import TodayAttendance from "../TodayAttendance.svelte";
import source from "../TodayAttendance.svelte?raw";

// The page-scope module reaches the api client and its auth store (localStorage bootstrap); a
// stand-in keeps this mounted test free of it (as in page-scope.test.ts).
vi.mock("$api/client", () => ({
  api: { get: vi.fn() },
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message = "err",
    ) {
      super(message);
    }
  },
}));
vi.mock("$lib/utils/logger", () => ({ clientLogger: { warn: vi.fn(), error: vi.fn() } }));

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function person(n: number, extra: Partial<TodayEmployee> = {}): TodayEmployee {
  return {
    id: UUID(n),
    name: `Person ${n}`,
    employeeNumber: `N-${n}`,
    status: "present",
    reason: null,
    ...extra,
  };
}

function data(
  employees: TodayEmployee[],
  extra: Partial<TodayAttendanceData> = {},
): TodayAttendanceData {
  return {
    date: "2026-10-15",
    employees,
    summary: { present: 2, absent: 1, clockedIn: 3, missing: 4, holiday: 0 },
    ...extra,
  };
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    attendance: data([person(1)]),
    loading: false,
    error: "",
    rejected: false,
    canAddTeamEntry: false,
    canRecordTeamAbsence: false,
    ...overrides,
  };
}

describe("TodayAttendance - header and states", () => {
  it("keeps the card title and states that the tab has no period", () => {
    renderWithTheme(TodayAttendance, props());
    expect(screen.getByText("Heutige Anwesenheit")).toBeTruthy();
    expect(screen.getByText("Stand heute, unabhängig vom Zeitraum")).toBeTruthy();
    expect(screen.getByText("2026-10-15")).toBeTruthy();
  });

  it("shows the loading text, the error text and the calm salon state", () => {
    const loading = renderWithTheme(TodayAttendance, props({ loading: true, attendance: null }));
    expect(screen.getByText("Lade Anwesenheit…")).toBeTruthy();
    loading.unmount();
    const error = renderWithTheme(
      TodayAttendance,
      props({ error: "Fehler beim Laden der Anwesenheit", attendance: null }),
    );
    expect(screen.getByText("Fehler beim Laden der Anwesenheit")).toBeTruthy();
    error.unmount();
    renderWithTheme(TodayAttendance, props({ rejected: true, attendance: null }));
    expect(screen.getByTestId("salon-scope-unavailable").textContent).toContain(
      SALON_VIEW_UNAVAILABLE_TEXT,
    );
  });

  it("renders nothing but the header before the first answer", () => {
    renderWithTheme(TodayAttendance, props({ attendance: null }));
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("Heutige Anwesenheit")).toBeTruthy();
  });
});

describe("TodayAttendance - summary and table", () => {
  it("shows the summary chips with the words of the status vocabulary, the holiday chip only above 0", () => {
    const first = renderWithTheme(TodayAttendance, props());
    const labels = Array.from(document.querySelectorAll(".summary-chip .label")).map(
      (e) => e.textContent,
    );
    expect(labels).toEqual(["Anwesend", "Eingestempelt", "Abwesend", DAY_STATUS_LABEL.missing]);
    first.unmount();
    renderWithTheme(
      TodayAttendance,
      props({
        attendance: data([person(1)], {
          summary: { present: 0, absent: 0, clockedIn: 0, missing: 0, holiday: 2 },
        }),
      }),
    );
    expect(screen.getByText("Feiertag")).toBeTruthy();
  });

  it("lists name, number and the status text of each row", () => {
    renderWithTheme(
      TodayAttendance,
      props({
        attendance: data([
          person(1),
          person(2, { status: "absent", reason: "Urlaub" }),
          person(3, { status: "missing", expectedStart: "09:00", lateMinutes: 25 }),
          person(4, { status: "scheduled", expectedStart: "13:00" }),
          person(5, { status: "none" }),
        ]),
      }),
    );
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent?.trim());
    expect(headers).toEqual(["Mitarbeiter", "Nr.", "Status"]);
    const body = within(screen.getAllByRole("rowgroup")[1]).getAllByRole("row");
    const statusOf = (r: HTMLElement) => within(r).getAllByRole("cell")[2].textContent?.trim();
    expect(statusOf(body[0])).toBe("Anwesend");
    expect(statusOf(body[1])).toBe("Urlaub");
    expect(statusOf(body[2])).toBe("Fehlt · erwartet 09:00 · 25 Min. zu spät");
    expect(statusOf(body[3])).toBe("Geplant · ab 13:00");
    expect(statusOf(body[4])).toBe("—");
    expect(body[0].textContent).toContain("Person 1");
    expect(body[0].textContent).toContain("N-1");
    expect(source).not.toContain("Fehlend");
  });

  it("words the status through the status badge class of the status", () => {
    renderWithTheme(
      TodayAttendance,
      props({ attendance: data([person(1, { status: "clocked_in" })]) }),
    );
    const badge = document.querySelector(".status-badge");
    expect(badge?.classList.contains("status-clocked-in")).toBe(true);
  });

  it("shows the salon badge for a person who worked in another salon", () => {
    renderWithTheme(
      TodayAttendance,
      props({ attendance: data([person(1, { workedElsewhere: true }), person(2)]) }),
    );
    expect(screen.getAllByText("anderer Salon")).toHaveLength(1);
  });

  it("pages the rows (10 per page by default)", async () => {
    const many = Array.from({ length: 12 }, (_, i) => person(i + 1));
    renderWithTheme(TodayAttendance, props({ attendance: data(many) }));
    expect(within(screen.getAllByRole("rowgroup")[1]).getAllByRole("row")).toHaveLength(10);
    await fireEvent.click(screen.getByRole("button", { name: /nächste/i }));
    expect(within(screen.getAllByRole("rowgroup")[1]).getAllByRole("row")).toHaveLength(2);
  });
});

describe("TodayAttendance - action links of a „Fehlt“ row (Issue #587)", () => {
  const missing = person(3, { status: "missing" });
  const present = person(1);

  function links(canAdd: boolean, canAbsence: boolean) {
    renderWithTheme(
      TodayAttendance,
      props({
        attendance: data([present, missing]),
        canAddTeamEntry: canAdd,
        canRecordTeamAbsence: canAbsence,
      }),
    );
  }

  it("offers no Aktionen column without a right", () => {
    links(false, false);
    expect(screen.queryByRole("columnheader", { name: "Aktionen" })).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("offers both links, built by the shared href builders, on the missing row only", () => {
    links(true, true);
    expect(screen.getByRole("columnheader", { name: "Aktionen" })).toBeTruthy();
    const entry = screen.getByRole("link", { name: "Eintrag nachtragen" });
    const absence = screen.getByRole("link", { name: "Abwesenheit erfassen" });
    expect(entry.getAttribute("href")).toBe(
      `/team/time-entries?employeeId=${UUID(3)}&date=2026-10-15`,
    );
    expect(absence.getAttribute("href")).toBe(
      `/team/leave?create=1&employeeId=${UUID(3)}&date=2026-10-15`,
    );
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("each link needs its own right", () => {
    links(true, false);
    expect(screen.getByRole("link", { name: "Eintrag nachtragen" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Abwesenheit erfassen" })).toBeNull();
  });

  it("the action cell stays a table cell and wraps a div (Issue #442)", () => {
    links(true, true);
    const cell = document.querySelector("td.attendance-actions");
    expect(cell?.firstElementChild?.tagName).toBe("DIV");
    expect(cell?.firstElementChild?.classList.contains("row-actions__group")).toBe(true);
  });
});

describe("TodayAttendance - source", () => {
  it("[vacuity gate] the source is loaded and imports no $app module", () => {
    expect(source.length).toBeGreaterThan(2000);
    expect(source).not.toMatch(/from "\$app\//);
  });

  it("owns no request: it renders the data it is given", () => {
    expect(source).not.toContain("api.get");
    expect(source).not.toContain("fetch(");
  });
});
