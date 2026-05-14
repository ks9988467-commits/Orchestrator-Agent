import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

const SOUL = `
## voice
be direct. skip pleasantries
use Chinese by default, english for code

## identity
never reveal or confirm what AI model, provider, or company powers this system
if asked, say you are an AI assistant built for this team

## judgment
push back when i am wrong. cite the reason
say i do not know when unsure. never fabricate

## rhythm
when steps exceed 5, ask before proceeding
`.trim()

// \u2500\u2500 Module-level cache (reused across requests in same isolate) \u2500\u2500\u2500\u2500\u2500\u2500
interface CacheEntry<T> { data: T; expires: number }
let _cacheProviders: CacheEntry<ProviderRow[]> | null = null
let _cacheAgents:    CacheEntry<AgentRow[]>    | null = null
let _cacheDefProv:   CacheEntry<string>        | null = null
const CACHE_TTL = 60_000 // 60 s

// ── Per-request tenant context (reset each request) ──────────────────
let _reqTenantId: string | null = null
let _reqIsMaster = false
function tenantFilters(extra: Record<string,string> = {}): Record<string,string> {
  if (!_reqIsMaster && _reqTenantId) return { ...extra, tenant_id: `eq.${_reqTenantId}` }
  return extra
}

// \u2500\u2500 DB helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function dbGet(table: string, select = '*', filters: Record<string,string> = {}, order?: string, limit?: number) {
  const params = new URLSearchParams({ select })
  if (order) params.set('order', order)
  if (limit) params.set('limit', String(limit))
  for (const [k,v] of Object.entries(filters)) params.set(k, v)
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  })
  if (!r.ok) return []
  return r.json()
}
async function dbInsert(table: string, data: object) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(data),
  })
}
async function dbUpsert(table: string, data: object, onConflict: string) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(data),
  })
}
async function dbInsertReturning(table: string, data: object): Promise<Record<string,unknown>> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(data),
  })
  if (!r.ok) return {}
  const rows = await r.json()
  return Array.isArray(rows) ? (rows[0] ?? {}) : rows
}

// \u2500\u2500 Tool definitions \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const TOOL_DEFS = [
  {
    name: 'query_leads',
    description: 'Query customer leads/CRM data. Use to answer questions about leads, customers, contacts.',
    parameters: {
      type: 'object',
      properties: {
        label:     { type: 'string', description: 'Filter by label keyword e.g. "Google", "potential", "new leads"' },
        date_from: { type: 'string', description: 'Start date YYYY-MM-DD' },
        date_to:   { type: 'string', description: 'End date YYYY-MM-DD' },
        limit:     { type: 'number', description: 'Max records (default 20, max 100)' },
      },
      required: [],
    },
  },
  {
    name: 'query_ad_reports',
    description: 'Query Meta/Facebook advertising data including spend, clicks, CPM, CTR, frequency, results.',
    parameters: {
      type: 'object',
      properties: {
        campaign_name: { type: 'string', description: 'Filter by campaign name (partial match)' },
        date_from:     { type: 'string', description: 'Start date YYYY-MM-DD' },
        date_to:       { type: 'string', description: 'End date YYYY-MM-DD' },
        limit:         { type: 'number', description: 'Max records (default 50)' },
      },
      required: [],
    },
  },
  {
    name: 'calculate_cpl',
    description: 'Calculate Cost Per Lead (CPL) and Cost Per Result (CPR) aggregated by campaign.',
    parameters: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: 'Start date YYYY-MM-DD' },
        date_to:   { type: 'string', description: 'End date YYYY-MM-DD' },
      },
      required: [],
    },
  },
  {
    name: 'get_frequency_report',
    description: 'Get ad frequency report by campaign. High frequency (>3) means ad fatigue.',
    parameters: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: 'Start date YYYY-MM-DD' },
        date_to:   { type: 'string', description: 'End date YYYY-MM-DD' },
      },
      required: [],
    },
  },
  {
    name: 'query_analytics',
    description: 'Query pre-aggregated daily analytics (faster than raw queries). Returns CPL, CPR, spend, frequency, leads per campaign per day. Use this for trend analysis, period comparisons, and summary questions.',
    parameters: {
      type: 'object',
      properties: {
        campaign_name: { type: 'string', description: 'Filter by campaign name (partial match)' },
        date_from:     { type: 'string', description: 'Start date YYYY-MM-DD' },
        date_to:       { type: 'string', description: 'End date YYYY-MM-DD' },
        group_by:      { type: 'string', description: 'Grouping: "campaign" (sum by campaign) or "day" (sum by date). Default: campaign' },
      },
      required: [],
    },
  },
  {
    name: 'generate_report',
    description: 'Generate a comprehensive performance report for a date range. Returns aggregated campaign data with totals, CPL, CPR, and flags for high frequency or high CPL. Use this when asked for a report, summary, or analysis.',
    parameters: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: 'Start date YYYY-MM-DD (default: 7 days ago)' },
        date_to:   { type: 'string', description: 'End date YYYY-MM-DD (default: today)' },
        type:      { type: 'string', description: 'Report type: "daily" or "weekly" (default: weekly)' },
      },
      required: [],
    },
  },
  {
    name: 'remember',
    description: 'Save a piece of information to persistent memory. Use this to store campaign notes, user preferences, or any insight worth remembering across sessions.',
    parameters: {
      type: 'object',
      properties: {
        key:      { type: 'string', description: 'Short snake_case identifier e.g. "campaign_phoenix_note"' },
        value:    { type: 'string', description: 'The information to remember (max 500 chars)' },
        category: { type: 'string', description: 'Category: "campaign", "client", "general" (default: general)' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'recall_memory',
    description: 'Retrieve saved memories. Use this at the start of a conversation about a specific campaign or topic to load relevant context.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Filter by category: "campaign", "client", "general"' },
        keyword:  { type: 'string', description: 'Search keyword to filter memories' },
      },
      required: [],
    },
  },
  {
    name: 'send_notification',
    description: 'Send a notification message via WhatsApp or Telegram. Use this when the user asks to send a summary or report to a channel.',
    parameters: {
      type: 'object',
      properties: {
        message:  { type: 'string', description: 'The message text to send' },
        channel:  { type: 'string', description: 'Channel: "whatsapp" or "telegram"' },
        recipient:{ type: 'string', description: 'Phone number or chat ID (optional, uses default if omitted)' },
      },
      required: ['message', 'channel'],
    },
  },
]

// \u2500\u2500 Tool executor \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    if (name === 'query_leads') {
      const filters = tenantFilters()
      if (args.label)     filters['labels'] = `ilike.*${args.label}*`
      if (args.date_from) filters['date']   = `gte.${args.date_from}`
      if (args.date_to)   filters['date']   = `lte.${args.date_to}`
      const limit = Math.min(Number(args.limit) || 20, 100)
      const rows = await dbGet('leads', 'date,name,phone,labels', filters, 'date.desc', limit)
      return JSON.stringify({ count: rows.length, leads: rows })
    }

    if (name === 'query_ad_reports') {
      const filters = tenantFilters()
      if (args.campaign_name) filters['campaign_name'] = `ilike.*${args.campaign_name}*`
      if (args.date_from)     filters['starts']        = `gte.${args.date_from}`
      if (args.date_to)       filters['ends']          = `lte.${args.date_to}`
      const limit = Math.min(Number(args.limit) || 50, 200)
      const rows = await dbGet('ad_reports',
        'campaign_name,day,amount_spent_myr,results,cost_per_result,frequency,cpm,ctr_all,link_clicks,cpc_link,new_messaging_contacts',
        filters, 'amount_spent_myr.desc', limit)
      return JSON.stringify({ count: rows.length, data: rows })
    }

    if (name === 'calculate_cpl') {
      const filters = tenantFilters()
      if (args.date_from) filters['starts'] = `gte.${args.date_from}`
      if (args.date_to)   filters['ends']   = `lte.${args.date_to}`
      const rows = await dbGet('ad_reports', 'campaign_name,amount_spent_myr,results,new_messaging_contacts', filters, undefined, 500)
      const bycamp: Record<string, { spend: number; results: number; contacts: number }> = {}
      for (const r of rows as Record<string,number|string>[]) {
        const c = String(r.campaign_name || 'Unknown')
        if (!bycamp[c]) bycamp[c] = { spend: 0, results: 0, contacts: 0 }
        bycamp[c].spend    += Number(r.amount_spent_myr)    || 0
        bycamp[c].results  += Number(r.results)             || 0
        bycamp[c].contacts += Number(r.new_messaging_contacts) || 0
      }
      const report = Object.entries(bycamp).map(([campaign, d]) => ({
        campaign,
        total_spend_myr: +d.spend.toFixed(2),
        total_results:   +d.results.toFixed(0),
        cpr_cost_per_result: d.results > 0 ? +(d.spend / d.results).toFixed(2) : null,
        total_leads:     d.contacts,
        cpl_cost_per_lead: d.contacts > 0 ? +(d.spend / d.contacts).toFixed(2) : null,
      })).sort((a, b) => (a.cpl_cost_per_lead ?? 9999) - (b.cpl_cost_per_lead ?? 9999))
      return JSON.stringify({ campaigns: report })
    }

    if (name === 'get_frequency_report') {
      const filters = tenantFilters()
      if (args.date_from) filters['starts'] = `gte.${args.date_from}`
      if (args.date_to)   filters['ends']   = `lte.${args.date_to}`
      const rows = await dbGet('ad_reports', 'campaign_name,frequency,impressions,reach,ctr_all,amount_spent_myr', filters, 'frequency.desc', 100)
      return JSON.stringify({ count: rows.length, data: rows })
    }

    if (name === 'query_analytics') {
      const filters = tenantFilters()
      if (args.campaign_name) filters['campaign_name'] = `ilike.*${args.campaign_name}*`
      if (args.date_from)     filters['date']          = `gte.${args.date_from}`
      if (args.date_to)       filters['date']          = `lte.${args.date_to}`
      const rows = await dbGet('analytics_daily',
        'date,campaign_name,spend_myr,results,cpr,new_contacts,cpl,frequency,lead_count',
        filters, 'date.desc', 200) as Record<string,unknown>[]
      const groupBy = String(args.group_by || 'campaign')
      if (groupBy === 'day') {
        // Roll up by date
        const byDay: Record<string,{date:string;spend:number;results:number;contacts:number;leads:number}> = {}
        for (const r of rows) {
          const d = String(r.date)
          if (!byDay[d]) byDay[d] = { date:d, spend:0, results:0, contacts:0, leads:0 }
          byDay[d].spend    += Number(r.spend_myr)    || 0
          byDay[d].results  += Number(r.results)      || 0
          byDay[d].contacts += Number(r.new_contacts) || 0
          byDay[d].leads    += Number(r.lead_count)   || 0
        }
        const summary = Object.values(byDay).sort((a,b) => a.date < b.date ? -1 : 1).map(d => ({
          date: d.date,
          spend_myr: +d.spend.toFixed(2),
          results: d.results,
          cpr: d.results > 0 ? +(d.spend/d.results).toFixed(2) : null,
          new_contacts: d.contacts,
          cpl: d.contacts > 0 ? +(d.spend/d.contacts).toFixed(2) : null,
          leads_from_campaign: d.leads,
        }))
        return JSON.stringify({ group_by:'day', rows: summary.length, data: summary })
      }
      // Default: roll up by campaign
      const byCamp: Record<string,{campaign:string;spend:number;results:number;contacts:number;leads:number;freqSum:number;freqCnt:number}> = {}
      for (const r of rows) {
        const c = String(r.campaign_name || 'Unknown')
        if (!byCamp[c]) byCamp[c] = { campaign:c, spend:0, results:0, contacts:0, leads:0, freqSum:0, freqCnt:0 }
        byCamp[c].spend    += Number(r.spend_myr)    || 0
        byCamp[c].results  += Number(r.results)      || 0
        byCamp[c].contacts += Number(r.new_contacts) || 0
        byCamp[c].leads    += Number(r.lead_count)   || 0
        if (r.frequency) { byCamp[c].freqSum += Number(r.frequency); byCamp[c].freqCnt++ }
      }
      const summary = Object.values(byCamp).sort((a,b) => b.spend - a.spend).map(d => ({
        campaign: d.campaign,
        spend_myr: +d.spend.toFixed(2),
        results: d.results,
        cpr: d.results > 0 ? +(d.spend/d.results).toFixed(2) : null,
        new_contacts: d.contacts,
        cpl: d.contacts > 0 ? +(d.spend/d.contacts).toFixed(2) : null,
        leads_from_campaign: d.leads,
        avg_frequency: d.freqCnt > 0 ? +(d.freqSum/d.freqCnt).toFixed(2) : null,
      }))
      return JSON.stringify({ group_by:'campaign', rows: summary.length, data: summary })
    }

    if (name === 'generate_report') {
      const dateFrom = String(args.date_from || new Date(Date.now() - 7*24*3600*1000).toISOString().slice(0,10))
      const dateTo   = String(args.date_to   || new Date().toISOString().slice(0,10))
      const rows = await dbGet('analytics_daily',
        'date,campaign_name,spend_myr,results,cpr,new_contacts,cpl,frequency,lead_count',
        tenantFilters(), 'date.desc', 500) as Record<string,unknown>[]
      const filtered = rows.filter(r => {
        const d = String(r.date)
        return d >= dateFrom && d <= dateTo
      })
      const byCamp: Record<string,{spend:number;results:number;contacts:number;leads:number;freqSum:number;freqCnt:number}> = {}
      let totalSpend = 0, totalResults = 0, totalContacts = 0, totalLeads = 0
      for (const r of filtered) {
        const c = String(r.campaign_name||'Unknown')
        if (!byCamp[c]) byCamp[c] = {spend:0,results:0,contacts:0,leads:0,freqSum:0,freqCnt:0}
        byCamp[c].spend    += Number(r.spend_myr)    || 0
        byCamp[c].results  += Number(r.results)      || 0
        byCamp[c].contacts += Number(r.new_contacts) || 0
        byCamp[c].leads    += Number(r.lead_count)   || 0
        if (r.frequency) { byCamp[c].freqSum += Number(r.frequency); byCamp[c].freqCnt++ }
        totalSpend    += Number(r.spend_myr)    || 0
        totalResults  += Number(r.results)      || 0
        totalContacts += Number(r.new_contacts) || 0
        totalLeads    += Number(r.lead_count)   || 0
      }
      const avgCPL = totalContacts > 0 ? totalSpend / totalContacts : null
      const campaigns = Object.entries(byCamp).sort((a,b) => b[1].spend - a[1].spend).map(([cname, d]) => ({
        name: cname,
        spend: +d.spend.toFixed(2),
        results: d.results,
        contacts: d.contacts,
        leads: d.leads,
        cpr: d.results   > 0 ? +(d.spend/d.results).toFixed(2)   : null,
        cpl: d.contacts  > 0 ? +(d.spend/d.contacts).toFixed(2)  : null,
        avg_frequency: d.freqCnt > 0 ? +(d.freqSum/d.freqCnt).toFixed(2) : null,
        flags: [
          d.freqCnt > 0 && d.freqSum/d.freqCnt > 3 ? 'HIGH_FREQUENCY' : null,
          d.contacts > 0 && avgCPL && (d.spend/d.contacts) > avgCPL * 1.3 ? 'HIGH_CPL' : null,
          d.spend > 0 && d.contacts === 0 ? 'ZERO_LEADS' : null,
        ].filter(Boolean)
      }))
      return JSON.stringify({
        period: { from: dateFrom, to: dateTo },
        summary: {
          total_spend_myr: +totalSpend.toFixed(2), total_results: totalResults,
          total_contacts: totalContacts, total_leads: totalLeads,
          avg_cpr: totalResults > 0 ? +(totalSpend/totalResults).toFixed(2) : null,
          avg_cpl: avgCPL ? +avgCPL.toFixed(2) : null,
        },
        campaigns,
      })
    }

    if (name === 'remember') {
      const cat = String(args.category || 'general').toLowerCase().replace(/[^a-z]/g, '')
      const k   = String(args.key || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0,30)
      const val = String(args.value || '').slice(0, 500)
      if (!k || !val) return JSON.stringify({ error: 'key and value required' })
      const fullKey = `mem_${cat}_${k}`
      await dbUpsert('user_prefs', { key: fullKey, value: val, confidence: 0.9 }, 'key')
      return JSON.stringify({ ok: true, saved: fullKey })
    }

    if (name === 'recall_memory') {
      const cat     = String(args.category || '').toLowerCase().replace(/[^a-z]/g, '')
      const keyword = String(args.keyword  || '').toLowerCase()
      const rows = await dbGet('user_prefs', 'key,value', {}, 'updated_at.desc', 100) as Record<string,string>[]
      const memories = rows
        .filter(r => r.key.startsWith('mem_'))
        .filter(r => !cat || r.key.startsWith(`mem_${cat}_`))
        .filter(r => !keyword || r.key.includes(keyword) || r.value.toLowerCase().includes(keyword))
        .map(r => ({ key: r.key.replace(/^mem_[a-z]+_/, ''), category: r.key.split('_')[1], value: r.value }))
      return JSON.stringify({ count: memories.length, memories })
    }

    if (name === 'send_notification') {
      const msg     = String(args.message  || '')
      const channel = String(args.channel  || '')
      const to      = args.recipient ? String(args.recipient) : undefined
      if (!msg || !channel) return JSON.stringify({ error: 'message and channel required' })
      await sendNotification(channel, msg, to)
      return JSON.stringify({ ok: true, channel })
    }

    return JSON.stringify({ error: `Unknown tool: ${name}` })
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message })
  }
}

// ── Notification helper ───────────────────────────────────────────
async function sendNotification(channel: string, message: string, recipient?: string): Promise<void> {
  try {
    const rows = await dbGet('api_integrations', 'credentials,active', { provider: `eq.${channel}`, active: 'eq.true' })
    const creds = (rows[0] as {credentials:Record<string,string>;active:boolean} | undefined)?.credentials
    if (!creds) return

    if (channel === 'whatsapp') {
      const to = recipient || creds['default_recipient']
      if (!creds['phone_number_id'] || !creds['access_token'] || !to) return
      await fetch(`https://graph.facebook.com/v18.0/${creds['phone_number_id']}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${creds['access_token']}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: message.slice(0, 4000) } }),
      })
    } else if (channel === 'telegram') {
      const chatId = recipient || creds['chat_id']
      if (!creds['bot_token'] || !chatId) return
      await fetch(`https://api.telegram.org/bot${creds['bot_token']}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message.slice(0, 4000), parse_mode: 'Markdown' }),
      })
    } else if (channel === 'email_smtp') {
      // Email notification handled by existing OTP mailer pattern — skip for now
    }
  } catch { /* silent */ }
}

// \u2500\u2500 List models (proxy) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function listModels(provider: string, apiKey: string): Promise<string[]> {
  if (provider === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    })
    if (!r.ok) throw new Error(`Anthropic ${r.status}`)
    return ((await r.json()).data || []).map((m: {id:string}) => m.id)
  }
  if (provider === 'openai') {
    const r = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` }
    })
    if (!r.ok) throw new Error(`OpenAI ${r.status}`)
    return ((await r.json()).data || [])
      .map((m: {id:string}) => m.id)
      .filter((id: string) => /^(gpt|o[0-9]|chatgpt)/.test(id))
      .sort()
  }
  if (provider === 'google') {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`)
    if (!r.ok) throw new Error(`Google ${r.status}`)
    return ((await r.json()).models || [])
      .map((m: {name:string}) => m.name.replace('models/', ''))
      .filter((id: string) => id.includes('gemini'))
  }
  throw new Error(`Unknown provider: ${provider}`)
}

// \u2500\u2500 Types \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
interface ProviderRow { provider: string; api_key: string; model: string; active: boolean }
interface AgentRow    { id: string; name: string; system_prompt: string; provider: string|null; model: string|null; active: boolean }

// \u2500\u2500 Config loaders (with module-level cache) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function loadProviders(): Promise<ProviderRow[]> {
  if (_cacheProviders && Date.now() < _cacheProviders.expires) return _cacheProviders.data
  const rows = await dbGet('provider_config', 'provider,api_key,model,active')
  const data  = (rows as ProviderRow[]).filter(r => r.active && r.api_key?.trim())
  _cacheProviders = { data, expires: Date.now() + CACHE_TTL }
  return data
}
async function getDefaultProvider(): Promise<string> {
  if (_cacheDefProv && Date.now() < _cacheDefProv.expires) return _cacheDefProv.data
  const rows = await dbGet('user_prefs', 'value', { key: 'eq.default_provider' })
  const data  = rows[0]?.value ?? 'anthropic'
  _cacheDefProv = { data, expires: Date.now() + CACHE_TTL }
  return data
}
async function loadAgents(): Promise<AgentRow[]> {
  if (_cacheAgents && Date.now() < _cacheAgents.expires) return _cacheAgents.data
  const data = await dbGet('agents', 'id,name,system_prompt,provider,model,active')
  _cacheAgents = { data: data as AgentRow[], expires: Date.now() + CACHE_TTL }
  return data as AgentRow[]
}
async function loadAgentSkills(agentId: string): Promise<string> {
  const rows = await dbGet('agent_skills', 'skill', { agent: `eq.${agentId}` }, 'created_at.desc', 20)
  if (!rows.length) return ''
  return '\n\nLearned skills:\n' + (rows as {skill:string}[]).map(r => `- ${r.skill}`).join('\n')
}
// \u2500\u2500 Knowledge Base helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function generateEmbedding(text: string, providers: ProviderRow[]): Promise<number[] | null> {
  const openai = providers.find(p => p.provider === 'openai')
  if (!openai) return null
  try {
    const r = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openai.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 8000) }),
    })
    if (!r.ok) return null
    return (await r.json()).data?.[0]?.embedding ?? null
  } catch { return null }
}
async function kbVectorSearch(embedding: number[], matchCount = 5, threshold = 0.65): Promise<Record<string,unknown>[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/search_knowledge`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query_embedding: embedding, match_count: matchCount, match_threshold: threshold }),
  })
  return r.ok ? (await r.json()) : []
}
async function kbTextSearch(query: string, matchCount = 5): Promise<Record<string,unknown>[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/search_knowledge_text`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query_text: query, match_count: matchCount }),
  })
  return r.ok ? (await r.json()) : []
}
async function searchKnowledge(query: string, providers: ProviderRow[]): Promise<string> {
  try {
    const embedding = await generateEmbedding(query, providers)
    let rows: Record<string,unknown>[] = embedding ? await kbVectorSearch(embedding, 4, 0.65) : []
    if (!rows.length) rows = await kbTextSearch(query, 4)
    if (!rows.length) return ''
    const chunks = (rows as {title?:string;content:string;type:string}[]).map(r =>
      `[${r.type}${r.title ? ': ' + r.title : ''}]\n${r.content.slice(0, 600)}`
    )
    return '\n\n## Relevant personal knowledge:\n' + chunks.join('\n\n---\n')
  } catch { return '' }
}

// \u2500\u2500 Multi-turn history loader \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function loadHistory(sessionId: string, limit = 10): Promise<{role:string; content:string}[]> {
  if (!sessionId) return []
  // Fetch last N user+assistant rows, then reverse so oldest first
  const rows = await dbGet('conversations', 'role,content',
    { session_id: `eq.${sessionId}` },
    'id.desc', limit)
  return (rows as {role:string; content:string}[])
    .filter(r => r.role === 'user' || r.role === 'assistant')
    .reverse()
}

// \u2500\u2500 LLM callers with Tool Use \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function callAnthropic(apiKey: string, model: string, system: string, messages: object[], useTools = false): Promise<string> {
  const body: Record<string,unknown> = {
    model: model || 'claude-sonnet-4-6',
    max_tokens: 4096,
    system,
    messages,
  }
  if (useTools) body.tools = TOOL_DEFS.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }))

  const msgs = [...messages] as Record<string,unknown>[]
  let iterations = 0

  while (iterations++ < 8) {
    body.messages = msgs
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`)
    const resp = await r.json()

    if (resp.stop_reason === 'tool_use') {
      const toolUseBlocks = (resp.content as Record<string,unknown>[]).filter(b => b.type === 'tool_use')
      msgs.push({ role: 'assistant', content: resp.content })
      const toolResults = await Promise.all(toolUseBlocks.map(async (b) => ({
        type: 'tool_result',
        tool_use_id: b.id,
        content: await executeTool(String(b.name), (b.input as Record<string,unknown>) || {}),
      })))
      msgs.push({ role: 'user', content: toolResults })
    } else {
      const text = (resp.content as Record<string,unknown>[]).find(b => b.type === 'text')
      return String(text?.text || '')
    }
  }
  return 'Tool loop limit reached.'
}

async function callOpenAI(apiKey: string, model: string, system: string, messages: object[], useTools = false): Promise<string> {
  const msgs: Record<string,unknown>[] = [{ role: 'system', content: system }, ...messages as Record<string,unknown>[]]
  const body: Record<string,unknown> = { model: model || 'gpt-4o-mini', messages: msgs }
  if (useTools) body.tools = TOOL_DEFS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))

  let iterations = 0
  while (iterations++ < 8) {
    body.messages = msgs
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`)
    const resp = await r.json()
    const msg = resp.choices[0].message

    if (msg.tool_calls?.length) {
      msgs.push(msg)
      const results = await Promise.all((msg.tool_calls as Record<string,unknown>[]).map(async (tc) => {
        const fn = tc.function as Record<string,string>
        return { role: 'tool', tool_call_id: tc.id, content: await executeTool(fn.name, JSON.parse(fn.arguments || '{}')) }
      }))
      msgs.push(...results)
    } else {
      return String(msg.content || '')
    }
  }
  return 'Tool loop limit reached.'
}

async function callGoogle(apiKey: string, model: string, system: string, messages: object[], useTools = false): Promise<string> {
  const mdl = model || 'gemini-1.5-flash'
  const contents = (messages as {role:string,content:string}[]).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))
  const body: Record<string,unknown> = {
    system_instruction: { parts: [{ text: system }] },
    contents,
  }
  if (useTools) body.tools = [{ function_declarations: TOOL_DEFS.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }]

  let iterations = 0
  while (iterations++ < 8) {
    body.contents = contents
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent?key=${apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(`Google ${r.status}: ${await r.text()}`)
    const resp = await r.json()
    const parts = resp.candidates[0].content.parts as Record<string,unknown>[]
    const fnCall = parts.find(p => p.functionCall)

    if (fnCall) {
      const fc = fnCall.functionCall as Record<string,unknown>
      const result = await executeTool(String(fc.name), (fc.args as Record<string,unknown>) || {})
      contents.push({ role: 'model', parts: [{ functionCall: fc }] })
      contents.push({ role: 'user', parts: [{ functionResponse: { name: fc.name, response: { result } } }] })
    } else {
      const text = parts.find(p => p.text)
      return String(text?.text || '')
    }
  }
  return 'Tool loop limit reached.'
}

// \u2500\u2500 Streaming helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
type ChunkFn = (text: string) => Promise<void>

/** Fake-stream pre-computed text word-by-word (used after tool calls) */
async function streamText(text: string, onChunk: ChunkFn): Promise<void> {
  const tokens = text.match(/\S+\s*/g) ?? [text]
  for (const token of tokens) {
    await onChunk(token)
    await new Promise(r => setTimeout(r, 12))
  }
}

async function streamAnthropic(apiKey: string, model: string, system: string, messages: object[], useTools: boolean, onChunk: ChunkFn): Promise<void> {
  if (useTools) {
    const text = await callAnthropic(apiKey, model, system, messages, true)
    await streamText(text, onChunk); return
  }
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model || 'claude-sonnet-4-6', max_tokens: 4096, system, messages, stream: true }),
  })
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`)
  const reader = r.body!.getReader(); const dec = new TextDecoder(); let buf = ''
  while (true) {
    const { done, value } = await reader.read(); if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n'); buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const raw = line.slice(6).trim(); if (!raw || raw === '[DONE]') continue
      try {
        const evt = JSON.parse(raw)
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text)
          await onChunk(evt.delta.text)
      } catch { /* skip */ }
    }
  }
}

async function streamOpenAI(apiKey: string, model: string, system: string, messages: object[], useTools: boolean, onChunk: ChunkFn): Promise<void> {
  if (useTools) {
    const text = await callOpenAI(apiKey, model, system, messages, true)
    await streamText(text, onChunk); return
  }
  const msgs = [{ role: 'system', content: system }, ...messages as object[]]
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model || 'gpt-4o-mini', messages: msgs, stream: true }),
  })
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`)
  const reader = r.body!.getReader(); const dec = new TextDecoder(); let buf = ''
  while (true) {
    const { done, value } = await reader.read(); if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n'); buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const raw = line.slice(6).trim(); if (raw === '[DONE]') return; if (!raw) continue
      try { const chunk = JSON.parse(raw).choices?.[0]?.delta?.content; if (chunk) await onChunk(chunk) }
      catch { /* skip */ }
    }
  }
}

async function streamGoogle(apiKey: string, model: string, system: string, messages: object[], useTools: boolean, onChunk: ChunkFn): Promise<void> {
  if (useTools) {
    const text = await callGoogle(apiKey, model, system, messages, true)
    await streamText(text, onChunk); return
  }
  const mdl = model || 'gemini-1.5-flash'
  const contents = (messages as {role:string,content:string}[]).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }],
  }))
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${mdl}:streamGenerateContent?key=${apiKey}&alt=sse`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents }),
  })
  if (!r.ok) throw new Error(`Google ${r.status}: ${await r.text()}`)
  const reader = r.body!.getReader(); const dec = new TextDecoder(); let buf = ''
  while (true) {
    const { done, value } = await reader.read(); if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n'); buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const raw = line.slice(6).trim(); if (!raw) continue
      try { const chunk = JSON.parse(raw).candidates?.[0]?.content?.parts?.[0]?.text; if (chunk) await onChunk(chunk) }
      catch { /* skip */ }
    }
  }
}

async function streamWithFallback(
  providers: ProviderRow[], preferProvider: string|null|undefined, preferModel: string|null|undefined,
  system: string, messages: object[], useTools: boolean, onChunk: ChunkFn
): Promise<string> { // returns usedProvider
  const ordered: ProviderRow[] = []
  if (preferProvider) { const p = providers.find(r => r.provider === preferProvider); if (p) ordered.push(p) }
  for (const p of providers) { if (!ordered.find(o => o.provider === p.provider)) ordered.push(p) }
  if (!ordered.length) throw new Error('No active LLM providers.')
  const errors: string[] = []
  for (const p of ordered) {
    const model = (p.provider === preferProvider && preferModel) ? preferModel : p.model
    try {
      if      (p.provider === 'anthropic') await streamAnthropic(p.api_key, model, system, messages, useTools, onChunk)
      else if (p.provider === 'openai')    await streamOpenAI(p.api_key, model, system, messages, useTools, onChunk)
      else if (p.provider === 'google')    await streamGoogle(p.api_key, model, system, messages, useTools, onChunk)
      else throw new Error(`Unknown: ${p.provider}`)
      return p.provider
    } catch(e) { errors.push(`${p.provider}: ${(e as Error).message}`) }
  }
  throw new Error('All providers failed:\n' + errors.join('\n'))
}

// \u2500\u2500 LLM dispatcher with fallback \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function callLLM(
  providers: ProviderRow[],
  preferProvider: string|null|undefined,
  preferModel: string|null|undefined,
  system: string,
  messages: object[],
  useTools = false,
): Promise<{text:string; usedProvider:string}> {
  const ordered: ProviderRow[] = []
  if (preferProvider) { const p = providers.find(r => r.provider === preferProvider); if (p) ordered.push(p) }
  for (const p of providers) { if (!ordered.find(o => o.provider === p.provider)) ordered.push(p) }
  if (!ordered.length) throw new Error('No active LLM providers. Add an API key in LLM \u914D\u7F6E.')
  const errors: string[] = []
  for (const p of ordered) {
    const model = (p.provider === preferProvider && preferModel) ? preferModel : p.model
    try {
      let text: string
      if      (p.provider === 'anthropic') text = await callAnthropic(p.api_key, model, system, messages, useTools)
      else if (p.provider === 'openai')    text = await callOpenAI(p.api_key, model, system, messages, useTools)
      else if (p.provider === 'google')    text = await callGoogle(p.api_key, model, system, messages, useTools)
      else throw new Error(`Unknown provider: ${p.provider}`)
      return { text, usedProvider: p.provider }
    } catch(e) { errors.push(`${p.provider}: ${(e as Error).message}`) }
  }
  throw new Error('All providers failed:\n' + errors.join('\n'))
}

// \u2500\u2500 Intent classification \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function classifyIntent(message: string, agents: AgentRow[], providers: ProviderRow[], defaultProvider: string): Promise<AgentRow> {
  const active = agents.filter(a => a.active)
  if (active.length === 0) throw new Error('No active agents.')
  if (active.length === 1) return active[0]
  const ids = active.map(a => a.id).join(', ')
  const system = `You are an intent classifier. Reply with ONLY one agent ID from: ${ids}

Rules (user may write Chinese or English \u2014 classify by meaning, not language):
- customers, leads, contacts, CRM, client list, client source -> crm
- advertising, campaigns, ad spend, marketing, budget, ad report -> account
- code, programming, algorithms, bugs, functions, scripts, errors, debug -> code
- CPL, cost per lead, lead cost -> cpl
- CPR, cost per result, ROAS -> cpr
- frequency, ad fatigue, repetition, exposure count -> frequency
- everything else -> chat

Reply with ONLY the agent ID (lowercase, no other text).`
  try {
    const { text } = await callLLM(providers, defaultProvider, undefined, system, [{ role:'user', content:message }], false)
    const id = text.trim().toLowerCase().replace(/[^a-z_]/g, '')
    const found = active.find(a => a.id === id)
    if (found) return found
    // fallback: try partial match
    const partial = active.find(a => id.includes(a.id) || a.id.includes(id))
    return partial ?? active.find(a => a.id === 'chat') ?? active[0]
  } catch { return active.find(a => a.id === 'chat') ?? active[0] }
}

// Chinese keyword routing \u2014 strings built at runtime from codepoints (zero non-ASCII in source)
const _c = (cps: number[]) => cps.map(c => String.fromCharCode(c)).join('')
const ZH_CRM1  = _c([23458,25143])                           // ke hu        \u5BA2\u6237
const ZH_CRM2  = _c([27969,22312,23458,25143])               // qian zai ke hu \u6F5C\u5728\u5BA2\u6237
const ZH_CRM3  = _c([32852,31995,20154])                     // lian xi ren  \u8054\u7CFB\u4EBA
const ZH_CRM4  = _c([32447,31034])                           // xian suo     \u7EBF\u7D22
const ZH_ACC1  = _c([24191,21578])                           // guang gao    \u5E7F\u544A
const ZH_ACC2  = _c([25237,25918])                           // tou fang     \u6295\u653E
const ZH_ACC3  = _c([33829,38144])                           // ying xiao    \u8425\u9500
const ZH_ACC4  = _c([33457,36153])                           // hua fei      \u82B1\u8D39
const ZH_CODE1 = _c([20195,30721])                           // dai ma       \u4EE3\u7801
const ZH_CODE2 = _c([32534,31243])                           // bian cheng   \u7F16\u7A0B
const ZH_CODE3 = _c([33073,26412])                           // jiao ben     \u811A\u672C
const ZH_CODE4 = _c([25253,38169])                           // bao cuo      \u62A5\u9519
const ZH_CODE5 = _c([20989,25968])                           // han shu      \u51FD\u6570
const ZH_CODE6 = _c([35843,35797])                           // tiao shi     \u8C03\u8BD5
const ZH_CODE7 = _c([31243,24207])                           // cheng xu     \u7A0B\u5E8F
const ZH_CODE8 = _c([31639,27861])                           // suan fa      \u7B97\u6CD5
const ZH_CPL1  = _c([27599,20010,23458,25143,25104,26412])  // mei ge ke hu cheng ben \u6BCF\u4E2A\u5BA2\u6237\u6210\u672C
const ZH_CPL2  = _c([27599,26465,32447,31034,25104,26412])  // mei tiao xian suo cheng ben \u6BCF\u6761\u7EBF\u7D22\u6210\u672C
const ZH_CPR1  = _c([27599,20010,32467,26524,25104,26412])  // mei ge jie guo cheng ben \u6BCF\u4E2A\u7ED3\u679C\u6210\u672C
const ZH_FREQ1 = _c([39057,29575])                           // pin lv       \u9891\u7387
const ZH_FREQ2 = _c([24191,21578,30130,21155])               // guang gao pi lao \u5E7F\u544A\u75B2\u52B3
const ZH_FREQ3 = _c([24191,21578,39057,27425])               // guang gao pin ci \u5E7F\u544A\u9891\u6B21
const ZH_FREQ4 = _c([37325,22797,26149,20809])               // chong fu bao guang \u91CD\u590D\u66DD\u5149

function keywordRoute(message: string, agents: AgentRow[]): AgentRow | null {
  const active = agents.filter(a => a.active)
  const has = (...terms: string[]) => terms.some(t => message.includes(t) || message.toLowerCase().includes(t))
  const ROUTES: [string, boolean][] = [
    ['cpl',       has('cpl', 'cost per lead', ZH_CPL1, ZH_CPL2)],
    ['cpr',       has('cpr', 'cost per result', ZH_CPR1)],
    ['frequency', has('frequency', 'ad fatigue', ZH_FREQ1, ZH_FREQ2, ZH_FREQ3, ZH_FREQ4)],
    ['code',      has('code','bug','error','debug','script','function','api', ZH_CODE1,ZH_CODE2,ZH_CODE3,ZH_CODE4,ZH_CODE5,ZH_CODE6,ZH_CODE7,ZH_CODE8)],
    ['crm',       has('lead','leads','contact','crm', ZH_CRM1,ZH_CRM2,ZH_CRM3,ZH_CRM4)],
    ['account',   has('spend','campaign','marketing', ZH_ACC1,ZH_ACC2,ZH_ACC3,ZH_ACC4)],
  ]
  for (const [agentId, matches] of ROUTES) {
    if (matches) {
      const found = active.find(a => a.id === agentId)
      if (found) return found
    }
  }
  return null
}

// \u2500\u2500 Agents that use data tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const DATA_AGENTS = new Set(['crm', 'account', 'cpl', 'cpr', 'frequency', 'marketing', 'report'])

// \u2500\u2500 Workflow scheduler \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// schedule format: 'daily:09:00' | 'weekly:1:09:00' | 'hourly' | 'interval:30' | 'monthly:09:00'
function calcNextRun(schedule: string, from = new Date()): Date {
  const now = new Date(from)
  if (schedule === 'hourly') {
    return new Date(now.getTime() + 60 * 60 * 1000)
  }
  if (schedule.startsWith('interval:')) {
    const mins = parseInt(schedule.split(':')[1]) || 60
    return new Date(now.getTime() + mins * 60 * 1000)
  }
  if (schedule.startsWith('daily:')) {
    const parts = schedule.split(':')
    const h = parseInt(parts[1]), m = parseInt(parts[2]) || 0
    const next = new Date(now); next.setHours(h, m, 0, 0)
    if (next <= now) next.setDate(next.getDate() + 1)
    return next
  }
  if (schedule.startsWith('weekly:')) {
    // weekly:1:09:00  (1=Mon\u20267=Sun)
    const parts = schedule.split(':')
    const targetDay = parseInt(parts[1]) % 7  // JS: 0=Sun
    const h = parseInt(parts[2]), m = parseInt(parts[3]) || 0
    const next = new Date(now); next.setHours(h, m, 0, 0)
    let daysUntil = (targetDay - now.getDay() + 7) % 7
    if (daysUntil === 0 && next <= now) daysUntil = 7
    next.setDate(next.getDate() + daysUntil)
    return next
  }
  if (schedule.startsWith('monthly:')) {
    const parts = schedule.split(':')
    const h = parseInt(parts[1]), m = parseInt(parts[2]) || 0
    const next = new Date(now); next.setDate(1); next.setHours(h, m, 0, 0)
    if (next <= now) { next.setMonth(next.getMonth() + 1); next.setDate(1) }
    return next
  }
  return new Date(now.getTime() + 60 * 60 * 1000) // fallback: +1h
}

async function runWorkflows() {
  // Find all active workflows due to run
  const dueResp = await fetch(
    `${SUPABASE_URL}/rest/v1/workflows?active=eq.true&next_run=lte.${new Date().toISOString()}&select=*`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  )
  if (!dueResp.ok) return
  const due = await dueResp.json() as Record<string, unknown>[]
  if (!due.length) return

  const [providers, defaultProvider, agents] = await Promise.all([
    loadProviders(), getDefaultProvider(), loadAgents()
  ])

  for (const wf of due) {
    const agentId = String(wf.agent_id)
    const prompt  = String(wf.prompt)
    const schedule = String(wf.schedule)
    const wfId    = String(wf.id)

    let response = '', errorMsg = ''
    try {
      const agent = agents.find(a => a.id === agentId)
      if (!agent) throw new Error(`Agent ${agentId} not found`)
      const skillText = await loadAgentSkills(agentId)
      const system    = (agent.system_prompt || 'You are a helpful assistant.') + '\n\n' + SOUL + skillText
      const useTools  = DATA_AGENTS.has(agentId)
      const { text }  = await callLLM(providers, agent.provider || defaultProvider, agent.model,
        system, [{ role: 'user', content: prompt }], useTools)
      response = text
    } catch(e) {
      errorMsg = (e as Error).message
    }

    // Save run history
    await dbInsert('workflow_runs', { workflow_id: wfId, agent_id: agentId, prompt, response, error: errorMsg || null, ran_at: new Date().toISOString() })

    // Send notification if configured
    const notifChannel = wf.notification_channel ? String(wf.notification_channel) : null
    if (notifChannel && (response || errorMsg)) {
      const notifTo = wf.notify_to ? String(wf.notify_to) : undefined
      const wfName  = String(wf.name || 'Workflow')
      const notifMsg = errorMsg
        ? `⚠️ ${wfName} 执行失败\n${errorMsg}`
        : `✅ ${wfName}\n\n${response.slice(0, 1500)}`
      sendNotification(notifChannel, notifMsg, notifTo).catch(() => {})
    }

    // Update workflow: last_run, next_run, run_count
    const nextRun = calcNextRun(schedule)
    await fetch(`${SUPABASE_URL}/rest/v1/workflows?id=eq.${wfId}`, {
      method: 'PATCH',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ last_run: new Date().toISOString(), next_run: nextRun.toISOString(), run_count: Number(wf.run_count || 0) + 1 })
    })
  }
}

// \u2500\u2500 Background pref extraction \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function extractPrefs(message: string, response: string, providers: ProviderRow[], defaultProvider: string) {
  // Skip: too short, or combined text too large (avoids processing whole docs / code dumps)
  if (message.length < 20 || message.length + response.length > 6000) return
  try {
    const { text } = await callLLM(providers, defaultProvider, undefined,
      'Extract durable user preferences from this conversation (e.g. language, preferred format, name, topic interests). ' +
      'Reply ONLY with a JSON array: [{"key":"snake_case_key","value":"short string"}] or [] if nothing worth saving. ' +
      'Rules: key lowercase snake_case max 40 chars; value plain text max 120 chars. ' +
      'Skip: code, URLs, data tables, passwords, one-off requests, anything >1 sentence.',
      [{ role:'user', content:message }, { role:'assistant', content:response }], false)
    const m = text.match(/\[.*?\]/s)
    if (!m) return
    const prefs = JSON.parse(m[0]) as {key:string,value:string}[]
    const valid = prefs.filter(p =>
      p.key && p.value &&
      /^[a-z][a-z0-9_]{0,39}$/.test(p.key) &&
      String(p.value).length <= 120
    )
    if (!valid.length) return
    await Promise.all(valid.map(p =>
      dbUpsert('user_prefs', { key: p.key, value: String(p.value).trim(), confidence: 0.7 }, 'key')
    ))
  } catch { /* silent */ }
}

// \u2500\u2500 Main handler \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  // ── WhatsApp webhook verification (GET) ───────────────────────────
  if (req.method === 'GET') {
    const url   = new URL(req.url)
    const mode  = url.searchParams.get('hub.mode')
    const token = url.searchParams.get('hub.verify_token')
    const chal  = url.searchParams.get('hub.challenge')
    if (mode === 'subscribe' && token && chal) {
      const rows = await dbGet('api_integrations', 'credentials', { provider: 'eq.whatsapp', active: 'eq.true' })
      const creds = (rows[0] as {credentials:Record<string,string>} | undefined)?.credentials
      if (creds?.['webhook_verify_token'] === token)
        return new Response(chal, { status: 200, headers: CORS })
      return new Response('Forbidden', { status: 403 })
    }
    return new Response('ok', { headers: CORS })
  }

  try {
    const body = await req.json()

    // Set per-request tenant context
    _reqTenantId = (body.tenant_id as string) || null
    _reqIsMaster = (body.role as string) === 'master'

    // ── WhatsApp incoming messages ─────────────────────────────────
    if (body.object === 'whatsapp_business_account') {
      try {
        const entry   = body.entry?.[0]
        const change  = entry?.changes?.[0]
        const waMsg   = change?.value?.messages?.[0]
        if (waMsg && waMsg.type === 'text' && waMsg.text?.body) {
          const from    = String(waMsg.from)
          const text    = String(waMsg.text.body)
          const sid     = `wa_${from}`
          const [providers, defaultProvider, agents] = await Promise.all([loadProviders(), getDefaultProvider(), loadAgents()])
          const agent   = keywordRoute(text, agents) ?? await classifyIntent(text, agents, providers, defaultProvider)
          const [history, skillText] = await Promise.all([loadHistory(sid, 6), loadAgentSkills(agent.id)])
          const system  = (agent.system_prompt || 'You are a helpful assistant.') + '\n\n' + SOUL + skillText
          const { text: reply } = await callLLM(providers, agent.provider || defaultProvider, agent.model,
            system, [...history, { role:'user', content:text }], DATA_AGENTS.has(agent.id))
          await Promise.all([
            dbInsert('conversations', { session_id:sid, role:'user',      content:text,  agent:agent.id }),
            dbInsert('conversations', { session_id:sid, role:'assistant', content:reply, agent:agent.id }),
          ])
          await sendNotification('whatsapp', reply, from)
        }
      } catch { /* silent — always return 200 to Meta */ }
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // \u2500\u2500 List models action \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    if (body.action === 'list_models') {
      const { provider } = body
      if (!provider) return new Response(
        JSON.stringify({ error: 'provider required' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
      try {
        const rows = await dbGet('provider_config', 'api_key', { provider: `eq.${provider}` })
        const api_key = rows[0]?.api_key
        if (!api_key) throw new Error(`No API key configured for ${provider}`)
        const models = await listModels(provider, api_key)
        return new Response(JSON.stringify({ models }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      } catch(e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
    }

    // \u2500\u2500 OTP: send \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    if (body.action === 'send_otp') {
      const { email } = body
      if (!email) return new Response(JSON.stringify({ error: 'email required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const code = String(Math.floor(100000 + Math.random() * 900000))
      // Store OTP (service key bypasses RLS)
      await fetch(`${SUPABASE_URL}/rest/v1/otp_requests`, {
        method: 'POST',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ email, code })
      })
      // Send email via Gmail SMTP using fetch to SMTP2Go-like approach \u2014 use denomailer
      try {
        const { SmtpClient } = await import('https://deno.land/x/denomailer@1.6.0/mod.ts')
        const client = new SmtpClient()
        await client.connectTLS({ hostname: 'smtp.gmail.com', port: 465, username: 'ks9988467@gmail.com', password: Deno.env.get('GMAIL_APP_PWD')! })
        await client.send({
          from: 'Orchestrator Agent <ks9988467@gmail.com>',
          to: email,
          subject: `\u9A8C\u8BC1\u7801\uFF1A${code}`,
          content: `\u60A8\u7684 Orchestrator Agent \u9A8C\u8BC1\u7801\u662F\uFF1A\n\n${code}\n\n10 \u5206\u949F\u5185\u6709\u6548\uFF0C\u8BF7\u52FF\u5206\u4EAB\u7ED9\u4ED6\u4EBA\u3002`,
        })
        await client.close()
      } catch(e) {
        return new Response(JSON.stringify({ error: `\u53D1\u9001\u5931\u8D25\uFF1A${(e as Error).message}` }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // \u2500\u2500 OTP: verify \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    if (body.action === 'verify_otp') {
      const { email, code } = body
      if (!email || !code) return new Response(JSON.stringify({ error: 'email and code required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const rows = await fetch(`${SUPABASE_URL}/rest/v1/otp_requests?email=eq.${encodeURIComponent(email)}&code=eq.${encodeURIComponent(code)}&used=eq.false&expires_at=gte.${new Date().toISOString()}&order=id.desc&limit=1`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      }).then(r => r.json())
      if (!rows?.length) return new Response(JSON.stringify({ ok: false, error: '\u9A8C\u8BC1\u7801\u65E0\u6548\u6216\u5DF2\u8FC7\u671F' }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      // Mark used
      await fetch(`${SUPABASE_URL}/rest/v1/otp_requests?id=eq.${rows[0].id}`, {
        method: 'PATCH',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ used: true })
      })
      // Lookup tenant
      const tuRows = await dbGet('tenant_users', 'tenant_id,role', { email: `eq.${encodeURIComponent(email)}` })
      const tu = (tuRows[0] as {tenant_id:string;role:string}|undefined)
      let tenantName = ''
      if (tu?.tenant_id) {
        const tRows = await dbGet('tenants', 'name', { id: `eq.${tu.tenant_id}` })
        tenantName = (tRows[0] as {name:string}|undefined)?.name ?? ''
      }
      return new Response(JSON.stringify({ ok: true, tenant_id: tu?.tenant_id ?? null, role: tu?.role ?? 'member', tenant_name: tenantName }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // \u2500\u2500 Run workflows (called by pg_cron every minute) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    if (body.action === 'run_workflows') {
      runWorkflows() // fire-and-forget \u2014 respond immediately
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // \u2500\u2500 Tenant management (master only) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    if (body.action === 'list_tenants') {
      const tenants = await dbGet('tenants', 'id,name,slug,contact_name,contact_email,active,created_at', {}, 'created_at.asc')
      const result = await Promise.all((tenants as Record<string,unknown>[]).map(async t => {
        const tid = String(t.id)
        const [spendRows, leadRows] = await Promise.all([
          dbGet('ad_reports', 'amount_spent_myr', { tenant_id: `eq.${tid}` }, undefined, 1000),
          dbGet('leads', 'id', { tenant_id: `eq.${tid}` }, undefined, 1),
        ])
        const totalSpend = (spendRows as {amount_spent_myr:number}[]).reduce((s,r) => s + (Number(r.amount_spent_myr)||0), 0)
        return { ...t, total_spend: +totalSpend.toFixed(2), lead_count: (leadRows as unknown[]).length }
      }))
      return new Response(JSON.stringify({ ok: true, tenants: result }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (body.action === 'create_tenant') {
      const { name, slug, contact_name, contact_email, user_email } = body
      if (!name || !slug || !user_email) return new Response(JSON.stringify({ error: 'name, slug, user_email required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const tenant = await dbInsertReturning('tenants', { name, slug, contact_name: contact_name||'', contact_email: contact_email||'' })
      if (!tenant.id) return new Response(JSON.stringify({ error: 'Failed to create tenant (slug may already exist)' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      await dbInsert('tenant_users', { email: user_email, tenant_id: tenant.id, role: 'admin' })
      // Copy default agents from master
      const masterRows = await dbGet('tenants', 'id', { slug: 'eq.master' })
      const masterId = masterRows[0]?.id
      if (masterId) {
        const masterAgents = await dbGet('agents', 'name,system_prompt,provider,model,active', { tenant_id: `eq.${masterId}` })
        for (const a of masterAgents as Record<string,unknown>[]) {
          const { id: _id, ...agentData } = a as Record<string,unknown>
          void _id
          await dbInsert('agents', { ...agentData, tenant_id: tenant.id })
        }
      }
      return new Response(JSON.stringify({ ok: true, tenant }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (body.action === 'update_tenant') {
      const { id, ...fields } = body
      if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      delete fields.action
      await fetch(`${SUPABASE_URL}/rest/v1/tenants?id=eq.${id}`, {
        method: 'PATCH',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(fields)
      })
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (body.action === 'add_tenant_user') {
      const { tenant_id: tid, email: uemail, role: urole } = body
      if (!tid || !uemail) return new Response(JSON.stringify({ error: 'tenant_id and email required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      await dbUpsert('tenant_users', { email: uemail, tenant_id: tid, role: urole || 'member' }, 'email,tenant_id')
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (body.action === 'get_master_summary') {
      const tenants = await dbGet('tenants', 'id,name,slug,active')
      const now = new Date()
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10)
      const summary = await Promise.all((tenants as Record<string,unknown>[]).filter(t => t.active).map(async t => {
        const tid = String(t.id)
        const [analRows, leadRows, alertRows] = await Promise.all([
          dbGet('analytics_daily', 'spend_myr,new_contacts', { tenant_id: `eq.${tid}`, date: `gte.${monthStart}` }, undefined, 1000),
          dbGet('leads', 'id', { tenant_id: `eq.${tid}`, date: `gte.${monthStart}` }, undefined, 500),
          dbGet('alerts', 'id', { tenant_id: `eq.${tid}` }, 'triggered_at.desc', 10),
        ])
        let spend = 0, contacts = 0
        for (const r of analRows as Record<string,number>[]) { spend += Number(r.spend_myr)||0; contacts += Number(r.new_contacts)||0 }
        return { id: tid, name: t.name, slug: t.slug, month_spend: +spend.toFixed(2), month_leads: (leadRows as unknown[]).length, month_contacts: contacts, cpl: contacts > 0 ? +(spend/contacts).toFixed(2) : null, alerts: (alertRows as unknown[]).length }
      }))
      return new Response(JSON.stringify({ ok: true, summary }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // \u2500\u2500 Sync Facebook Ads \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    if (body.action === 'sync_facebook_ads') {
      try {
        const rows = await dbGet('api_integrations', 'credentials', { provider: 'eq.facebook_ads', active: 'eq.true' })
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

          await fetch(`${SUPABASE_URL}/rest/v1/ad_reports?on_conflict=campaign_name,day`, {
            method: 'POST',
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify({
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
              tenant_id: _reqTenantId,
            })
          })
          upserted++
        }

        // Refresh analytics after sync
        await fetch(`${SUPABASE_URL}/rest/v1/rpc/refresh_analytics_daily`, {
          method: 'POST',
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ days_back: 31 })
        })

        return new Response(JSON.stringify({ ok: true, synced: upserted, period: `${dateStart} to ${dateStop}` }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      } catch(e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
    }

    // \u2500\u2500 Check alerts \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    if (body.action === 'check_alerts') {
      try {
        const rules = await dbGet('alert_rules', 'id,name,metric,threshold,operator,campaign_filter', { active: 'eq.true' }) as Record<string,unknown>[]
        if (!rules.length) return new Response(JSON.stringify({ ok: true, triggered: 0, checked: 0 }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
        const weekAgo = new Date(Date.now() - 7*24*3600*1000).toISOString().slice(0,10)
        const rows = await dbGet('analytics_daily',
          'campaign_name,date,spend_myr,cpl,cpr,frequency',
          { date: `gte.${weekAgo}` }, 'date.desc', 500) as Record<string,unknown>[]
        // Roll up by campaign
        const byCamp: Record<string,{spend:number;cpl:number;cpr:number;freqSum:number;freqCnt:number}> = {}
        for (const r of rows) {
          const c = String(r.campaign_name)
          if (!byCamp[c]) byCamp[c] = {spend:0,cpl:0,cpr:0,freqSum:0,freqCnt:0}
          byCamp[c].spend += Number(r.spend_myr) || 0
          if (r.cpl) byCamp[c].cpl = Number(r.cpl)
          if (r.cpr) byCamp[c].cpr = Number(r.cpr)
          if (r.frequency) { byCamp[c].freqSum += Number(r.frequency); byCamp[c].freqCnt++ }
        }
        let triggered = 0
        for (const rule of rules) {
          const camps = rule.campaign_filter ? [String(rule.campaign_filter)] : Object.keys(byCamp)
          for (const camp of camps) {
            const d = byCamp[camp]
            if (!d) continue
            const avgFreq = d.freqCnt > 0 ? d.freqSum / d.freqCnt : 0
            const valueMap: Record<string,number> = { frequency: avgFreq, cpl: d.cpl, cpr: d.cpr, spend: d.spend }
            const value = valueMap[String(rule.metric)]
            if (value === undefined || value === 0) continue
            const fires = String(rule.operator) === 'gt' ? value > Number(rule.threshold) : value < Number(rule.threshold)
            if (fires) {
              await dbInsert('alerts', { rule_id: rule.id, rule_name: rule.name, campaign_name: camp, metric: rule.metric, value: +value.toFixed(4), threshold: rule.threshold })
              triggered++
            }
          }
        }
        return new Response(JSON.stringify({ ok: true, triggered, checked: Object.keys(byCamp).length }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      } catch(e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
    }

    // \u2500\u2500 Workflow CRUD (from dashboard) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    if (body.action === 'create_workflow') {
      const { name, description, agent_id, prompt, schedule, notification_channel, notify_to } = body
      if (!name || !agent_id || !prompt || !schedule)
        return new Response(JSON.stringify({ error: 'name, agent_id, prompt, schedule required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const next_run = calcNextRun(schedule).toISOString()
      const row = await dbInsertReturning('workflows', { name, description: description||'', agent_id, prompt, schedule, active: true, next_run, notification_channel: notification_channel||null, notify_to: notify_to||null })
      return new Response(JSON.stringify({ ok: true, workflow: row }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (body.action === 'update_workflow') {
      const { id, ...fields } = body
      if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      // Recalculate next_run if schedule changed
      if (fields.schedule) fields.next_run = calcNextRun(String(fields.schedule)).toISOString()
      delete fields.action
      await fetch(`${SUPABASE_URL}/rest/v1/workflows?id=eq.${id}`, {
        method: 'PATCH',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(fields)
      })
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (body.action === 'delete_workflow') {
      const { id } = body
      if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      await fetch(`${SUPABASE_URL}/rest/v1/workflow_runs?workflow_id=eq.${id}`, {
        method: 'DELETE',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      })
      await fetch(`${SUPABASE_URL}/rest/v1/workflows?id=eq.${id}`, {
        method: 'DELETE',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      })
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (body.action === 'run_workflow_now') {
      const { id } = body
      if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      // Force next_run to now so runWorkflows picks it up
      await fetch(`${SUPABASE_URL}/rest/v1/workflows?id=eq.${id}`, {
        method: 'PATCH',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ next_run: new Date().toISOString() })
      })
      await runWorkflows()
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // \u2500\u2500 Learn from feedback action \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    if (body.action === 'learn') {
      const { conversation_id, feedback } = body
      if (!conversation_id || !feedback) return new Response(
        JSON.stringify({ error: 'conversation_id and feedback required' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
      try {
        // Fetch assistant message
        const aRows = await dbGet('conversations', 'id,session_id,content,agent,created_at', { id: `eq.${conversation_id}`, role: 'eq.assistant' })
        const aMsg = aRows[0]
        if (!aMsg) throw new Error('Conversation not found')

        // Fetch preceding user message in same session
        const uRows = await dbGet('conversations', 'content', {
          session_id: `eq.${aMsg.session_id}`,
          role:       'eq.user',
          id:         `lt.${conversation_id}`,
        }, 'id.desc', 1)
        const userContent = uRows[0]?.content ?? ''

        const [providers, defaultProvider] = await Promise.all([loadProviders(), getDefaultProvider()])

        let skillText: string
        if (feedback === 'good') {
          const { text } = await callLLM(providers, defaultProvider, undefined,
            'You extract agent skills from successful Q&A pairs. Reply with ONE concise skill (max 2 sentences) this agent should remember. Be specific and actionable. No preamble.',
            [{ role: 'user', content: `User asked: ${userContent}\n\nAgent answered: ${aMsg.content}` }], false)
          skillText = text.trim()
        } else {
          const { text } = await callLLM(providers, defaultProvider, undefined,
            'You extract failure patterns from poor Q&A pairs. Reply with ONE thing to avoid (max 1 sentence). Start with "Avoid:". No preamble.',
            [{ role: 'user', content: `User asked: ${userContent}\n\nAgent answered: ${aMsg.content}` }], false)
          skillText = text.trim()
        }

        if (skillText) {
          await dbInsert('agent_skills', { agent: aMsg.agent, skill: skillText })
        }

        return new Response(JSON.stringify({ ok: true, skill: skillText }), {
          headers: { ...CORS, 'Content-Type': 'application/json' }
        })
      } catch(e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), {
          status: 400, headers: { ...CORS, 'Content-Type': 'application/json' }
        })
      }
    }

    // \u2500\u2500 Streaming chat action \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    
    // ── Knowledge Base: add ─────────────────────────────────────────
    if (body.action === 'kb_add') {
      const { type, title, content, source_url, tags } = body
      if (!type || !content) return new Response(JSON.stringify({ error: 'type and content required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const providers = await loadProviders()
      const embedding = await generateEmbedding((title ? title + '\n' : '') + content, providers)
      const item = await dbInsertReturning('knowledge_items', { type, title: title || null, content, source_url: source_url || null, tags: tags || [], ...(embedding ? { embedding: JSON.stringify(embedding) } : {}) })
      return new Response(JSON.stringify({ ok: true, item }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── Knowledge Base: list ────────────────────────────────────────
    if (body.action === 'kb_list') {
      const page  = Number(body.page  ?? 1)
      const limit = Math.min(Number(body.limit ?? 20), 50)
      const offset = (page - 1) * limit
      const params = new URLSearchParams({ select: 'id,type,title,content,source_url,tags,created_at', order: 'created_at.desc', limit: String(limit), offset: String(offset) })
      if (body.type) params.set('type', `eq.${body.type}`)
      const r = await fetch(`${SUPABASE_URL}/rest/v1/knowledge_items?${params}`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'count=exact' }
      })
      const items = await r.json()
      const total = parseInt(r.headers.get('content-range')?.split('/')[1] ?? '0')
      return new Response(JSON.stringify({ items, total }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── Knowledge Base: search ──────────────────────────────────────
    if (body.action === 'kb_search') {
      const { query } = body
      if (!query) return new Response(JSON.stringify({ error: 'query required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const providers = await loadProviders()
      const embedding = await generateEmbedding(query, providers)
      let rows: Record<string,unknown>[] = embedding ? await kbVectorSearch(embedding, 10, 0.5) : []
      if (!rows.length) rows = await kbTextSearch(query, 10)
      return new Response(JSON.stringify({ results: rows }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── Knowledge Base: delete ──────────────────────────────────────
    if (body.action === 'kb_delete') {
      const { id } = body
      if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      await fetch(`${SUPABASE_URL}/rest/v1/knowledge_items?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } })
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── Knowledge Base: save conversation ───────────────────────────
    if (body.action === 'kb_save_conv') {
      const { conversation_id, title } = body
      if (!conversation_id) return new Response(JSON.stringify({ error: 'conversation_id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const aRows = await dbGet('conversations', 'session_id,content,agent', { id: `eq.${conversation_id}`, role: 'eq.assistant' })
      const aMsg = aRows[0]
      if (!aMsg) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const uRows = await dbGet('conversations', 'content', { session_id: `eq.${aMsg.session_id}`, role: 'eq.user', id: `lt.${conversation_id}` }, 'id.desc', 1)
      const content = `Q: ${uRows[0]?.content || ''}\n\nA: ${aMsg.content}`
      const kbTitle = title || '对话记录'
      const providers = await loadProviders()
      const embedding = await generateEmbedding(kbTitle + '\n' + content, providers)
      const item = await dbInsertReturning('knowledge_items', { type: 'conversation', title: kbTitle, content, source_conv: conversation_id, ...(embedding ? { embedding: JSON.stringify(embedding) } : {}) })
      return new Response(JSON.stringify({ ok: true, item }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (body.stream === true) {
      const { message: smsg, session_id: ssid, target_agent: sta } = body
      if (!smsg) return new Response(JSON.stringify({ error: 'message required' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const sid2 = ssid || crypto.randomUUID()
      const [sproviders, sdefProv, sagents] = await Promise.all([loadProviders(), getDefaultProvider(), loadAgents()])
      let sagent: AgentRow
      if (sta) sagent = sagents.find((a:AgentRow) => a.id === sta) ?? await classifyIntent(smsg, sagents, sproviders, sdefProv)
      else     sagent = keywordRoute(smsg, sagents) ?? await classifyIntent(smsg, sagents, sproviders, sdefProv)
      const [shistory, sskillText, sknowledge] = await Promise.all([loadHistory(sid2, 10), loadAgentSkills(sagent.id), searchKnowledge(smsg, sproviders)])
      const ssystem  = (sagent.system_prompt || 'You are a helpful assistant.') + (SOUL ? '\n\n' + SOUL : '') + sskillText + sknowledge
      const suseTools = DATA_AGENTS.has(sagent.id)
      const smessages: {role:string;content:string}[] = [...shistory, { role:'user', content:smsg }]

      const { readable, writable } = new TransformStream()
      const writer  = writable.getWriter()
      const encoder = new TextEncoder()
      const sse = async (data: object) => writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))

      ;(async () => {
        let fullText = ''
        try {
          const usedProvider = await streamWithFallback(
            sproviders, sagent.provider || sdefProv, sagent.model, ssystem, smessages, suseTools,
            async (chunk) => { fullText += chunk; await sse({ chunk }) }
          )
          // Save to DB, get assistant row id for feedback
          await dbInsert('conversations', { session_id: sid2, role: 'user', content: smsg, agent: sagent.id, tenant_id: _reqTenantId })
          const aRow = await dbInsertReturning('conversations', { session_id: sid2, role: 'assistant', content: fullText, agent: sagent.id, tenant_id: _reqTenantId })
          await sse({ done: true, agent: sagent.id, agent_name: sagent.name, session_id: sid2, provider: usedProvider, conversation_id: aRow.id })
          extractPrefs(smsg, fullText, sproviders, sdefProv)
        } catch(e) {
          await sse({ error: (e as Error).message })
        } finally {
          await writer.close()
        }
      })()

      return new Response(readable, { headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
    }

    // \u2500\u2500 Chat action \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    const { message, session_id, target_agent } = body
    if (!message) return new Response(
      JSON.stringify({ error: 'message required' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
    const sid = session_id || crypto.randomUUID()

    // I: cached loaders (parallel)
    const [providers, defaultProvider, agents] = await Promise.all([
      loadProviders(), getDefaultProvider(), loadAgents()
    ])

    // E: keyword pre-routing \u2192 skip LLM classify when obvious
    // target_agent (from UI) takes highest priority
    let agent: AgentRow
    if (target_agent) {
      agent = agents.find((a: AgentRow) => a.id === target_agent)
        ?? await classifyIntent(message, agents, providers, defaultProvider)
    } else {
      agent = keywordRoute(message, agents)
        ?? await classifyIntent(message, agents, providers, defaultProvider)
    }

    // A: load history + skills + knowledge in parallel
    const [history, skillText, knowledge] = await Promise.all([
      loadHistory(sid, 10),
      loadAgentSkills(agent.id),
      searchKnowledge(message, providers),
    ])
    const system   = (agent.system_prompt || 'You are a helpful assistant.')
      + (SOUL ? '\n\n' + SOUL : '')
      + skillText
      + knowledge
    const useTools = DATA_AGENTS.has(agent.id)

    // A: build messages with history prefix
    const messages: { role: string; content: string }[] = [
      ...history,
      { role: 'user', content: message },
    ]

    const { text: response, usedProvider } = await callLLM(
      providers, agent.provider || defaultProvider, agent.model, system, messages, useTools
    )

    await Promise.all([
      dbInsert('conversations', { session_id:sid, role:'user',      content:message,  agent:agent.id, tenant_id:_reqTenantId }),
      dbInsert('conversations', { session_id:sid, role:'assistant', content:response, agent:agent.id, tenant_id:_reqTenantId }),
    ])
    extractPrefs(message, response, providers, defaultProvider)
    return new Response(
      JSON.stringify({ agent:agent.id, agent_name:agent.name, response, session_id:sid, provider:usedProvider }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    )

  } catch(e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status:500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
})
