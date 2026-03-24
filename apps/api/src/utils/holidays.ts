/**
 * Deutsche Feiertage – kalkulierbar für jedes Jahr.
 *
 * Ostern basiert auf dem Gauss-Algorithmus.
 * Alle anderen beweglichen Feiertage leiten sich von Ostern ab.
 * Feste Feiertage haben immer denselben Kalender-Tag.
 */

export type FederalStateCode =
  | "BB" | "BE" | "BW" | "BY" | "HB" | "HE" | "HH"
  | "MV" | "NI" | "NW" | "RP" | "SH" | "SL" | "SN" | "ST" | "TH";

/** Prisma FederalState-Enum → 2-Buchstaben-Code */
export const STATE_MAP: Record<string, FederalStateCode> = {
  NIEDERSACHSEN:          "NI",
  BAYERN:                 "BY",
  BERLIN:                 "BE",
  BRANDENBURG:            "BB",
  BREMEN:                 "HB",
  HAMBURG:                "HH",
  HESSEN:                 "HE",
  MECKLENBURG_VORPOMMERN: "MV",
  NORDRHEIN_WESTFALEN:    "NW",
  RHEINLAND_PFALZ:        "RP",
  SAARLAND:               "SL",
  SACHSEN:                "SN",
  SACHSEN_ANHALT:         "ST",
  SCHLESWIG_HOLSTEIN:     "SH",
  THUERINGEN:             "TH",
  BADEN_WUERTTEMBERG:     "BW",
};

export interface HolidayDef {
  date: string;   // "YYYY-MM-DD"
  name: string;
  isNational: boolean;
  states?: FederalStateCode[];   // leer = alle Länder
}

/** Gauss-Algorithmus für den Ostersonntag */
function easter(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day   = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function fmt(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Gibt alle Feiertage für ein Jahr + Bundesland zurück.
 * Bundesland = null  →  nur nationale Feiertage.
 */
export function getHolidays(year: number, state?: FederalStateCode | null): HolidayDef[] {
  const e = easter(year);
  const holidays: HolidayDef[] = [
    // ── Nationale Feiertage (§ 1 FZG / Länderkataloge) ────────────────
    { date: `${year}-01-01`, name: "Neujahr",                    isNational: true },
    { date: fmt(addDays(e, -2)), name: "Karfreitag",             isNational: true },
    { date: fmt(e),              name: "Ostersonntag",            isNational: false,
      states: ["BB"] },
    { date: fmt(addDays(e, 1)),  name: "Ostermontag",            isNational: true },
    { date: `${year}-05-01`,     name: "Tag der Arbeit",         isNational: true },
    { date: fmt(addDays(e, 39)), name: "Christi Himmelfahrt",    isNational: true },
    { date: fmt(addDays(e, 49)), name: "Pfingstsonntag",          isNational: false,
      states: ["BB"] },
    { date: fmt(addDays(e, 50)), name: "Pfingstmontag",          isNational: true },
    { date: `${year}-10-03`,     name: "Tag der Deutschen Einheit", isNational: true },
    { date: `${year}-12-25`,     name: "1. Weihnachtstag",       isNational: true },
    { date: `${year}-12-26`,     name: "2. Weihnachtstag",       isNational: true },

    // ── Länderspezifische Feiertage ────────────────────────────────────
    { date: `${year}-01-06`,     name: "Heilige Drei Könige",    isNational: false,
      states: ["BW", "BY", "ST"] },
    { date: `${year}-03-08`,     name: "Internationaler Frauentag", isNational: false,
      states: ["BE", "MV"] },
    { date: fmt(addDays(e, 60)), name: "Fronleichnam",           isNational: false,
      states: ["BW", "BY", "HE", "NW", "RP", "SL", "SN", "TH"] },
    { date: `${year}-08-15`,     name: "Mariä Himmelfahrt",      isNational: false,
      states: ["BY", "SL"] },
    { date: `${year}-09-20`,     name: "Weltkindertag",          isNational: false,
      states: ["TH"] },
    { date: `${year}-10-31`,     name: "Reformationstag",        isNational: false,
      states: ["BB", "HB", "HH", "MV", "NI", "SN", "ST", "SH", "TH"] },
    { date: `${year}-11-01`,     name: "Allerheiligen",          isNational: false,
      states: ["BW", "BY", "NW", "RP", "SL"] },
    ...(year >= 2019
      ? [{ date: `${year}-11-${year === 2019 ? "18" : "??"}`, name: "Buß- und Bettag", isNational: false,
           states: ["SN"] as FederalStateCode[] }]
      : []),
  ];

  // Buß- und Bettag: Mittwoch vor dem 23. November
  const bussUndBettag = (() => {
    const nov23 = new Date(year, 10, 23);
    const dow = nov23.getDay(); // 0=So
    const diff = dow === 0 ? -4 : dow === 1 ? -5 : dow === 2 ? -6 : dow === 3 ? 0 : -(dow - 3);
    return addDays(nov23, diff);
  })();
  holidays.push({
    date: fmt(bussUndBettag),
    name: "Buß- und Bettag",
    isNational: false,
    states: ["SN"],
  });

  if (!state) {
    return holidays.filter(h => h.isNational);
  }

  return holidays.filter(h => h.isNational || (h.states?.includes(state) ?? false));
}
