-- ═══════════════════════════════════════════════════════════════════════
-- Postgres functions called via dbRpc() from the orchestrator.
--
-- ⚠️ RECONSTRUCTED FROM CALL SITES, not dumped from the live database.
--    Argument names and result columns are exact (the backend depends on
--    them); the internal logic is inferred from how results are consumed.
--    Validate against real data before trusting the numbers.
-- ═══════════════════════════════════════════════════════════════════════

-- ── kb_match ───────────────────────────────────────────────────────────
-- Called: dbRpc('kb_match', { query_embedding, match_kb_id, match_count })
-- Consumed: row.source_name, row.content, row.similarity
--           similarity is 0..1 (backend multiplies by 100 and filters >= 0.45)
create or replace function kb_match(
  query_embedding vector,
  match_kb_id     uuid,
  match_count     int
)
returns table (
  id          uuid,
  source_name text,
  chunk_index int,
  content     text,
  similarity  double precision
)
language sql stable as $$
  select
    c.id,
    c.source_name,
    c.chunk_index,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity   -- cosine similarity
  from kb_chunks c
  where c.kb_id = match_kb_id
    and c.embedding is not null
  order by c.embedding <=> query_embedding                -- nearest first
  limit match_count;
$$;

-- ── channel_funnel ─────────────────────────────────────────────────────
-- Called: dbRpc('channel_funnel', { p_tenant, p_from, p_to })
--   p_tenant may be NULL  → aggregate across all tenants
--   p_from / p_to default to the strings '-infinity' / 'infinity'
-- Consumed: { source, leads, customers, value }
-- Leads come from `leads`; customers + value come from won `bookings`.
create or replace function channel_funnel(
  p_tenant text,
  p_from   text,
  p_to     text
)
returns table (
  source    text,
  leads     bigint,
  customers bigint,
  value     numeric
)
language sql stable as $$
  with bounds as (
    select p_from::timestamptz as ts_from, p_to::timestamptz as ts_to
  ),
  l as (
    select coalesce(nullif(campaign_source, ''), 'unknown') as source,
           count(*) as leads
    from leads, bounds
    where (p_tenant is null or tenant_id = p_tenant)
      and created_at >= bounds.ts_from
      and created_at <= bounds.ts_to
    group by 1
  ),
  b as (
    select coalesce(nullif(campaign_source, ''), 'unknown') as source,
           count(*)                    as customers,
           coalesce(sum(amount_myr), 0) as value
    from bookings, bounds
    where (p_tenant is null or tenant_id = p_tenant)
      and status = 'won'
      and booked_at >= bounds.ts_from
      and booked_at <= bounds.ts_to
    group by 1
  )
  select
    coalesce(l.source, b.source)  as source,
    coalesce(l.leads, 0)          as leads,
    coalesce(b.customers, 0)      as customers,
    coalesce(b.value, 0)          as value
  from l
  full outer join b on b.source = l.source
  order by 2 desc;
$$;

-- ── refresh_analytics_daily ────────────────────────────────────────────
-- Called: dbRpc('refresh_analytics_daily', { days_back: 31 }); result ignored.
-- Rebuilds the analytics_daily rollup for the trailing window from ad_reports,
-- joining lead counts by campaign + day.
create or replace function refresh_analytics_daily(days_back int default 31)
returns void
language plpgsql as $$
declare
  cutoff date := current_date - days_back;
begin
  delete from analytics_daily where date >= cutoff;

  insert into analytics_daily
    (tenant_id, date, campaign_name, spend_myr, results, cpr,
     new_contacts, cpl, frequency, lead_count)
  -- ad_reports.day is text (may be ''); nullif(...)::date turns '' into NULL
  -- instead of raising, and NULL days fall out of the >= cutoff filter.
  select
    r.tenant_id,
    nullif(r.day, '')::date                       as date,
    r.campaign_name,
    sum(r.amount_spent_myr)                       as spend_myr,
    sum(r.results)                                as results,
    case when sum(r.results) > 0
         then sum(r.amount_spent_myr) / sum(r.results) end          as cpr,
    sum(r.new_messaging_contacts)                 as new_contacts,
    case when sum(r.new_messaging_contacts) > 0
         then sum(r.amount_spent_myr) / sum(r.new_messaging_contacts) end as cpl,
    avg(r.frequency)                              as frequency,
    (select count(*) from leads l
      where l.campaign_source = r.campaign_name
        and l.date = nullif(r.day, '')::date
        and (r.tenant_id is null or l.tenant_id = r.tenant_id)) as lead_count
  from ad_reports r
  where nullif(r.day, '')::date >= cutoff
  group by r.tenant_id, r.day, r.campaign_name;
end $$;
