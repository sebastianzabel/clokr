// Issue #853 (D-853-18) - the figures of Team › Zeiten as Kennzahlenleiste cells. The page used to
// show them in two cards (MonatSaldoCard and KontoSaldoCard); the strip shows exactly the same
// values with exactly the same wording. This module only SELECTS and FORMATS what the page already
// holds: it computes no Soll, no saldo and no forecast of its own.
//
//  - every number is a minute count the page took from the server's answers (or, for the running
//    month, from the entries the server returned for the caller's scope) and is formatted with the
//    helpers the cards use (`fmtMin`, `fmtBalance`);
//  - the forecast wording comes from `forecastCaption()` of `lib/saldo/forecast-label.ts`, the one
//    place that wording is chosen (Issue #588); this file never spells it;
//  - where a card derives a string inline (micro label, context lines, status line) the same string
//    is derived here; `__tests__/zeiten-kpis-parity-853.test.ts` mounts the UNCHANGED cards and
//    pins the equality, so a drift on either side turns that test red.
//
// A refused saldo read arrives as `noSollTarget: true` (see `istOnlyMonthMetrics`): the strip then
// shows the Ist hours and no Soll, exactly like the card's no-Soll rendering (#85, #495).
//
// Pure: no Svelte, no request, no store, no clock.
import { fmtBalance, fmtMin } from "$lib/utils/format-minutes";
import { forecastCaption } from "$lib/saldo/forecast-label"; // Issue #588

/** A cell of the strip. Structurally the `KpiItem` of `KpiStrip.svelte`. */
export interface ZeitenKpiItem {
  label: string;
  value: string;
  unit?: string;
  explanation?: string;
  delta?: string;
  deltaTone?: "good" | "bad" | "warn" | "neutral";
  progress?: { value: number; max: number; label?: string };
  testId?: string;
}

/** The props the page hands to MonatSaldoCard today (minus the display state). */
export interface MonthKpiInput {
  sollToDateMin: number;
  istMin: number;
  /** null = no WorkSchedule (when `noSollTarget` is false). */
  saldoMin: number | null;
  /** True when there is no Soll to compare against (MONTHLY_HOURS without monthly hours, or a refused saldo read). */
  noSollTarget: boolean;
  sollLabel: string;
  workdaysSoFar: number | null;
  runningCount: number;
  isLocked: boolean;
}

/** The "N Arbeitstage bisher · M läuft" line, or the running count alone, or nothing. */
function workdaysLine(workdaysSoFar: number | null, runningCount: number): string | undefined {
  if (workdaysSoFar !== null) {
    return runningCount > 0
      ? `${workdaysSoFar} Arbeitstage bisher · ${runningCount} läuft`
      : `${workdaysSoFar} Arbeitstage bisher`;
  }
  return runningCount > 0 ? `${runningCount} läuft` : undefined;
}

/**
 * The month cells: „Gearbeitet“ (Ist against the Soll to date; absent without a Soll), the month saldo
 * (or, without a Soll, the month's hours) and „Status“ of the Monatsabschluss.
 */
export function monthKpiItems(input: MonthKpiInput): ZeitenKpiItem[] {
  const { sollToDateMin, istMin, saldoMin, noSollTarget, sollLabel, isLocked } = input;
  const items: ZeitenKpiItem[] = [];

  if (!noSollTarget) {
    const hasSoll = sollToDateMin > 0;
    // The mid label of the card's Soll/Ist bar: the difference of two server figures, shown as words.
    const diffMin = Math.abs(istMin - sollToDateMin);
    const midLabel =
      istMin === sollToDateMin
        ? "ausgeglichen"
        : istMin < sollToDateMin
          ? `fehlen ${fmtMin(diffMin)} h`
          : `+${fmtMin(diffMin)} h mehr`;
    items.push({
      label: "Gearbeitet",
      value: fmtMin(istMin),
      unit: "h",
      explanation: hasSoll
        ? `${sollLabel} ${fmtMin(sollToDateMin)} h · Ist ${fmtMin(istMin)} h erfüllt`
        : "noch keine Sollzeit in diesem Monat",
      progress: hasSoll ? { value: istMin, max: sollToDateMin, label: midLabel } : undefined,
      testId: "zeiten-kpi-gearbeitet",
    });
  }

  // "Prognose" describes a saldo forecast; a plain hour count is only provisional.
  const label = noSollTarget
    ? isLocked
      ? "Monatsstunden (Bestätigt)"
      : "Monatsstunden (Vorläufig)"
    : isLocked
      ? "Monat-Saldo (Bestätigt)"
      : "Monat-Saldo (Prognose)";
  // No arithmetic: without Soll the figure is the Ist minutes, otherwise the server's saldo.
  const value = noSollTarget
    ? `${fmtMin(istMin)} h`
    : saldoMin === null
      ? "—"
      : fmtBalance(saldoMin);
  items.push({
    label,
    value,
    explanation: workdaysLine(input.workdaysSoFar, input.runningCount),
    delta: noSollTarget ? "Zeiterfassung ohne Sollvergleich" : undefined,
    testId: "zeiten-kpi-monatssaldo",
  });

  items.push({
    label: "Status",
    value: isLocked ? "Abgeschlossen" : "Offen",
    explanation: isLocked
      ? "Monat ist abgeschlossen — Werte sind final."
      : "Noch kein Monatsabschluss — Werte sind vorläufig.",
    // Employees cannot close a month, so an open month always says who does.
    delta: isLocked ? undefined : "Abschluss durch die Betriebsleitung",
    testId: "zeiten-kpi-status",
  });

  return items;
}

/** The props the page hands to KontoSaldoCard today (minus the display state). */
export interface KontoKpiInput {
  totalHours: number | null;
  confirmedMinutes?: number;
  openMonthMinutes?: number | null;
  hasClosedMonth?: boolean;
  /** Issue #588 (P-14) - how many calendar months the forecast spans; words the caption. */
  unconfirmedMonths?: number | null;
  rosterIncomplete?: boolean;
}

/**
 * The account cell „Stundenkonto“: the lifetime saldo, the forecast wording of `forecastCaption()` and the
 * confirmed part. The caller renders it only where the overtime read was not refused.
 */
export function kontoKpiItem(input: KontoKpiInput): ZeitenKpiItem {
  const isSplit = input.confirmedMinutes !== undefined;
  const open = input.openMonthMinutes;

  // Issue #291 - the headline is the lifetime total. In split mode it is the two integer-minute
  // parts added (the open part is derived server-side as total - confirmed); outside split mode
  // there are no parts and `totalHours` is used directly.
  const totalMin =
    isSplit && open !== undefined && open !== null
      ? (input.confirmedMinutes ?? 0) + open
      : input.totalHours !== null
        ? Math.round(input.totalHours * 60)
        : null;

  const item: ZeitenKpiItem = {
    label: "Stundenkonto",
    value: totalMin === null ? "—" : fmtBalance(totalMin),
    testId: "zeiten-kpi-konto",
  };
  if (!isSplit) return item;

  const confirmedMin = input.confirmedMinutes ?? 0;
  item.explanation = `${forecastCaption(input.unconfirmedMonths, input.hasClosedMonth)}${
    input.rosterIncomplete ? " · Restmonat unverplant" : ""
  }`;

  // Issue #291 - nothing confirmed while the account is not empty: every minute sits in months that
  // were never closed. The marker leads; it implies the confirmed part (0), which is then not repeated.
  if (confirmedMin === 0 && totalMin !== null && totalMin !== 0) {
    item.delta = "Monatsabschlüsse fehlen · Saldo vollständig unbestätigt";
    item.deltaTone = "warn";
  } else {
    const newHireZero = confirmedMin === 0 && input.hasClosedMonth !== true;
    item.delta = `${newHireZero ? "noch kein Monatsabschluss" : "Bestätigt"} ${fmtBalance(confirmedMin)}`;
  }
  return item;
}
