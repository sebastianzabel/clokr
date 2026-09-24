/**
 * Phase 64b Plan 01 (issue #64) — Unterbau's public `Salon` surface.
 *
 * `Salon` sits one level below `Tenant` (ADR 0001: Unterbau = Tenant, Salon, Beschäftigung,
 * Berechtigungen). Every exported function here takes `db: Prisma.TransactionClient` first and a
 * REQUIRED `tenantId` — `apps/api/scripts/lint-facade-signatures.ts` (F1/F3) and
 * `apps/api/scripts/lint-tenant-scoping.ts` enforce this mechanically; this module is already
 * inside `SCOPED_DIRS` (`platform/facade/**`), so it is walked by both gates without a new
 * exception. No exported function here calls `app.audit()` — this module has no `app` — the
 * caller wraps the write and its own `app.audit()` call in one `$transaction`, passing `tx` to
 * both (Phase 64b Plan 02 adds the write functions this docblock originally deferred).
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
import type { Prisma, Salon } from "@clokr/db";
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
 * rows" rule. This schema only gates NEW writes — {@link createSalonSchema} and
 * {@link updateSalonSchema} both embed it (Phase 64b Plan 02).
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

// ── Write surface (Phase 64b Plan 02, issue #64 AC-1/AC-2/AC-4/AC-6) ────────────────────────────

const NAME_MAX_LENGTH = 100;
const STREET_MAX_LENGTH = 200;
const POSTAL_CODE_MAX_LENGTH = 20;
const CITY_MAX_LENGTH = 100;

const nameSchema = z
  .string()
  .trim()
  .min(1, "Name ist erforderlich.")
  .max(NAME_MAX_LENGTH, "Name darf höchstens 100 Zeichen lang sein.");

/**
 * D-02: an address field is always optional and nullable, and an explicit empty string is
 * normalised to null on write — for BOTH create and update (Clokr frontends send explicit `null`
 * for a field the user cleared, never omit the key; CLAUDE.md "Zod .optional() vs .nullable()").
 * A key absent from the input stays ABSENT from the parsed result (Zod does not synthesize an
 * `undefined`-valued key for a missing `.optional()` field — verified against this exact schema
 * shape) — that is what lets {@link updateSalon} use `Object.keys(patch)` as the precise set of
 * fields the caller actually touched, with no separate "was this key present" bookkeeping.
 */
function addressField(maxLength: number, label: string) {
  return z
    .string()
    .trim()
    .max(maxLength, `${label} darf höchstens ${maxLength} Zeichen lang sein.`)
    .nullable()
    .optional()
    .transform((value) => (value === "" ? null : value));
}

/**
 * D-02/D-04/D-05: create a salon. `name` required/trimmed/1..100; address fields optional,
 * nullable, empty string -> null; `openingHours` REQUIRED (unlike {@link updateSalonSchema});
 * `isActive` optional (default applied in {@link createSalon}, not baked into this schema, so the
 * inferred type stays `boolean | undefined`). `.strict()` rejects `tenantId`/`id`/anything else a
 * client must never control through this endpoint.
 */
export const createSalonSchema = z
  .object({
    name: nameSchema,
    street: addressField(STREET_MAX_LENGTH, "Straße"),
    postalCode: addressField(POSTAL_CODE_MAX_LENGTH, "Postleitzahl"),
    city: addressField(CITY_MAX_LENGTH, "Ort"),
    openingHours: salonOpeningHoursSchema,
    isActive: z.boolean().optional(),
  })
  .strict();

export type CreateSalonInput = z.infer<typeof createSalonSchema>;

/**
 * D-02/D-04/D-05: update a salon's master data. Every field optional — only keys PRESENT in the
 * input are present in the parsed result (see {@link addressField}'s docblock), which is exactly
 * the patch {@link updateSalon} applies. `isActive`/`deactivatedAt`/`tenantId`/`id` are
 * deliberately NOT part of this schema — `.strict()` turns any of them into a 400, keeping
 * activation-state changes on their own dedicated, audited routes (D-06/D-07).
 */
export const updateSalonSchema = z
  .object({
    name: nameSchema.optional(),
    street: addressField(STREET_MAX_LENGTH, "Straße"),
    postalCode: addressField(POSTAL_CODE_MAX_LENGTH, "Postleitzahl"),
    city: addressField(CITY_MAX_LENGTH, "Ort"),
    openingHours: salonOpeningHoursSchema.optional(),
  })
  .strict();

export type UpdateSalonInput = z.infer<typeof updateSalonSchema>;

/**
 * D-09/D-13: the single existence+ownership primitive every `/:id` route and every mutating
 * function below calls first. `null` for a salon belonging to a DIFFERENT tenant AND for an id
 * that exists nowhere — byte-identical by construction (T-100-09), because there is only one code
 * path that can produce `null` at all.
 */
export async function findSalon(
  db: Prisma.TransactionClient,
  tenantId: string,
  salonId: string,
): Promise<Salon | null> {
  return db.salon.findFirst({ where: { id: salonId, tenantId } });
}

/**
 * Audit-only helper for THIS context's own routes (`api/salons.ts`'s `rejectUnknownSalon`) — never
 * loads the foreign row, its boolean answer never reaches the client, and it is deliberately NOT
 * re-exported from `index.ts`: handing another context an existence probe across the tenant
 * boundary would build the exact oracle T-100-09 forbids. `db.salon.count(...)` is not one of
 * `lint-tenant-scoping`'s RELEVANT_METHODS (`count`/`findMany`/`create` are unjudged), so the
 * intentional `NOT: { tenantId }` shape below needs no scoping exception.
 */
export async function salonExistsInForeignTenant(
  db: Prisma.TransactionClient,
  tenantId: string,
  salonId: string,
): Promise<boolean> {
  const count = await db.salon.count({ where: { id: salonId, NOT: { tenantId } } });
  return count > 0;
}

/**
 * D-02/D-06: create a salon for `tenantId` — never from `input` (a client cannot choose which
 * tenant it creates into). `isActive: false` on create sets `deactivatedAt` to now in the SAME
 * write, keeping the isActive <-> deactivatedAt invariant true from row zero; the default
 * (`isActive` omitted, or explicitly `true`) leaves `deactivatedAt` null.
 */
export async function createSalon(
  db: Prisma.TransactionClient,
  tenantId: string,
  input: CreateSalonInput,
): Promise<Salon> {
  const isActive = input.isActive ?? true;
  return db.salon.create({
    data: {
      tenantId,
      name: input.name,
      street: input.street ?? null,
      postalCode: input.postalCode ?? null,
      city: input.city ?? null,
      openingHours: input.openingHours as unknown as Prisma.InputJsonValue,
      isActive,
      deactivatedAt: isActive ? null : new Date(),
    },
  });
}

/**
 * D-13: the exact `updateLeaveType` shape (`apps/api/src/contexts/absence/facade/leave-types.ts`)
 * — a tenant-scoped guard-fetch AND the update itself both carry `tenantId` in their OWN `where`,
 * so the update does not depend on the guard having run first. `null` for a foreign OR nonexistent
 * `salonId` — the same byte-identical shape as {@link findSalon}. Only the keys PRESENT in `patch`
 * are written (see {@link updateSalonSchema}'s docblock); the ROUTE rejects an empty patch with
 * NO_CHANGES before ever calling this function.
 */
export async function updateSalon(
  db: Prisma.TransactionClient,
  tenantId: string,
  salonId: string,
  patch: UpdateSalonInput,
): Promise<{ existing: Salon; updated: Salon } | null> {
  const existing = await db.salon.findFirst({ where: { id: salonId, tenantId } });
  if (!existing) return null;

  const { openingHours, ...rest } = patch;
  const updated = await db.salon.update({
    where: { id: salonId, tenantId },
    data: {
      ...rest,
      ...(openingHours !== undefined
        ? { openingHours: openingHours as unknown as Prisma.InputJsonValue }
        : {}),
    },
  });
  return { existing, updated };
}
