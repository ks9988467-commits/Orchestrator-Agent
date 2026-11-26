// Data actions: home overview, leads, ad reports, data entries, analytics, bookings, channel metrics, costs.
import { dbDelete, dbGet, dbGetPage, dbInsert, dbInsertReturning, dbRpc, dbUpsert } from '../db.ts'
import { type Body, R, tenantFilters } from '../state.ts'
import { signedUrl } from '../storage.ts'

// Search text for an ilike filter, wrapped in `*` wildcards. `"` and `\` are
// removed so the pattern can sit inside quotes in an or=(…) list.
export function likePattern(s: unknown): string {
  return `*${String(s ?? '').replace(/["\\]/g, '').trim()}*`
}

// Rows imported from the dashboard: keep allowed columns, drop blank values
// ('' would be rejected by date/numeric columns) and give every row the same
// keys — a batch insert rejects rows whose keys differ.
export function normalizeImportRows(rows: unknown, cols: string[]): Record<string, unknown>[] {
  if (!Array.isArray(rows)) return []
  const picked = rows.map(r => {
    const out: Record<string, unknown> = {}
    for (const c of cols) {
      const v = (r as Record<string, unknown> | null)?.[c]
      if (v !== undefined && v !== null && String(v).trim() !== '') out[c] = v
    }
    return out
  }).filter(r => Object.keys(r).length > 0)
  const used = cols.filter(c => picked.some(r => c in r))
  return picked.map(r => Object.fromEntries(used.map(c => [c, r[c] ?? null])))
}

export async function insertInChunks(table: string, rows: Record<string, unknown>[]): Promise<{ inserted: number; error?: string }> {
  let inserted = 0
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100)
    const r = await dbInsert(table, chunk)
    if (!r.ok) return { inserted, error: r.error || 'insert failed' }
    inserted += chunk.length
  }
  return { inserted }
}

// Returns the response for one of this module's actions, or undefined for any other action
export async function handleDataActions(body: Body, CORS: Record<string, string>): Promise<Response | undefined> {
  // \u2500\u2500 Sync Facebook Ads \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  if (body.action === 'sync_facebook_ads') {
    try {
      const rows = await dbGet('api_integrations', 'credentials', { service: 'eq.facebook_ads', active: 'eq.true' })
      const creds = (rows[0] as {credentials:Record<string,string>}|undefined)?.credentials
      if (!creds?.access_token || !creds?.ad_account_id)
        return new Response(JSON.stringify({ error: 'Facebook Ads credentials not configured' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })

      const token = creds.access_token
      const accountId = creds.ad_account_id // format: act_XXXXXXXXX

      // Fetch last 30 days of campaign insights
      const dateStop = new Date().toISOString().slice(0,10)
      const dateStart = new Date(Date.now() - 30*24*3600*1000).toISOString().slice(0,10)

      const fields = 'campaign_name,spend,impressions,reach,frequency,clicks,cpm,ctr,actions,cost_per_action_type,date_start,date_stop'
      const url = `https://graph.facebook.com/v18.0/${accountId}/insights?fields=${fields}&time_range={"since":"${dateStart}","until":"${dateStop}"}&time_increment=1&level=campaign&access_token=${token}&limit=500`

      const r = await fetch(url)
      if (!r.ok) throw new Error(`Facebook API ${r.status}: ${await r.text()}`)
      const data = await r.json()
      const insights = data.data || []

      let upserted = 0
      for (const row of insights as Record<string,unknown>[]) {
        const actions = (row.actions as {action_type:string;value:string}[]|undefined) || []
        const costPerAction = (row.cost_per_action_type as {action_type:string;value:string}[]|undefined) || []

        const results = actions.find(a => a.action_type === 'onsite_conversion.messaging_conversation_started_7d' || a.action_type === 'lead')
        const newContacts = actions.find(a => a.action_type === 'onsite_conversion.messaging_conversation_started_7d')
        const cpr = costPerAction.find(a => a.action_type === 'onsite_conversion.messaging_conversation_started_7d' || a.action_type === 'lead')

        const spendMYR = parseFloat(String(row.spend || 0))
        const resultsVal = results ? parseInt(results.value) : 0
        const contactsVal = newContacts ? parseInt(newContacts.value) : 0

        await dbUpsert('ad_reports', {
          campaign_name: String(row.campaign_name || ''),
          day: String(row.date_start || ''),
          starts: String(row.date_start || ''),
          ends: String(row.date_stop || ''),
          amount_spent_myr: spendMYR,
          impressions: parseInt(String(row.impressions || 0)),
          reach: parseInt(String(row.reach || 0)),
          frequency: parseFloat(String(row.frequency || 0)),
          cpm: parseFloat(String(row.cpm || 0)),
          ctr_all: parseFloat(String(row.ctr || 0)),
          link_clicks: parseInt(String(row.clicks || 0)),
          results: resultsVal,
          cost_per_result: cpr ? parseFloat(cpr.value) : null,
          new_messaging_contacts: contactsVal,
          tenant_id: R.tenantId,
        }, 'campaign_name,day')
        upserted++
      }

      // Refresh analytics after sync
      await dbRpc('refresh_analytics_daily', { days_back: 31 })

      return new Response(JSON.stringify({ ok: true, synced: upserted, period: `${dateStart} to ${dateStop}` }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    } catch(e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
  }

  // ── Bookings CRUD (成交/营收记录) ───────────────────────────────────
  if (body.action === 'booking_crud') {
    const tid = R.tenantId || (body.tenant_id ? String(body.tenant_id) : null)
    const m = String(body.method || 'list')

    if (m === 'create') {
      const d = (body.data || {}) as Record<string, unknown>
      const row = await dbInsertReturning('bookings', {
        tenant_id:       tid,
        lead_id:         d.lead_id || null,
        campaign_source: d.campaign_source || null,
        customer_name:   d.customer_name || null,
        amount_myr:      Number(d.amount_myr) || 0,
        service_type:    d.service_type || null,
        status:          d.status || 'won',
        booked_at:       d.booked_at || new Date().toISOString(),
        notes:           d.notes || null,
      })
      return new Response(JSON.stringify({ ok: true, booking: row }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    if (m === 'list') {
      const filt: Record<string,string> = {}
      if (tid) filt['tenant_id'] = `eq.${tid}`
      const rows = await dbGet('bookings', '*', filt, 'booked_at.desc', 200)
      return new Response(JSON.stringify({ ok: true, bookings: rows }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    if (m === 'delete') {
      const bid = String(body.booking_id || '')
      if (bid) await dbDelete('bookings', tid ? { id: `eq.${bid}`, tenant_id: `eq.${tid}` } : { id: `eq.${bid}` })
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ error: 'unknown method' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  // ── Home overview (首页) ─────────────────────────────────────────────
  // The client sends its own local month start (YYYY-MM-DD) and local midnight
  // (ISO), so "this month" / "today" follow the viewer's timezone.
  if (body.action === 'home_summary') {
    const monthStart = String(body.month_start || '')
    const todayStart = new Date(String(body.today_start || ''))
    if (!/^\d{4}-\d{2}-\d{2}$/.test(monthStart) || isNaN(todayStart.getTime())) {
      return new Response(JSON.stringify({ error: 'month_start (YYYY-MM-DD) and today_start (ISO) required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    const [analytics, leads, alerts, recent_convs, active_agents, gaps, skills, today] = await Promise.all([
      dbGet('analytics_daily', 'spend_myr,results,new_contacts,campaign_name', tenantFilters({ date: `gte.${monthStart}` })),
      dbGetPage('leads', 'id', tenantFilters({ date: `gte.${monthStart}` }), undefined, 0),
      dbGet('automation_logs', 'id,message,action_taken,status,read,triggered_at', tenantFilters(), 'triggered_at.desc', 10),
      dbGet('conversations', 'id,role,content,agent,created_at', tenantFilters({ role: 'eq.user' }), 'created_at.desc', 6),
      dbGet('agents', 'id,name', { active: 'eq.true' }, 'id.asc'),
      dbGetPage('agent_suggestions', 'id', tenantFilters({ handled: 'eq.false' }), undefined, 0),
      dbGetPage('agent_skills', 'id', {}, undefined, 0),
      dbGetPage('conversations', 'id', tenantFilters({ role: 'eq.user', created_at: `gte.${todayStart.toISOString()}` }), undefined, 0),
    ])
    return new Response(JSON.stringify({
      ok: true, analytics, alerts, recent_convs, active_agents,
      lead_count: leads.count, gap_count: gaps.count, skill_count: skills.count, today_conv_count: today.count,
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  // ── Data page (数据): accounts / leads / ad reports / data entries / analytics ──
  if (body.action === 'account_crud') {
    const m = String(body.method || 'list')
    if (m === 'list') {
      const accounts = await dbGet('accounts', 'id,name', tenantFilters({ active: 'eq.true' }), 'name.asc')
      return new Response(JSON.stringify({ ok: true, accounts }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ error: 'unknown method' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  if (body.action === 'lead_crud') {
    const m = String(body.method || 'list')
    const filt: Record<string, string> = {}
    if (body.search)     filt['or']         = `(name.ilike."${likePattern(body.search)}",phone.ilike."${likePattern(body.search)}")`
    if (body.from)       filt['date']       = `gte.${String(body.from)}`
    if (body.to)         filt['date2']      = `lte.${String(body.to)}`
    if (body.label)      filt['labels']     = `ilike.${likePattern(body.label)}`
    if (body.account_id) filt['account_id'] = `eq.${String(body.account_id)}`

    if (m === 'list') {
      const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 200)
      const page  = Math.max(Number(body.page) || 1, 1)
      const { rows, count } = await dbGetPage('leads', '*', tenantFilters(filt), 'date.desc', limit, (page - 1) * limit)
      return new Response(JSON.stringify({ ok: true, rows, count }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    if (m === 'export') {
      const rows = await dbGet('leads', 'date,name,phone,email,labels,campaign_source,created_at', tenantFilters(filt), 'date.desc', 10000)
      return new Response(JSON.stringify({ ok: true, rows }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    // phone → id of an existing lead with that phone
    const findConflicts = async (phones: string[]) => {
      const found: Record<string, string> = {}
      const uniq = [...new Set(phones.map(p => p.replace(/["\\]/g, '')).filter(Boolean))]
      for (let i = 0; i < uniq.length; i += 100) {
        const list = uniq.slice(i, i + 100).map(p => `"${p}"`).join(',')
        const rows = await dbGet('leads', 'id,phone', tenantFilters({ phone: `in.(${list})` })) as { id: string; phone: string }[]
        for (const r of rows) found[String(r.phone)] = r.id
      }
      return found
    }
    if (m === 'check_phones') {
      const phones = Array.isArray(body.phones) ? (body.phones as unknown[]).map(String) : []
      return new Response(JSON.stringify({ ok: true, conflicts: await findConflicts(phones) }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    if (m === 'import') {
      // mode: insert | skip (leave leads whose phone exists) | overwrite (replace them)
      const mode = String(body.mode || 'insert')
      if (!['insert', 'skip', 'overwrite'].includes(mode)) return new Response(JSON.stringify({ error: 'unknown mode' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      let rows = normalizeImportRows(body.rows, ['date', 'name', 'phone', 'email', 'labels', 'campaign_source', 'account_id'])
      if (!rows.length || rows.length > 20000) return new Response(JSON.stringify({ error: 'rows: 1–20000 valid rows required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      let skipped = 0, deleteIds: string[] = []
      if (mode !== 'insert') {
        const conflicts = await findConflicts(rows.map(r => String(r.phone ?? '')))
        if (mode === 'skip') {
          skipped = Object.keys(conflicts).length
          rows = rows.filter(r => !conflicts[String(r.phone ?? '')])
        } else {
          deleteIds = Object.values(conflicts)
          const seen = new Set<string>()   // within the file, the first row per phone wins
          rows = rows.filter(r => {
            const ph = String(r.phone ?? '')
            if (!ph) return true
            if (seen.has(ph)) return false
            seen.add(ph); return true
          })
        }
      }
      if (R.tenantId) rows.forEach(r => { r.tenant_id = R.tenantId })
      // Insert first, then delete the leads being replaced: a failed insert leaves the old data intact.
      const res = await insertInChunks('leads', rows)
      if (res.error) return new Response(JSON.stringify({ error: `${res.error}（已导入 ${res.inserted} 条）`, inserted: res.inserted }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
      for (let i = 0; i < deleteIds.length; i += 100) await dbDelete('leads', { id: `in.(${deleteIds.slice(i, i + 100).join(',')})` })
      return new Response(JSON.stringify({ ok: true, inserted: res.inserted, skipped, overwritten: deleteIds.length }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ error: 'unknown method' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  if (body.action === 'ad_report_crud') {
    const m = String(body.method || 'list')
    const COLS = 'campaign_name,day,amount_spent_myr,results,cost_per_result,frequency,cpm,ctr_all,link_clicks,new_messaging_contacts'
    const filt: Record<string, string> = {}
    if (body.search)     filt['campaign_name'] = `ilike.${likePattern(body.search)}`
    if (body.from)       filt['day']           = `gte.${String(body.from)}`
    if (body.to)         filt['day2']          = `lte.${String(body.to)}`
    if (body.account_id) filt['account_id']    = `eq.${String(body.account_id)}`

    if (m === 'list') {
      const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 200)
      const page  = Math.max(Number(body.page) || 1, 1)
      const { rows, count } = await dbGetPage('ad_reports', COLS, tenantFilters(filt), 'amount_spent_myr.desc', limit, (page - 1) * limit)
      return new Response(JSON.stringify({ ok: true, rows, count }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    if (m === 'export') {
      const rows = await dbGet('ad_reports', COLS, tenantFilters(filt), 'day.desc', 10000)
      return new Response(JSON.stringify({ ok: true, rows }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    if (m === 'import') {
      const rows = normalizeImportRows(body.rows, [...COLS.split(','), 'account_id'])
      if (!rows.length || rows.length > 20000) return new Response(JSON.stringify({ error: 'rows: 1–20000 valid rows required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      if (R.tenantId) rows.forEach(r => { r.tenant_id = R.tenantId })
      const res = await insertInChunks('ad_reports', rows)
      if (res.error) return new Response(JSON.stringify({ error: `${res.error}（已导入 ${res.inserted} 条）`, inserted: res.inserted }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
      return new Response(JSON.stringify({ ok: true, inserted: res.inserted }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ error: 'unknown method' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  if (body.action === 'data_entry_crud') {
    const m = String(body.method || 'list')
    if (m === 'list') {
      const filt: Record<string, string> = {}
      if (body.search)    filt['file_name'] = `ilike.${likePattern(body.search)}`
      if (body.file_type) filt['file_type'] = `eq.${String(body.file_type)}`
      const { rows, count } = await dbGetPage('data_entries', '*', tenantFilters(filt), 'created_at.desc', 50, 0)
      for (const r of rows) r.file_url = await signedUrl(r.file_url, 3600)
      return new Response(JSON.stringify({ ok: true, rows, count }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ error: 'unknown method' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  if (body.action === 'analytics_crud') {
    const m = String(body.method || 'list')
    if (m === 'list') {
      const filt: Record<string, string> = {}
      if (body.from) filt['date']  = `gte.${String(body.from)}`
      if (body.to)   filt['date2'] = `lte.${String(body.to)}`
      const rows = await dbGet('analytics_daily', '*', tenantFilters(filt), 'date.desc')
      return new Response(JSON.stringify({ ok: true, rows }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ error: 'unknown method' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  // ── Channel funnel metrics (CAC / 转化率 / ROAS / LTV:CAC) ──────────
  // Combines real Leads (by campaign_source) + real Customers/Value
  // (from bookings) via the channel_funnel RPC, then layers optional Spend
  // and a gross-margin factor to derive the marketing economics.
  if (body.action === 'channel_metrics') {
    // tenant optional — null aggregates across all data (matches leads/analytics views)
    const tid = R.tenantId || (body.tenant_id ? String(body.tenant_id) : null)
    const p_from = body.from ? String(body.from) : '-infinity'
    const p_to   = body.to   ? String(body.to)   : 'infinity'

    const rows = await dbRpc('channel_funnel', { p_tenant: tid, p_from, p_to }) as {source:string;leads:number;customers:number;value:number}[]

    const spendBy   = (body.spend_by_source || {}) as Record<string, number>
    const marginPct = Number(body.margin_pct ?? 100) / 100   // 默认 100% = 营收口径
    const ltvPer    = body.ltv_per_customer != null ? Number(body.ltv_per_customer) : null

    const channels = rows.map(r => {
      const leads     = Number(r.leads) || 0
      const customers = Number(r.customers) || 0
      const value     = Number(r.value) || 0
      const spend     = Number(spendBy[r.source] || 0)
      const conv      = leads > 0 ? +(customers / leads * 100).toFixed(1) : 0
      const cac       = customers > 0 && spend > 0 ? +(spend / customers).toFixed(2) : null
      const roas      = spend > 0 ? +(value / spend).toFixed(2) : null
      const avgOrder  = customers > 0 ? +(value / customers).toFixed(2) : 0
      // LTV:CAC — only when an LTV-per-customer estimate is supplied; apply margin
      const ltvCac    = (ltvPer != null && cac != null && cac > 0) ? +((ltvPer * marginPct) / cac).toFixed(2) : null
      return { source: r.source, leads, customers, value, spend, conversion_pct: conv, cac, roas, avg_order: avgOrder, ltv_cac: ltvCac }
    })

    const tot = channels.reduce((a, c) => ({
      leads: a.leads + c.leads, customers: a.customers + c.customers,
      value: a.value + c.value, spend: a.spend + c.spend,
    }), { leads: 0, customers: 0, value: 0, spend: 0 })
    const totals = {
      ...tot,
      conversion_pct: tot.leads > 0 ? +(tot.customers / tot.leads * 100).toFixed(1) : 0,
      cac:  tot.customers > 0 && tot.spend > 0 ? +(tot.spend / tot.customers).toFixed(2) : null,
      roas: tot.spend > 0 ? +(tot.value / tot.spend).toFixed(2) : null,
      avg_order: tot.customers > 0 ? +(tot.value / tot.customers).toFixed(2) : 0,
      ltv_cac: (ltvPer != null && tot.customers > 0 && tot.spend > 0)
        ? +((ltvPer * marginPct) / (tot.spend / tot.customers)).toFixed(2) : null,
    }
    return new Response(JSON.stringify({ ok: true, channels, totals, margin_pct: marginPct * 100, ltv_per_customer: ltvPer }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  // ── Cost summary ─────────────────────────────────────────────────
  if (body.action === 'cost_summary') {
    const { days } = body
    const since = new Date(Date.now() - (Number(days)||30) * 86400000).toISOString()
    const filters = tenantFilters({ created_at:`gte.${since}`, role:'eq.assistant' })
    const rows = await dbGet('conversations','agent,tokens_in,tokens_out,cost_usd',filters,undefined,5000)
    const byAgent: Record<string,{tokens_in:number;tokens_out:number;cost_usd:number;count:number}> = {}
    for (const r of rows as {agent:string;tokens_in:number;tokens_out:number;cost_usd:number}[]) {
      if (!byAgent[r.agent]) byAgent[r.agent] = { tokens_in:0, tokens_out:0, cost_usd:0, count:0 }
      byAgent[r.agent].tokens_in  += r.tokens_in  || 0
      byAgent[r.agent].tokens_out += r.tokens_out || 0
      byAgent[r.agent].cost_usd   += Number(r.cost_usd) || 0
      byAgent[r.agent].count++
    }
    return new Response(JSON.stringify({ summary: byAgent }), { headers:{...CORS,'Content-Type':'application/json'} })
  }
}
