-- Issue #92 (Phase 92b, D-05/D-06): database backstop of the travel-entry shape. Prisma models no CHECK
-- constraint and `prisma migrate diff` ignores one, so this file is hand-written and the CI drift guard stays
-- empty (precedent: Tenant_salonQuota_positive, SupportAccess CHECKs). The application rule lives in ONE place,
-- validateTravelEntry (contexts/time-tracking/travel-entry.ts); this constraint only makes a wrong shape
-- impossible for every writer. Existing rows have no destination and are not TRAVEL, so they all satisfy it.
--
-- Why a separate, later file than the enum value: a new enum value cannot be used in the transaction that
-- adds it (ALTER TYPE ... ADD VALUE, measured 2026-09-15), and this constraint compares against 'TRAVEL'.
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_travel_shape_check" CHECK (
  (("activityKind" = 'TRAVEL') = ("travelToSalonId" IS NOT NULL))
  AND (
    "travelToSalonId" IS NULL
    OR (
      "travelToSalonId" <> "salonId"
      AND "type" = 'WORK'
      AND "endTime" IS NOT NULL
      AND "endTime" > "startTime"
      AND "breakMinutes" = 0
    )
  )
);
