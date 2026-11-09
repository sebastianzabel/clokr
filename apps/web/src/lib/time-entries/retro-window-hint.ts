// Issue #849 (5) — the time-entry form names the self-service window up front.
//
// The tenant setting `retroEntryWindowDays` (default 10, served by GET /settings/work) decides how
// far back a person may record or change their own time without approval; the API refuses older
// days with RETRO_WINDOW_EXCEEDED (entry-invariants.ts). The form used to learn the window only from
// that refusal. The earliest day mirrors computeRetroLimitStr(): today − windowDays, inclusive.

function germanDay(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

/** `YYYY-MM-DD` of `todayIso` minus `days` calendar days (pure string-day arithmetic in UTC). */
export function earliestRetroDay(todayIso: string, days: number): string {
  const d = new Date(`${todayIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** The hint text, or null when the window is unknown (settings not loaded). */
export function retroWindowHint(
  windowDays: number | null | undefined,
  todayIso: string,
): string | null {
  if (
    windowDays === null ||
    windowDays === undefined ||
    !Number.isFinite(windowDays) ||
    windowDays < 0
  ) {
    return null;
  }
  const earliest = germanDay(earliestRetroDay(todayIso, windowDays));
  if (windowDays === 0) {
    return "Nachträge ohne Genehmigung sind nur für heute möglich. Für frühere Tage stellst du einen Antrag.";
  }
  const unit = windowDays === 1 ? "Tag" : "Tage";
  return `Nachträge sind bis zu ${windowDays} ${unit} rückwirkend ohne Genehmigung möglich (ab ${earliest}). Für frühere Tage stellst du einen Antrag.`;
}
