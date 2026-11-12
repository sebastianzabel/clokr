// Issue #854 (D-854-08) - the ONE place the Minijob limit lives. It is an advisory hint for the
// create flow and the contract tab: a person classified as Minijob whose planned hours would, at the
// minimum wage, earn more than the monthly limit gets a warning BEFORE the contract is saved. It is
// never a block and never a rule of the API - § 8 SGB IV allows an occasional exceedance, and the
// real earning depends on a wage Clokr does not store.

/** One row per year; only a verified year may be added (a guessed row would be a wrong legal figure). */
export interface MinijobLimit {
  /** Monthly earning limit of a Minijob in euro. */
  monthlyEuro: number;
  /** Statutory minimum wage per hour in euro that year. */
  minimumWageEuro: number;
}

/**
 * Minijob-Grenze and Mindestlohn by calendar year.
 *
 * 2026: 603 EUR a month at 13,90 EUR an hour - § 8 Abs. 1a SGB IV (limit = minimum wage x 130 / 3,
 * rounded up to full euro) and the Mindestlohngesetz (MiLoG); Deutsche Rentenversicherung press
 * release of 22.12.2025 ("Minijob-Verdienstgrenze steigt 2026 auf 603 Euro").
 *
 * A 2027 row is deliberately absent: its figures (633 EUR / 14,60 EUR) are only known from a
 * secondary source. Add it with a primary source; until then a later year uses the latest row.
 */
export const MINIJOB_LIMITS: Readonly<Record<number, MinijobLimit>> = {
  2026: { monthlyEuro: 603, minimumWageEuro: 13.9 },
};

/** The row for the calendar year of `validFrom` (ISO day): the latest row at or before it, else the earliest. */
export function minijobLimitFor(validFrom: string | null | undefined): MinijobLimit {
  const years = Object.keys(MINIJOB_LIMITS)
    .map(Number)
    .sort((a, b) => a - b);
  const year = /^\d{4}/.test(validFrom ?? "") ? Number((validFrom as string).slice(0, 4)) : null;
  const chosen =
    year === null ? years[years.length - 1] : (years.filter((y) => y <= year).pop() ?? years[0]);
  return MINIJOB_LIMITS[chosen];
}

export interface MinijobHintInput {
  classification: string;
  scheduleType: "FIXED_SCHEDULE" | "FLEXTIME" | "MONTHLY_HOURS" | "SHIFT_BASED";
  weeklyHours: number | null;
  monthlyHours: number | null;
  /** First day of the contract, ISO; picks the limit row. */
  validFrom: string | null;
}

export interface MinijobHint {
  /** Planned hours per month, one decimal (display). */
  plannedMonthlyHours: number;
  /** The hours per month the limit allows at the minimum wage, one decimal (display). */
  limitHours: number;
  limitEuro: number;
  minimumWageEuro: number;
}

const WEEKS_PER_MONTH = 52 / 12;

function oneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

/** `null` = nothing to warn about. The comparison uses the unrounded figures. */
export function minijobHint(input: MinijobHintInput): MinijobHint | null {
  if (input.classification !== "MINIJOB") return null;
  const hours = input.scheduleType === "MONTHLY_HOURS" ? input.monthlyHours : input.weeklyHours;
  if (hours === null || !Number.isFinite(hours) || hours <= 0) return null;

  const planned = input.scheduleType === "MONTHLY_HOURS" ? hours : hours * WEEKS_PER_MONTH;
  const limit = minijobLimitFor(input.validFrom);
  const limitHours = limit.monthlyEuro / limit.minimumWageEuro;
  if (planned <= limitHours) return null;

  return {
    plannedMonthlyHours: oneDecimal(planned),
    limitHours: oneDecimal(limitHours),
    limitEuro: limit.monthlyEuro,
    minimumWageEuro: limit.minimumWageEuro,
  };
}

/** The advisory sentence of the Note; the tone is a prompt to check, not a finding. */
export function minijobHintText(hint: MinijobHint): string {
  const fmt = (n: number) => n.toLocaleString("de-DE", { maximumFractionDigits: 1 });
  return (
    `Prüfe die Minijob-Grenze: ${fmt(hint.plannedMonthlyHours)} Stunden im Monat liegen über ` +
    `${fmt(hint.limitHours)} Stunden (${hint.limitEuro.toLocaleString("de-DE")} € bei ` +
    `${hint.minimumWageEuro.toLocaleString("de-DE", { minimumFractionDigits: 2 })} € Mindestlohn). ` +
    `Gelegentliches Überschreiten ist erlaubt. Du kannst die Person trotzdem anlegen.`
  );
}
