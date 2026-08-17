-- Run this in Supabase SQL Editor before setting DATA_DRIVER=supabase.

create table if not exists members (
  member_id text primary key,
  created_at timestamptz not null default now(),
  first_name text not null default '',
  last_name text not null default '',
  email text not null,
  email_lc text not null unique,
  phone text not null default '',
  password_hash text not null,
  payment_customer_id text not null default '',
  subscription_id text not null default '',
  membership_status text not null default 'none',
  member_since timestamptz,
  account_status text not null default 'active',
  membership_expiry timestamptz,
  network_status text not null default 'out',
  network_visibility jsonb not null default '{"email":true,"phone":false,"projects":true,"tenures":true,"commodities":true}',
  profile jsonb not null default '{"bio":"","company":"","role":"","location":"","avatar":"","socials":{"website":"","linkedin":"","facebook":"","x":""},"expertise":[]}'
);

create index if not exists members_membership_idx on members (membership_status, account_status);
create index if not exists members_network_idx on members (network_status);

create table if not exists projects (
  id text primary key,
  created_at timestamptz not null default now(),
  member_id text not null references members(member_id) on delete restrict,
  first_name text not null default '',
  last_name text not null default '',
  email text not null default '',
  phone text not null default '',
  title text not null default '',
  operator text not null default '',
  tenures_text text not null default '',
  commodities_text text not null default '',
  deposit_types_text text not null default '',
  project_stage text not null default '',
  resource_estimate text not null default '',
  resource_source text not null default '',
  website text not null default '',
  status text not null default 'Pending',
  documents_text text not null default '',
  review_note text not null default '',
  reviewed_by text not null default '',
  reviewed_at timestamptz,
  archived boolean not null default false,
  -- Google Drive folder link supplied by the project owner, replacing the
  -- per-project file uploads. Empty string means the owner has not set one.
  data_room_url text not null default ''
);

-- Existing deployments: add the column without touching any existing row.
alter table projects add column if not exists data_room_url text not null default '';

create index if not exists projects_member_idx on projects (member_id);
create index if not exists projects_status_idx on projects (status, archived);
create index if not exists projects_created_idx on projects (created_at desc);

create table if not exists project_submissions (
  id text primary key references projects(id) on delete cascade,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists project_documents (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  object_path text not null,
  file_name text not null,
  title text not null default '',
  size_bytes bigint not null default 0,
  mime_type text not null default '',
  uploaded_at timestamptz not null default now()
);

create index if not exists project_documents_project_idx on project_documents (project_id);

create table if not exists portal_settings (
  key text primary key,
  value jsonb not null
);

create table if not exists activity (
  id bigserial primary key,
  type text not null,
  actor_member_id text,
  actor_name text,
  project_id text,
  project_title text,
  summary text not null,
  created_at timestamptz not null default now()
);
create index if not exists activity_created_idx on activity (created_at desc);
create index if not exists activity_project_idx on activity (project_id);

create table if not exists notifications (
  id bigserial primary key,
  member_id text not null,
  type text not null,
  title text not null,
  body text,
  link text,
  dedupe_key text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_member_idx on notifications (member_id, created_at desc);
create unique index if not exists notifications_dedupe_idx
  on notifications (member_id, dedupe_key) where dedupe_key is not null;

create table if not exists favorites (
  member_id text not null,
  project_id text not null,
  created_at timestamptz not null default now(),
  primary key (member_id, project_id)
);
create index if not exists favorites_project_idx on favorites (project_id);

create table if not exists events (
  id bigserial primary key,
  title text not null,
  category text not null,
  description text,
  location text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  capacity integer,
  registration_open boolean not null default true,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists events_start_idx on events (starts_at);

create table if not exists event_registrations (
  event_id bigint not null references events(id) on delete cascade,
  member_id text not null,
  member_name text,
  member_email text,
  created_at timestamptz not null default now(),
  primary key (event_id, member_id)
);

create table if not exists event_files (
  id bigserial primary key,
  event_id bigint not null references events(id) on delete cascade,
  file_name text not null,
  stored_name text not null,
  size bigint,
  mime_type text,
  created_at timestamptz not null default now()
);
create index if not exists event_files_event_idx on event_files (event_id);

create table if not exists resources (
  id bigserial primary key,
  title text not null,
  category text not null,
  description text,
  file_name text,
  stored_name text,
  size bigint,
  mime_type text,
  external_url text,
  uploaded_by text,
  created_at timestamptz not null default now()
);
create index if not exists resources_category_idx on resources (category, created_at desc);

create table if not exists student_verifications (
  member_id text primary key,
  institution text,
  school_email text not null,
  email_domain text not null,
  code_hash text,
  status text not null default 'pending',
  requested_at timestamptz not null default now(),
  expires_at timestamptz,
  verified_at timestamptz
);
create index if not exists student_verifications_status_idx on student_verifications (status, requested_at desc);

create table if not exists tenure_watch (
  tenure_number text primary key,
  status text,
  title_type text,
  issue_date text,
  anniversary text,
  expiry text,
  area_ha numeric,
  holder text,
  checked_at timestamptz not null default now(),
  missing boolean not null default false
);

create table if not exists tenure_alerts (
  id bigserial primary key,
  member_id text not null,
  tenure_number text not null,
  kind text not null,
  milestone text not null,
  due_date text,
  created_at timestamptz not null default now(),
  unique (member_id, tenure_number, kind, milestone, due_date)
);
create index if not exists tenure_alerts_member_idx on tenure_alerts (member_id, created_at desc);

create table if not exists claim_neighbours (
  member_id text not null,
  tenure_number text not null,
  neighbour_tenure text not null,
  neighbour_member text,
  status text,
  title_type text,
  expiry text,
  updated_at timestamptz not null default now(),
  primary key (member_id, tenure_number, neighbour_tenure)
);
create index if not exists claim_neighbours_member_idx on claim_neighbours (member_id);

create table if not exists claim_alerts (
  id bigserial primary key,
  member_id text not null,
  name text not null,
  criteria jsonb not null,
  frequency text not null default 'instant',
  channel text not null default 'both',
  paused boolean not null default false,
  last_run_at timestamptz,
  match_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists claim_alerts_member_idx on claim_alerts (member_id, created_at desc);
create index if not exists claim_alerts_active_idx on claim_alerts (paused);

create table if not exists alert_areas (
  id bigserial primary key,
  member_id text not null,
  name text not null,
  geojson jsonb not null,
  bbox jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists alert_areas_member_idx on alert_areas (member_id);

create table if not exists alert_matches (
  id bigserial primary key,
  alert_id bigint not null references claim_alerts(id) on delete cascade,
  member_id text not null,
  tenure_number text not null,
  reason text not null,
  detail jsonb,
  notified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (alert_id, tenure_number, reason)
);
create index if not exists alert_matches_member_idx on alert_matches (member_id, created_at desc);
create index if not exists alert_matches_pending_idx on alert_matches (notified_at);

create table if not exists watchlist_items (
  id bigserial primary key,
  member_id text not null,
  kind text not null,
  value text not null,
  created_at timestamptz not null default now(),
  unique (member_id, kind, value)
);
create index if not exists watchlist_items_member_idx on watchlist_items (member_id);
