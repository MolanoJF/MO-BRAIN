#!/usr/bin/env bash
# Runs once, on an empty pg-data volume. Two databases, two roles, one password.
# Probe P1: a fresh gbrain role cannot finish `gbrain init` without BYPASSRLS, and
# v35 cannot create the event trigger. Pre-create both as the superuser. The
# function must be owned by gbrain or v120 fails with "must be owner of function".
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<SQL
CREATE ROLE gbrain LOGIN PASSWORD '${POSTGRES_PASSWORD}';
ALTER ROLE gbrain BYPASSRLS;
CREATE ROLE mobrain LOGIN PASSWORD '${POSTGRES_PASSWORD}';
CREATE DATABASE gbrain OWNER gbrain;
CREATE DATABASE mobrain OWNER mobrain;
\c gbrain
CREATE EXTENSION IF NOT EXISTS vector;
ALTER SCHEMA public OWNER TO gbrain;
\c mobrain
CREATE EXTENSION IF NOT EXISTS citext;
ALTER SCHEMA public OWNER TO mobrain;
SQL

# SQL copied from the probe (v35 create-if-absent function and trigger), not a guessed migration.
# $body$ must not be expanded by the shell. Trigger owner stays postgres (superuser-only).
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -d gbrain <<'SQL'
CREATE FUNCTION auto_enable_rls()
RETURNS event_trigger AS $body$
DECLARE
  obj record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
    WHERE object_type = 'table'
    AND schema_name = 'public'
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.object_identity);
  END LOOP;
END;
$body$ LANGUAGE plpgsql;

ALTER FUNCTION public.auto_enable_rls() OWNER TO gbrain;

CREATE EVENT TRIGGER auto_rls_on_create_table
  ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  EXECUTE FUNCTION auto_enable_rls();
SQL
