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
 * migration data section can copy the JSON without reshaping it, and so #325's shift-check reader
 * could switch from tenant to salon level without changing its parsing.
 *
 * A `Salon` is never hard-deleted (D-06) — deactivation only (`isActive` / `deactivatedAt`). This
 * module therefore has, and will only ever have, no delete function.
 *
 * ── Salon rules (Phase 64b, Issue #64) ────────────────────────────────────────────────────────
 * - Salon is the Unterbau level below Tenant, read and written only through this module
 *   (re-exported from `contexts/platform/index.ts`) — never a direct table access from another
 *   context (ADR 0001).
 * - Every function here requires `tenantId`; there is no untenanted read or write.
 * - `openingHours` uses 0 = Monday … 6 = Sunday — NOT `WorkSchedule.workDays`'s encoding.
 * - A Salon is never hard-deleted — only deactivate/activate; the last active salon of a tenant
 *   cannot be deactivated.
 * - Multisalon means MORE THAN ONE active salon (`isMultiSalonTenant()`) — a derived read, never
 *   a config flag.
 * - `TenantConfig.storeHours` is deprecated: no new code reads it. Since Phase 325 (issue #325)
 *   the shift check (`contexts/scheduling/api/shifts.ts`) reads the shift's own `Salon.openingHours`
 *   instead; `PUT /api/v1/settings/work` still mirrors a `storeHours` write into a tenant's single
 *   active salon (D-13) until #82 removes both the mirror and this field — pinned by
 *   `store-hours-readers.test.ts`'s living allowlist (now `settings.ts` only).
 * - Every tenant-creating path (`seed.ts`, `seed-demo.ts`, `test-bootstrap.ts`) creates that
 *   tenant's default salon in the same step (D-18).
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

/**
 * Phase 325 (issue #325), D-04: the tenant's "default salon" — the earliest-created ACTIVE salon
 * (`createdAt asc`, tie-break `id`), same ordering as {@link listSalons}. `null` when the tenant
 * has no active salon — callers answer with a 409 `NO_ACTIVE_SALON` (routes) or fail the sync run
 * loudly (D-15); this facade never falls back to an inactive salon at runtime (the migration's own
 * backfill SQL has a migration-only fallback to the earliest salon of any state, pinned equal to
 * this function's active-only rule by `apps/api/src/__tests__/shift-salon-migration.test.ts`).
 * Once #65 exists, the Phorest sync's use of this function is replaced by the salon of the
 * specific Phorest coupling.
 */
export async function findDefaultSalon(
  db: Prisma.TransactionClient,
  tenantId: string,
): Promise<Salon | null> {
  return db.salon.findFirst({
    where: { tenantId, isActive: true },
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

// ── Deactivate / re-activate (Phase 64b Plan 02, D-06/D-07/D-08) — never delete ────────────────

/**
 * D-06/D-07/D-08: the outcome of a deactivate/activate attempt, as a CODE, never a display string
 * (CLAUDE.md "never use a new display string as a control value") — the ROUTE maps each status to
 * its own German 409 message, or, for `NOT_FOUND`, to the shared `rejectUnknownSalon` 404.
 */
export type SalonStateChange =
  | { status: "OK"; existing: Salon; updated: Salon }
  | { status: "NOT_FOUND" }
  | { status: "ALREADY_INACTIVE" }
  | { status: "ALREADY_ACTIVE" }
  | { status: "LAST_ACTIVE_SALON" };

/** The statuses {@link deactivateSalon} can return — never `ALREADY_ACTIVE`. */
export type SalonDeactivation = Exclude<SalonStateChange, { status: "ALREADY_ACTIVE" }>;

/** The statuses {@link activateSalon} can return — never `ALREADY_INACTIVE`/`LAST_ACTIVE_SALON`. */
export type SalonActivation = Exclude<
  SalonStateChange,
  { status: "ALREADY_INACTIVE" | "LAST_ACTIVE_SALON" }
>;

/**
 * D-08/D-11: deactivate a salon. MUST run inside an interactive `$transaction` — the row lock
 * below is released at the end of the transaction it runs in, so calling this with a bare
 * `PrismaClient` (no surrounding `$transaction`) gives no protection against the concurrent-
 * deactivation race the lock exists to prevent. This is the single place Phase 67b extends with
 * its Stammsalon guard (D-08's own wording): a status check inserted between `ALREADY_INACTIVE`
 * and `LAST_ACTIVE_SALON`, in this one function.
 */
export async function deactivateSalon(
  db: Prisma.TransactionClient,
  tenantId: string,
  salonId: string,
): Promise<SalonDeactivation> {
  // FOR UPDATE, ordered by id — locks every one of the tenant's Salon rows for the lifetime of
  // the enclosing transaction, the same shape as `services/clock/resolver.ts:37`'s per-employee
  // lock, generalised to "every row that could change countActiveSalons' answer".
  await db.$queryRaw`SELECT "id" FROM "Salon" WHERE "tenantId" = ${tenantId} ORDER BY "id" FOR UPDATE`;

  const existing = await db.salon.findFirst({ where: { id: salonId, tenantId } });
  if (!existing) return { status: "NOT_FOUND" };
  if (!existing.isActive) return { status: "ALREADY_INACTIVE" };

  const activeCount = await countActiveSalons(db, tenantId);
  if (activeCount <= 1) return { status: "LAST_ACTIVE_SALON" };

  const updated = await db.salon.update({
    where: { id: salonId, tenantId },
    data: { isActive: false, deactivatedAt: new Date() },
  });
  return { status: "OK", existing, updated };
}

/** D-07: the mirror of {@link deactivateSalon} — same lock, same lookup shape. */
export async function activateSalon(
  db: Prisma.TransactionClient,
  tenantId: string,
  salonId: string,
): Promise<SalonActivation> {
  await db.$queryRaw`SELECT "id" FROM "Salon" WHERE "tenantId" = ${tenantId} ORDER BY "id" FOR UPDATE`;

  const existing = await db.salon.findFirst({ where: { id: salonId, tenantId } });
  if (!existing) return { status: "NOT_FOUND" };
  if (existing.isActive) return { status: "ALREADY_ACTIVE" };

  const updated = await db.salon.update({
    where: { id: salonId, tenantId },
    data: { isActive: true, deactivatedAt: null },
  });
  return { status: "OK", existing, updated };
}

// ── storeHours <-> Salon mirror (Phase 64b Plan 04, D-16) — removed by #82 ──────────────────────

/**
 * Tolerant equality for two `openingHours` JSON values: sorts by day and normalises an ABSENT
 * `closed` down to the same shape as an explicit `false`, so key order and an omitted `closed`
 * never register as a "change" that {@link syncSoleActiveSalonOpeningHours} would otherwise
 * mirror (and audit) for no real difference. Module-private — no caller needs the intermediate
 * string, only the equality it produces.
 */
function normalizeOpeningHoursForCompare(value: unknown): string {
  const rows = Array.isArray(value) ? (value as SalonOpeningHours) : [];
  return JSON.stringify(
    [...rows]
      .sort((a, b) => a.day - b.day)
      .map((row) => ({
        day: row.day,
        open: row.open,
        close: row.close,
        closed: row.closed === true,
      })),
  );
}

/**
 * D-13/D-16: keeps `TenantConfig.storeHours` and a tenant's single active salon in step until #82
 * removes the tenant field entirely (Phase 325, issue #325, kept this mirror deliberately — the
 * admin UI's only opening-hours editor still writes `storeHours`, and removing the mirror before
 * #82 builds a salon-level editor would make every future edit there invisible to the shift check).
 * Called ONLY from `PUT /api/v1/settings/work`
 * (`contexts/platform/api/settings.ts`) when its body carries `storeHours`, and mirrors ONLY when
 * that value differs from `previousTenantHours` — the tenant value before the write, read by the
 * caller — so resending an unchanged week never overwrites a salon edited via
 * `PATCH /api/v1/salons/:id` (Phase 64b review, WR-02). This is a WRITE into
 * the salon from inside an existing platform route, not a new read of `storeHours` (this function
 * never reads `TenantConfig` itself). `openingHours` arrives validated only by that route's legacy
 * schema (7 entries, `HH:MM` format) and is written verbatim, exactly as the migration copied the
 * tenant value — D-04: legacy values are not re-validated against {@link salonOpeningHoursSchema}
 * (Phase 64b review, WR-03). Deliberately NOT re-exported from `index.ts` (Plan 04) — the
 * PUT /work handler is this function's only legitimate caller, not a general-purpose surface for
 * Phase 67b.
 *
 * With more than one active salon the tenant value is ambiguous which salon it means — nothing is
 * mirrored, and `TenantConfig.storeHours` is still updated by the caller regardless. A salon
 * edited directly via `PATCH /api/v1/salons/:id` is never mirrored back into `TenantConfig` in the
 * other direction — #325 switches the shift check's reader instead of building a second mirror.
 */
export async function syncSoleActiveSalonOpeningHours(
  db: Prisma.TransactionClient,
  tenantId: string,
  change: { previousTenantHours: unknown; openingHours: SalonOpeningHours },
): Promise<{ existing: Salon; updated: Salon } | null> {
  const { previousTenantHours, openingHours } = change;
  // Review WR-02: mirror only a CHANGE of the tenant value. A tenant without a TenantConfig row
  // (`undefined`) effectively has the column default, which DEFAULT_SALON_OPENING_HOURS equals.
  if (
    normalizeOpeningHoursForCompare(previousTenantHours ?? DEFAULT_SALON_OPENING_HOURS) ===
    normalizeOpeningHoursForCompare(openingHours)
  ) {
    return null;
  }

  const activeSalons = await db.salon.findMany({
    where: { tenantId, isActive: true },
    take: 2,
  });
  if (activeSalons.length !== 1) return null;

  const [salon] = activeSalons;
  if (
    normalizeOpeningHoursForCompare(salon.openingHours) ===
    normalizeOpeningHoursForCompare(openingHours)
  ) {
    return null;
  }

  const updated = await db.salon.update({
    where: { id: salon.id, tenantId },
    data: { openingHours: openingHours as unknown as Prisma.InputJsonValue },
  });
  return { existing: salon, updated };
}
