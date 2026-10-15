-- Issue #93 (Phase 93b, D-07/D-25) — SupportAccess is immutable except for ONE transition.
--
-- Prisma does not model triggers or CHECK constraints and `prisma migrate diff` ignores them, so this
-- migration is hand-written DDL only and the CI drift guard stays empty; the generated migration that
-- created the table stays untouched.
--
-- The guard refuses TRUNCATE, every DELETE and every UPDATE, with two exceptions:
--   1. The end transition: an UPDATE whose OLD row has endedAt, endedBy and endedByUserId all NULL, whose
--      NEW row sets endedAt and endedBy, and which changes no other column. A grant can therefore be
--      ended once and never edited afterwards (a second UPDATE finds a non-NULL endedAt and is refused).
--   2. The retention purge: a DELETE inside a transaction that set the transaction-local flag
--      clokr.support_access_retention = 'on' (the same mechanism as clokr.operator_audit_retention of
--      OperatorAuditLog), for a row older than 120 months. The 120-month floor holds even for a misused
--      flag, so no grant younger than the lifecycle retention class can ever be erased. The purge
--      function itself arrives with a later plan of this phase.
--
-- Protection level: accident- and application-bug-proof, NOT insider-proof — the table owner can drop
-- the trigger. That residual risk is accepted and documented in the phase decisions (D-07).

CREATE OR REPLACE FUNCTION support_access_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."endedAt" IS NULL AND OLD."endedBy" IS NULL AND OLD."endedByUserId" IS NULL
       AND NEW."endedAt" IS NOT NULL AND NEW."endedBy" IS NOT NULL
       AND NEW."id" = OLD."id"
       AND NEW."tenantId" = OLD."tenantId"
       AND NEW."operatorId" = OLD."operatorId"
       AND NEW."reason" = OLD."reason"
       AND NEW."startedAt" = OLD."startedAt"
       AND NEW."expiresAt" = OLD."expiresAt"
       AND NEW."createdAt" = OLD."createdAt" THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF current_setting('clokr.support_access_retention', true) = 'on'
       AND OLD."createdAt" < now() - interval '120 months' THEN
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION 'SupportAccess is append-only (% refused)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER support_access_no_update_delete
  BEFORE UPDATE OR DELETE ON "SupportAccess"
  FOR EACH ROW EXECUTE FUNCTION support_access_guard();

CREATE TRIGGER support_access_no_truncate
  BEFORE TRUNCATE ON "SupportAccess"
  FOR EACH STATEMENT EXECUTE FUNCTION support_access_guard();

-- endedBy is one of two control values, or NULL while the grant has not been ended.
ALTER TABLE "SupportAccess" ADD CONSTRAINT "SupportAccess_endedBy_valid"
  CHECK ("endedBy" IS NULL OR "endedBy" IN ('OPERATOR', 'TENANT'));

-- endedAt and endedBy are set together or not at all.
ALTER TABLE "SupportAccess" ADD CONSTRAINT "SupportAccess_end_pair"
  CHECK (("endedAt" IS NULL) = ("endedBy" IS NULL));

-- A grant window has a positive length.
ALTER TABLE "SupportAccess" ADD CONSTRAINT "SupportAccess_window_valid"
  CHECK ("expiresAt" > "startedAt");
