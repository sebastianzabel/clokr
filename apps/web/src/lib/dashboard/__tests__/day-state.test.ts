import { describe, it, expect } from "vitest";
import {
  resolveDayState,
  primaryClockLabel,
  canReopenFinishedDay,
  reopenGapStartLabel,
  upsertDayEntry,
  dayTotals,
  entryCountLabel,
  entryRangeLabel,
  entryWorkedMinutes,
  entriesInStartOrder,
  type ClockDayEntry,
} from "../day-state";

// Phase 115 (GitHub issue #118). The FIRST describe block below IS acceptance criterion #5:
// no test anywhere in this repo asserted that a finished day offers no clock-in action, which
// is why a one-tap path from "Bereit zum Einstempeln" straight into CLOCK_REOPEN — reopening a
// closed, retention-relevant TimeEntry and burying its recorded break under a ~3 h gap break —
// could ship and stay shipped.

const FINISHED: ClockDayEntry = {
  id: "e-finished",
  startTime: "2026-08-28T06:55:00.000Z", // 08:55 local (Europe/Berlin, CEST)
  endTime: "2026-08-28T15:46:00.000Z", // 17:46 local
  breakMinutes: 30,
  isLocked: false,
  isInvalid: false,
};
const RUNNING: ClockDayEntry = { ...FINISHED, id: "e-running", endTime: null };

/**
 * The expected HH:MM label, derived the same way the module derives it (local time), so this
 * assertion holds on a CEST laptop AND in a UTC CI container. Asserting the literal "17:46"
 * would be the time-bomb class already logged in project memory ("API test time-bombs").
 */
function localHhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

describe("primaryClockLabel — the action a finished day must NOT offer (acceptance criterion #5)", () => {
  it("a finished day yields NO primary clock action", () => {
    expect(primaryClockLabel(resolveDayState([FINISHED]))).toBeNull();
  });

  it("a finished day never yields the string 'Einstempeln'", () => {
    expect(primaryClockLabel(resolveDayState([FINISHED]))).not.toBe("Einstempeln");
  });

  it("a not-started day still offers Einstempeln", () => {
    expect(primaryClockLabel(resolveDayState([]))).toBe("Einstempeln");
  });

  it("a running day offers Ausstempeln", () => {
    expect(primaryClockLabel(resolveDayState([RUNNING]))).toBe("Ausstempeln");
  });

  it("a locked finished day also yields no primary action", () => {
    expect(primaryClockLabel(resolveDayState([{ ...FINISHED, isLocked: true }]))).toBeNull();
  });
});

describe("resolveDayState — three states where there used to be a boolean", () => {
  it("an empty array is idle", () => {
    expect(resolveDayState([])).toEqual({ kind: "idle", entry: null, isLocked: false });
  });

  it("null is idle", () => {
    expect(resolveDayState(null)).toEqual({ kind: "idle", entry: null, isLocked: false });
  });

  it("undefined is idle", () => {
    expect(resolveDayState(undefined)).toEqual({ kind: "idle", entry: null, isLocked: false });
  });

  it("an open entry is running", () => {
    const day = resolveDayState([RUNNING]);
    expect(day.kind).toBe("running");
    expect(day.entry?.id).toBe("e-running");
  });

  it("a closed entry is finished", () => {
    const day = resolveDayState([FINISHED]);
    expect(day.kind).toBe("finished");
    expect(day.entry?.id).toBe("e-finished");
  });

  it("the old boolean collapsed these two — this test is the regression shield", () => {
    // `clockedIn = !!entries.find(e => !e.endTime)` was false for BOTH of these.
    expect(resolveDayState([FINISHED]).kind).not.toBe(resolveDayState([]).kind);
  });

  it("isLocked is surfaced from the entry", () => {
    expect(resolveDayState([{ ...FINISHED, isLocked: true }]).isLocked).toBe(true);
  });

  it("isLocked defaults to false when the field is absent", () => {
    const withoutLock: ClockDayEntry = {
      id: "e-nolock",
      startTime: FINISHED.startTime,
      endTime: FINISHED.endTime,
    };
    expect(resolveDayState([withoutLock]).isLocked).toBe(false);
  });
});

describe("resolveDayState — selects the entry the server resolver would act on", () => {
  it("an open entry wins over a closed one (resolver.ts: openEntry is looked up first)", () => {
    const day = resolveDayState([FINISHED, RUNNING]);
    expect(day.kind).toBe("running");
    expect(day.entry?.id).toBe("e-running");
  });

  it("among closed entries the LATEST endTime wins (resolver.ts orderBy endTime desc)", () => {
    const early: ClockDayEntry = {
      ...FINISHED,
      id: "e-early",
      endTime: "2026-08-28T12:00:00.000Z",
    };
    const late: ClockDayEntry = { ...FINISHED, id: "e-late", endTime: "2026-08-28T15:46:00.000Z" };
    expect(resolveDayState([early, late]).entry?.id).toBe("e-late");
    expect(resolveDayState([late, early]).entry?.id).toBe("e-late");
  });

  it("an isInvalid open entry is deliberately NOT filtered out", () => {
    // Since Phase 118 the resolver's READ lookup no longer filters isInvalid either, so this
    // module now mirrors it exactly. Filtering it here would resolve this day to "idle" →
    // Einstempeln → START → the resolver refuses a second open entry of the day (the partial
    // unique index TimeEntry_employeeId_date_open_unique, 409 — amended Issue #70: the former
    // one-entry-per-day index is gone) instead of the action the user needs. Not filtering means:
    // "running" → Ausstempeln → the resolver closes the open entry.
    expect(resolveDayState([{ ...RUNNING, isInvalid: true }]).kind).toBe("running");
  });
});

describe("reopenGapStartLabel — names the timestamp the resolver will use as the gap break start", () => {
  it("a finished day names its recorded clock-out time", () => {
    const label = reopenGapStartLabel(resolveDayState([FINISHED]));
    expect(label).toBe(localHhmm(FINISHED.endTime!));
    expect(label).toMatch(/^\d{2}:\d{2}$/);
  });

  it("a running day has no gap to name", () => {
    expect(reopenGapStartLabel(resolveDayState([RUNNING]))).toBeNull();
  });

  it("a not-started day has no gap to name", () => {
    expect(reopenGapStartLabel(resolveDayState([]))).toBeNull();
  });
});

describe("canReopenFinishedDay — never offer what the server will refuse", () => {
  it("an unlocked finished day may be reopened deliberately", () => {
    expect(canReopenFinishedDay(resolveDayState([FINISHED]))).toBe(true);
  });

  it("a locked finished day may not — resolver.ts:117-123 answers CONFLICT MONTH_LOCKED", () => {
    expect(canReopenFinishedDay(resolveDayState([{ ...FINISHED, isLocked: true }]))).toBe(false);
  });

  it("a running day has nothing to reopen", () => {
    expect(canReopenFinishedDay(resolveDayState([RUNNING]))).toBe(false);
  });

  it("a not-started day has nothing to reopen", () => {
    expect(canReopenFinishedDay(resolveDayState([]))).toBe(false);
  });
});

describe("upsertDayEntry — the optimistic update must not drop rows", () => {
  it("appends into an empty list", () => {
    expect(upsertDayEntry([], FINISHED)).toEqual([FINISHED]);
  });

  it("replaces in place when the id matches (a REOPEN returns the SAME row)", () => {
    const reopened: ClockDayEntry = { ...FINISHED, endTime: null, breakMinutes: 214 };
    const next = upsertDayEntry([FINISHED], reopened);
    expect(next).toHaveLength(1);
    expect(next[0]).toBe(reopened);
  });

  it("appends when the id differs — a co-existing row survives", () => {
    const next = upsertDayEntry([FINISHED], RUNNING);
    expect(next).toHaveLength(2);
    expect(next.map((e) => e.id)).toEqual(["e-finished", "e-running"]);
  });

  it("does not mutate the input array", () => {
    const original: ClockDayEntry[] = [FINISHED];
    upsertDayEntry(original, { ...FINISHED, breakMinutes: 999 });
    upsertDayEntry(original, RUNNING);
    expect(original).toHaveLength(1);
    expect(original[0]).toBe(FINISHED);
  });
});

// Issue #70 (Phase 70b-06, D-07): a day may hold several entries. The three-state answer mirrors the
// server's selectors, and the day sums feed the "Heutiger Eintrag" card.
const A_MORNING: ClockDayEntry = {
  id: "e-a",
  startTime: "2026-08-28T05:00:00.000Z",
  endTime: "2026-08-28T09:00:00.000Z",
  breakMinutes: 15,
  workingMinutes: 225,
  salonId: "salon-a",
  salonName: "Salon A",
};
const B_AFTERNOON: ClockDayEntry = {
  id: "e-b",
  startTime: "2026-08-28T09:30:00.000Z",
  endTime: "2026-08-28T13:00:00.000Z",
  breakMinutes: 0,
  workingMinutes: 210,
  salonId: "salon-b",
  salonName: "Salon B",
};
const B_RUNNING: ClockDayEntry = {
  ...B_AFTERNOON,
  id: "e-b-run",
  endTime: null,
  workingMinutes: null,
};

describe("resolveDayState — several entries a day (Issue #70)", () => {
  it("two closed rows: the day is finished and names the row ending last, whatever the order", () => {
    for (const rows of [
      [A_MORNING, B_AFTERNOON],
      [B_AFTERNOON, A_MORNING],
    ]) {
      const day = resolveDayState(rows);
      expect(day.kind).toBe("finished");
      expect(day.entry?.id).toBe("e-b");
    }
  });

  it("an open row next to a closed one: the day is running and names the open row", () => {
    const day = resolveDayState([A_MORNING, B_RUNNING]);
    expect(day.kind).toBe("running");
    expect(day.entry?.id).toBe("e-b-run");
  });

  it("a tie on the end instant goes to the later start, then to the larger id (the server's tie-break)", () => {
    const end = "2026-08-28T13:00:00.000Z";
    const early = { ...A_MORNING, id: "e-1", startTime: "2026-08-28T12:00:00.000Z", endTime: end };
    const late = { ...A_MORNING, id: "e-2", startTime: "2026-08-28T12:30:00.000Z", endTime: end };
    expect(resolveDayState([early, late]).entry?.id).toBe("e-2");
    expect(resolveDayState([late, early]).entry?.id).toBe("e-2");
    const sameStart = { ...late, id: "e-3" };
    expect(resolveDayState([late, sameStart]).entry?.id).toBe("e-3");
    expect(resolveDayState([sameStart, late]).entry?.id).toBe("e-3");
  });
});

describe("dayTotals — the sums of today's entries (Issue #70, D-07)", () => {
  const NOW = new Date("2026-08-28T14:00:00.000Z");

  it("two closed rows: earliest start, latest end, Σ breaks, Σ server working minutes", () => {
    expect(dayTotals([B_AFTERNOON, A_MORNING], NOW)).toEqual({
      startTime: new Date(A_MORNING.startTime).toISOString(),
      endTime: new Date(B_AFTERNOON.endTime!).toISOString(),
      breakMinutes: 15,
      workingMinutes: 435,
      rowCount: 2,
    });
  });

  it("a running row has no end yet and contributes its live minutes at `now`", () => {
    // Running since 09:30 UTC, now 11:00 UTC → 90 min gross, no break → 90; plus the closed 225.
    const running = { ...B_RUNNING, breakMinutes: 0 };
    const totals = dayTotals([A_MORNING, running], new Date("2026-08-28T11:00:00.000Z"));
    expect(totals.endTime).toBeNull();
    expect(totals.workingMinutes).toBe(225 + 90);
    expect(totals.startTime).toBe(new Date(A_MORNING.startTime).toISOString());
    expect(totals.breakMinutes).toBe(15);
  });

  it("a closed row without a server value falls back to the display formula (end − start − break)", () => {
    const optimistic = { ...A_MORNING, workingMinutes: undefined };
    // 4 h presence − 15 min break.
    expect(dayTotals([optimistic], NOW).workingMinutes).toBe(225);
  });

  it("the server's per-row value wins over the display formula for a closed row", () => {
    const rounded = { ...A_MORNING, workingMinutes: 200 };
    expect(dayTotals([rounded], NOW).workingMinutes).toBe(200);
  });

  it("no rows: nothing to sum", () => {
    expect(dayTotals([], NOW)).toEqual({
      startTime: null,
      endTime: null,
      breakMinutes: 0,
      workingMinutes: 0,
      rowCount: 0,
    });
  });

  it("entryWorkedMinutes is the live display value: open row up to now, closed row to its end, minus breaks", () => {
    expect(entryWorkedMinutes(A_MORNING, NOW)).toBe(225);
    expect(
      entryWorkedMinutes({ ...B_RUNNING, breakMinutes: 10 }, new Date("2026-08-28T10:30:00.000Z")),
    ).toBe(50);
    expect(
      entryWorkedMinutes({ ...B_RUNNING, breakMinutes: 999 }, new Date("2026-08-28T10:30:00.000Z")),
    ).toBe(0);
  });
});

describe("the count label and the list lines (Issue #70, D-07)", () => {
  it("entryCountLabel is „2 Einträge heute“ from two rows on and null below", () => {
    expect(entryCountLabel(0)).toBeNull();
    expect(entryCountLabel(1)).toBeNull();
    expect(entryCountLabel(2)).toBe("2 Einträge heute");
    expect(entryCountLabel(3)).toBe("3 Einträge heute");
  });

  it("entryRangeLabel: HH:MM–HH:MM for a closed row, „seit HH:MM“ for the running one (local time)", () => {
    expect(entryRangeLabel(A_MORNING)).toBe(
      `${localHhmm(A_MORNING.startTime)}–${localHhmm(A_MORNING.endTime!)}`,
    );
    expect(entryRangeLabel(B_RUNNING)).toBe(`seit ${localHhmm(B_RUNNING.startTime)}`);
  });

  it("entriesInStartOrder sorts by start, then id, without touching its input", () => {
    const input = [B_AFTERNOON, A_MORNING];
    expect(entriesInStartOrder(input).map((e) => e.id)).toEqual(["e-a", "e-b"]);
    expect(input.map((e) => e.id)).toEqual(["e-b", "e-a"]);
  });
});
