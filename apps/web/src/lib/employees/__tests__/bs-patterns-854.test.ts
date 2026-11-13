// Issue #854 (plan 854-22) - the pure model of the Berufsschultage editor: hydration, the mode
// guard, the weekday index conversion, validation, the change count and the PUT body.
import { describe, expect, it } from "vitest";

import {
  draftOf,
  fromPickerDays,
  hasRetroactiveRow,
  messageCountOf,
  newDraft,
  patternChangeCount,
  patternMessages,
  patternsBody,
  patternsErrorCount,
  toPickerDays,
  toggled,
  withBlockWeekToggled,
  withMode,
  type StoredPattern,
} from "../bs-patterns";

const STORED: StoredPattern = {
  id: "p1",
  dayOfWeek: 0,
  daysOfWeek: [0, 2],
  blockWeeks: [],
  blockYear: null,
  validFrom: "2026-09-01",
  validUntil: null,
};

describe("draftOf", () => {
  it("a weekly row keeps its days and defaults the optional fields", () => {
    const draft = draftOf(STORED);
    expect(draft).toMatchObject({
      key: "p1",
      mode: "weekly",
      daysOfWeek: [0, 2],
      respectSchoolHolidays: true,
      federalStateOverride: null,
      bsSlotFirstLongDayMinutes: null,
      bsSlotBlockWeekMinutes: null,
    });
  });

  it("any block week makes it a block row; a legacy row with both is coerced to block", () => {
    expect(draftOf({ ...STORED, blockWeeks: [10, 11], blockYear: 2026 }).mode).toBe("block");
  });

  it("falls back to the legacy single day when daysOfWeek is empty", () => {
    expect(draftOf({ ...STORED, daysOfWeek: [], dayOfWeek: 3 }).daysOfWeek).toEqual([3]);
    expect(draftOf({ ...STORED, daysOfWeek: [], dayOfWeek: null }).daysOfWeek).toEqual([]);
  });

  it("keeps stored slot minutes and flags", () => {
    const draft = draftOf({
      ...STORED,
      respectSchoolHolidays: false,
      federalStateOverride: "BAYERN",
      bsSlotShortDayMinutes: 300,
    });
    expect(draft.respectSchoolHolidays).toBe(false);
    expect(draft.federalStateOverride).toBe("BAYERN");
    expect(draft.bsSlotShortDayMinutes).toBe(300);
  });
});

describe("newDraft and the mode guard", () => {
  it("a new row is weekly, empty and starts today", () => {
    expect(newDraft(2, "2026-11-12")).toMatchObject({
      key: "new-2",
      mode: "weekly",
      daysOfWeek: [],
      validFrom: "2026-11-12",
      validUntil: null,
    });
  });

  it("switching the mode clears the other mode's data", () => {
    const block = { ...draftOf(STORED), mode: "block" as const, blockWeeks: [3], blockYear: 2026 };
    expect(withMode(block, "weekly")).toMatchObject({ blockWeeks: [], blockYear: null });
    expect(withMode(draftOf(STORED), "block")).toMatchObject({ mode: "block", daysOfWeek: [] });
    const same = draftOf(STORED);
    expect(withMode(same, "weekly")).toBe(same);
  });

  it("toggling keeps the set sorted; emptying the weeks clears the year", () => {
    expect(toggled([1, 5], 3)).toEqual([1, 3, 5]);
    expect(toggled([1, 3, 5], 3)).toEqual([1, 5]);
    const first = withBlockWeekToggled(newDraft(1, "2026-11-12"), 40, 2026);
    expect(first).toMatchObject({ blockWeeks: [40], blockYear: 2026 });
    expect(withBlockWeekToggled(first, 40, 2026)).toMatchObject({
      blockWeeks: [],
      blockYear: null,
    });
  });
});

describe("weekday indices", () => {
  it("converts 0 = Montag … 6 = Sonntag to the picker's 0 = Sonntag and back", () => {
    expect(toPickerDays([0, 2, 6])).toEqual([0, 1, 3]);
    expect(fromPickerDays([0, 1, 3])).toEqual([0, 2, 6]);
    for (const days of [[], [4], [0, 1, 2, 3, 4, 5, 6]]) {
      expect(fromPickerDays(toPickerDays(days))).toEqual(days);
    }
  });
});

describe("validation", () => {
  it("a fine weekly row has no message", () => {
    expect(messageCountOf(patternMessages(draftOf(STORED)))).toBe(0);
  });

  it("weekly needs a day; block needs weeks and a year", () => {
    const empty = newDraft(1, "2026-11-12");
    expect(patternMessages(empty).days).toBe("Wähle mindestens einen Wochentag.");
    const block = withMode(empty, "block");
    const messages = patternMessages(block);
    expect(messages.weeks).toBe("Wähle mindestens eine Block-Woche.");
    expect(messages.year).toContain("Jahr");
  });

  it("names a missing start and an end before the start", () => {
    expect(patternMessages({ ...draftOf(STORED), validFrom: "" }).validFrom).toContain("Gültig ab");
    expect(patternMessages({ ...draftOf(STORED), validUntil: "2026-08-31" }).validUntil).toContain(
      "nicht vor",
    );
  });

  it("checks the slot bounds instead of dropping a bad value silently", () => {
    const messages = patternMessages({
      ...draftOf(STORED),
      bsSlotFirstLongDayMinutes: 100,
      bsSlotBlockWeekMinutes: 5000,
      bsSlotShortDayMinutes: 300,
    });
    expect(Object.keys(messages.slots).sort()).toEqual([
      "bsSlotBlockWeekMinutes",
      "bsSlotFirstLongDayMinutes",
    ]);
    expect(patternsErrorCount([draftOf(STORED), newDraft(1, "2026-11-12")])).toBe(1);
  });
});

describe("changes and the PUT body", () => {
  const saved = [draftOf(STORED)];

  it("no change, an edit, an added and a removed row", () => {
    expect(patternChangeCount(saved, [draftOf(STORED)])).toBe(0);
    expect(patternChangeCount(saved, [{ ...draftOf(STORED), daysOfWeek: [0] }])).toBe(1);
    expect(patternChangeCount(saved, [...saved, newDraft(1, "2026-11-12")])).toBe(1);
    expect(patternChangeCount(saved, [])).toBe(1);
  });

  it("undoing an edit by hand clears the change", () => {
    const edited = { ...draftOf(STORED), daysOfWeek: [0] };
    expect(patternChangeCount(saved, [{ ...edited, daysOfWeek: [0, 2] }])).toBe(0);
  });

  it("the body carries the persistable fields only, never the key or the mode", () => {
    const body = patternsBody([{ ...draftOf(STORED), bsSlotShortDayMinutes: 300 }]);
    expect(body.patterns).toHaveLength(1);
    expect(Object.keys(body.patterns[0]).sort()).toEqual([
      "blockWeeks",
      "blockYear",
      "bsSlotBlockWeekMinutes",
      "bsSlotFirstLongDayMinutes",
      "bsSlotSecondLongDayMinutes",
      "bsSlotShortDayMinutes",
      "daysOfWeek",
      "federalStateOverride",
      "respectSchoolHolidays",
      "validFrom",
      "validUntil",
    ]);
    expect(body.patterns[0].bsSlotShortDayMinutes).toBe(300);
    expect(body.patterns[0].bsSlotFirstLongDayMinutes).toBeNull();
  });

  it("the retroactive check fires only for a row that starts before today", () => {
    expect(hasRetroactiveRow([draftOf(STORED)], "2026-11-12")).toBe(true);
    expect(hasRetroactiveRow([draftOf(STORED)], "2026-09-01")).toBe(false);
    expect(hasRetroactiveRow([], "2026-11-12")).toBe(false);
  });
});
