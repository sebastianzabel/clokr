// Issue #849 (3) — the week of the "Planungsbedarf" page.
//
// `mondayOfWeek` used to take the LOCAL weekday but serialise with `toISOString()` (UTC), so on a
// Monday before 01:00 Berlin time it returned the previous Sunday, and the label printed the raw
// ISO pair "Woche 2026-11-08 – 2026-11-08". Both helpers work on calendar-day strings only.

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

function germanDay(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

/** "Woche 09.11.2026 – 15.11.2026"; without an end only the start. */
export function planningWeekLabel(weekStart: string, weekEnd: string): string {
  return weekEnd
    ? `Woche ${germanDay(weekStart)} – ${germanDay(weekEnd)}`
    : `Woche ${germanDay(weekStart)}`;
}
