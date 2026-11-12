// Issue #853 (D-853-18) - the pure Zeiten figure model: which cells exist when, and what they say.
// The equality with the unchanged cards is pinned in zeiten-kpis-parity-853.test.ts.
import { describe, expect, it } from "vitest";
import { kontoKpiItem, monthKpiItems, type MonthKpiInput } from "../zeiten-kpis";

function month(overrides: Partial<MonthKpiInput> = {}): MonthKpiInput {
  return {
    sollToDateMin: 480,
    istMin: 500,
    saldoMin: 20,
    noSollTarget: false,
    sollLabel: "Soll (bisher)",
    workdaysSoFar: 1,
    runningCount: 0,
    isLocked: false,
    ...overrides,
  };
}

describe("monthKpiItems", () => {
  it("a Soll month has Gearbeitet, the saldo cell and Status", () => {
    const items = monthKpiItems(month());
    expect(items.map((i) => i.label)).toEqual(["Gearbeitet", "Monat-Saldo (Prognose)", "Status"]);
    expect(items[0].value).toBe("8:20");
    expect(items[0].unit).toBe("h");
    expect(items[0].explanation).toBe("Soll (bisher) 8:00 h · Ist 8:20 h erfüllt");
    expect(items[0].progress).toEqual({ value: 500, max: 480, label: "+0:20 h mehr" });
    expect(items[1].value).toBe("+0:20");
    expect(items[1].explanation).toBe("1 Arbeitstage bisher");
  });

  it("without a Soll to date, Gearbeitet says so and has no progress bar", () => {
    const [gearbeitet] = monthKpiItems(month({ sollToDateMin: 0, istMin: 0, saldoMin: 0 }));
    expect(gearbeitet.label).toBe("Gearbeitet");
    expect(gearbeitet.explanation).toBe("noch keine Sollzeit in diesem Monat");
    expect(gearbeitet.progress).toBeUndefined();
  });

  it("the progress label names the deficit, the overhang or a balanced month", () => {
    const label = (soll: number, ist: number) =>
      monthKpiItems(month({ sollToDateMin: soll, istMin: ist }))[0].progress?.label;
    expect(label(3360, 2880)).toBe("fehlen 8:00 h");
    expect(label(2880, 3360)).toBe("+8:00 h mehr");
    expect(label(2880, 2880)).toBe("ausgeglichen");
  });

  it("a negative saldo carries the minus sign, no saldo shows a dash", () => {
    expect(monthKpiItems(month({ saldoMin: -480 }))[1].value).toBe("−8:00");
    expect(monthKpiItems(month({ saldoMin: 0 }))[1].value).toBe("±0:00");
    expect(monthKpiItems(month({ saldoMin: null }))[1].value).toBe("—");
  });

  it("no Soll target (track-only or a refused saldo read): Ist hours, no Gearbeitet cell, the hint", () => {
    const items = monthKpiItems(
      month({ noSollTarget: true, sollToDateMin: 0, saldoMin: null, istMin: 750 }),
    );
    expect(items.map((i) => i.label)).toEqual(["Monatsstunden (Vorläufig)", "Status"]);
    expect(items[0].value).toBe("12:30 h");
    expect(items[0].delta).toBe("Zeiterfassung ohne Sollvergleich");
    expect(items.some((i) => /Saldo/.test(i.label))).toBe(false);
  });

  it("a closed month says Bestätigt and Abgeschlossen and names no closer", () => {
    const items = monthKpiItems(month({ isLocked: true }));
    expect(items[1].label).toBe("Monat-Saldo (Bestätigt)");
    expect(items[2].value).toBe("Abgeschlossen");
    expect(items[2].delta).toBeUndefined();
    const open = monthKpiItems(month())[2];
    expect(open.value).toBe("Offen");
    expect(open.delta).toBe("Abschluss durch die Betriebsleitung");
  });

  it("the running count stands alone when the branch has no workday count", () => {
    expect(monthKpiItems(month({ workdaysSoFar: null, runningCount: 2 }))[1].explanation).toBe(
      "2 läuft",
    );
    expect(monthKpiItems(month({ workdaysSoFar: null }))[1].explanation).toBeUndefined();
    expect(monthKpiItems(month({ workdaysSoFar: 3, runningCount: 1 }))[1].explanation).toBe(
      "3 Arbeitstage bisher · 1 läuft",
    );
  });
});

describe("kontoKpiItem", () => {
  it("is labelled Stundenkonto and sums the confirmed and the open part", () => {
    const item = kontoKpiItem({
      totalHours: 99,
      confirmedMinutes: 120,
      openMonthMinutes: -30,
      hasClosedMonth: true,
      unconfirmedMonths: 1,
    });
    expect(item.label).toBe("Stundenkonto");
    expect(item.value).toBe("+1:30");
    expect(item.explanation).toBe("inkl. laufendem Monat");
    expect(item.delta).toBe("Bestätigt +2:00");
  });

  it("words the forecast through forecastCaption (several months, closed month known)", () => {
    const item = kontoKpiItem({
      totalHours: 1,
      confirmedMinutes: 60,
      openMonthMinutes: 0,
      hasClosedMonth: true,
      unconfirmedMonths: 3,
    });
    expect(item.explanation).toBe("inkl. Zeitraum seit Monatsabschluss");
  });

  it("falls back to totalHours outside split mode and shows no caption", () => {
    const item = kontoKpiItem({ totalHours: -1.5 });
    expect(item.value).toBe("−1:30");
    expect(item.explanation).toBeUndefined();
    expect(item.delta).toBeUndefined();
  });

  it("no data at all shows a dash", () => {
    expect(kontoKpiItem({ totalHours: null }).value).toBe("—");
  });

  it("a brand-new hire with nothing confirmed and nothing booked", () => {
    const item = kontoKpiItem({
      totalHours: 0,
      confirmedMinutes: 0,
      openMonthMinutes: 0,
      hasClosedMonth: false,
      unconfirmedMonths: 1,
    });
    expect(item.value).toBe("±0:00");
    expect(item.delta).toBe("noch kein Monatsabschluss ±0:00");
    expect(item.deltaTone).toBeUndefined();
  });

  it("nothing confirmed while the account is not empty is flagged as a warning", () => {
    const item = kontoKpiItem({
      totalHours: 0,
      confirmedMinutes: 0,
      openMonthMinutes: -4212,
      hasClosedMonth: false,
      unconfirmedMonths: 4,
      rosterIncomplete: true,
    });
    expect(item.value).toBe("−70:12");
    expect(item.delta).toBe("Monatsabschlüsse fehlen · Saldo vollständig unbestätigt");
    expect(item.deltaTone).toBe("warn");
    expect(item.explanation).toBe("inkl. Zeitraum seit Eintritt · Restmonat unverplant");
  });
});
