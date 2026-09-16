/**
 * Numeric thresholds + bounds for auto-break logic (CONTEXT.md D-03).
 *
 * ArbZG §4 PFLICHT-PAUSEN:
 *   - > 6h Arbeit → mindestens 30 Min Pause
 *   - > 9h Arbeit → mindestens 45 Min Pause
 *
 * These are LEGAL MINIMA — the Floor below which Tenant-Default and
 * per-Employee-Override values MUST NOT drop. The validation layer
 * (settings.ts, employees.ts Zod schemas) enforces this in HTTP 400 form.
 *
 * The TenantConfig defaults (30/45) match these floors exactly to preserve
 * the previously hard-coded behavior (BREAK-08). Tenants who never edit see
 * identical behavior.
 *
 * The upper bounds (BREAK_MAX_*) are sane caps — 2h for >6h work, 3h for >9h.
 * No legal basis; just guards against typos like "300" instead of "30".
 */
export const ARBZG_FLOOR_OVER_6H = 30;
export const ARBZG_FLOOR_OVER_9H = 45;
export const BREAK_MAX_OVER_6H = 120;
export const BREAK_MAX_OVER_9H = 180;
