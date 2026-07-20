/**
 * Retro-entry window helpers (RETRO-01, CFG-01).
 *
 * Guards how far back employees can create or edit time entries without an
 * approved RetroEntryRequest. The window is configured per-tenant via
 * TenantConfig.retroEntryWindowDays (default 10 calendar days).
 *
 * All date math uses tenant-TZ string comparison (YYYY-MM-DD) via dateStrInTz /
 * todayInTz — never raw UTC arithmetic — so DST transitions cannot shift the
 * boundary by a day (RETRO-01 C1).
 *
 * Boundary is INCLUSIVE at -N: day -N is allowed, day -(N+1) is blocked.
 * Example with window=10: today=2024-04-15, limit=2024-04-05 (inclusive).
 *   dateStr "2024-04-05" >= "2024-04-05" → allowed.
 *   dateStr "2024-04-04" <  "2024-04-05" → 403 RETRO_WINDOW_EXCEEDED.
 */
import type { FastifyInstance } from "fastify";
import { todayInTz, dateStrInTz } from "./timezone";

const DEFAULT_WINDOW_DAYS = 10;

// ── Short TTL cache (mirrors getTenantTimezone pattern in timezone.ts:13-35) ────
// One DB round-trip per tenant per 5 min, not per time-entry write.
const retroWindowCache = new Map<string, { days: number; exp: number }>();
const RETRO_CACHE_TTL_MS = 5 * 60_000;

/**
 * Return the configured retroEntryWindowDays for the tenant.
 * Falls back to DEFAULT_WINDOW_DAYS (10) when the column is null.
 * Cached for 5 minutes to avoid per-request DB reads.
 */
export async function getRetroEntryWindowDays(
  prisma: FastifyInstance["prisma"],
  tenantId: string,
): Promise<number> {
  const cached = retroWindowCache.get(tenantId);
  if (cached && cached.exp > Date.now()) return cached.days;

  const cfg = await prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: { retroEntryWindowDays: true },
  });
  const days = cfg?.retroEntryWindowDays ?? DEFAULT_WINDOW_DAYS;
  retroWindowCache.set(tenantId, { days, exp: Date.now() + RETRO_CACHE_TTL_MS });
  return days;
}

/**
 * Compute the earliest allowed entry date string (YYYY-MM-DD, tenant TZ).
 *
 * Algorithm (RETRO-01 C1 — DST-safe):
 *   1. Take todayInTz(tz) — a UTC midnight Date that represents "today" in the tenant TZ.
 *   2. Subtract N calendar days by adjusting the UTC day component
 *      (todayInTz already normalised to midnight UTC so this subtraction is exact).
 *   3. Re-format via dateStrInTz — produces the tenant-local date string.
 *
 * Result: the inclusive lower bound.  Any dateStr >= retroLimitStr is allowed.
 */
export function computeRetroLimitStr(tz: string, windowDays: number): string {
  const todayUtcMidnight = todayInTz(tz);
  const limitUtc = new Date(todayUtcMidnight.getTime() - windowDays * 24 * 60 * 60 * 1000);
  return dateStrInTz(limitUtc, tz);
}

/**
 * Calculate how many calendar days old an entry date is relative to today.
 *
 * Both todayStr and dateStr are YYYY-MM-DD strings already computed in the
 * tenant TZ so the subtraction is DST-safe (we parse to UTC midnight and
 * divide by ms-per-day).
 */
export function computeEntryAgeInDays(todayStr: string, dateStr: string): number {
  const todayMs = new Date(todayStr + "T00:00:00Z").getTime();
  const entryMs = new Date(dateStr + "T00:00:00Z").getTime();
  return Math.round((todayMs - entryMs) / (24 * 60 * 60 * 1000));
}
