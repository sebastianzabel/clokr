// Issue #70 (Phase 70b-07, D-07/D-12) — the presentation decisions of the two time-entry pages.
//
// The server decides validity, salon, overlap and the month lock; these pure functions only decide
// WHAT the page opens: the entry form, an existing entry, or the list focused on a day.
import { describe, it, expect } from "vitest";
import {
  addActionForDay,
  cellClickAction,
  entryCountTitle,
  salonFieldOptions,
  salonIdToSend,
  type DayEntryRow,
} from "../day-entry-actions";

// Local wall-clock instants, so the HH:MM the module derives equals the typed value in any
// time zone of the test runner (the page shows times in the browser's zone).
function row(id: string, start: string, end: string | null, extra: Partial<DayEntryRow> = {}) {
  return {
    id,
    date: "2026-06-22",
    startTime: new Date(`2026-06-22T${start}:00`).toISOString(),
    endTime: end === null ? null : new Date(`2026-06-22T${end}:00`).toISOString(),
    ...extra,
  } satisfies DayEntryRow;
}

describe("cellClickAction", () => {
  it("a day without entries opens the new form", () => {
    expect(cellClickAction([])).toEqual({ kind: "new" });
  });

  it("a day with exactly one entry still opens that entry for editing", () => {
    const only = row("a", "08:00", "12:00");
    expect(cellClickAction([only])).toEqual({ kind: "edit", entry: only });
  });

  it("a day with two or more entries switches to the list", () => {
    expect(cellClickAction([row("a", "08:00", "12:00"), row("b", "13:00", "16:00")])).toEqual({
      kind: "list",
    });
    expect(
      cellClickAction([
        row("a", "08:00", "10:00"),
        row("b", "10:00", "12:00"),
        row("c", "13:00", "16:00"),
      ]),
    ).toEqual({ kind: "list" });
  });
});

describe("addActionForDay", () => {
  const first = row("a", "08:00", "12:00");
  const second = row("b", "13:00", "16:30");

  it("without salon options a day with an entry opens that entry (the old pick: the first row)", () => {
    expect(addActionForDay([first], false)).toEqual({ kind: "edit", entry: first });
    expect(addActionForDay([first, second], false)).toEqual({ kind: "edit", entry: first });
  });

  it("without salon options an empty day opens the default 09:00 - 17:00 form", () => {
    expect(addActionForDay([], false)).toEqual({ kind: "new", start: "09:00", end: "17:00" });
  });

  it("with salon options an empty day opens the same default form", () => {
    expect(addActionForDay([], true)).toEqual({ kind: "new", start: "09:00", end: "17:00" });
  });

  it("with salon options a day with entries opens a NEW form starting at the day's latest end", () => {
    expect(addActionForDay([first], true)).toEqual({ kind: "new", start: "12:00", end: "13:00" });
    // The latest END counts, whatever the order of the rows.
    expect(addActionForDay([second, first], true)).toEqual({
      kind: "new",
      start: "16:30",
      end: "17:30",
    });
  });

  it("caps the preset end at 23:59", () => {
    expect(addActionForDay([row("late", "20:00", "23:30")], true)).toEqual({
      kind: "new",
      start: "23:30",
      end: "23:59",
    });
  });

  it("an open entry has no end: only closed entries set the start; open-only falls back to the default", () => {
    expect(addActionForDay([first, row("run", "13:00", null)], true)).toEqual({
      kind: "new",
      start: "12:00",
      end: "13:00",
    });
    expect(addActionForDay([row("run", "13:00", null)], true)).toEqual({
      kind: "new",
      start: "09:00",
      end: "17:00",
    });
  });
});

describe("salonFieldOptions", () => {
  const south = { id: "s-south", name: "Südstadt" };
  const north = { id: "s-north", name: "Nordstadt" };

  it("lists the context salons sorted by name", () => {
    expect(salonFieldOptions([south, north], null)).toEqual([north, south]);
  });

  it("does not mutate its input", () => {
    const input = [south, north];
    salonFieldOptions(input, null);
    expect(input).toEqual([south, north]);
  });

  it("adds the entry's own salon, by its name, when the context does not list it", () => {
    const entry = row("a", "08:00", "12:00", { salonId: "s-east", salonName: "Oststadt" });
    expect(salonFieldOptions([south, north], entry)).toEqual([
      north,
      { id: "s-east", name: "Oststadt" },
      south,
    ]);
  });

  it("does not duplicate an entry salon the context already lists", () => {
    const entry = row("a", "08:00", "12:00", { salonId: "s-north", salonName: "Nordstadt" });
    expect(salonFieldOptions([south, north], entry)).toEqual([north, south]);
  });

  it("adds nothing for an entry without a salon name (an older answer)", () => {
    const entry = row("a", "08:00", "12:00", { salonId: "s-east" });
    expect(salonFieldOptions([south, north], entry)).toEqual([north, south]);
  });
});

describe("salonIdToSend", () => {
  it("a new entry sends the salon only when one was picked", () => {
    expect(salonIdToSend("", null)).toBeUndefined();
    expect(salonIdToSend("s-north", null)).toBe("s-north");
  });

  it("an edited entry sends the salon only when it differs from the entry's own", () => {
    expect(salonIdToSend("s-north", "s-north")).toBeUndefined();
    expect(salonIdToSend("s-south", "s-north")).toBe("s-south");
    expect(salonIdToSend("", "s-north")).toBeUndefined();
  });
});

describe("entryCountTitle", () => {
  it("names a count only from two entries on", () => {
    expect(entryCountTitle(0)).toBeNull();
    expect(entryCountTitle(1)).toBeNull();
    expect(entryCountTitle(2)).toBe("2 Einträge");
    expect(entryCountTitle(3)).toBe("3 Einträge");
  });
});
