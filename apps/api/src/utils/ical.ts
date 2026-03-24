// ── iCalendar (RFC 5545) Generator ──────────────────────────────────────────

export interface ICalEvent {
  uid: string;
  summary: string;
  dtstart: string; // YYYY-MM-DD (all-day event)
  dtend: string;   // YYYY-MM-DD (exclusive end, so +1 day)
  description?: string;
  status?: string;
  categories?: string;
}

export function generateICal(calName: string, events: ICalEvent[]): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Clokr//Time Tracking//DE",
    `X-WR-CALNAME:${calName}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];

  for (const ev of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${ev.uid}`);
    lines.push(`DTSTART;VALUE=DATE:${ev.dtstart.replace(/-/g, "")}`);
    lines.push(`DTEND;VALUE=DATE:${ev.dtend.replace(/-/g, "")}`);
    lines.push(`SUMMARY:${escapeIcal(ev.summary)}`);
    if (ev.description) lines.push(`DESCRIPTION:${escapeIcal(ev.description)}`);
    if (ev.status) lines.push(`STATUS:${ev.status}`);
    if (ev.categories) lines.push(`CATEGORIES:${ev.categories}`);
    lines.push(`DTSTAMP:${formatIcalDate(new Date())}`);
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

function escapeIcal(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function formatIcalDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * Add one day to a YYYY-MM-DD string (iCal DTEND for all-day events is exclusive)
 */
export function addOneDay(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split("T")[0];
}
