-- Read-only role of the invariant checker (Issue #715). Run as the database owner AFTER the api has
-- applied its migrations (bin/sim.sh ro-role does it). The role can neither write nor read the
-- credential tables; on top of that every session of it starts read-only.
\set ON_ERROR_STOP on

SELECT 'CREATE ROLE clokr_sim_ro LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'clokr_sim_ro')
\gexec

ALTER ROLE clokr_sim_ro WITH LOGIN PASSWORD :'ro_password';
ALTER ROLE clokr_sim_ro SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE clokr TO clokr_sim_ro;
GRANT USAGE ON SCHEMA public TO clokr_sim_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO clokr_sim_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE clokr IN SCHEMA public GRANT SELECT ON TABLES TO clokr_sim_ro;

-- The checker has no use for credentials, tokens or device keys.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['User', 'RefreshToken', 'OtpToken', 'Invitation', 'OperatorAccount',
                           'TerminalApiKey', 'PresenceSource', 'ApiKey']
  LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM clokr_sim_ro', t);
    END IF;
  END LOOP;
END $$;
