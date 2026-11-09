-- Phase 842 (Issue #842, D-842-17 / D-842-19) - stored UI preferences follow the redesigned theme
-- set: the themes `nacht` and `schiefer` become `salz`, `wald` becomes `petrol`, and the retired
-- `skin` and `density` keys are removed from the stored object.
--
-- DATA ONLY: no table, column, index, type or constraint is created, altered or dropped
-- (`prisma migrate diff` against the migration history stays empty). It is one UPDATE on "User"
-- and touches only rows whose "uiPreferences" is a JSON object that holds `skin`, `density` or a
-- retired theme id; a SQL NULL, a JSON null, an array or a scalar is skipped. A stored theme
-- outside the known ids is left alone (the API falls back to `pflaume` on read).
-- IDEMPOTENT and REPLAY-SAFE: after the first run no row matches the predicate any more, so a
-- replay changes no row. "updatedAt" is deliberately not touched - this is a data fix, not a user
-- edit.
--
-- Not audit-relevant: a UI preference is neither working-time, leave nor payroll data, so no
-- "AuditLog" row is written (same reasoning as PUT /api/v1/me/preferences).
--
-- The mapping also lives in code (apps/api/src/contexts/platform/ui-theme.ts, normalizeUiTheme);
-- the replay test src/__tests__/ui-preferences-migration-842.test.ts pins the two against each
-- other. Changing the mapping again means a NEW migration, never an edit of this file.

UPDATE "User"
SET "uiPreferences" =
      (("uiPreferences" - 'skin') - 'density')
      || CASE
           WHEN "uiPreferences" ->> 'theme' IN ('nacht', 'schiefer') THEN '{"theme":"salz"}'::jsonb
           WHEN "uiPreferences" ->> 'theme' = 'wald' THEN '{"theme":"petrol"}'::jsonb
           ELSE '{}'::jsonb
         END
WHERE jsonb_typeof("uiPreferences") = 'object'
  AND (
        jsonb_exists("uiPreferences", 'skin')
        OR jsonb_exists("uiPreferences", 'density')
        OR "uiPreferences" ->> 'theme' IN ('nacht', 'schiefer', 'wald')
      );
