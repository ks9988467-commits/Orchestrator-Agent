-- ═══════════════════════════════════════════════════════════════════════
-- UCG local schema — 28 tables
--
-- ⚠️ RECONSTRUCTED from the 187 db*() call sites in orchestrator/index.ts,
--    NOT dumped from the live Supabase database. Column names are exact
--    (the backend depends on them). Types are inferred from the JS values
--    written to them. Expect to adjust some types once real data flows.
--
-- Deliberate design decisions (each traceable to code evidence):
--   • agents.id is TEXT — the code compares it to slugs ('chat','crm',…).
--   • conversations.id / otp_requests.id are BIGSERIAL — the code orders by
--     id.desc and filters `lt.${id}`, which requires a monotonic number.
--   • tenant_id is TEXT (not uuid FK) — automation_rules, automation_logs and
--     ugc_platform_rules write the literal string 'default' when no tenant is
--     set, which a uuid column would reject.
--   • No FOREIGN KEYs: the 'default' tenant fallback and slug ids make strict
--     referential integrity impossible without changing app behaviour.
--   • kb_chunks.embedding is vector(768) — every provider is normalized to
--     768 dims (OpenAI dimensions=768, Google text-embedding-004 native).
-- ═══════════════════════════════════════════════════════════════════════

create extension if not exists vector;
create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- ── Tenancy ────────────────────────────────────────────────────────────
create table tenants (
  id            uuid primary key default gen_random_uuid(),
  name          text,
  slug          text unique,
  contact_name  text,
  contact_email text,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create table tenant_users (
  id        uuid primary key default gen_random_uuid(),
  email     text not null,
  tenant_id text not null,
  role      text not null default 'member',
  created_at timestamptz not null default now(),
  unique (email, tenant_id)              -- dbUpsert onConflict 'email,tenant_id'
);

-- ── Agents ─────────────────────────────────────────────────────────────
create table agents (
  id            text primary key,        -- slug: 'chat','crm','account','code','ugc'
  name          text,
  system_prompt text,
  provider      text,
  model         text,
  active        boolean not null default true,
  description   text,
  uses_tools    boolean not null default false,
  tenant_id     text,
  updated_at    timestamptz,
  created_at    timestamptz not null default now()
);

create table agent_versions (
  id            uuid primary key default gen_random_uuid(),
  agent_id      text not null,
  version       int  not null,
  system_prompt text,
  provider      text,
  model         text,
  note          text,
  saved_at      timestamptz not null default now(),
  unique (agent_id, version)
);

create table agent_skills (
  id         bigserial primary key,      -- deleted via id in.(…)
  agent      text,
  skill      text,
  created_at timestamptz not null default now()
);

create table agent_suggestions (
  id         bigserial primary key,      -- patched via id in.(…)
  message    text,
  session_id text,
  tenant_id  text,
  handled    boolean not null default false,
  asked_at   timestamptz not null default now()
);

create table agent_tasks (
  id           uuid primary key default gen_random_uuid(),
  goal         text,
  plan         jsonb,                    -- TaskStep[]
  status       text not null default 'pending',
  current_step int  not null default 0,
  output       jsonb,                    -- { [stepId]: result }
  final_output text,
  session_id   text,
  tenant_id    text,
  updated_at   timestamptz,
  created_at   timestamptz not null default now()
);

-- ── Conversations / memory ─────────────────────────────────────────────
create table conversations (
  id         bigserial primary key,      -- MUST be ordered: filtered `lt.${id}`
  session_id text,
  role       text,
  content    text,
  agent      text,
  tokens_in  int,
  tokens_out int,
  cost_usd   numeric,
  tenant_id  text,
  created_at timestamptz not null default now()
);

create table user_prefs (
  id         bigserial primary key,      -- deleted via id in.(…)
  key        text not null unique,       -- dbUpsert onConflict 'key' (global)
  value      text,
  confidence numeric,
  updated_at timestamptz not null default now()
);

-- ── Knowledge base (pgvector) ──────────────────────────────────────────
create table knowledge_bases (
  id          uuid primary key default gen_random_uuid(),
  name        text,
  description text,
  agent_id    text,
  embed_model text,
  tenant_id   text,
  created_at  timestamptz not null default now()
);

create table kb_chunks (
  id          uuid primary key default gen_random_uuid(),
  kb_id       uuid not null,
  source_name text,
  chunk_index int,
  content     text,
  embedding   vector(768),               -- '[0.1,-0.2,…]' text literal cast by PG
  tenant_id   text,
  created_at  timestamptz not null default now()
);

-- ── Marketing / analytics ──────────────────────────────────────────────
create table leads (
  id              uuid primary key default gen_random_uuid(),
  date            date,
  name            text,
  phone           text,
  email           text,
  labels          text,
  campaign_source text,
  tenant_id       text,
  created_at      timestamptz not null default now()
);

create table ad_reports (
  id                     uuid primary key default gen_random_uuid(),
  campaign_name          text,
  -- text, not date: the backend writes String(row.date_start || ''), which can
  -- be '' — a date column would reject that insert. Values are ISO YYYY-MM-DD,
  -- so gte/lte string filters still compare correctly.
  day                    text,
  starts                 text,
  ends                   text,
  amount_spent_myr       numeric,
  impressions            int,
  reach                  int,
  frequency              numeric,
  cpm                    numeric,
  ctr_all                numeric,
  link_clicks            int,
  cpc_link               numeric,
  results                int,
  cost_per_result        numeric,
  new_messaging_contacts int,
  tenant_id              text,
  created_at             timestamptz not null default now(),
  unique (campaign_name, day)            -- dbUpsert onConflict 'campaign_name,day'
);

create table analytics_daily (
  id            bigserial primary key,
  date          date,
  campaign_name text,
  spend_myr     numeric,
  results       int,
  cpr           numeric,
  new_contacts  int,
  cpl           numeric,
  frequency     numeric,
  lead_count    int,
  tenant_id     text
);

create table bookings (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       text,
  lead_id         uuid,
  campaign_source text,
  customer_name   text,
  amount_myr      numeric not null default 0,
  service_type    text,
  status          text not null default 'won',
  booked_at       timestamptz not null default now(),
  notes           text
);

-- ── Alerts ─────────────────────────────────────────────────────────────
create table alert_rules (
  id              uuid primary key default gen_random_uuid(),
  name            text,
  metric          text,                  -- frequency | cpl | cpr | spend
  threshold       numeric,
  operator        text default 'gt',
  campaign_filter text,
  active          boolean not null default true,
  tenant_id       text,
  created_at      timestamptz not null default now()
);

create table alerts (
  id            uuid primary key default gen_random_uuid(),
  rule_id       uuid,
  rule_name     text,
  campaign_name text,
  metric        text,
  value         numeric,
  threshold     numeric,
  tenant_id     text,
  triggered_at  timestamptz not null default now()
);

-- ── Automation ─────────────────────────────────────────────────────────
create table automation_rules (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         text,                -- may be the literal 'default'
  name              text,
  description       text,
  trigger_type      text default 'schedule',
  trigger_config    jsonb default '{}'::jsonb,
  action_type       text default 'dashboard_alert',
  action_config     jsonb default '{}'::jsonb,
  enabled           boolean not null default true,
  created_by        text,
  last_run_at       timestamptz,
  last_triggered_at timestamptz,
  updated_at        timestamptz,
  created_at        timestamptz not null default now()
);

create table automation_logs (
  id           uuid primary key default gen_random_uuid(),
  rule_id      uuid,                     -- null for the daily digest
  tenant_id    text,
  trigger_data jsonb,
  action_taken text,
  message      text,
  status       text default 'ok',
  read         boolean not null default false,
  triggered_at timestamptz not null default now()
);

-- ── Workflows ──────────────────────────────────────────────────────────
create table workflows (
  id                   uuid primary key default gen_random_uuid(),
  name                 text,
  description          text,
  agent_id             text,
  prompt               text,
  schedule             text,
  active               boolean not null default true,
  next_run             timestamptz,
  last_run             timestamptz,
  run_count            int not null default 0,
  notification_channel text,
  notify_to            text,
  nodes                jsonb default '[]'::jsonb,
  edges                jsonb default '[]'::jsonb,
  tenant_id            text,
  updated_at           timestamptz,
  created_at           timestamptz not null default now()
);

create table workflow_runs (
  id          uuid primary key default gen_random_uuid(),
  workflow_id uuid,
  response    text,
  error       text,
  ran_at      timestamptz not null default now()
);

-- ── Document review ────────────────────────────────────────────────────
create table department_routes (
  id                  uuid primary key default gen_random_uuid(),
  department          text,
  reviewer_name       text,
  reviewer_email      text,
  reviewer_company_id text,
  active              boolean not null default true,
  tenant_id           text,
  created_at          timestamptz not null default now()
);

create table reviews (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             text,
  file_name             text,
  file_type             text,
  file_content          text,
  file_url              text,
  department            text,
  classification_reason text,
  key_info              jsonb,
  summary               text,
  submitted_by          text,
  submitted_by_staff_id text,
  reviewer_route_id     uuid,
  status                text not null default 'pending',
  review_notes          text,
  reviewed_at           timestamptz,
  notified_at           timestamptz,
  created_at            timestamptz not null default now()
);

create table data_entries (
  id              uuid primary key default gen_random_uuid(),
  file_name       text,
  file_url        text,
  file_type       text,
  data_type       text,
  structured_data jsonb,
  summary         text,
  tenant_id       text,
  created_at      timestamptz not null default now()
);

-- ── Integrations / auth / config ───────────────────────────────────────
create table api_integrations (
  id          uuid primary key default gen_random_uuid(),
  service     text not null,             -- slack | lark | whatsapp | sendgrid | …
  credentials jsonb,
  active      boolean not null default true,
  tenant_id   text,
  created_at  timestamptz not null default now()
);

create table provider_config (
  id       uuid primary key default gen_random_uuid(),
  provider text not null unique,         -- anthropic | openai | google | openrouter
  api_key  text,
  model    text,
  active   boolean not null default true
);

create table otp_requests (
  id         bigserial primary key,      -- ordered id.desc; String(id) in JS
  email      text not null,
  code       text not null,              -- 6-digit string
  used       boolean not null default false,
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  created_at timestamptz not null default now()
);

-- ── UGC studio ─────────────────────────────────────────────────────────
create table ugc_platform_rules (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  text not null,              -- may be the literal 'default'
  platform   text not null,              -- tiktok | ig_reels | xiaohongshu | …
  max_words  text,                       -- descriptive, e.g. '正文200-400字'
  style      text,
  special    text,
  updated_at timestamptz not null default now(),
  unique (tenant_id, platform)           -- dbUpsert onConflict
);

-- ═══════════════════════════════════════════════════════════════════════
-- Indexes — driven by the filters/orders actually used in the backend
-- ═══════════════════════════════════════════════════════════════════════

-- tenant scoping (tenantFilters() is applied on almost every read)
create index on conversations   (tenant_id);
create index on agent_tasks     (tenant_id);
create index on workflows       (tenant_id);
create index on automation_rules(tenant_id);
create index on automation_logs (tenant_id);
create index on ad_reports      (tenant_id);
create index on analytics_daily (tenant_id);
create index on leads           (tenant_id);
create index on knowledge_bases (tenant_id);
create index on kb_chunks       (tenant_id);
create index on department_routes(tenant_id);
create index on reviews         (tenant_id);
create index on alert_rules     (tenant_id);
create index on alerts          (tenant_id);
create index on bookings        (tenant_id);

-- hot paths
create index on conversations (session_id, id desc);      -- history + `lt.${id}`
create index on conversations (created_at);
create index on agent_skills  (agent, created_at desc);
create index on kb_chunks     (kb_id, source_name);       -- dedup delete
create index on workflows     (active, next_run);         -- scheduler sweep
create index on workflow_runs (workflow_id);
create index on leads         (date);
create index on leads         (created_at);
create index on ad_reports    (starts);
create index on analytics_daily (date);
create index on bookings      (booked_at);
create index on alerts        (triggered_at desc);
create index on automation_logs (triggered_at desc);
create index on otp_requests  (email, id desc);
create index on tenant_users  (email);
create index on api_integrations (service, active);
create index on reviews       (status, created_at desc);

-- ANN index for kb_match() cosine search
create index on kb_chunks using hnsw (embedding vector_cosine_ops);
