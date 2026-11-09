// Issue #846 — Team › Heute im Salon, mounted (the page file is the dashboard route, rendered at
// /team/heute; harness of dashboard-team-saldo-pending-588, which this file replaces together with
// dashboard-charts-591, dashboard-team-saldo-588 and dashboard-overtime-trend-degrade: the charts
// and the saldo card left the start page by owner decision D-04, they move to Berichte with #895).
//
// Proves: the Kennzahlen-Band counts the server's statuses and every figure links to its filtered
// list (D-01); no chart and no saldo figure is requested or drawn (D-04); the team week pages only
// from 25 persons on and its count text is right (D-02, regression of „1 – 18 von 14“); deciding a
// request opens the shared review dialog of Aufgaben and the page itself writes nothing (D-03).
const apiGet = vi.fn();
const apiPatch = vi.fn();
const apiPost = vi.fn();

vi.mock("$app/navigation", () => ({
  goto: vi.fn(),
  afterNavigate: vi.fn(),
  replaceState: vi.fn(),
}));

vi.mock("$stores/auth", async () => {
  const { writable } = await import("svelte/store");
  return { authStore: writable({ user: null }) };
});

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
    api: {
      get: (...args: unknown[]) => apiGet(...args),
      post: (...args: unknown[]) => apiPost(...args),
      put: vi.fn(),
      patch: (...args: unknown[]) => apiPatch(...args),
      delete: vi.fn(),
    },
  };
});

vi.mock("$lib/utils/logger", () => ({
  clientLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import { authStore } from "$stores/auth";
import { salonContext } from "$stores/salon-context";
import { ApiError } from "$api/client";
vi.mock("$app/stores", async () => {
  const { readable } = await import("svelte/store");
  return { page: readable({ url: new URL("http://localhost/team/heute"), state: {} }) };
});
import DashboardPage from "../routes/(app)/dashboard/+page.svelte";
import {
  attendanceBand,
  attendanceFilterOf,
  filterAttendance,
  openTeamLeaveTasks,
} from "$lib/dashboard/heute-im-salon";

const WEEK_DAYS = [
  "2026-11-09",
  "2026-11-10",
  "2026-11-11",
  "2026-11-12",
  "2026-11-13",
  "2026-11-14",
  "2026-11-15",
];

function teamOf(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i}`,
    name: `Person ${i}`,
    employeeNumber: String(i),
    days: [],
  }));
}

const ATTENDANCE = {
  date: "2026-11-09",
  employees: [
    { id: "e1", name: "Anna", employeeNumber: "1", status: "clocked_in", reason: null },
    { id: "e2", name: "Ben", employeeNumber: "2", status: "clocked_in", reason: null },
    { id: "e3", name: "Cem", employeeNumber: "3", status: "present", reason: null },
    {
      id: "e4",
      name: "Dora",
      employeeNumber: "4",
      status: "missing",
      reason: null,
      expectedStart: "09:00",
      lateMinutes: 42,
    },
    { id: "e5", name: "Emil", employeeNumber: "5", status: "absent", reason: "Urlaub" },
    { id: "e6", name: "Finn", employeeNumber: "6", status: "none", reason: null },
  ],
  summary: { present: 1, absent: 1, clockedIn: 2, missing: 1, holiday: 0 },
};

const PENDING = [
  {
    id: "lr1",
    employeeId: "e9",
    typeCode: "VACATION",
    employee: { firstName: "Hanna", lastName: "Personal" },
    startDate: "2026-12-14",
    endDate: "2026-12-18",
    days: 5,
    halfDay: false,
    status: "PENDING",
    note: null,
    attestPresent: false,
    attestValidFrom: null,
    attestValidTo: null,
  },
];

let teamSize = 3;

function answer(path: string): Promise<unknown> {
  if (path === "/me/context") {
    return Promise.resolve({
      tenant: { id: "t1", name: "Mandant" },
      isMultiSalon: false,
      homeSalonId: null,
      salons: [],
    });
  }
  if (path.startsWith("/dashboard/team-week")) {
    return Promise.resolve({
      weekStart: WEEK_DAYS[0],
      weekEnd: WEEK_DAYS[6],
      weekDays: WEEK_DAYS,
      team: teamOf(teamSize),
    });
  }
  if (path.startsWith("/dashboard/today-attendance")) return Promise.resolve(ATTENDANCE);
  if (path.startsWith("/dashboard/team-trend")) {
    return Promise.resolve({
      salonId: null,
      workedBasis: "ACCOUNT",
      sollUnavailableReason: null,
      months: [{ month: "2026-11", workedMinutes: 296 * 60, shouldMinutes: 312 * 60, sickDays: 0 }],
    });
  }
  if (path.startsWith("/dashboard/team-upcoming-leave")) return Promise.resolve({ items: [] });
  if (path.startsWith("/leave/requests")) return Promise.resolve(PENDING);
  if (path === "/retro-entry-requests") return Promise.resolve([{ status: "PENDING" }]);
  if (path === "/dashboard/open-items") return Promise.resolve({});
  if (path.startsWith("/time-entries")) return Promise.resolve([]);
  if (path === "/dashboard") return Promise.reject(new ApiError(500, "ignored in this test"));
  return Promise.reject(new ApiError(404, "not part of this test"));
}

function asManager() {
  (authStore as unknown as { set: (v: unknown) => void }).set({
    user: {
      id: "u1",
      email: "u1@example.invalid",
      employeeId: "e1",
      firstName: "Sabine",
      permissions: [
        "team-overview:read:ZUGEWIESEN",
        "leave-request:approve:ZUGEWIESEN",
        "leave-request:read:ZUGEWIESEN",
        "retro-request:approve:ZUGEWIESEN",
        "time-entry:read:ZUGEWIESEN",
      ],
    },
  });
}

beforeEach(async () => {
  teamSize = 3;
  apiGet.mockReset();
  apiGet.mockImplementation((path: string) => answer(path));
  apiPatch.mockReset();
  apiPost.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  await salonContext.load("u1", { force: true }).catch(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Heute im Salon — the Kennzahlen-Band (D-01)", () => {
  it("counts the server's statuses and links every figure to its filtered list", async () => {
    asManager();
    renderWithTheme(DashboardPage, {});
    const present = await screen.findByTestId("kpi-present");
    expect(present.textContent).toMatch(/Anwesend\s*2\s*von 4/);
    expect(screen.getByTestId("kpi-expected").textContent).toMatch(/Erwartet\s*1/);
    expect(screen.getByTestId("kpi-absent").textContent).toMatch(/Abwesend\s*1/);
    await waitFor(() =>
      expect(screen.getByTestId("kpi-tasks").textContent).toMatch(/Aufgaben\s*2/),
    );
    expect(screen.getByTestId("kpi-month").textContent).toMatch(/296:00h\s*\/ 312:00h/);
    const link = (id: string) =>
      screen.getByTestId(id).querySelector("a")?.getAttribute("href") ?? "";
    expect(link("kpi-present")).toBe("/team/heute?status=anwesend#jetzt");
    expect(link("kpi-expected")).toBe("/team/heute?status=erwartet#jetzt");
    expect(link("kpi-absent")).toBe("/team/heute?status=abwesend#jetzt");
    expect(link("kpi-tasks")).toBe("/team/aufgaben");
  });

  it("lists the missing person with the shift start, never the person without a day", async () => {
    asManager();
    renderWithTheme(DashboardPage, {});
    expect(await screen.findByText("Schicht seit 09:00 · nicht eingestempelt")).toBeTruthy();
    expect(screen.queryByText("Finn")).toBeNull();
  });
});

describe("Heute im Salon — no charts, no saldo (D-04)", () => {
  it("requests neither a trend nor a saldo overview and draws no canvas", async () => {
    asManager();
    const { container } = renderWithTheme(DashboardPage, {});
    await screen.findByTestId("kpi-present");
    const paths = apiGet.mock.calls.map((c) => String(c[0]));
    expect(paths.some((p) => p.startsWith("/dashboard/overtime-trend"))).toBe(false);
    expect(paths.some((p) => p.startsWith("/dashboard/overtime-overview"))).toBe(false);
    expect(paths.some((p) => p.startsWith("/dashboard/team-trend?months=1"))).toBe(true);
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("the page source imports no chart library and no saldo card", () => {
    const src = readFileSync(resolve(__dirname, "../routes/(app)/dashboard/+page.svelte"), "utf8");
    expect(src.length).toBeGreaterThan(50_000);
    expect(src).not.toMatch(/from "chart\.js"/);
    expect(src).not.toContain("TeamSaldoCard");
    expect(src).not.toContain("<canvas");
  });
});

describe("Heute im Salon — the team week (D-02)", () => {
  it("shows no pagination up to 25 persons", async () => {
    asManager();
    teamSize = 25;
    const { container } = renderWithTheme(DashboardPage, {});
    await screen.findByTestId("team-week");
    expect(container.querySelector(".pag-range")).toBeNull();
  });

  it("pages from 26 persons on and counts „1–25 von 30“ (regression „1 – 18 von 14“)", async () => {
    asManager();
    teamSize = 30;
    const { container } = renderWithTheme(DashboardPage, {});
    await screen.findByTestId("team-week");
    await waitFor(() => expect(container.querySelector(".pag-range")).not.toBeNull());
    const range = container.querySelector(".pag-range")?.textContent?.replace(/\s+/g, " ").trim();
    expect(range).toMatch(/^1–25 von 30\b/);
  });
});

describe("Heute im Salon — tasks decided through the dialog of Aufgaben (D-03)", () => {
  it("„Genehmigen“ opens the shared review dialog; the page itself writes nothing", async () => {
    asManager();
    renderWithTheme(DashboardPage, {});
    const approve = await screen.findByRole("button", { name: "Genehmigen" });
    await fireEvent.click(approve);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(apiPatch).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("parity: both pages decide through LeaveReviewDialog, and only the dialog patches /review", () => {
    const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8");
    const page = read("../routes/(app)/dashboard/+page.svelte");
    const inbox = read("../routes/(app)/inbox/+page.svelte");
    const dialog = read("../lib/components/leave/LeaveReviewDialog.svelte");
    for (const src of [page, inbox]) {
      expect(src).toContain("<LeaveReviewDialog");
      expect(src).not.toMatch(/\/leave\/requests\/\$\{[^}]+\}\/review/);
    }
    expect(dialog).toMatch(/\/leave\/requests\/\$\{ctx\.id\}\/review/);
  });
});

describe("heute-im-salon helpers", () => {
  it("attendanceBand counts each status once", () => {
    const band = attendanceBand(ATTENDANCE as never);
    expect(band).toEqual({ present: 2, expected: 4, missing: 1, scheduled: 0, absent: 1, done: 1 });
    expect(attendanceBand(null).expected).toBe(0);
  });

  it("the filter is an allow-list read from the URL", () => {
    expect(attendanceFilterOf("erwartet")).toBe("erwartet");
    expect(attendanceFilterOf("<script>")).toBe("alle");
    expect(attendanceFilterOf(null)).toBe("alle");
    const rows = ATTENDANCE.employees as never[];
    expect(filterAttendance(rows, "alle").map((r: { id: string }) => r.id)).not.toContain("e6");
    expect(filterAttendance(rows, "abwesend").map((r: { id: string }) => r.id)).toEqual(["e5"]);
  });

  it("never offers the caller's own request for a decision", () => {
    const own = { ...PENDING[0], id: "own", employeeId: "e1" };
    const tasks = openTeamLeaveTasks([own, PENDING[0]] as never, "e1");
    expect(tasks.map((t) => t.id)).toEqual(["lr1"]);
  });
});
