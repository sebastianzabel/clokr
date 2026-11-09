// Issue #850 — the three conflict buckets become one dated list of notices with one action each.
import { describe, it, expect } from "vitest";
import { buildShiftNotices, noticeDay, type ConflictShift } from "../shift-notices";

const shift = (over: Partial<ConflictShift>): ConflictShift => ({
  id: "s1",
  date: "2026-11-10T00:00:00.000Z",
  startTime: "09:00",
  endTime: "17:00",
  label: null,
  employee: { firstName: "Mia", lastName: "Beispiel" },
  deletedAt: null,
  deletedReason: null,
  conflictsWithLeave: true,
  ...over,
});

describe("shift notices (Issue #850)", () => {
  const notices = buildShiftNotices({
    softDeleted: [
      shift({
        id: "gone",
        date: "2026-11-12T00:00:00.000Z",
        deletedAt: "2026-11-01T10:00:00.000Z",
        deletedReason: "AUTO_BS_DAY_CLEANUP",
        conflictsWithLeave: false,
        label: "Früh",
      }),
    ],
    flagged: [shift({ id: "marked" })],
    weekOverbooked: [
      {
        employeeId: "e2",
        employeeName: "Timo Muster",
        weekStart: "2026-11-09",
        weekEnd: "2026-11-15",
        contractDays: 5,
        leaveDays: 1,
        otherAbsenceDays: 0,
        scheduledDays: 5,
        overbookedBy: 1,
      },
    ],
  });

  it("is one list sorted by day, every row with date, person, reason and action", () => {
    expect(notices.map((n) => n.kind)).toEqual(["week-overbooked", "marked", "removed"]);
    for (const n of notices) {
      expect(n.dateLabel).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(n.person.length).toBeGreaterThan(0);
      expect(n.reason.length).toBeGreaterThan(0);
      expect(n.action.label.length).toBeGreaterThan(0);
    }
  });

  it("a marked shift is kept, a removed one restored — both through the restore call", () => {
    const marked = notices.find((n) => n.kind === "marked")!;
    expect(marked.dateLabel).toBe("Di., 10. Nov.");
    expect(marked.action).toMatchObject({
      type: "restore",
      shiftId: "marked",
      label: "Schicht behalten",
    });
    const removed = notices.find((n) => n.kind === "removed")!;
    expect(removed.detail).toBe("09:00–17:00 · Früh");
    expect(removed.action).toMatchObject({
      type: "restore",
      shiftId: "gone",
      label: "Wiederherstellen",
    });
  });

  it("an overbooked week names its days in words and links to the Planungsbedarf", () => {
    const week = notices.find((n) => n.kind === "week-overbooked")!;
    expect(week.dateLabel).toBe("KW 46 · 9.–15. Nov.");
    expect(week.reason).toBe("5 Tage geplant, laut Vertrag 4 Tage möglich – 1 Tag zu viel.");
    expect(week.action).toEqual({
      type: "link",
      href: "/shifts/planning",
      label: "Zum Planungsbedarf",
    });
  });

  it("an empty response is an empty list", () => {
    expect(buildShiftNotices({ softDeleted: [], flagged: [], weekOverbooked: [] })).toEqual([]);
  });

  it("names the weekday", () => {
    expect(noticeDay("2026-11-09")).toBe("Mo., 9. Nov.");
  });
});
