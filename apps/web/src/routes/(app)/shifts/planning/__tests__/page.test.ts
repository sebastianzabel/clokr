// Phase 430 (D-12/D-13/D-14, Issue #430) — mounted test for the new Wochenübersicht
// "Planungsbedarf" page. `lib/components/**` conventions apply (lint:ui-classes does not scan
// `routes/**` either), so this mounted test is the only automated net for this page, per
// CLAUDE.md's UI Consistency Rules note.
//
// `$api/client` is mocked directly (same pattern as
// apps/web/src/lib/components/leave/__tests__/LeaveReviewDialog.test.ts) — this page imports no
// `$app/*` module itself, and mocking `$api/client` means `$stores/auth` (and its own
// `$app/environment` dependency) never has to be resolved either.

const apiGet = vi.fn();
vi.mock("$api/client", () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
  },
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import PlanningOverviewPage from "../+page.svelte";

interface PlanningRow {
  employeeId: string;
  name: string;
  contractDays: number;
  leaveDays: number;
  leaveWeekdays: string[];
  otherAbsenceDays: number;
  stillToPlan: number;
  plannedDays?: number;
  difference?: number;
}

function response(weekStart: string, weekEnd: string, employees: PlanningRow[]) {
  return { weekStart, weekEnd, employees };
}

beforeEach(() => {
  apiGet.mockReset();
});

describe("Wochenübersicht Planungsbedarf (Phase 430, Issue #430)", () => {
  it("renders the owner's table shape — Person/Vertrag/Urlaub/noch einzuplanen, no geplant/Differenz when absent", async () => {
    apiGet.mockResolvedValueOnce(
      response("2031-02-03", "2031-02-09", [
        {
          employeeId: "emp-1",
          name: "Lena Beispiel",
          contractDays: 5,
          leaveDays: 2,
          leaveWeekdays: ["Do", "Fr"],
          otherAbsenceDays: 0,
          stillToPlan: 3,
        },
      ]),
    );

    renderWithTheme(PlanningOverviewPage, {});

    await waitFor(() => expect(screen.getByText("Lena Beispiel")).toBeTruthy());
    expect(screen.getByText("5 Tage")).toBeTruthy();
    expect(screen.getByText("2 (Do, Fr)")).toBeTruthy();
    expect(screen.getByText("3 Tage")).toBeTruthy();
    // geplant/Differenz columns are absent entirely when no row carries them.
    expect(screen.queryByText("geplant")).toBeNull();
    expect(screen.queryByText("Differenz")).toBeNull();
  });

  it("shows geplant/Differenz columns once at least one row carries them", async () => {
    apiGet.mockResolvedValueOnce(
      response("2031-02-03", "2031-02-09", [
        {
          employeeId: "emp-1",
          name: "Lena Beispiel",
          contractDays: 5,
          leaveDays: 2,
          leaveWeekdays: ["Do", "Fr"],
          otherAbsenceDays: 0,
          stillToPlan: 3,
          plannedDays: 3,
          difference: 0,
        },
      ]),
    );

    renderWithTheme(PlanningOverviewPage, {});

    await waitFor(() => expect(screen.getByText("geplant")).toBeTruthy());
    expect(screen.getByText("Differenz")).toBeTruthy();
  });

  it("no leave this week -> renders 0, not '0 ()'", async () => {
    apiGet.mockResolvedValueOnce(
      response("2031-02-03", "2031-02-09", [
        {
          employeeId: "emp-2",
          name: "Sam Null",
          contractDays: 5,
          leaveDays: 0,
          leaveWeekdays: [],
          otherAbsenceDays: 0,
          stillToPlan: 5,
        },
      ]),
    );

    renderWithTheme(PlanningOverviewPage, {});

    await waitFor(() => expect(screen.getByText("Sam Null")).toBeTruthy());
    expect(screen.getByText("0")).toBeTruthy();
    expect(screen.queryByText(/0 \(/)).toBeNull();
  });

  it("the week pager's 'Nächste Woche' button re-fetches with a weekStart 7 days later", async () => {
    apiGet.mockResolvedValueOnce(response("2031-02-03", "2031-02-09", []));
    renderWithTheme(PlanningOverviewPage, {});
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    const firstUrl = apiGet.mock.calls[0][0] as string;
    const firstWeekStart = new URL(firstUrl, "http://localhost").searchParams.get("weekStart")!;

    apiGet.mockResolvedValueOnce(response("x", "y", []));
    await fireEvent.click(screen.getByText("Nächste Woche →"));

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    const secondUrl = apiGet.mock.calls[1][0] as string;
    const secondWeekStart = new URL(secondUrl, "http://localhost").searchParams.get("weekStart")!;

    const diffDays =
      (new Date(`${secondWeekStart}T00:00:00Z`).getTime() -
        new Date(`${firstWeekStart}T00:00:00Z`).getTime()) /
      (24 * 60 * 60 * 1000);
    expect(diffDays).toBe(7);
  });

  it("empty scope renders the empty-state row", async () => {
    apiGet.mockResolvedValueOnce(response("2031-02-03", "2031-02-09", []));
    renderWithTheme(PlanningOverviewPage, {});
    await waitFor(() =>
      expect(screen.getByText("Keine SHIFT_BASED-Mitarbeiter im Scope.")).toBeTruthy(),
    );
  });
});
