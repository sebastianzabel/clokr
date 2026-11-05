/**
 * Pure German labels and figure lines of the deactivate dialog (Issue #615, D-13).
 * No date arithmetic and no figure of its own: every day and number arrives from the server's
 * preview; this module only words it. Control values (action, reason, type code) are mapped by
 * code, never by a display string.
 */
import type {
  AbsenceCounts,
  DeactivatePreview,
  PreviewAbsence,
  PreviewAction,
} from "$lib/api/deactivate-preview";
import { LEAVE_TYPES } from "$lib/leave/team-calendar-visibility";
import { fmtBalance } from "$lib/utils/format-minutes";
import { fmtDateDe, fmtDaysDe } from "$lib/reports/period-format";

/** The day the date field starts on: the stored exit date when it is not in the future, else today. */
export function initialExitDay(preview: Pick<DeactivatePreview, "today" | "storedExitDate">) {
  const stored = preview.storedExitDate;
  // ISO calendar days compare correctly as strings; both values are the server's.
  return stored !== null && stored <= preview.today ? stored : preview.today;
}

// Imposed absence types (Absence.type) next to the request types of LEAVE_TYPES.
const IMPOSED_TYPE_LABELS: Record<string, string> = {
  VOCATIONAL_SCHOOL: "Berufsschule",
  OTHER: "Sonstige Abwesenheit",
};

export function absenceTypeLabel(code: string): string {
  const imposed = IMPOSED_TYPE_LABELS[code];
  if (imposed) return imposed;
  return LEAVE_TYPES.find((t) => t.code === code)?.label ?? "Abwesenheit";
}

const SKIP_REASON_TEXTS: Record<string, string> = {
  CLOSED_MONTH: "Der Monat ist bereits abgeschlossen.",
  PARENTAL_REDUCTION_ACTIVE: "Es läuft eine Elternzeit-Kürzung (§ 17 BEEG).",
  CORRECTION_REFUSED: "Die Korrektur wird vom System abgelehnt.",
  SPANNING_ABSENCE: "Die Abwesenheit reicht über den letzten Arbeitstag hinaus.",
};

const SKIP_REASON_FALLBACK = "Der Eintrag kann nicht automatisch angepasst werden.";

export function skipReasonText(reason: string): string {
  return SKIP_REASON_TEXTS[reason] ?? SKIP_REASON_FALLBACK;
}

const ACTION_TEXTS: Record<Exclude<PreviewAction, "SHORTEN">, string> = {
  CANCEL: "wird storniert",
  DELETE: "entfällt",
  SKIP: "bleibt unverändert",
};

export function absenceActionText(row: PreviewAbsence): string {
  if (row.action === "SHORTEN") {
    const end = row.newEndDate ? ` (${fmtDateDe(row.newEndDate)})` : "";
    return `wird auf den letzten Arbeitstag${end} gekürzt`;
  }
  return ACTION_TEXTS[row.action];
}

export function absencePeriodText(row: Pick<PreviewAbsence, "startDate" | "endDate">): string {
  return `${fmtDateDe(row.startDate)} – ${fmtDateDe(row.endDate)}`;
}

/** Review WR-02: the figure is the live saldo, not the saldo after the exit. */
export const SALDO_LABEL = "Aktueller Saldo";
export const SALDO_FINAL_NOTE =
  "Der Endsaldo steht mit dem Monatsabschluss des Austrittsmonats fest.";

const SALDO_UNAVAILABLE: Record<string, string> = {
  NO_PERMISSION: "Das Saldo kannst du mit deinen Rechten nicht einsehen.",
  NOT_TRACKED: "Für diese Person wird kein Saldo geführt.",
  UNAVAILABLE: "Das Saldo ist gerade nicht verfügbar.",
};

export function saldoLine(p: Pick<DeactivatePreview, "saldo" | "saldoUnavailableReason">): string {
  if (p.saldo) {
    return `${fmtBalance(p.saldo.balanceMinutes)} h (Stand gestern, ${fmtDateDe(p.saldo.asOf)})`;
  }
  return (
    SALDO_UNAVAILABLE[p.saldoUnavailableReason ?? "UNAVAILABLE"] ?? SALDO_UNAVAILABLE.UNAVAILABLE
  );
}

const VACATION_UNAVAILABLE: Record<string, string> = {
  NO_PERMISSION: "Den Resturlaub kannst du mit deinen Rechten nicht einsehen.",
  NO_ENTITLEMENT: "Für das Austrittsjahr ist kein Urlaubsanspruch hinterlegt.",
};

/** One or two lines: the Resturlaub of the exit year and, when it changes, the § 5 note. */
export function vacationLines(
  p: Pick<DeactivatePreview, "vacation" | "vacationUnavailableReason">,
): string[] {
  const v = p.vacation;
  if (!v) {
    // EXIT_DATE_REFUSED shows nothing extra: the refusal itself is shown.
    return p.vacationUnavailableReason && VACATION_UNAVAILABLE[p.vacationUnavailableReason]
      ? [VACATION_UNAVAILABLE[p.vacationUnavailableReason]]
      : [];
  }
  const lines: string[] = [];
  if (v.remainingAtExitDays < 0) {
    lines.push(
      `${fmtDaysDe(Math.abs(v.remainingAtExitDays))} Tage mehr genommen als der Anspruch im Austrittsjahr ${v.year}`,
    );
  } else {
    lines.push(`${fmtDaysDe(v.remainingAtExitDays)} Tage Resturlaub im Austrittsjahr ${v.year}`);
  }
  if (v.entitlementRecomputed) {
    lines.push(
      `Der Anspruch ${v.year} wird nach § 5 BUrlG auf ${fmtDaysDe(v.entitlementDays)} Tage neu berechnet.`,
    );
  }
  return lines;
}

/**
 * Review WR-03: a caller without the leave right gets only the counts per action. One calm line,
 * or `null` when the plan touches nothing.
 */
export function absenceCountsLine(counts: AbsenceCounts | null): string | null {
  if (counts === null) return null;
  const ends = counts.CANCEL + counts.SHORTEN + counts.DELETE;
  const parts: string[] = [];
  if (ends > 0) {
    parts.push(
      ends === 1
        ? "1 Abwesenheit endet oder wird gekürzt"
        : `${ends} Abwesenheiten enden oder werden gekürzt`,
    );
  }
  if (counts.SKIP > 0) {
    parts.push(
      counts.SKIP === 1
        ? "1 Abwesenheit bleibt unverändert"
        : `${counts.SKIP} Abwesenheiten bleiben unverändert`,
    );
  }
  if (parts.length === 0) return null;
  return `${parts.join(", ")}. Einzelheiten siehst du mit deinen Rechten nicht.`;
}
