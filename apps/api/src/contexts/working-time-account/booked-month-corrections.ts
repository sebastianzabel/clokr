/**
 * Issue #599 — the ONE read of booked month corrections for the saldo core.
 *
 * An approved `MonthCorrectionRequest` (a correction of a day of a CLOSED month) is booked as an
 * account movement on its `bookingDate`, a day of the month that was running at approval.
 * `closeEmployeeMonth()` folds it into `balanceMinutes` through its required
 * `accountCorrections` input; every caller fetches that input here (one person) or through
 * {@link getBookedMonthCorrectionsForMany} (many persons, the #696 bulk chain), so the chain, the
 * month series, the close paths and the reports read the same rows.
 *
 * Only APPROVED rows count; a row is never edited after approval (the DB CHECK
 * `MonthCorrectionRequest_booking_shape_check` pins the booking shape).
 */
import type { Prisma } from "@clokr/db";

export type BookedMonthCorrection = { date: Date; minutes: number };

type Db = Pick<Prisma.TransactionClient, "monthCorrectionRequest">;

/** Booked corrections of one person with `from <= bookingDate <= to` (calendar days). */
export async function getBookedMonthCorrections(
  db: Db,
  employeeId: string,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<BookedMonthCorrection[]> {
  const rows = await db.monthCorrectionRequest.findMany({
    where: {
      employeeId,
      employee: { tenantId },
      status: "APPROVED",
      bookingDate: { gte: from, lte: to },
    },
    select: { bookingDate: true, correctionMinutes: true },
    orderBy: [{ bookingDate: "asc" }, { id: "asc" }],
  });
  return toCloseMonthAccountCorrections(rows);
}

/** The same read for many persons of one tenant, grouped by person. */
export async function getBookedMonthCorrectionsForMany(
  db: Db,
  tenantId: string,
  employeeIds: readonly string[],
  from: Date,
  to: Date,
): Promise<Map<string, BookedMonthCorrection[]>> {
  const byEmployee = new Map<string, BookedMonthCorrection[]>();
  if (employeeIds.length === 0) return byEmployee;
  const rows = await db.monthCorrectionRequest.findMany({
    where: {
      employeeId: { in: [...employeeIds] },
      employee: { tenantId },
      status: "APPROVED",
      bookingDate: { gte: from, lte: to },
    },
    select: { employeeId: true, bookingDate: true, correctionMinutes: true },
    orderBy: [{ bookingDate: "asc" }, { id: "asc" }],
  });
  for (const row of rows) {
    const list = byEmployee.get(row.employeeId) ?? [];
    list.push(...toCloseMonthAccountCorrections([row]));
    byEmployee.set(row.employeeId, list);
  }
  return byEmployee;
}

/** The mapping into `CloseMonthInput.accountCorrections`; rows without a booking are dropped. */
export function toCloseMonthAccountCorrections(
  rows: ReadonlyArray<{ bookingDate: Date | null; correctionMinutes: number | null }>,
): BookedMonthCorrection[] {
  const out: BookedMonthCorrection[] = [];
  for (const r of rows) {
    if (r.bookingDate && r.correctionMinutes) {
      out.push({ date: r.bookingDate, minutes: r.correctionMinutes });
    }
  }
  return out;
}
