-- Phase 88 (#88, D-07a) — OperatorAuditLog is append-only at the database level.
--
-- Prisma does not model triggers, so this migration is hand-written DDL only; the generated migration
-- that created the table stays untouched. The guard refuses every UPDATE and TRUNCATE, and every DELETE
-- except one: a transaction that set the transaction-local flag clokr.operator_audit_retention = 'on'
-- (done only by purgeExpiredOperatorAudit in contexts/platform/operator-audit.ts) deleting a row older
-- than 12 months. The 12-month floor holds even for a misused flag, so no event younger than the shortest
-- retention class can ever be erased.
--
-- Protection level: accident- and application-bug-proof, NOT insider-proof — the table owner can drop
-- the trigger. That residual risk is accepted and documented in the phase decisions (D-07a).

CREATE OR REPLACE FUNCTION operator_audit_log_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('clokr.operator_audit_retention', true) = 'on'
     AND OLD."createdAt" < now() - interval '12 months' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'OperatorAuditLog is append-only (% refused)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER operator_audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON "OperatorAuditLog"
  FOR EACH ROW EXECUTE FUNCTION operator_audit_log_guard();

CREATE TRIGGER operator_audit_log_no_truncate
  BEFORE TRUNCATE ON "OperatorAuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION operator_audit_log_guard();
