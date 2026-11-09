// Issue #851 (prototype „Zeiten“): the four Kennzahlen above the own month - Gearbeitet, Monatssaldo,
// Pausen, Status. Pure wording over figures the page already holds (its MonthMetrics, the sum of the
// recorded breaks and the server's day-check map): nothing is computed here, so the figures stay the
// ones MonatSaldoCard showed (#125 one-source count, #433 MONTHLY_HOURS Soll, #495 no-Soll contract).
import type { KpiItem } from "$components/ui/KpiStrip.svelte";
import { fmtBalance, fmtMin } from "$lib/utils/format-minutes";

export interface ZeitenMonthFigures {
  sollToDateMin: number;
  istMin: number;
  /** null = no Soll target or no contract: no saldo is claimed. */
  saldoMin: number | null;
  noSollTarget: boolean;
  /** Days with worked time, from the same source as `istMin`; null = that source has none. */
  workdaysSoFar: number | null;
  rosterIncomplete: boolean;
  extraNote?: string;
}

export interface ZeitenKpiInput {
  month: ZeitenMonthFigures;
  /** The displayed month is closed (Monatsabschluss). */
  locked: boolean;
  /** Recorded break minutes of the counted entries (through yesterday). */
  breakMinutes: number;
  /** Days of the month with a finding of the server's day check; null = the check is off. */
  findingDays: number | null;
  runningCount: number;
}

function daysText(n: number): string {
  return n === 1 ? "1 Arbeitstag" : `${n} Arbeitstage`;
}

export function zeitenKpis(input: ZeitenKpiInput): KpiItem[] {
  const { month, locked, breakMinutes, findingDays, runningCount } = input;
  const cutoff = locked ? "ganzer Monat" : "bis gestern";

  const workedParts = [
    month.workdaysSoFar !== null ? daysText(month.workdaysSoFar) : null,
    cutoff,
    runningCount > 0 ? `${runningCount} läuft` : null,
  ].filter(Boolean);

  const worked: KpiItem = {
    label: "Gearbeitet",
    value: fmtMin(month.istMin),
    unit:
      !month.noSollTarget && month.sollToDateMin > 0 ? `/ ${fmtMin(month.sollToDateMin)} h` : "h",
    explanation: workedParts.join(" · "),
    testId: "zeiten-kpi-worked",
  };

  const saldo: KpiItem = month.noSollTarget
    ? {
        label: "Monatssaldo",
        value: "—",
        explanation: "Zeiterfassung ohne Sollvergleich",
        testId: "zeiten-kpi-saldo",
      }
    : {
        label: "Monatssaldo",
        value: month.saldoMin === null ? "—" : fmtBalance(month.saldoMin),
        unit: month.saldoMin === null ? undefined : "h",
        explanation: [
          locked ? "Bestätigt · Monat abgeschlossen" : "Prognose · Monat offen",
          month.rosterIncomplete ? "Dienstplan unvollständig" : null,
          month.extraNote ?? null,
        ]
          .filter(Boolean)
          .join(" · "),
        testId: "zeiten-kpi-saldo",
      };

  const pauses: KpiItem = {
    label: "Pausen",
    value: fmtMin(breakMinutes),
    unit: "h",
    explanation:
      findingDays === null
        ? cutoff
        : findingDays === 0
          ? "keine ArbZG-Hinweise"
          : findingDays === 1
            ? "1 Tag mit ArbZG-Hinweis"
            : `${findingDays} Tage mit ArbZG-Hinweis`,
    testId: "zeiten-kpi-breaks",
  };

  return [worked, saldo, pauses];
}

/** The status cell: closed or open, and who closes it (a person never closes their own month). */
export function zeitenStatus(locked: boolean): {
  label: string;
  tone: "ok" | "info";
  explanation: string;
} {
  return locked
    ? { label: "Abgeschlossen", tone: "ok", explanation: "Werte sind final" }
    : { label: "Offen", tone: "info", explanation: "Abschluss durch die Salonleitung" };
}
