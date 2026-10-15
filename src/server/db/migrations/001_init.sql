create extension if not exists citext;

create table settings (key text primary key, value jsonb not null);
insert into settings (key, value) values ('mode', '"personal"');

create table users (
  id uuid primary key default gen_random_uuid(),
  email citext unique not null,
  name text,
  role text not null check (role in ('owner','admin','member','viewer')),
  status text not null check (status in ('invited','active','offboarding','disabled')),
  password_hash text,
  created_at timestamptz not null default now()
);
create unique index users_one_owner on users ((true)) where role = 'owner';

create table sessions (
  id_hash text primary key,
  user_id uuid not null references users on delete cascade,
  expires_at timestamptz not null
);

create table invites (
  token_hash text primary key,
  user_id uuid not null references users on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table sources (
  id text primary key,
  kind text not null check (kind in ('private','company')),
  owner_user_id uuid references users,
  name text not null,
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now(),
  check ((kind = 'private') = (owner_user_id is not null))
);

create table grants (
  user_id uuid not null references users on delete cascade,
  source_id text not null references sources,
  agent_reads boolean not null default true,
  primary key (user_id, source_id)
);

create table gbrain_clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users,
  purpose text not null check (purpose in ('agent','ui','company_writer','instance')),
  write_source text references sources,
  gbrain_client_id text not null,
  token_enc text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index gbrain_clients_live on gbrain_clients (user_id, purpose) where revoked_at is null;

create table api_keys (
  key_hash text primary key,
  user_id uuid not null references users on delete cascade,
  label text not null default 'cli',
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table collector_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users,
  source_id text not null,
  collector text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null check (status in ('running','ok','partial','error','timeout')),
  exit_code int,
  timeout_s int not null default 1200,
  summary text,
  log_tail text
);
create index collector_runs_recent on collector_runs (source_id, collector, started_at desc);

create table audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor_user_id uuid,
  action text not null,
  target text,
  detail jsonb
);
