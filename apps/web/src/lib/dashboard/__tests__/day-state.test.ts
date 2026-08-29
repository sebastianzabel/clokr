import { describe, it, expect } from "vitest";
import {
  resolveDayState,
  primaryClockLabel,
  canReopenFinishedDay,
  reopenGapStartLabel,
  upsertDayEntry,
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
    // Filtering it (as presence.ts and the resolver's READ lookup do) would resolve this day
    // to "idle" → Einstempeln → START → timeEntry.create → the partial unique index
    // TimeEntry_employeeId_date_unique_not_deleted rejects it → P2002 → HTTP 500.
    // Not filtering it keeps today's honest HTTP 409 (CONFLICT NOT_CLOCKED_IN).
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
