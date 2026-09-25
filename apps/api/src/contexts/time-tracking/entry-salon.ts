/**
 * Phase 68b (issue #68), D-06/D-07/D-08/D-16 — the ONE place the entry-salon rule lives.
 *
 * Every TimeEntry creation path (the clock resolver's START branch for NFC/MOBILE/WIFI, the three
 * `POST /time-entries` branches, the CSV importer) calls {@link resolveEntrySalon}; none rebuilds
 * the rule inline.
 *
 * Rule, in this order:
 * 1. An explicit salon id is resolved tenant-scoped via `findSalon`: `null` (a foreign tenant's
 *    real salon AND an id that exists nowhere — one code path, so byte-identical by construction,
 *    T-100-09) answers 404; a found but deactivated salon answers 400 SALON_INACTIVE (issue #68
 *    mandates 400 — deliberately not the 422 of the shift sibling `resolveShiftSalon`).
 * 2. Without an explicit id: `salonForDay(tenantId, employeeId, startTime)`. Its answer is used
 *    as-is even if that salon has since been deactivated — the "must be active" rule is about
 *    explicit input, the derived value is assignment history (67b D-16).
 * 3. `salonForDay` answers `null` for two different reasons — the instant lies before the
 *    employee's tenant-local hire day, or the employee has no assignment row at all (research
 *    Pitfall 4). Both deliberately fall back to the tenant's default salon (`findDefaultSalon`).
 * 4. No default salon either (the tenant has no active salon) → 409 NO_ACTIVE_SALON.
 *
 * `startTime` is the entry's start INSTANT, never the day-only `date` — `salonForDay` does the
 * tenant-local conversion itself. The salon hangs on the ENTRY: the input is one entry's
 * `(employeeId, startTime)`, never "the day", so several entries per day in different salons
 * (#70) need no change here.
 *
 * Tenant safety comes from delegating every read to the three tenant-scoped Unterbau facades,
 * reached only through `contexts/platform/index.ts`. This file lives outside `facade/`, so
 * `lint-facade-signatures` does not scan it.
 */
import type { Prisma } from "@clokr/db";
import { findDefaultSalon, findSalon, salonForDay } from "../platform";

export type ResolveEntrySalonInput = {
  tenantId: string;
  employeeId: string;
  /** The entry's start instant — never the day-only `date`. */
  startTime: Date;
  /** An explicitly requested salon (manual / Zeitnachtrag / grant / CSV paths only). */
  explicitSalonId?: string;
};

const SALON_NOT_FOUND_BODY = { error: "Salon nicht gefunden" } as const;
const SALON_INACTIVE_BODY = { error: "Salon ist deaktiviert", code: "SALON_INACTIVE" } as const;
const NO_ACTIVE_SALON_BODY = {
  error: "Kein aktiver Salon vorhanden.",
  code: "NO_ACTIVE_SALON",
} as const;

export type ResolveEntrySalonResult =
  | { ok: true; salonId: string }
  | { ok: false; status: 404; body: typeof SALON_NOT_FOUND_BODY }
  | { ok: false; status: 400; body: typeof SALON_INACTIVE_BODY }
  | { ok: false; status: 409; body: typeof NO_ACTIVE_SALON_BODY };

export async function resolveEntrySalon(
  db: Prisma.TransactionClient,
  input: ResolveEntrySalonInput,
): Promise<ResolveEntrySalonResult> {
  const { tenantId, employeeId, startTime, explicitSalonId } = input;

  if (explicitSalonId !== undefined) {
    const salon = await findSalon(db, tenantId, explicitSalonId);
    if (!salon) return { ok: false, status: 404, body: SALON_NOT_FOUND_BODY };
    if (!salon.isActive) return { ok: false, status: 400, body: SALON_INACTIVE_BODY };
    return { ok: true, salonId: salon.id };
  }

  const derived = await salonForDay(db, tenantId, employeeId, startTime);
  if (derived) return { ok: true, salonId: derived.salonId };

  const fallback = await findDefaultSalon(db, tenantId);
  if (fallback) return { ok: true, salonId: fallback.id };

  return { ok: false, status: 409, body: NO_ACTIVE_SALON_BODY };
}
