import { PrismaClient } from "@clokr/db";
import { getTenantTimezone, dateStrInTz, getDayOfWeekInTz } from "./timezone";

export interface ArbZGWarning {
  code: "BREAK_TOO_SHORT" | "MAX_DAILY_EXCEEDED" | "MAX_WEEKLY_EXCEEDED" | "MIN_REST_VIOLATED";
  severity: "warning" | "error";
  message: string;
}

/**
 * Prüft ArbZG-Konformität für einen Mitarbeiter nach einem geänderten Eintrag.
 * Gibt eine Liste von Warnungen zurück (blockiert NICHT das Speichern).
 */
export async function checkArbZG(
  prisma: PrismaClient,
  employeeId: string,
  changedDate: Date,
): Promise<ArbZGWarning[]> {
  const warnings: ArbZGWarning[] = [];

  // Look up tenant timezone for this employee
  const employee = await prisma.employee.findUniqueOrThrow({
    where: { id: employeeId },
    select: { tenantId: true },
  });
  const tz = await getTenantTimezone(prisma, employee.tenantId);

  const dateStr = dateStrInTz(changedDate, tz);

  // ── 1. Tagessicht: alle abgeschlossenen Slots des Tages ────────────────────
  const daySlots = await prisma.timeEntry.findMany({
    where: {
      employeeId,
      date: { gte: new Date(dateStr), lte: new Date(dateStr + "T23:59:59.999Z") },
      endTime: { not: null },
      type: "WORK",
    },
    orderBy: { startTime: "asc" },
  });

  if (daySlots.length > 0) {
    // Netto-Arbeitszeit + explizite Pausen
    let netWorkedMin = 0;
    let explicitBreakMin = 0;

    for (const slot of daySlots) {
      const slotMin = (slot.endTime!.getTime() - slot.startTime.getTime()) / 60000;
      explicitBreakMin += Number(slot.breakMinutes ?? 0);
      netWorkedMin += slotMin - Number(slot.breakMinutes ?? 0);
    }

    // Lücken zwischen Slots zählen als Pausen
    let gapBreakMin = 0;
    for (let i = 1; i < daySlots.length; i++) {
      const gap = (daySlots[i].startTime.getTime() - daySlots[i - 1].endTime!.getTime()) / 60000;
      if (gap > 0) gapBreakMin += gap;
    }

    const totalBreakMin = explicitBreakMin + gapBreakMin;

    // § 4 ArbZG – Ruhepausenvorschrift
    if (netWorkedMin > 9 * 60 && totalBreakMin < 45) {
      warnings.push({
        code: "BREAK_TOO_SHORT",
        severity: "error",
        message: `§ 4 ArbZG: Bei über 9 Stunden Arbeitszeit sind mindestens 45 Minuten Pause vorgeschrieben. Erfasst: ${Math.round(totalBreakMin)} Min.`,
      });
    } else if (netWorkedMin > 6 * 60 && totalBreakMin < 30) {
      warnings.push({
        code: "BREAK_TOO_SHORT",
        severity: "warning",
        message: `§ 4 ArbZG: Bei über 6 Stunden Arbeitszeit sind mindestens 30 Minuten Pause vorgeschrieben. Erfasst: ${Math.round(totalBreakMin)} Min.`,
      });
    }

    // § 3 ArbZG – Tägliche Höchstarbeitszeit (10h absolut, 8h nur als 24-Wochen-Schnitt relevant)
    if (netWorkedMin > 10 * 60) {
      warnings.push({
        code: "MAX_DAILY_EXCEEDED",
        severity: "error",
        message: `§ 3 ArbZG: Tägliche Höchstarbeitszeit von 10 Stunden überschritten. Erfasst: ${(netWorkedMin / 60).toFixed(1)} h.`,
      });
    }

    // § 5 ArbZG – Mindestruhezeit (11h zwischen Arbeitstagen)
    // Vortag prüfen: letzter Slot des Vortages
    const prevDate = new Date(changedDate);
    prevDate.setDate(prevDate.getDate() - 1);
    const prevDateStr = dateStrInTz(prevDate, tz);

    const prevLastSlot = await prisma.timeEntry.findFirst({
      where: {
        employeeId,
        date: { gte: new Date(prevDateStr), lte: new Date(prevDateStr + "T23:59:59.999Z") },
        endTime: { not: null },
      },
      orderBy: { endTime: "desc" },
    });

    if (prevLastSlot?.endTime && daySlots.length > 0) {
      const restMin = (daySlots[0].startTime.getTime() - prevLastSlot.endTime.getTime()) / 60000;
      if (restMin < 11 * 60) {
        const restH = (restMin / 60).toFixed(1);
        warnings.push({
          code: "MIN_REST_VIOLATED",
          severity: "warning",
          message: `§ 5 ArbZG: Mindestruhezeit von 11 Stunden zwischen Arbeitstagen unterschritten. Ruhezeit: ${restH} h.`,
        });
      }
    }

    // Folgetag prüfen: erster Slot des Folgetages
    const nextDate = new Date(changedDate);
    nextDate.setDate(nextDate.getDate() + 1);
    const nextDateStr = dateStrInTz(nextDate, tz);

    const nextFirstSlot = await prisma.timeEntry.findFirst({
      where: {
        employeeId,
        date: { gte: new Date(nextDateStr), lte: new Date(nextDateStr + "T23:59:59.999Z") },
        endTime: { not: null },
      },
      orderBy: { startTime: "asc" },
    });

    const lastSlotToday = daySlots[daySlots.length - 1];
    if (nextFirstSlot && lastSlotToday.endTime) {
      const restMin = (nextFirstSlot.startTime.getTime() - lastSlotToday.endTime.getTime()) / 60000;
      if (restMin < 11 * 60) {
        const restH = (restMin / 60).toFixed(1);
        warnings.push({
          code: "MIN_REST_VIOLATED",
          severity: "warning",
          message: `§ 5 ArbZG: Mindestruhezeit zum Folgetag unterschritten. Ruhezeit: ${restH} h.`,
        });
      }
    }
  }

  // ── 2. Wochensicht: § 3 ArbZG – max. 48h / Woche ─────────────────────────
  const dayOfWeek = getDayOfWeekInTz(changedDate, tz); // 0=So, 1=Mo, ...
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(changedDate);
  monday.setDate(monday.getDate() - daysFromMonday);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  const weekSlots = await prisma.timeEntry.findMany({
    where: {
      employeeId,
      startTime: { gte: monday, lte: sunday },
      endTime: { not: null },
      type: "WORK",
    },
  });

  const weeklyNetMin = weekSlots.reduce((sum, e) => {
    const slotMin = (e.endTime!.getTime() - e.startTime.getTime()) / 60000;
    return sum + slotMin - Number(e.breakMinutes ?? 0);
  }, 0);

  if (weeklyNetMin > 48 * 60) {
    warnings.push({
      code: "MAX_WEEKLY_EXCEEDED",
      severity: "error",
      message: `§ 3 ArbZG: Wöchentliche Höchstarbeitszeit von 48 Stunden überschritten. Diese Woche: ${(weeklyNetMin / 60).toFixed(1)} h.`,
    });
  }

  return warnings;
}
