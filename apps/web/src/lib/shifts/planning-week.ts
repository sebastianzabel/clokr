// Issue #849 (3) — the week of the "Planungsbedarf" page.
//
// `mondayOfWeek` used to take the LOCAL weekday but serialise with `toISOString()` (UTC), so on a
// Monday before 01:00 Berlin time it returned the previous Sunday, and the label printed the raw
// ISO pair "Woche 2026-11-08 – 2026-11-08". Both helpers work on calendar-day strings only.
// Issue #850 — the label is "KW 46 · 9.–15. Nov." (week number, short German days).

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** The Monday of `d`'s LOCAL calendar week as `YYYY-MM-DD` (built from local parts, never UTC). */
export function mondayOfWeek(d: Date): string {
  const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = copy.getDay();
  copy.setDate(copy.getDate() + (dow === 0 ? -6 : 1 - dow));
  return `${copy.getFullYear()}-${pad(copy.getMonth() + 1)}-${pad(copy.getDate())}`;
}

/** German month abbreviations as Duden writes them (short months stay whole). */
const MONTHS = [
  "Jan.",
  "Feb.",
  "März",
  "Apr.",
  "Mai",
  "Juni",
  "Juli",
  "Aug.",
  "Sept.",
  "Okt.",
  "Nov.",
  "Dez.",
];

function parts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}

/** ISO 8601 week number of a calendar day (the week of its Thursday). Pure calendar arithmetic. */
export function isoWeekNumber(iso: string): number {
  const { y, m, d } = parts(iso);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = date.getUTCDay() || 7; // Mo=1..So=7
  date.setUTCDate(date.getUTCDate() + 4 - dow); // the Thursday of this week
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

/** A short German day: "9. Nov.", with the year when asked for. */
export function shortGermanDay(iso: string, withYear = false): string {
  const { y, m, d } = parts(iso);
  return `${d}. ${MONTHS[m - 1]}${withYear ? ` ${y}` : ""}`;
}

/**
 * Issue #850 — "KW 46 · 9.–15. Nov.": the week number and the two days, never an ISO date and
 * never the same date twice. Across a month "28. Okt.–3. Nov.", across a year with both years.
 * Without an end only the start ("KW 46 · ab 9. Nov.").
 */
export function planningWeekLabel(weekStart: string, weekEnd: string): string {
  const kw = `KW ${isoWeekNumber(weekStart)}`;
  if (!weekEnd || weekEnd === weekStart) {
    return weekEnd
      ? `${kw} · ${shortGermanDay(weekStart)}`
      : `${kw} · ab ${shortGermanDay(weekStart)}`;
  }
  const a = parts(weekStart);
  const b = parts(weekEnd);
  if (a.y !== b.y)
    return `${kw} · ${shortGermanDay(weekStart, true)}–${shortGermanDay(weekEnd, true)}`;
  if (a.m !== b.m) return `${kw} · ${shortGermanDay(weekStart)}–${shortGermanDay(weekEnd)}`;
  return `${kw} · ${a.d}.–${shortGermanDay(weekEnd)}`;
}
