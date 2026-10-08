-- ═══════════════════════════════════════════════════════════════════════
-- Tables, columns and constraints used by the dashboard frontend.
--
-- 01-schema.sql was reconstructed from the backend (orchestrator/index.ts)
-- only, so it missed everything the frontend queried directly through
-- supabase-js. These definitions are inferred from those 86 call sites in
-- app-*.js (payload keys, filters, how values are used).
--
-- Idempotent: runs on a fresh init (after 01 and 02) and can also be applied
-- to an existing local database:
--   docker exec -i ucg-postgres psql -U ucg -d ucg < local/initdb/03-frontend-tables.sql
-- ═══════════════════════════════════════════════════════════════════════

-- ── Ad accounts (leads / ad_reports can be filtered by account) ─────────
create table if not exists accounts (
  id         text primary key,            -- only ever used as a string option value
  name       text,
  active     boolean not null default true,
  tenant_id  text,
  created_at timestamptz not null default now()
);

alter table leads      add column if not exists account_id text;
alter table ad_reports add column if not exists account_id text;
create index if not exists leads_account_id_idx      on leads (account_id);
create index if not exists ad_reports_account_id_idx on ad_reports (account_id);

-- ── Staff and tasks ────────────────────────────────────────────────────
create table if not exists staff (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  avatar     text,                        -- emoji
  role       text,
  department text,
  active     boolean not null default true,  -- UI soft-deletes by toggling this
  tenant_id  text,                        -- frontend writes the literal 'default'
  created_at timestamptz not null default now()
);

create table if not exists tasks (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  description text,
  assignee_id uuid references staff (id) on delete set null,
  created_by  uuid references staff (id) on delete set null,
  priority    text not null default 'normal',   -- high | normal | low
  status      text not null default 'todo',     -- todo | in_progress | done (insert omits it)
  due_date    date,                             -- round-trips through <input type=date>
  tenant_id   text,
  updated_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists tasks_assignee_id_idx on tasks (assignee_id);
create index if not exists tasks_status_idx      on tasks (status);
create index if not exists tasks_created_at_idx  on tasks (created_at desc);

-- ── Direct messages between staff ──────────────────────────────────────
create table if not exists direct_messages (
  id         uuid primary key default gen_random_uuid(),
  from_id    uuid not null references staff (id),
  to_id      uuid not null references staff (id),
  content    text not null,
  read_at    timestamptz,                  -- null = unread
  tenant_id  text,
  created_at timestamptz not null default now()
);
create index if not exists direct_messages_pair_idx   on direct_messages (from_id, to_id, created_at);
create index if not exists direct_messages_unread_idx on direct_messages (to_id) where read_at is null;

-- ── Document approval ──────────────────────────────────────────────────
create table if not exists documents (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  notes       text,
  file_url    text,                        -- optional attachment
  file_name   text,
  file_type   text,                        -- MIME type
  file_size   bigint,                      -- bytes
  status      text not null default 'pending',  -- pending | partial | approved | rejected
  tenant_id   text,
  uploaded_by text,                        -- uploader email
  created_at  timestamptz not null default now()
);
create index if not exists documents_tenant_created_idx on documents (tenant_id, created_at desc);
create index if not exists documents_status_idx         on documents (status);

create table if not exists document_reviewers (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents (id) on delete cascade,  -- deleting a document removes its reviewers
  name        text not null,
  contact     text,                        -- email or WhatsApp number
  decision    text,                        -- null | approved | rejected
  comment     text,
  decided_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists document_reviewers_document_idx on document_reviewers (document_id);
create index if not exists document_reviewers_contact_idx  on document_reviewers (contact);

-- ── Columns missing on existing tables ─────────────────────────────────
alter table conversations    add column if not exists feedback    text;        -- 'good' | 'bad' | null
alter table api_integrations add column if not exists updated_at  timestamptz;
alter table analytics_daily  add column if not exists impressions int;
alter table analytics_daily  add column if not exists link_clicks int;

-- ── Constraints ────────────────────────────────────────────────────────
-- The frontend upserts integrations on `service` alone (one row per service).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'api_integrations_service_key') then
    alter table api_integrations add constraint api_integrations_service_key unique (service);
  end if;
end $$;
