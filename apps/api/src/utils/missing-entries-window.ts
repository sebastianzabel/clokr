/**
 * Missing-entries window (GitHub issue #141).
 *
 * How many days back the system looks when deciding an employee has "missing"
 * time entries. This value is consumed by BOTH:
 * - the Cron (Feature 2, `checkMissingEntries` in `attendance-checker.ts`), and
 * - the Karte (`GET /api/v1/dashboard/open-items`).
 *
 * Both callers derive the window from the same `TenantConfig.missingEntriesDays`
 * column through the same `resolveMissingEntriesDays()` function, so they cannot
 * drift apart the way they used to before issue #141.
 *
 * This file is the ONLY place the TypeScript default for this setting may be
 * stated (issue #141 acceptance criterion 4). `packages/db/prisma/schema.prisma`'s
 * `missingEntriesDays Int @default(7)` is the DB-layer mirror of the same number
 * — the schema DSL cannot import a TS constant, so that default is kept and
 * cross-referenced back to this file instead of being removed (removing it would
 * require a migration, which this ticket must not carry).
 */

/**
 * Fallback used ONLY when a tenant has no TenantConfig row at all — the column
 * itself is `Int @default(7)` and NOT nullable, so it can never be null on an
 * existing row.
 */
export const DEFAULT_MISSING_ENTRIES_DAYS = 7;

/**
 * Resolve the configured window from an ALREADY-FETCHED TenantConfig row (or
 * its absence).
 *
 * Deliberately a PURE function over an already-fetched row, not a
 * `(prisma, tenantId)` fetcher: both callers already read TenantConfig for
 * other fields, so a fetcher would add a redundant query to each call site.
 *
 * Deliberately has NO TTL cache, unlike `retro-config.ts`'s
 * `getRetroEntryWindowDays`. Acceptance criterion 3 requires a changed
 * configuration to arrive in the route's answer immediately; a 5-minute cache
 * would make that provably false for up to five minutes and would make the
 * regression test in `dashboard-open-items-window.test.ts` flaky. Do not
 * reintroduce a cache here.
 *
 * Deliberately has NO clamping. The write path
 * (`apps/api/src/routes/settings.ts`, `z.number().int().min(1).max(90)`) is
 * the single existing bound and stays the only one — a second bound here would
 * re-create the exact divergence this issue closes.
 */
export function resolveMissingEntriesDays(
  cfg: { missingEntriesDays: number | null } | null | undefined,
): number {
  return cfg?.missingEntriesDays ?? DEFAULT_MISSING_ENTRIES_DAYS;
}
