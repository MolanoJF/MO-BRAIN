#!/bin/bash
set -e

# CREATE DATABASE has no IF NOT EXISTS in Postgres. This directory is also
# mounted by compose/docker-compose.slice0.yml, whose POSTGRES_DB=gbrain
# makes the postgres entrypoint pre-create the "gbrain" database before any
# docker-entrypoint-initdb.d script runs -- an unguarded `CREATE DATABASE
# gbrain` aborts the whole init (ON_ERROR_STOP=1) with "database gbrain
# already exists", which breaks slice0's postgres container on every fresh
# volume (verified: `docker compose -f compose/docker-compose.slice0.yml up
# postgres` exits 3 with that error). Guard both so this script is safe
# whichever compose file it runs under.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-'SQL'
  SELECT 'CREATE DATABASE gbrain'  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'gbrain')\gexec
  SELECT 'CREATE DATABASE control' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'control')\gexec
SQL

for db in gbrain control; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<-'SQL'
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
SQL
done
