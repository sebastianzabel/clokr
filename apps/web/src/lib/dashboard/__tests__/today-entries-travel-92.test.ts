// Issue #92 (Phase 92b-05, D-08) - the dashboard's list of today's entries labels a trip.
// Display only: the names are the server's `salonName` / `travelToSalonName`; nothing is looked up.
import { screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";

import { renderWithTheme } from "../../../__tests__/test-utils";
import TodayEntriesList from "$lib/components/dashboard/TodayEntriesList.svelte";
import type { ClockDayEntry } from "../day-state";

/** Start/end as local wall-clock times of 2026-08-28, so the labels hold in any time zone. */
function row(id: string, from: string, to: string, extra: Partial<ClockDayEntry>): ClockDayEntry {
  const at = (hhmm: string) => new Date(`2026-08-28T${hhmm}:00`).toISOString();
  return { id, startTime: at(from), endTime: at(to), breakMinutes: 0, ...extra };
}

const A = row("e-a", "08:00", "12:00", { salonId: "salon-a", salonName: "Salon Nordstadt" });
const T = row("e-t", "12:00", "12:30", {
  salonId: "salon-a",
  salonName: "Salon Nordstadt",
  activityKind: "TRAVEL",
  travelToSalonId: "salon-b",
  travelToSalonName: "Salon Südstadt",
});
const B = row("e-b", "12:30", "16:00", { salonId: "salon-b", salonName: "Salon Südstadt" });

describe("today's entries with a trip (Issue #92)", () => {
  it("a trip renders its range, the word Fahrzeit and the route", () => {
    renderWithTheme(TodayEntriesList, { entries: [B, T, A] });
    const items = screen.getAllByRole("listitem").map((li) => li.textContent?.trim());
    expect(items).toEqual([
      "08:00–12:00 · Salon Nordstadt",
      "12:00–12:30 · Fahrzeit Salon Nordstadt → Salon Südstadt",
      "12:30–16:00 · Salon Südstadt",
    ]);
  });

  it("a trip row without names falls back to „anderer Salon“ on both sides", () => {
    renderWithTheme(TodayEntriesList, {
      entries: [
        { ...T, salonName: undefined, travelToSalonName: undefined },
        { ...A, salonName: undefined },
      ],
    });
    const items = screen.getAllByRole("listitem").map((li) => li.textContent?.trim());
    expect(items).toContain("12:00–12:30 · Fahrzeit anderer Salon → anderer Salon");
    expect(items).toContain("08:00–12:00");
  });
});
