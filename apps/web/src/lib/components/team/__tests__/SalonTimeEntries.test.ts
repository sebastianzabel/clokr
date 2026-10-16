// Issue #85 D-09 — the mountable Salonansicht. The route page cannot be mounted ($app imports and
// a dozen requests on mount), so the component carries the rendering contract.

import { describe, it, expect, vi } from "vitest";

// The grouping module imports `withSalonId` from team-view, which pulls in the api client, the auth
// store and its localStorage bootstrap; a stand-in (as in team-view.test.ts) keeps this file free
// of that.
vi.mock("$api/client", () => ({
  api: { get: vi.fn() },
  ApiError: class ApiError extends Error {},
}));
vi.mock("$lib/utils/logger", () => ({ clientLogger: { warn: vi.fn(), error: vi.fn() } }));
import { screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import SalonTimeEntries from "../SalonTimeEntries.svelte";
import { groupSalonEntries, type SalonViewEntry } from "$lib/team/salon-time-entries";

function entry(over: Partial<SalonViewEntry> & { id: string }): SalonViewEntry {
  return {
    employeeId: "e1",
    date: "2026-06-15T00:00:00.000Z",
    startTime: "2026-06-15T08:00:00.000Z",
    endTime: "2026-06-15T16:00:00.000Z",
    breakMinutes: 30,
    isInvalid: false,
    salonId: "s1",
    employee: { firstName: "Anna", lastName: "Berg" },
    workingMinutes: 450,
    ...over,
  };
}

const days = groupSalonEntries([
  entry({ id: "1" }),
  entry({
    id: "2",
    employeeId: "e2",
    employee: { firstName: "Bernd", lastName: "Adler" },
    endTime: null,
    workingMinutes: null,
  }),
  entry({
    id: "3",
    date: "2026-06-16T00:00:00.000Z",
    startTime: "2026-06-16T08:00:00.000Z",
    endTime: "2026-06-16T12:00:00.000Z",
    isInvalid: true,
    workingMinutes: 210,
  }),
]);

describe("SalonTimeEntries — rows", () => {
  it("renders the column headers, the persons, offen and ungültig, and no sum", () => {
    renderWithTheme(SalonTimeEntries, {
      days,
      status: "rows",
      capReached: false,
      salonName: "Hauptsalon",
    });
    for (const header of ["Mitarbeiter", "Beginn", "Ende", "Pause", "Arbeitszeit"]) {
      expect(screen.getAllByText(header).length).toBeGreaterThan(0);
    }
    expect(screen.getByText("Mo, 15.06.2026")).toBeTruthy();
    expect(screen.getByText("Di, 16.06.2026")).toBeTruthy();
    expect(screen.getByText("Adler, Bernd")).toBeTruthy();
    expect(screen.getAllByText("Berg, Anna").length).toBe(2);
    expect(screen.getByText("offen")).toBeTruthy();
    expect(screen.getByText("ungültig")).toBeTruthy();
    expect(document.body.textContent ?? "").not.toMatch(/Summe|Gesamt/);
  });

  it("shows the loading text", () => {
    renderWithTheme(SalonTimeEntries, {
      days: [],
      status: "loading",
      capReached: false,
      salonName: null,
    });
    expect(screen.getByText("Wird geladen …")).toBeTruthy();
  });
});

describe("SalonTimeEntries — states", () => {
  const base = { days: [], capReached: false, salonName: null };

  it("prompts for a salon", () => {
    renderWithTheme(SalonTimeEntries, { ...base, status: "prompt" });
    expect(
      screen.getByText("Wählen Sie in der Kopfleiste einen Salon, um seine Einträge zu sehen."),
    ).toBeTruthy();
  });

  it("shows the calm rejected text", () => {
    renderWithTheme(SalonTimeEntries, { ...base, status: "rejected" });
    expect(
      screen.getByText(
        "Für diesen Salon liegt keine Salonansicht vor. Wählen Sie in der Kopfleiste einen anderen Salon.",
      ),
    ).toBeTruthy();
  });

  it("shows the empty-month text", () => {
    renderWithTheme(SalonTimeEntries, { ...base, status: "empty" });
    expect(
      screen.getByText("In diesem Monat sind in diesem Salon keine Einträge erfasst."),
    ).toBeTruthy();
  });

  it("shows the incomplete-list hint above the rows when the cap is reached (D-15)", () => {
    renderWithTheme(SalonTimeEntries, { ...base, days, status: "rows", capReached: true });
    const hint = screen.getByText(
      "Es werden höchstens 1000 Einträge angezeigt; die Liste für diesen Monat ist unvollständig.",
    );
    const firstTable = document.querySelector("table");
    expect(hint).toBeTruthy();
    expect(
      hint.compareDocumentPosition(firstTable as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows no hint below the cap and none for the other states", () => {
    renderWithTheme(SalonTimeEntries, { ...base, days, status: "rows", capReached: false });
    expect(document.body.textContent ?? "").not.toContain("unvollständig");
  });
});

// Issue #92 (Phase 92b-05): a trip between two salons is listed under its departure salon, with the
// badge and its route from the served display names.
describe("SalonTimeEntries - a trip between two salons", () => {
  it("shows the badge and the route next to the person; an ordinary row shows neither", () => {
    const tripDays = groupSalonEntries([
      entry({
        id: "t1",
        startTime: "2026-06-15T12:00:00.000Z",
        endTime: "2026-06-15T12:30:00.000Z",
        activityKind: "TRAVEL",
        salonName: "Hauptsalon",
        travelToSalonId: "s2",
        travelToSalonName: "Zweitsalon",
        workingMinutes: 30,
      }),
      entry({ id: "o1", employeeId: "e2", employee: { firstName: "Bernd", lastName: "Adler" } }),
    ]);
    renderWithTheme(SalonTimeEntries, {
      days: tripDays,
      status: "rows",
      capReached: false,
      salonName: "Hauptsalon",
    });
    expect(screen.getAllByText("Fahrzeit")).toHaveLength(1);
    expect(screen.getByText("Hauptsalon → Zweitsalon")).toBeTruthy();
  });
});
