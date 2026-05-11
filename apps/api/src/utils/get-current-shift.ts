/**
 * Looks up the employee's scheduled Shift for the calendar date corresponding to `at`
 * in the given tenant timezone, and converts the HH:MM string times to UTC Date objects.
 *
 * Returns null if no Shift is scheduled for that date.
 */
import { fromZonedTime } from "date-fns-tz";
import type { PrismaClient } from "@clokr/db";
import { dateStrInTz } from "./timezone";

export interface ShiftWindow {
  shift: {
    id: string;
    startTime: string; // "HH:MM" — the raw DB string
    endTime: string; // "HH:MM" — the raw DB string
  };
  startUtc: Date; // shift start converted to UTC
  endUtc: Date; // shift end converted to UTC
}

export async function getCurrentShift(
  prisma: PrismaClient,
  employeeId: string,
  at: Date,
  tz: string,
): Promise<ShiftWindow | null> {
  // Determine which calendar date `at` represents in the tenant timezone
  const dateStr = dateStrInTz(at, tz); // "YYYY-MM-DD"
  const dateForQuery = new Date(dateStr + "T00:00:00Z");

  const shift = await prisma.shift.findFirst({
    where: { employeeId, date: dateForQuery },
    select: { id: true, startTime: true, endTime: true },
  });

  if (!shift) return null;

  // Parse "HH:MM" into hours and minutes
  const [startH, startM] = shift.startTime.split(":").map(Number);
  const [endH, endM] = shift.endTime.split(":").map(Number);

  // Build a "local" Date object (the wall-clock time on that date in the tenant TZ)
  // then convert to UTC using date-fns-tz fromZonedTime
  const [year, month, day] = dateStr.split("-").map(Number);

  const startLocal = new Date(year, month - 1, day, startH, startM, 0, 0);
  const startUtc = fromZonedTime(startLocal, tz);

  // For overnight shifts (endTime < startTime numerically), endTime is on the next day
  let endDay = day;
  if (endH < startH || (endH === startH && endM <= startM)) {
    endDay = day + 1;
  }
  const endLocal = new Date(year, month - 1, endDay, endH, endM, 0, 0);
  const endUtc = fromZonedTime(endLocal, tz);

  return { shift, startUtc, endUtc };
}
