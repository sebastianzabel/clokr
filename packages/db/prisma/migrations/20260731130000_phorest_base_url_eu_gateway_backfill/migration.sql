-- Phorest base URL EU-gateway backfill (Phase 85 gap closure — WR-02).
--
-- The prior migration (20260731120000_phorest_base_url_eu_gateway_default) changed ONLY the
-- column DEFAULT, which in Postgres applies at INSERT time. Every TenantConfig row created before
-- that migration still holds the OLD stored value 'https://api.phorest.com/third-party-api-server'
-- as a non-null value, so the code fallback `cfg.phorestBaseUrl ?? DEFAULT_BASE_URL` never fires
-- for them — an already-configured tenant would hit the WRONG host on the first live sync
-- (fail-closed, but a confusing cutover failure).
--
-- This re-points ONLY rows still on the EXACT old default. Any deliberately customized/EU/null
-- value is left untouched (audit-safe: TenantConfig is configuration, not time/leave audit data,
-- and we never override a value a tenant set on purpose).
UPDATE "TenantConfig"
SET "phorestBaseUrl" = 'https://api-gateway-eu.phorest.com/third-party-api-server'
WHERE "phorestBaseUrl" = 'https://api.phorest.com/third-party-api-server';
