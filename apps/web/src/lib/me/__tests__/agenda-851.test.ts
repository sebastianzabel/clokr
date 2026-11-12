// Issue #597 (Phase 851) - the next days as one stream of shifts, leave and holidays.
import { describe, expect, it } from "vitest";
import { buildAgenda, isoWeek } from "../agenda";

const names: Record<string, string> = { nord: "Clokr Demo Nord", haupt: "Clokr Demo" };
const salonName = (id: string | undefined) => (id ? (names[id] ?? "anderer Salon") : "");

describe("buildAgenda", () => {
  const start = new Date(2026, 10, 9); // Mo 9.11.2026

  it("groups by week and marks today", () => {
    const weeks = buildAgenda(start, 14, {
      shifts: [],
      leave: [],
      holidays: [],
      homeSalonId: "nord",
      salonName,
    });
    expect(weeks.map((w) => w.label)).toEqual(["Diese Woche · KW 46", "Nächste Woche · KW 47"]);
    expect(weeks[0].days[0]).toMatchObject({
      weekday: "Mo",
      dayLabel: "9.11.",
      isToday: true,
      kind: "free",
      title: "Frei",
    });
    expect(weeks.flatMap((w) => w.days)).toHaveLength(14);
  });

  it("names shift times, its salon and flags another salon", () => {
    const weeks = buildAgenda(start, 7, {
      shifts: [
        {
          date: "2026-11-10",
          startTime: "10:00",
          endTime: "18:30",
          durationMinNetto: 480,
          salonId: "nord",
        },
        {
          date: "2026-11-12",
          startTime: "10:00",
          endTime: "18:30",
          durationMinNetto: 480,
          salonId: "haupt",
        },
      ],
      leave: [],
      holidays: [],
      homeSalonId: "nord",
      salonName,
    });
    const [tue, , thu] = weeks[0].days.slice(1);
    expect(tue).toMatchObject({
      kind: "shift",
      title: "10:00 – 18:30",
      subtitle: "Clokr Demo Nord",
      netMinutes: 480,
      otherSalon: false,
    });
    expect(thu).toMatchObject({ subtitle: "Clokr Demo", otherSalon: true });
  });

  it("shows effective leave and holidays, ignores pending leave", () => {
    const weeks = buildAgenda(start, 7, {
      shifts: [],
      leave: [
        { startDate: "2026-11-11", endDate: "2026-11-11", status: "APPROVED", label: "Urlaub" },
        { startDate: "2026-11-13", endDate: "2026-11-13", status: "PENDING", label: "Urlaub" },
      ],
      holidays: [{ date: "2026-11-12", name: "Testfeiertag" }],
      homeSalonId: null,
      salonName,
    });
    const d = weeks[0].days;
    expect(d[2]).toMatchObject({ kind: "leave", title: "Urlaub" });
    expect(d[3]).toMatchObject({ kind: "holiday", title: "Testfeiertag" });
    expect(d[4]).toMatchObject({ kind: "free" });
  });

  it("isoWeek counts like ISO 8601", () => {
    expect(isoWeek(new Date(2026, 10, 9))).toBe(46);
    expect(isoWeek(new Date(2027, 0, 1))).toBe(53);
  });
});
