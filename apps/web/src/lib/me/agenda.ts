// Issue #597 (Phase 851, prototype „Ich › Dienstplan“): the next 14 days as one stream - the own shifts
// (GET /shifts/range, with the shift's own salon), effective leave (the EFFECTIVE_LEAVE_STATUSES mirror)
// and public holidays (GET /holidays of the Stammsalon). Pure: it groups and labels, no rule of its own.
import { isEffectiveLeaveStatus } from "$lib/leave/effective-leave-statuses";

export interface AgendaShift {
  date: string;
  startTime: string;
  endTime: string;
  durationMinNetto: number;
  salonId?: string;
}

export interface AgendaLeave {
  startDate: string;
  endDate: string;
  status: string;
  halfDay?: boolean;
  label: string;
}

export interface AgendaHoliday {
  date: string;
  name: string;
}

export type AgendaKind = "shift" | "leave" | "holiday" | "free";

export interface AgendaDay {
  date: string;
  weekday: string;
  dayLabel: string;
  isToday: boolean;
  kind: AgendaKind;
  shifts: AgendaShift[];
  title: string;
  subtitle: string;
  /** Planned net minutes of the day's shifts (for the chip). */
  netMinutes: number;
  /** A shift in a salon other than the Stammsalon. */
  otherSalon: boolean;
}

export interface AgendaWeek {
  label: string;
  days: AgendaDay[];
}

const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** ISO week number of a local date. */
export function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

export function buildAgenda(
  start: Date,
  days: number,
  input: {
    shifts: readonly AgendaShift[];
    leave: readonly AgendaLeave[];
    holidays: readonly AgendaHoliday[];
    homeSalonId: string | null;
    salonName: (id: string | undefined) => string;
  },
): AgendaWeek[] {
  const today = isoDay(start);
  const thisWeek = isoWeek(start);
  const weeks: AgendaWeek[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const date = isoDay(d);
    const shifts = input.shifts.filter((s) => s.date === date);
    const leave = input.leave.find(
      (l) =>
        isEffectiveLeaveStatus(l.status) &&
        l.startDate.slice(0, 10) <= date &&
        l.endDate.slice(0, 10) >= date,
    );
    const holiday = input.holidays.find((h) => h.date.slice(0, 10) === date);
    let kind: AgendaKind = "free";
    let title = "Frei";
    let subtitle = "";
    if (shifts.length > 0) {
      kind = "shift";
      title = shifts.map((s) => `${s.startTime} – ${s.endTime}`).join(" · ");
      subtitle = [...new Set(shifts.map((s) => input.salonName(s.salonId)))].join(" · ");
    }
    if (leave) {
      kind = shifts.length > 0 ? "shift" : "leave";
      if (shifts.length === 0) title = leave.halfDay ? `${leave.label} (halber Tag)` : leave.label;
      else subtitle = `${subtitle} · ${leave.label}`;
    }
    if (holiday && shifts.length === 0) {
      kind = "holiday";
      title = holiday.name;
      subtitle = "Feiertag";
    }
    const week = isoWeek(d);
    const label =
      week === thisWeek
        ? `Diese Woche · KW ${week}`
        : week === thisWeek + 1 || (thisWeek >= 52 && week === 1)
          ? `Nächste Woche · KW ${week}`
          : `KW ${week}`;
    let bucket = weeks[weeks.length - 1];
    if (!bucket || bucket.label !== label) {
      bucket = { label, days: [] };
      weeks.push(bucket);
    }
    bucket.days.push({
      date,
      weekday: WD[d.getDay()],
      dayLabel: `${d.getDate()}.${d.getMonth() + 1}.`,
      isToday: date === today,
      kind,
      shifts,
      title,
      subtitle,
      netMinutes: shifts.reduce((sum, s) => sum + s.durationMinNetto, 0),
      otherSalon:
        input.homeSalonId !== null &&
        shifts.some((s) => s.salonId && s.salonId !== input.homeSalonId),
    });
  }
  return weeks;
}
