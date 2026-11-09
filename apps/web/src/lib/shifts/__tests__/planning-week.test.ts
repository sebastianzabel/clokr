// Issue #849 (3) — the Planungsbedarf week starts on the local Monday and is labelled in German.
import { describe, it, expect } from "vitest";
import { mondayOfWeek, planningWeekLabel } from "../planning-week";

describe("planning week (Issue #849)", () => {
  it("Monday shortly after local midnight stays that Monday (was the previous Sunday)", () => {
    // 2026-11-09 is a Monday; 00:30 local is still 2026-11-08 in UTC for Europe/Berlin.
    expect(mondayOfWeek(new Date(2026, 10, 9, 0, 30))).toBe("2026-11-09");
  });

  it("Sunday belongs to the week that started the Monday before", () => {
    expect(mondayOfWeek(new Date(2026, 10, 15, 23, 50))).toBe("2026-11-09");
    expect(mondayOfWeek(new Date(2026, 10, 11, 12, 0))).toBe("2026-11-09");
  });

  it("labels the week as German dates, start before end", () => {
    expect(planningWeekLabel("2026-11-09", "2026-11-15")).toBe("Woche 09.11.2026 – 15.11.2026");
    expect(planningWeekLabel("2026-11-09", "")).toBe("Woche 09.11.2026");
  });
});
