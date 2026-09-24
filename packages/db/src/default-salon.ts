/**
 * Phase 64b Plan 03 (issue #64, D-18) — the seeds' own copy of the default salon
 * opening-hours constant.
 *
 * `packages/db` cannot import from `apps/api` (the dependency runs the other way:
 * the API imports `@clokr/db`), so this is a deliberate second copy of
 * `DEFAULT_SALON_OPENING_HOURS` in `apps/api/src/contexts/platform/facade/salons.ts`.
 * Both constants must stay byte-identical to `TenantConfig.storeHours`'s Prisma
 * column default (`packages/db/prisma/schema.prisma`) — that equality is pinned by
 * `apps/api/src/__tests__/salon-migration.test.ts` on the API side.
 *
 * `seed.ts` and `seed-demo.ts` write this SAME constant into both
 * `TenantConfig.storeHours` and the tenant's default `Salon.openingHours`, so a
 * freshly bootstrapped tenant and its default salon agree by construction — even
 * if the schema default ever changes, both seed-written values change together.
 *
 * No side effects on import — this module only exports data, so it is safe to pull
 * into any seed script without affecting `main()`'s idempotency checks.
 */

/** Mirrors `SalonOpeningHours`'s shape in the API facade — day 0 = Monday … 6 = Sunday. */
export interface SeedSalonOpeningHours {
  day: number;
  open: string;
  close: string;
  closed?: boolean;
}

export const DEFAULT_SALON_OPENING_HOURS: SeedSalonOpeningHours[] = [
  { day: 0, open: "08:00", close: "20:00" },
  { day: 1, open: "08:00", close: "20:00" },
  { day: 2, open: "08:00", close: "20:00" },
  { day: 3, open: "08:00", close: "20:00" },
  { day: 4, open: "08:00", close: "20:00" },
  { day: 5, open: "08:00", close: "20:00" },
  { day: 6, open: "08:00", close: "20:00", closed: true },
];
