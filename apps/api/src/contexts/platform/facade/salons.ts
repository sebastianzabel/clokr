/**
 * Phase 64b Plan 01 (issue #64) — Unterbau's public `Salon` read surface.
 *
 * `Salon` sits one level below `Tenant` (ADR 0001: Unterbau = Tenant, Salon, Beschäftigung,
 * Berechtigungen). Every exported function here takes `db: Prisma.TransactionClient` first and a
 * REQUIRED `tenantId` — `apps/api/scripts/lint-facade-signatures.ts` (F1/F3) and
 * `apps/api/scripts/lint-tenant-scoping.ts` enforce this mechanically; this module is already
 * inside `SCOPED_DIRS` (`platform/facade/**`), so it is walked by both gates without a new
 * exception. No exported function here calls `app.audit()` — this module has no `app` — the
 * caller wraps the write (this task adds no write function) and its own `app.audit()` call in one
 * `$transaction`, passing `tx` to both.
 *
 * Weekday encoding: `day` is 0 = Monday … 6 = Sunday — identical to `TenantConfig.storeHours`
 * (schema.prisma:217) and deliberately NOT `WorkSchedule.workDays`'s encoding (0 = Sunday). This
 * module's `openingHours` shape is a verbatim copy of `storeHours`'s shape (D-03) so the one-time
 * migration data section can copy the JSON without reshaping it, and so a future reader (#325) can
 * switch from tenant to salon level without changing its parsing.
 *
 * A `Salon` is never hard-deleted (D-06) — deactivation only (`isActive` / `deactivatedAt`). This
 * module therefore has, and will only ever have, no delete function.
 */
import type { Prisma } from "@clokr/db";
import { z } from "zod";

// A real HH:MM time: hours 00-23, minutes 00-59. Plain `\d{2}:\d{2}` (as `settings.ts`'s weaker,
// pre-existing `storeHours` schema uses) would also accept "99:99" — D-04 requires a real time.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * D-04: one canonical opening-hours schema for the whole Salon surface (do not reuse
 * `settings.ts`'s weaker `storeHours` schema — it has no `superRefine` for "each day exactly
 * once" or "open < close unless closed"). Array length exactly 7; every weekday 0..6 occurs
 * exactly once; `open`/`close` are real HH:MM times; `open < close` unless `closed: true`.
 *
 * Stored legacy rows (copied verbatim by the migration's data section, D-14) are NEVER
 * re-validated or "corrected" against this schema — this mirrors the Phase 95b "don't fix legacy
 * rows" rule. This schema only gates NEW writes; this task adds no write function, so today it is
 * exercised only by the living-assertion test that pins `DEFAULT_SALON_OPENING_HOURS` against it.
 */
export const salonOpeningHoursSchema = z
  .array(
    z.object({
      day: z.number().int().min(0).max(6),
      open: z.string().regex(TIME_RE, "Uhrzeit im Format HH:MM erwartet."),
      close: z.string().regex(TIME_RE, "Uhrzeit im Format HH:MM erwartet."),
      closed: z.boolean().optional(),
    }),
  )
  .length(7, "Öffnungszeiten müssen genau 7 Wochentage enthalten (0 = Montag … 6 = Sonntag).")
  .superRefine((rows, ctx) => {
    const seenDays = new Set(rows.map((row) => row.day));
    if (seenDays.size !== rows.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Jeder Wochentag (0 = Montag … 6 = Sonntag) muss genau einmal vorkommen.",
      });
    }
    rows.forEach((row, index) => {
      if (!row.closed && row.open >= row.close) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "close"],
          message: "Öffnungszeit muss vor der Schließzeit liegen.",
        });
      }
    });
  });

export type SalonOpeningHours = z.infer<typeof salonOpeningHoursSchema>;

/**
 * The default default-salon opening hours (D-14's migration data section, and every future
 * `createSalon` call with no explicit hours). MUST equal `TenantConfig.storeHours`'s
 * `@default(...)` literal in `schema.prisma:217` verbatim — pinned by a living assertion in
 * `salon-migration.test.ts` (comparing this constant against the migration's own COALESCE
 * fallback JSON) rather than restated as an assumption here.
 */
export const DEFAULT_SALON_OPENING_HOURS: SalonOpeningHours = [
  { day: 0, open: "08:00", close: "20:00" },
  { day: 1, open: "08:00", close: "20:00" },
  { day: 2, open: "08:00", close: "20:00" },
  { day: 3, open: "08:00", close: "20:00" },
  { day: 4, open: "08:00", close: "20:00" },
  { day: 5, open: "08:00", close: "20:00" },
  { day: 6, open: "08:00", close: "20:00", closed: true },
];

/**
 * List a tenant's salons, earliest-created first (`createdAt asc`, tie-break `id`) — the ordering
 * 67b's deferred "default salon = earliest" rule will rely on. Excludes inactive salons unless
 * `includeInactive` is set.
 */
export async function listSalons(
  db: Prisma.TransactionClient,
  tenantId: string,
  options: { includeInactive: boolean },
) {
  return db.salon.findMany({
    where: options.includeInactive ? { tenantId } : { tenantId, isActive: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

/** Count of the tenant's currently ACTIVE salons — the input to {@link isMultiSalonTenant}. */
export async function countActiveSalons(
  db: Prisma.TransactionClient,
  tenantId: string,
): Promise<number> {
  return db.salon.count({ where: { tenantId, isActive: true } });
}

/**
 * AC-5: multisalon status is DERIVED (> 1 active salon) — there is no config field for it, and
 * none may be added; a tenant simply has however many active salons it has.
 */
export async function isMultiSalonTenant(
  db: Prisma.TransactionClient,
  tenantId: string,
): Promise<boolean> {
  return (await countActiveSalons(db, tenantId)) > 1;
}
