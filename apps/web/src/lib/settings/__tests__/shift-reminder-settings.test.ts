// Issue #609 (D-01): the admin form must never send a value the whole-page PUT would reject.
import { describe, it, expect } from "vitest";
import {
  clampReminderOffsetInput,
  normalizeDayCloseTimeInput,
  DEFAULT_REMINDER_OFFSET_MINUTES,
  DEFAULT_DAY_CLOSE_TIME,
} from "../shift-reminder-settings";

describe("clampReminderOffsetInput", () => {
  it.each([
    [15, 15],
    [4, 5],
    [121, 120],
    [5, 5],
    [120, 120],
    [7.6, 8],
    [null, 15],
    [undefined, 15],
    [Number.NaN, 15],
    ["" as unknown as number, 15],
  ])("%s -> %s", (raw, expected) => {
    expect(clampReminderOffsetInput(raw as number | null | undefined)).toBe(expected);
  });

  it("exposes the defaults", () => {
    expect(DEFAULT_REMINDER_OFFSET_MINUTES).toBe(15);
    expect(DEFAULT_DAY_CLOSE_TIME).toBe("20:00");
  });
});

describe("normalizeDayCloseTimeInput", () => {
  it.each([
    ["20:00", "20:00"],
    ["07:30", "07:30"],
    ["23:59", "23:59"],
    ["00:00", "00:00"],
    ["", "20:00"],
    [null, "20:00"],
    [undefined, "20:00"],
    ["24:00", "20:00"],
    ["7:5", "20:00"],
    ["12:60", "20:00"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizeDayCloseTimeInput(raw as string | null | undefined)).toBe(expected);
  });
});
