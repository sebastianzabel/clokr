// Issue #435 (D-11/D-12) — DISPLAY-ONLY mirror of the API's `statutoryMinimumVacationDays`
// (apps/api/src/contexts/absence/vacation-calc.ts), used only for the create-form pre-fill
// (D-11) and the "Geburtsdatum fehlt" hint (D-12). The server's 400 (plan 03, D-10/D-11) is the
// authoritative check — this helper exists so the UI can suggest and warn BEFORE a save round
// trip, never to replace the server decision. Keep the two tables in sync (age bands, Werktage,
// the 5-day conversion) if either one changes.
//
// No imports — this file stays a zero-dependency leaf so it can be used from any page/component
// without pulling in API-only code.

/** Shown in the create dialog, the employee list and the edit form when an AZUBI has no
 *  birth date on file — the legal minimum cannot be checked without it (never blocks saving). */
export const MISSING_BIRTH_DATE_HINT =
  "Geburtsdatum fehlt – Mindesturlaub nach JArbSchG kann nicht geprüft werden";

interface IsoDateParts {
  year: number;
  month: number; // 1-12
  day: number;
}

/**
 * Parses the first 10 characters of an ISO date/datetime string as `YYYY-MM-DD` into plain
 * numbers — never `new Date(string)`, which parses a bare date string in LOCAL time and can
 * shift the calendar day depending on the runtime's timezone.
 */
function parseIsoDateParts(value: string): IsoDateParts | null {
  const slice = value.slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(slice);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/**
 * Age on 1 January of `year`, mirroring the server's `ageAtDate` (§ 187 Abs. 2 S. 2 BGB — a
 * birthday EXACTLY on the reference date counts the new age). Since the reference date is
 * always 1 January, the "has the birthday already passed" check collapses to "is the birth date
 * itself 1 January" — any other birth month/day means the birthday has NOT yet occurred this
 * calendar year, so one year is subtracted.
 */
function ageOnFirstOfJanuary(birth: IsoDateParts, year: number): number {
  const isJanuaryFirst = birth.month === 1 && birth.day === 1;
  return year - birth.year - (isJanuaryFirst ? 0 : 1);
}

/**
 * The statutory-minimum vacation entitlement at a 5-day week (Issue #435, D-11/D-12), mirroring
 * `statutoryMinimumVacationDays(birthDate, year, 5)` on the server:
 *
 * - age < 16 on 1 January of `year` -> 30 Werktage (§ 19 Abs. 2 Nr. 1 JArbSchG)
 * - age < 17 -> 27 Werktage (§ 19 Abs. 2 Nr. 2 JArbSchG)
 * - age < 18 -> 25 Werktage (§ 19 Abs. 2 Nr. 3 JArbSchG)
 * - else (or `birthDate` null/unparseable) -> 24 Werktage (§ 3 Abs. 1 BUrlG)
 *
 * Werktage (a 6-day reference week) converted to a 5-day week: `round(werktage / 6 * 5, 2)`.
 *
 * @param birthDate - ISO date or datetime string, or `null` (fail-open to the adult minimum)
 * @param year - the calendar year the minimum is computed for (age is evaluated at 1 January)
 */
export function statutoryMinimumFiveDayWeek(
  birthDate: string | null,
  year: number,
): { days: number; law: "§ 19 JArbSchG" | "§ 3 BUrlG" } {
  const parsed = birthDate !== null ? parseIsoDateParts(birthDate) : null;

  let werktage = 24; // § 3 Abs. 1 BUrlG — adult default, also the null/unparseable fail-open
  let isMinor = false;
  if (parsed !== null) {
    const age = ageOnFirstOfJanuary(parsed, year);
    if (age < 16) {
      werktage = 30;
      isMinor = true;
    } else if (age < 17) {
      werktage = 27;
      isMinor = true;
    } else if (age < 18) {
      werktage = 25;
      isMinor = true;
    }
  }

  const days = Math.round((werktage / 6) * 5 * 100) / 100;
  const law = isMinor ? "§ 19 JArbSchG" : "§ 3 BUrlG";
  return { days, law };
}
