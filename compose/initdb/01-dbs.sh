#!/usr/bin/env bash
# Runs once, on an empty pg-data volume. Two databases, two roles, one password.
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<SQL
CREATE ROLE gbrain LOGIN PASSWORD '${POSTGRES_PASSWORD}';
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
