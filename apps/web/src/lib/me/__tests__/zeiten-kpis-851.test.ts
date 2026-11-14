// Issue #851: the Kennzahlen of „Zeiten“ only word the page's month figures - a no-Soll contract
// claims no saldo (#495), a closed month reads as confirmed, the day-check findings are counted
// as the server gave them.
import { describe, expect, it } from "vitest";
import { ownZeitenKpis, zeitenKpis, zeitenStatus, type ZeitenMonthFigures } from "../zeiten-kpis";

const month: ZeitenMonthFigures = {
  sollToDateMin: 32 * 60,
  istMin: 33 * 60 + 55,
  saldoMin: 115,
  noSollTarget: false,
  workdaysSoFar: 4,
  rosterIncomplete: false,
};
const base = { month, locked: false, breakMinutes: 180, findingDays: 0, runningCount: 0 };

describe("zeitenKpis", () => {
  it("words the open month as the prototype does", () => {
    const [worked, saldo, pauses] = zeitenKpis(base);
    expect(worked).toMatchObject({ label: "Gearbeitet", value: "33:55", unit: "/ 32:00 h" });
    expect(worked.explanation).toBe("4 Arbeitstage · bis gestern");
    expect(saldo).toMatchObject({ value: "+1:55", unit: "h" });
    expect(saldo.explanation).toBe("Prognose · Monat offen");
    expect(pauses).toMatchObject({ value: "3:00", unit: "h" });
  });

  it("claims no saldo for a contract without Soll (#495)", () => {
    const [worked, saldo] = zeitenKpis({
      ...base,
      month: { ...month, noSollTarget: true, saldoMin: null, sollToDateMin: 0 },
    });
    expect(worked.unit).toBe("h");
    expect(saldo.value).toBe("—");
    expect(saldo.explanation).toBe("Zeiterfassung ohne Sollvergleich");
  });

  it("reads a closed month as confirmed and counts findings", () => {
    const [worked, saldo, pauses] = zeitenKpis({ ...base, locked: true, findingDays: 2 });
    expect(worked.explanation).toContain("ganzer Monat");
    expect(saldo.explanation).toBe("Bestätigt · Monat abgeschlossen");
    expect(pauses.explanation).toBe("2 Tage mit ArbZG-Hinweis");
    expect(zeitenStatus(true).label).toBe("Abgeschlossen");
    expect(zeitenStatus(false).explanation).toBe("Abschluss durch die Salonleitung");
  });

  it("withholds the saldo of a person the caller may not read (#853, #85)", () => {
    const [worked, saldo] = zeitenKpis({
      ...base,
      month: { ...month, noSollTarget: true, saldoMin: null, sollToDateMin: 0 },
      saldoWithheld: true,
    });
    expect(worked).toMatchObject({ unit: "h" });
    expect(saldo.value).toBe("—");
    expect(saldo.explanation).toBe("sehen Inhaber, Personalabteilung und die Person selbst");
    expect(saldo.explanation).not.toContain("ohne Sollvergleich");
  });

  it("claims no day count its source does not have (#125)", () => {
    const [worked] = zeitenKpis({ ...base, month: { ...month, workdaysSoFar: null } });
    expect(worked.explanation).toBe("bis gestern");
  });
});

// Issue #935: the own page words the same figures as Ist, Soll and Differenz (mockup 14.11.2026).
describe("ownZeitenKpis", () => {
  it("names Ist, Soll bis gestern and Differenz with the page's own figures", () => {
    const [ist, soll, diff] = ownZeitenKpis({ ...base, runningCount: 1 });
    expect(ist).toMatchObject({ label: "Ist", value: "33:55", unit: "h" });
    expect(ist.explanation).toBe("4 Arbeitstage · 1 Eintrag läuft");
    expect(soll).toMatchObject({ label: "Soll bis gestern", value: "32:00", unit: "h" });
    expect(diff).toMatchObject({ label: "Differenz", value: "+1:55", unit: "h" });
    expect(diff.explanation).toBe("Prognose · Monat offen");
  });

  it("is the same saldo figure zeitenKpis shows, never a new computation", () => {
    const [, saldo] = zeitenKpis(base);
    const [, , diff] = ownZeitenKpis(base);
    expect(diff.value).toBe(saldo.value);
  });

  it("claims no Soll and no Differenz for a contract without Soll (#495)", () => {
    const [, soll, diff] = ownZeitenKpis({
      ...base,
      month: { ...month, noSollTarget: true, saldoMin: null, sollToDateMin: 0 },
    });
    expect(soll.value).toBe("—");
    expect(diff.value).toBe("—");
  });

  it("reads a closed month as the whole month, confirmed", () => {
    const [, soll, diff] = ownZeitenKpis({ ...base, locked: true });
    expect(soll.label).toBe("Soll");
    expect(soll.explanation).toBe("ganzer Monat");
    expect(diff.explanation).toBe("Bestätigt · Monat abgeschlossen");
  });
});
