-- Issue #70 (Phase 70b, D-01/D-10) — several time entries per employee and day, never overlapping.
--
-- Hand-written DDL only. Prisma models neither exclusion constraints nor partial unique indexes, and
-- `prisma migrate diff` does not see partial indexes at all (the unmodelled "TimeEntry_employeeId_open_idx" of
-- 20260707153614_add_performance_indexes is the precedent), so this file keeps the CI drift guard empty. The
-- generated sibling migration only adds the plain (employeeId, date) index. Measured, not assumed: replaying
-- the chain and running the exact CI drift command against a fresh shadow database exits 0 (spike S1, 70b-01).
--
-- Why the old index is dropped HERE and not in the generated migration: Prisma does not see the partial unique
-- index "TimeEntry_employeeId_date_unique_not_deleted" (it has a WHERE clause), so removing its @@unique from
-- schema.prisma generates no DROP INDEX. Left in place it would keep refusing a second entry per day.
--
-- What replaces it:
--   1. An exclusion constraint: no two non-deleted CLOSED entries of one employee overlap, on any dates (an entry
--      spanning midnight is covered). Half-open [start, end): back-to-back entries are allowed; a zero-length row
--      is an empty range and overlaps nothing; an inverted row (end < start) is refused by the range constructor
--      (SQLSTATE 22000). Open entries are deliberately outside the constraint: an unbounded range would let a
--      forgotten clock-out block every later day (the v1.8.13 regression).
--   2. A partial unique index: at most one OPEN non-deleted entry per employee and day. It keeps the clock
--      resolver's unique-violation contract (a concurrent second clock-in is answered ALREADY_CLOCKED_IN).
--
-- Pre-deploy: run `apps/api/scripts/audit-70-entry-overlaps.ts` (read-only, ids only) against the target
-- database first; ADD CONSTRAINT aborts the whole deploy if a legacy row violates it.
--
-- Valid on PostgreSQL 17 (prod) and 18 (int, CI). btree_gist is a contrib module shipped with the server image
-- and creatable by the application's database user.

DROP INDEX "TimeEntry_employeeId_date_unique_not_deleted";

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "TimeEntry"
  ADD CONSTRAINT "TimeEntry_no_overlap_closed"
  EXCLUDE USING gist ("employeeId" WITH =, tstzrange("startTime", "endTime", '[)') WITH &&)
  WHERE ("deletedAt" IS NULL AND "endTime" IS NOT NULL);

CREATE UNIQUE INDEX "TimeEntry_employeeId_date_open_unique"
  ON "TimeEntry"("employeeId", "date")
  WHERE "deletedAt" IS NULL AND "endTime" IS NULL;
