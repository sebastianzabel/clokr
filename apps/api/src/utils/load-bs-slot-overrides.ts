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

export type BsSlotOverride = {
  bsSlotFirstLongDayMinutes: number | null;
  bsSlotSecondLongDayMinutes: number | null;
  bsSlotShortDayMinutes: number | null;
  bsSlotBlockWeekMinutes: number | null;
};

export type BsSlotOverrides = {
  employeeSlots: BsSlotOverride | null;
  patternSlots: BsSlotOverride | null;
};

/**
 * Load the Employee + active-Pattern bsSlot* override rows for a given employee
 * and reference date (typically the month being closed — pass the month's first
 * day). The active pattern is the isActive row whose validFrom/validUntil window
 * covers `referenceDate`; if several qualify the most recent validFrom wins
 * (mirrors the amount-site resolver in vocational-school-saldo.ts).
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
      orderBy: { validFrom: "desc" },
      select: {
        bsSlotFirstLongDayMinutes: true,
        bsSlotSecondLongDayMinutes: true,
        bsSlotShortDayMinutes: true,
        bsSlotBlockWeekMinutes: true,
      },
    }),
  ]);

  return {
    employeeSlots: employeeSlots ?? null,
    patternSlots: patternSlots ?? null,
  };
}
