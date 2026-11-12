// Issue #851: the Kennzahlen of „Zeiten“ only word the page's month figures - a no-Soll contract
// claims no saldo (#495), a closed month reads as confirmed, the day-check findings are counted
// as the server gave them.
import { describe, expect, it } from "vitest";
import { zeitenKpis, zeitenStatus, type ZeitenMonthFigures } from "../zeiten-kpis";

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
