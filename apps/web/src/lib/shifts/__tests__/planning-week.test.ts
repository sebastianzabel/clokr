// Issue #849 (3) — the Planungsbedarf week starts on the local Monday and is labelled in German.
import { describe, it, expect } from "vitest";
import { isoWeekNumber, mondayOfWeek, planningWeekLabel } from "../planning-week";

describe("planning week (Issue #849)", () => {
  it("Monday shortly after local midnight stays that Monday (was the previous Sunday)", () => {
    // 2026-11-09 is a Monday; 00:30 local is still 2026-11-08 in UTC for Europe/Berlin.
    expect(mondayOfWeek(new Date(2026, 10, 9, 0, 30))).toBe("2026-11-09");
  });

  it("Sunday belongs to the week that started the Monday before", () => {
    expect(mondayOfWeek(new Date(2026, 10, 15, 23, 50))).toBe("2026-11-09");
    expect(mondayOfWeek(new Date(2026, 10, 11, 12, 0))).toBe("2026-11-09");
  });

  it("labels the week as „KW 46 · 9.–15. Nov.“ (Issue #850)", () => {
    expect(planningWeekLabel("2026-11-09", "2026-11-15")).toBe("KW 46 · 9.–15. Nov.");
    expect(planningWeekLabel("2026-10-26", "2026-11-01")).toBe("KW 44 · 26. Okt.–1. Nov.");
    expect(planningWeekLabel("2026-12-28", "2027-01-03")).toBe(
      "KW 53 · 28. Dez. 2026–3. Jan. 2027",
    );
    expect(planningWeekLabel("2026-11-09", "")).toBe("KW 46 · ab 9. Nov.");
  });

  it("regression S-23: never „Woche 2026-11-08— 2026-11-08“ — no ISO date, no date twice", () => {
    const label = planningWeekLabel("2026-11-08", "2026-11-08");
    expect(label).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(label).toBe("KW 45 · 8. Nov.");
    expect(label.match(/8\. Nov\./g)).toHaveLength(1);
  });

  it("ISO week numbers at the year edges", () => {
    expect(isoWeekNumber("2026-01-01")).toBe(1);
    expect(isoWeekNumber("2027-01-03")).toBe(53);
    expect(isoWeekNumber("2027-01-04")).toBe(1);
  });
});
