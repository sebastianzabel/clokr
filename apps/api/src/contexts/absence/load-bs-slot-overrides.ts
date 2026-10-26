/**
 * load-bs-slot-overrides.ts
 *
 * Phase 76.31 (D-06) — caller-side DB loader for the two highest layers of the
 * 4-layer bsSlot* override hierarchy (Employee ?? Pattern ?? TenantConfig ??
 * daily-Soll). The close-employee-month.ts core is PURE (no DB) — this helper
 * lets the 5 close callers pre-fetch the Employee + active Pattern bsSlot* rows
 * and thread them in as `employeeSlots` / `patternSlots`.
 *
 * When either row is absent (no employee override configured / no active BS
 * pattern covers the reference date) the corresponding value is null, which the
 * pure resolver treats as "delegate to the next layer down" — the TenantConfig /
 * legacy / daily-Soll fallback still applies. So passing the result of this
 * loader is always safe: at worst it is a no-op relative to passing null.
 */

import type { PrismaClient } from "@clokr/db";
import { BS_PATTERN_ORDER_BY } from "./vocational-school-pattern-order.js";

export type BsSlotOverride = {
  bsSlotFirstLongDayMinutes: number | null;
  bsSlotSecondLongDayMinutes: number | null;
  bsSlotShortDayMinutes: number | null;
  bsSlotBlockWeekMinutes: number | null;
};

export type BsSlotOverrides = {
  employeeSlots: BsSlotOverride | null;
  patternSlots: BsSlotOverride | null;
  // Phase 76.38 (D-11) — active pattern's per-DOW Unterrichtszeit map (raw JSON,
  // {"1":300,"4":180}, DOW keys 0=Mo..6=So). Fallback for BS dates whose Absence
  // carries no per-day unterrichtsMinutes. null when no active pattern covers the date.
  patternUnterrichtsMinutenByDow: unknown;
};

/**
 * Load the Employee + active-Pattern bsSlot* override rows for a given employee
 * and reference date (typically the month being closed — pass the month's first
 * day). The active pattern is the isActive row whose validFrom/validUntil window
 * covers `referenceDate`; if several qualify, resolution follows the shared total
 * order in `vocational-school-pattern-order.ts` (`BS_PATTERN_ORDER_BY`) — the same
 * order every other single-winner BS-pattern lookup uses, so this loader (the most-
 * called of the group — the monthly-close cron, snapshot recompute, month-saldo, and
 * time-entries/overtime all go through it) agrees with the amount-site resolver in
 * vocational-school-saldo.ts on which row is "current" for the same date.
 */
export async function loadBsSlotOverrides(
  prisma: Pick<PrismaClient, "employee" | "employeeVocationalSchoolPattern">,
  employeeId: string,
  referenceDate: Date,
): Promise<BsSlotOverrides> {
  const [employeeSlots, patternSlots] = await Promise.all([
    prisma.employee.findFirst({
      where: { id: employeeId },
      select: {
        bsSlotFirstLongDayMinutes: true,
        bsSlotSecondLongDayMinutes: true,
        bsSlotShortDayMinutes: true,
        bsSlotBlockWeekMinutes: true,
      },
    }),
    prisma.employeeVocationalSchoolPattern.findFirst({
      where: {
        employeeId,
        isActive: true,
        validFrom: { lte: referenceDate },
        OR: [{ validUntil: null }, { validUntil: { gte: referenceDate } }],
      },
      orderBy: BS_PATTERN_ORDER_BY,
      select: {
        bsSlotFirstLongDayMinutes: true,
        bsSlotSecondLongDayMinutes: true,
        bsSlotShortDayMinutes: true,
        bsSlotBlockWeekMinutes: true,
        // Phase 76.38 (D-11) — per-DOW Unterrichtszeit map for duration-based classification.
        unterrichtsMinutenByDow: true,
      },
    }),
  ]);

  const { unterrichtsMinutenByDow, ...patternSlotFields } = patternSlots ?? {
    unterrichtsMinutenByDow: null,
  };

  return {
    employeeSlots: employeeSlots ?? null,
    patternSlots: patternSlots ? (patternSlotFields as BsSlotOverride) : null,
    patternUnterrichtsMinutenByDow: unterrichtsMinutenByDow ?? null,
  };
}

/**
 * Issue #696 — `loadBsSlotOverrides` for MANY employees with two queries in total. Returns, per
 * employee, a resolver `(referenceDate) => BsSlotOverrides` that answers exactly what the single
 * loader answers for that date: the Employee row's slots, and the FIRST active pattern covering the
 * date in `BS_PATTERN_ORDER_BY` (the same total order, so the same winner). Nothing is written.
 */
export async function loadBsSlotOverridesForMany(
  prisma: Pick<PrismaClient, "employee" | "employeeVocationalSchoolPattern">,
  employeeIds: readonly string[],
): Promise<Map<string, (referenceDate: Date) => BsSlotOverrides>> {
  const result = new Map<string, (referenceDate: Date) => BsSlotOverrides>();
  if (employeeIds.length === 0) return result;
  const [employees, patterns] = await Promise.all([
    prisma.employee.findMany({
      where: { id: { in: [...employeeIds] } },
      select: {
        id: true,
        bsSlotFirstLongDayMinutes: true,
        bsSlotSecondLongDayMinutes: true,
        bsSlotShortDayMinutes: true,
        bsSlotBlockWeekMinutes: true,
      },
    }),
    prisma.employeeVocationalSchoolPattern.findMany({
      where: { employeeId: { in: [...employeeIds] }, isActive: true },
      orderBy: BS_PATTERN_ORDER_BY,
      select: {
        employeeId: true,
        validFrom: true,
        validUntil: true,
        bsSlotFirstLongDayMinutes: true,
        bsSlotSecondLongDayMinutes: true,
        bsSlotShortDayMinutes: true,
        bsSlotBlockWeekMinutes: true,
        unterrichtsMinutenByDow: true,
      },
    }),
  ]);
  const patternsByEmployee = new Map<string, typeof patterns>();
  for (const p of patterns) {
    const list = patternsByEmployee.get(p.employeeId) ?? [];
    list.push(p);
    patternsByEmployee.set(p.employeeId, list);
  }
  for (const e of employees) {
    const { id: _id, ...employeeSlots } = e;
    void _id;
    const list = patternsByEmployee.get(e.id) ?? [];
    result.set(e.id, (referenceDate) => {
      const hit = list.find(
        (p) =>
          p.validFrom <= referenceDate && (p.validUntil === null || p.validUntil >= referenceDate),
      );
      if (!hit) {
        return { employeeSlots, patternSlots: null, patternUnterrichtsMinutenByDow: null };
      }
      const {
        unterrichtsMinutenByDow,
        employeeId: _e,
        validFrom: _f,
        validUntil: _u,
        ...slots
      } = hit;
      void _e;
      void _f;
      void _u;
      return {
        employeeSlots,
        patternSlots: slots as BsSlotOverride,
        patternUnterrichtsMinutenByDow: unterrichtsMinutenByDow ?? null,
      };
    });
  }
  return result;
}
