/**
 * Phase 64 — Auto-Break effective-value helper (D-04, BREAK-03).
 *
 * Pure function — no I/O, no Prisma import. Caller responsibility (D-05):
 *   - Fetch Employee with `select: { breakOver6hOverride: true, breakOver9hOverride: true }`
 *   - Fetch TenantConfig with the two `defaultBreakOver*h` fields
 *   - Pass both to this function with the entry's net work duration in minutes
 *
 * Precedence per threshold (independent):
 *   workDurationMin > 9h: Employee.breakOver9hOverride ?? TenantConfig.defaultBreakOver9h
 *   workDurationMin > 6h: Employee.breakOver6hOverride ?? TenantConfig.defaultBreakOver6h
 *   workDurationMin ≤ 6h: 0
 *
 * Boundaries are STRICT (>, not >=) — matches the existing hard-coded logic at
 * apps/api/src/routes/time-entries.ts lines 410-411, 646-647, 1032-1033 that
 * this helper replaces. BREAK-08 (behavior preservation) requires this.
 */
export interface BreakEmployeeShape {
  breakOver6hOverride: number | null;
  breakOver9hOverride: number | null;
}

export interface BreakTenantConfigShape {
  defaultBreakOver6h: number;
  defaultBreakOver9h: number;
}

export function getEffectiveBreakDuration(
  employee: BreakEmployeeShape,
  tenantConfig: BreakTenantConfigShape,
  workDurationMin: number,
): number {
  if (workDurationMin > 9 * 60) {
    return employee.breakOver9hOverride ?? tenantConfig.defaultBreakOver9h;
  }
  if (workDurationMin > 6 * 60) {
    return employee.breakOver6hOverride ?? tenantConfig.defaultBreakOver6h;
  }
  return 0;
}
