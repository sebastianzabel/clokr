/** What a person is supposed to do on a day: the contract plan or the roster. Pure and seeded. */
import type { PersonSpec } from "../plan";
import type { Rng } from "../rng";
import { addDays, weekdayOf } from "../tz";
import type { LeaveRecord, ShiftRecord } from "./context";

export interface PlannedDay {
  /** Wall clock start/end, tenant-local "HH:MM". */
  start: string;
  end: string;
  /** Paid break in minutes the person takes (a long day without one is an intended violation). */
  breakMinutes: number;
  salonIndex: number;
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const minutesToHhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** True when the person is on leave (requested or granted) or at school that day. */
export function blockedDay(
  person: PersonSpec,
  day: string,
  leave: readonly LeaveRecord[],
): "LEAVE" | "SCHOOL" | null {
  for (const l of leave) {
    if (
      (l.status === "PENDING" ||
        l.status === "APPROVED" ||
        l.status === "CANCELLATION_REQUESTED") &&
      l.start <= day &&
      day <= l.end
    ) {
      return "LEAVE";
    }
  }
  if (person.schoolDay !== null && weekdayOf(day) === person.schoolDay) return "SCHOOL";
  return null;
}

/** The planned working day, or null when the person does not work that day. */
export function plannedDay(
  person: PersonSpec,
  day: string,
  shift: ShiftRecord | undefined,
  rng: Rng,
): PlannedDay | null {
  const weekday = weekdayOf(day);
  if (person.scheduleType === "SHIFT_BASED") {
    if (!shift) return null;
    return {
      start: shift.start,
      end: shift.end,
      breakMinutes: toMinutes(shift.end) - toMinutes(shift.start) > 360 ? 30 : 0,
      salonIndex: shift.salonIndex,
    };
  }
  if (!person.workDays.includes(weekday)) return null;
  if (person.scheduleType === "MONTHLY_HOURS") {
    const start = rng.pick(["09:00", "10:00", "13:00"]);
    return {
      start,
      end: minutesToHhmm(toMinutes(start) + 255),
      breakMinutes: 0,
      salonIndex: person.homeSalonIndex,
    };
  }
  if (person.scheduleType === "FLEXTIME") {
    const start = minutesToHhmm(rng.int(7 * 60 + 30, 10 * 60));
    return {
      start,
      end: minutesToHhmm(toMinutes(start) + 462 + 30),
      breakMinutes: 30,
      salonIndex: person.homeSalonIndex,
    };
  }
  const dailyMinutes = Math.round((person.weeklyHours / person.workDays.length) * 60);
  const lengthWithBreak = dailyMinutes + (dailyMinutes > 360 ? 30 : 0);
  return {
    start: "09:00",
    end: minutesToHhmm(toMinutes("09:00") + lengthWithBreak),
    breakMinutes: dailyMinutes > 360 ? 30 : 0,
    salonIndex: person.homeSalonIndex,
  };
}

/** A shift week for a SHIFT_BASED person: their usual days, a start time and a salon per day. */
export function rosterFor(
  person: PersonSpec,
  from: string,
  to: string,
  rng: (day: string) => Rng,
): Record<string, ShiftRecord> {
  const result: Record<string, ShiftRecord> = {};
  for (let day = from; day <= to; day = addDays(day, 1)) {
    if (!(person.usualWorkDays ?? person.workDays).includes(weekdayOf(day))) continue;
    const r = rng(day);
    const start = r.pick(["09:00", "10:00", "10:30"]);
    const salons = [person.homeSalonIndex, ...person.extraSalonIndexes];
    result[day] = {
      start,
      end: minutesToHhmm(toMinutes(start) + 8 * 60),
      salonIndex: r.pick(salons),
    };
  }
  return result;
}
