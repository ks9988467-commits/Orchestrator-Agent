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

// ── Cost calculator ──────────────────────────────────────────────────
const COST_PER_M: Record<string,[number,number]> = {
  'claude-3-5-sonnet':[3,15],'claude-sonnet':[3,15],'claude-3-7-sonnet':[3,15],
  'claude-3-5-haiku':[0.8,4],'claude-haiku':[0.8,4],
  'claude-opus':[15,75],
  'gpt-4o-mini':[0.15,0.6],'gpt-4o':[2.5,10],'gpt-4':[30,60],'o1-mini':[3,12],'o3-mini':[1.1,4.4],
  'gemini-2.0-flash':[0.1,0.4],'gemini-1.5-flash':[0.075,0.3],'gemini-1.5-pro':[3.5,10.5],'gemini-2.5':[1.25,10],
}
function calcCost(model: string, tokensIn: number, tokensOut: number): number {
  const key = Object.keys(COST_PER_M).find(k => (model||'').toLowerCase().includes(k)) ?? ''
  const [inP, outP] = COST_PER_M[key] ?? [2.5, 10]
  return Number(((tokensIn * inP + tokensOut * outP) / 1_000_000).toFixed(6))
}

// ── Per-request token accumulator (reset each request) ───────────────
let _lastUsage = { tokens_in: 0, tokens_out: 0, used_model: '' }
function resetUsage(model='') { _lastUsage = { tokens_in: 0, tokens_out: 0, used_model: model } }

// ── Agent Task tools ─────────────────────────────────────────────────
// web_search: handled inline in executeTaskSteps via perplexity/sonar on OpenRouter
async function fetchUrl(url: string): Promise<string> {
  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers: { 'Accept': 'text/plain', 'X-Retain-Images': 'none' }
  })
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
  return (await res.text()).slice(0, 6000)
}

type TaskStep = { id:string; desc:string; tool:string; params:Record<string,string>; status:string; result:string|null }
type AgentTask = { id:string; goal:string; plan:TaskStep[]; current_step:number; status:string; output:Record<string,string>; final_output:string|null; session_id:string|null; tenant_id:string|null }

// 20s timeout wrapper — prevents any single step from hanging
function withTimeout<T>(p: Promise<T>, ms = 20_000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`步骤超时 (${ms/1000}s)`)), ms))
  ])
}

// Execute exactly ONE step per call, then self-chain to next step (fire-and-forget)
async function executeTaskSteps(taskId: string, providers: ProviderRow[], defaultProvider: string, agents: AgentRow[]) {
  const rows = await dbGet('agent_tasks','*',{ id:`eq.${taskId}` })
  const task = rows[0] as AgentTask
  if (!task || task.status === 'cancelled' || task.status === 'failed' || task.status === 'done') return

  const plan = task.plan as TaskStep[]
  const idx = task.current_step as number

  // All steps complete
  if (idx >= plan.length) {
    const finalOutput = plan.filter(s=>s.status==='done').slice(-1)[0]?.result || ''
    await dbPatch('agent_tasks', taskId, { status:'done', final_output:finalOutput, updated_at:new Date().toISOString() })
    return
  }

  const step = plan[idx]
  // Concurrency guard: skip if another invocation already picked up this step
  if (step.status === 'running') return

  await dbPatch('agent_tasks', taskId, { status:'running', updated_at:new Date().toISOString() })
  plan[idx] = { ...step, status:'running' }
  await dbPatch('agent_tasks', taskId, { plan, updated_at:new Date().toISOString() })

  let result = '', stepError = ''
  try {
    const prevOutput = task.output as Record<string,string>
    const fillRef = (s:string) => s.replace(/\{\{(step_\d+)\}\}/g, (_:string,k:string) => prevOutput[k] || '')

    if (step.tool === 'web_search') {
      const query = fillRef(step.params.query || '')
      resetUsage('perplexity/sonar')
      const { text } = await withTimeout(callLLM(
        providers, 'openrouter', 'perplexity/sonar',
        '你是联网搜索助手。用中文返回详细、准确、最新的搜索结果，包含关键事实和来源。',
        [{ role: 'user', content: `搜索：${query}` }]
      ), 50_000)
      result = text
      const _sc = calcCost(_lastUsage.used_model||'perplexity/sonar', _lastUsage.tokens_in, _lastUsage.tokens_out)
      dbInsert('conversations', { session_id:`task_${taskId}`, role:'assistant', content:result.slice(0,200), agent:'task_search', tokens_in:_lastUsage.tokens_in, tokens_out:_lastUsage.tokens_out, cost_usd:_sc }).catch(()=>{})
    } else if (step.tool === 'fetch_url') {
      result = await withTimeout(fetchUrl(step.params.url || ''), 15_000)
    } else if (step.tool === 'call_agent') {
      const agent = agents.find(a=>a.id===step.params.agent_id) ?? agents.find(a=>a.id==='chat') ?? agents[0]
      const prompt = fillRef(step.params.prompt || step.params.q || '')
      const skillText = await loadAgentSkills(agent?.id || '')
      const system = (agent?.system_prompt||'You are a helpful assistant.')+'\n\n'+SOUL+skillText
      resetUsage(agent?.model || '')
      const { text } = await withTimeout(callLLM(providers, agent?.provider||defaultProvider, agent?.model, system, [{ role:'user', content:prompt }]), 50_000)
      result = text
      const _ac = calcCost(_lastUsage.used_model||agent?.model||'', _lastUsage.tokens_in, _lastUsage.tokens_out)
      dbInsert('conversations', { session_id:`task_${taskId}`, role:'assistant', content:result.slice(0,200), agent:`task_${agent?.id||'chat'}`, tokens_in:_lastUsage.tokens_in, tokens_out:_lastUsage.tokens_out, cost_usd:_ac }).catch(()=>{})
    } else if (step.tool === 'send_notification') {
      const msg = fillRef(step.params.message || '')
      await sendNotification(step.params.channel||'slack', msg, step.params.to)
      result = `通知已发送 (${step.params.channel||'slack'})`
    } else {
      result = `(跳过：未知工具 ${step.tool})`
    }
  } catch(e) { stepError = (e as Error).message }

  plan[idx] = { ...plan[idx], status:stepError?'failed':'done', result:result||stepError }
  const newOutput = { ...(task.output as Record<string,string>), [step.id]: result }
  const nextIdx = idx + 1
  const allDone = nextIdx >= plan.length

  await dbPatch('agent_tasks', taskId, {
    plan, current_step:nextIdx, output:newOutput,
    status: stepError?'failed': allDone?'done':'running',
    final_output: allDone ? (result||'') : null,
    updated_at: new Date().toISOString()
  })

  // Chain: trigger next step after 1s delay (prevents request storm)
  if (!stepError && !allDone) {
    setTimeout(() => {
      fetch(`${SUPABASE_URL}/functions/v1/orchestrator`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'execute_task_step', task_id: taskId })
      }).catch(() => {})
    }, 1000)
  }
}

// ── Slack webhook ─────────────────────────────────────────────────────
async function sendSlackWebhook(webhookUrl: string, text: string, mrkdwn?: string) {
  const blocks = mrkdwn ? [{ type:'section', text:{ type:'mrkdwn', text: mrkdwn } }] : undefined
  const payload: Record<string,unknown> = { text }
  if (blocks) payload.blocks = blocks
  await fetch(webhookUrl, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload),
  })
}
async function notifySlack(title: string, body: string) {
  try {
    const rows = await dbGet('api_integrations','credentials,active',{service:'eq.slack',active:'eq.true'},undefined,1)
    const url = (rows[0] as {credentials:Record<string,string>}|undefined)?.credentials?.webhook_url
    if (url) await sendSlackWebhook(url, title, `*${title}*\n${body}`)
  } catch { /* non-fatal */ }
}

// ── Module-level cache (reused across requests in same isolate) ──────
interface CacheEntry<T> { data: T; expires: number }
let _cacheProviders: CacheEntry<ProviderRow[]> | null = null
let _cacheAgents:    CacheEntry<AgentRow[]>    | null = null
let _cacheDefProv:   CacheEntry<string>        | null = null
const CACHE_TTL = 60_000 // 60 s

// ── Per-request tenant context (reset each request) ──────────────────
let _reqTenantId: string | null = null
let _reqIsMaster = false
// ── Per-request LLM context (for use inside executeTool) ─────────────
let _reqProviders: ProviderRow[] = []
let _reqAgents: AgentRow[] = []
let _reqDefaultProvider = ''
let _reqDelegated = false        // true when delegate_to_agent was called this request
let _reqSessionId = ''           // current request session_id (for delegate history lookup)
let _reqDelegatedId   = ''       // agent_id that was delegated to
let _reqDelegatedName = ''       // agent display name that was delegated to
let _reqHermesMode = false       // true when calling agent is 'chat' (Hermes) — limits tools to delegation-only
let _reqDelegationContext = ''   // accumulated context from previous delegations this request
function tenantFilters(extra: Record<string,string> = {}): Record<string,string> {
  if (!_reqIsMaster && _reqTenantId) return { ...extra, tenant_id: `eq.${_reqTenantId}` }
  return extra
}

// ── DB patch helper ───────────────────────────────────────────────────
async function dbPatch(table: string, id: string, data: object) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(data),
  })
}

// ── DB helpers ──────────────────────────────────────────────────────
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

// ── Lark helpers ────────────────────────────────────────────────────
async function getLarkConfig(): Promise<{webhook_url?:string;app_id?:string;app_secret?:string}|null> {
  try {
    const rows = await dbGet('api_integrations', 'credentials,active', { service: 'eq.lark', active: 'eq.true' }, undefined, 1)
    const row = (rows as {credentials:Record<string,string>;active:boolean}[])[0]
    return row?.credentials ?? null
  } catch { return null }
}

async function sendLarkWebhook(webhookUrl: string, title: string, bodyMd: string, fileUrl?: string) {
  const elements: unknown[] = [{ tag: 'div', text: { tag: 'lark_md', content: bodyMd } }]
  if (fileUrl) elements.push({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '查看文件' }, type: 'primary', url: fileUrl }] })
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg_type: 'interactive', card: { header: { title: { tag: 'plain_text', content: title }, template: 'red' }, elements } }),
  })
}

async function getLarkToken(appId: string, appSecret: string): Promise<string|null> {
  try {
    const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    })
    const d = await r.json() as {tenant_access_token?:string}
    return d.tenant_access_token ?? null
  } catch { return null }
}

async function sendLarkMessage(token: string, receiveId: string, receiveIdType: string, text: string) {
  await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text }) }),
  })
}

async function createLarkTask(token: string, title: string, desc: string, dueMs?: number): Promise<string|null> {
  try {
    const payload: Record<string,unknown> = { summary: title, description: desc }
    if (dueMs) payload.due = { timestamp: String(Math.floor(dueMs / 1000)) }
    const r = await fetch('https://open.feishu.cn/open-apis/task/v2/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    })
    const d = await r.json() as {data?:{task?:{guid?:string}}}
    return d.data?.task?.guid ?? null
  } catch { return null }
}

// ── Tool definitions ─────────────────────────────────────────────────
const TOOL_DEFS = [
  {
    name: 'query_leads',
    description: 'Query customer leads/CRM data. Use to answer questions about leads, customers, contacts. Supports free-text search by name, phone, or email.',
    parameters: {
      type: 'object',
      properties: {
        search:          { type: 'string', description: 'Free-text search across name, phone, email (partial match). Use this when user asks about a specific person or number.' },
        label:           { type: 'string', description: 'Filter by label keyword e.g. "Google", "potential", "new leads"' },
        campaign_source: { type: 'string', description: 'Filter by campaign source (partial match)' },
        date_from:       { type: 'string', description: 'Start date YYYY-MM-DD' },
        date_to:         { type: 'string', description: 'End date YYYY-MM-DD' },
        limit:           { type: 'number', description: 'Max records (default 20, max 100)' },
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
    name: 'delegate_to_agent',
    description: 'MANDATORY: Delegate any business task or specialized query to the appropriate sub-agent. You MUST call this tool whenever the user\'s request falls within any sub-agent\'s domain. NEVER answer business questions directly — always delegate. Only respond directly for pure greetings or meta questions about yourself.',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'The ID of the agent to delegate to — use the IDs listed in your system prompt (e.g. "crm", "account", "ugc", "code", "report")' },
        query:    { type: 'string', description: 'The full question or task to send to the agent, preserving all user context and details' },
      },
      required: ['agent_id', 'query'],
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
  {
    name: 'search_knowledge_base',
    description: 'Search the knowledge base for relevant information using semantic search. Use this when the user asks questions that might be answered by company documentation, product manuals, FAQs, policies, SOPs, or any other stored knowledge. Always try this before saying you don\'t know something.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Describe what information you are looking for in natural language' },
        kb_id: { type: 'string', description: 'Specific knowledge base UUID to search (optional — omit to search all available KBs)' },
        limit: { type: 'number', description: 'Max results to return (default 3, max 8)' },
      },
      required: ['query'],
    },
  },
]

// \u2500\u2500 Tool executor \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    if (name === 'query_leads') {
      const filters = tenantFilters()
      if (args.label)           filters['labels']          = `ilike.*${args.label}*`
      if (args.campaign_source) filters['campaign_source'] = `ilike.*${args.campaign_source}*`
      // Free-text search across name / phone / email
      if (args.search) {
        const s = String(args.search).replace(/[()]/g, '')  // sanitise
        filters['or'] = `(name.ilike.*${s}*,phone.ilike.*${s}*,email.ilike.*${s}*)`
      }
      // Date range — use PostgREST `and` to avoid key collision when both present
      if (args.date_from && args.date_to) {
        filters['and'] = `(date.gte.${args.date_from},date.lte.${args.date_to})`
      } else if (args.date_from) {
        filters['date'] = `gte.${args.date_from}`
      } else if (args.date_to) {
        filters['date'] = `lte.${args.date_to}`
      }
      const limit = Math.min(Number(args.limit) || 20, 100)
      const rows = await dbGet('leads', 'date,name,phone,email,labels,campaign_source', filters, 'date.desc', limit)
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
      if (args.date_from && args.date_to) {
        filters['and'] = `(date.gte.${args.date_from},date.lte.${args.date_to})`
      } else if (args.date_from) {
        filters['date'] = `gte.${args.date_from}`
      } else if (args.date_to) {
        filters['date'] = `lte.${args.date_to}`
      }
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

    if (name === 'delegate_to_agent') {
      _reqDelegated = true
      const targetId     = String(args.agent_id || '').toLowerCase().trim()
      const originalQuery = String(args.query   || '')
      const target       = _reqAgents.find(a => a.id === targetId && a.active)
      if (!target) return JSON.stringify({ error: `Agent '${targetId}' not found or inactive. Available: ${_reqAgents.filter(a=>a.active&&a.id!=='chat').map(a=>a.id).join(', ')}` })
      _reqDelegatedId   = target.id
      _reqDelegatedName = target.name || target.id
      // Load session history + sub-agent skills in parallel
      const [history, subSkills] = await Promise.all([
        _reqSessionId ? loadHistory(_reqSessionId, 10) : Promise.resolve([]),
        loadAgentSkills(target.id),
      ])
      // Build augmented query: if previous delegations have context, pass it along
      const query = _reqDelegationContext
        ? `[参考——前步骤已收集信息]\n${_reqDelegationContext}\n\n---\n当前任务：${originalQuery}`
        : originalQuery
      // Hermes context injected into sub-agent system prompt
      const hermesCtx = `\n\n**[系统上下文]** 你是被 Hermes 调度系统委派的专项 Agent。当前用户问题：${originalQuery}\n请结合对话历史，给出专业回答。`
      const sys      = (target.system_prompt || 'You are a helpful assistant.') + hermesCtx + '\n\n' + SOUL + subSkills
      const useTools = DATA_AGENTS.has(target.id) || !!target.uses_tools
      _reqHermesMode = false  // sub-agents get full tool access
      const messages = [...history, { role: 'user', content: query }]
      const { text } = await callLLM(_reqProviders, target.provider || _reqDefaultProvider, target.model, sys, messages, useTools)
      // Accumulate result for subsequent delegations (first 300 chars summary)
      const summary = text.slice(0, 300).replace(/\n+/g, ' ')
      _reqDelegationContext += (_reqDelegationContext ? '\n' : '') + `[${target.name || targetId}]: ${summary}`
      return text
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

    if (name === 'search_knowledge_base') {
      const query = String(args.query || '').slice(0, 500)
      if (!query) return JSON.stringify({ error: 'query required' })
      const limit = Math.min(Number(args.limit) || 3, 8)
      // Embed using fallback chain: OpenAI → Google → OpenRouter
      const providers = await loadProviders()
      const kbFilters = tenantFilters()
      if (args.kb_id) kbFilters['id'] = `eq.${args.kb_id}`
      const kbs = await dbGet('knowledge_bases', 'id,name', kbFilters, undefined, 10) as Record<string,string>[]
      if (!kbs.length) return JSON.stringify({ results: [], message: '尚未建立知识库，请先在知识库页面录入文档。' })
      const qEmbed = await getEmbedding(query, providers)
      if (!qEmbed) return JSON.stringify({ error: '知识库搜索需要 Embedding API。请在 LLM Providers 中配置 OpenAI、Google 或 OpenRouter key。' })
      // Search across all matching KBs, collect results
      const allResults: Array<Record<string,unknown>> = []
      for (const kb of kbs.slice(0, 5)) {
        const rows = await fetch(`${SUPABASE_URL}/rest/v1/rpc/kb_match`, {
          method: 'POST',
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query_embedding: qEmbed, match_kb_id: kb.id, match_count: limit }),
        }).then(res => res.ok ? res.json() : []).catch(() => [])
        for (const row of rows as Record<string,unknown>[]) {
          allResults.push({ ...row, kb_name: kb.name })
        }
      }
      // Sort by similarity desc, return top N
      allResults.sort((a, b) => ((b.similarity as number) || 0) - ((a.similarity as number) || 0))
      const top = allResults.slice(0, limit)
      if (!top.length) return JSON.stringify({ results: [], message: '知识库中未找到相关内容' })
      return JSON.stringify({
        results: top.map(r => ({
          kb:         r.kb_name,
          source:     r.source_name,
          content:    r.content,
          similarity: +((r.similarity as number) * 100).toFixed(1),
        }))
      })
    }

    return JSON.stringify({ error: `Unknown tool: ${name}` })
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message })
  }
}

// ── Notification helper ───────────────────────────────────────────
async function sendNotification(channel: string, message: string, recipient?: string): Promise<void> {
  try {
    // Use 'service' field (not 'provider') matching api_integrations schema
    const rows = await dbGet('api_integrations', 'credentials,active', { service: `eq.${channel}`, active: 'eq.true' })
    const creds = (rows[0] as {credentials:Record<string,string>;active:boolean} | undefined)?.credentials

    if (channel === 'whatsapp') {
      if (!creds) return
      const to = recipient || creds['default_recipient']
      if (!creds['phone_number_id'] || !creds['access_token'] || !to) return
      await fetch(`https://graph.facebook.com/v18.0/${creds['phone_number_id']}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${creds['access_token']}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: message.slice(0, 4000) } }),
      })
    } else if (channel === 'telegram') {
      if (!creds) return
      const chatId = recipient || creds['chat_id']
      if (!creds['bot_token'] || !chatId) return
      await fetch(`https://api.telegram.org/bot${creds['bot_token']}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message.slice(0, 4000), parse_mode: 'Markdown' }),
      })
    } else if (channel === 'email_smtp') {
      // Use stored SMTP credentials via denomailer
      if (!creds?.host || !creds?.username || !creds?.password) return
      const to = recipient || creds['from_address']
      if (!to) return
      const { SmtpClient } = await import('https://deno.land/x/denomailer@1.6.0/mod.ts')
      const client = new SmtpClient()
      const port = parseInt(String(creds['port'] || '587'))
      if (port === 465) {
        await client.connectTLS({ hostname: String(creds['host']), port: 465, username: String(creds['username']), password: String(creds['password']) })
      } else {
        await client.connect({ hostname: String(creds['host']), port, username: String(creds['username']), password: String(creds['password']) })
      }
      await client.send({ from: String(creds['from_address'] || creds['username']), to, subject: '📋 Orchestrator 通知', content: message.slice(0, 4000) })
      await client.close()
    } else if (channel === 'sendgrid' || channel === 'email') {
      // Try SendGrid API key
      const sgRows = await dbGet('api_integrations', 'credentials,active', { service: 'eq.sendgrid', active: 'eq.true' }, undefined, 1)
      const sgCreds = (sgRows[0] as any)?.credentials
      if (sgCreds?.api_key && recipient) {
        await fetch('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: { Authorization: `Bearer ${sgCreds.api_key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: recipient }] }],
            from: { email: sgCreds.from_email || 'noreply@orchestrator.ai', name: 'Orchestrator' },
            subject: '📋 Orchestrator 通知',
            content: [{ type: 'text/plain', value: message }]
          })
        })
      }
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
  if (provider === 'openrouter') {
    const r = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` }
    })
    if (!r.ok) throw new Error(`OpenRouter ${r.status}`)
    const KNOWN = /^(deepseek|anthropic|openai|google|meta-llama|mistralai|qwen|x-ai|cohere|nvidia)\//
    return ((await r.json()).data || [])
      .map((m: {id:string}) => m.id)
      .filter((id: string) => KNOWN.test(id) && !id.includes(':extended'))
      .sort()
  }
  throw new Error(`Unknown provider: ${provider}`)
}

// \u2500\u2500 Types \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
interface ProviderRow { provider: string; api_key: string; model: string; active: boolean }
interface AgentRow    { id: string; name: string; system_prompt: string; provider: string|null; model: string|null; active: boolean; uses_tools?: boolean }

// \u2500\u2500 Config loaders (with module-level cache) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// ── Embedding helper: OpenAI → Google → OpenRouter fallback ──────────────
// All providers normalised to 768 dims:
//   OpenAI  text-embedding-3-small  (dimensions=768 param)
//   Google  text-embedding-004      (native 768)
//   OpenRouter  openai/text-embedding-3-small  (dimensions=768)
async function getEmbedding(text: string, providers: ProviderRow[]): Promise<number[] | null> {
  const input = String(text).slice(0, 8000)

  // 1. OpenAI
  const oai = providers.find(p => p.provider === 'openai' && p.active && p.api_key?.trim())
  if (oai?.api_key) {
    const r = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${oai.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input, dimensions: 768 }),
    })
    if (r.ok) {
      const d = await r.json() as { data: [{ embedding: number[] }] }
      if (d.data?.[0]?.embedding) return d.data[0].embedding
    }
    // non-ok (quota etc.) — fall through to next provider
  }

  // 2. Google text-embedding-004 (native 768 dims)
  const goo = providers.find(p => p.provider === 'google' && p.active && p.api_key?.trim())
  if (goo?.api_key) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${goo.api_key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: { parts: [{ text: input }] }, taskType: 'RETRIEVAL_DOCUMENT' }),
      }
    )
    if (r.ok) {
      const d = await r.json() as { embedding?: { values: number[] } }
      if (d.embedding?.values) return d.embedding.values
    }
  }

  // 3. OpenRouter (proxies OpenAI embedding)
  const or_ = providers.find(p => p.provider === 'openrouter' && p.active && p.api_key?.trim())
  if (or_?.api_key) {
    const r = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${or_.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'openai/text-embedding-3-small', input, dimensions: 768 }),
    })
    if (r.ok) {
      const d = await r.json() as { data: [{ embedding: number[] }] }
      if (d.data?.[0]?.embedding) return d.data[0].embedding
    }
  }

  return null  // all providers exhausted / unconfigured
}

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
  const data = await dbGet('agents', 'id,name,system_prompt,provider,model,active,description,uses_tools')
  _cacheAgents = { data: data as AgentRow[], expires: Date.now() + CACHE_TTL }
  return data as AgentRow[]
}
async function loadAgentSkills(agentId: string): Promise<string> {
  const rows = await dbGet('agent_skills', 'skill', { agent: `eq.${agentId}` }, 'created_at.desc', 20)
  if (!rows.length) return ''
  return '\n\nLearned skills:\n' + (rows as {skill:string}[]).map(r => `- ${r.skill}`).join('\n')
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
// Tools available to Hermes (router-only): cannot use sub-agent tools directly
const HERMES_TOOL_NAMES = new Set(['delegate_to_agent', 'remember', 'learn_gaps', 'learn'])
function getActiveTools() {
  const all = TOOL_DEFS
  return _reqHermesMode ? all.filter(t => HERMES_TOOL_NAMES.has(t.name)) : all
}

async function callAnthropic(apiKey: string, model: string, system: string, messages: object[], useTools = false): Promise<string> {
  const body: Record<string,unknown> = {
    model: model || 'claude-sonnet-4-6',
    max_tokens: 4096,
    system,
    messages,
  }
  if (useTools) {
    body.tools = getActiveTools().map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }))
  }

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
  if (useTools) body.tools = getActiveTools().map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))

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
  if (useTools) body.tools = [{ function_declarations: getActiveTools().map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }]

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
        if (evt.type === 'message_start')    _lastUsage.tokens_in  += evt.message?.usage?.input_tokens  || 0
        if (evt.type === 'message_delta')    _lastUsage.tokens_out += evt.usage?.output_tokens           || 0
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
    body: JSON.stringify({ model: model || 'gpt-4o-mini', messages: msgs, stream: true, stream_options: { include_usage: true } }),
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
      try {
        const parsed = JSON.parse(raw)
        const chunk = parsed.choices?.[0]?.delta?.content; if (chunk) await onChunk(chunk)
        if (parsed.usage) { _lastUsage.tokens_in += parsed.usage.prompt_tokens||0; _lastUsage.tokens_out += parsed.usage.completion_tokens||0 }
      } catch { /* skip */ }
    }
  }
}

async function streamOpenRouter(apiKey: string, model: string, system: string, messages: object[], useTools: boolean, onChunk: ChunkFn): Promise<void> {
  if (useTools) {
    const text = await callOpenRouter(apiKey, model, system, messages, true)
    await streamText(text, onChunk); return
  }
  const msgs = [{ role: 'system', content: system }, ...messages as object[]]
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://orchestrator-agent.ks9988467.workers.dev',
      'X-Title': 'Orchestrator Agent',
    },
    body: JSON.stringify({ model: model || 'deepseek/deepseek-r1', messages: msgs, stream: true }),
  })
  if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${await r.text()}`)
  const reader = r.body!.getReader(); const dec = new TextDecoder(); let buf = ''
  while (true) {
    const { done, value } = await reader.read(); if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n'); buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const raw = line.slice(6).trim(); if (raw === '[DONE]') return; if (!raw) continue
      try {
        const parsed = JSON.parse(raw)
        const chunk = parsed.choices?.[0]?.delta?.content; if (chunk) await onChunk(chunk)
        if (parsed.usage) { _lastUsage.tokens_in += parsed.usage.prompt_tokens||0; _lastUsage.tokens_out += parsed.usage.completion_tokens||0 }
      } catch { /* skip */ }
    }
  }
}

async function callOpenRouter(apiKey: string, model: string, system: string, messages: object[], useTools = false): Promise<string> {
  const msgs: Record<string,unknown>[] = [{ role: 'system', content: system }, ...messages as Record<string,unknown>[]]
  const body: Record<string,unknown> = { model: model || 'perplexity/sonar', messages: msgs }
  if (useTools) body.tools = getActiveTools().map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
  const OR_HEADERS = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://orchestrator-agent.ks9988467.workers.dev',
    'X-Title': 'Orchestrator Agent',
  }
  let iterations = 0
  while (iterations++ < 8) {
    body.messages = msgs
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: OR_HEADERS, body: JSON.stringify(body) })
    if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${await r.text()}`)
    const resp = await r.json()
    if (resp.usage) { _lastUsage.tokens_in += resp.usage.prompt_tokens||0; _lastUsage.tokens_out += resp.usage.completion_tokens||0 }
    const msg = resp.choices?.[0]?.message
    if (msg?.tool_calls?.length) {
      msgs.push(msg)
      const results = await Promise.all((msg.tool_calls as Record<string,unknown>[]).map(async (tc) => {
        const fn = tc.function as Record<string,string>
        return { role: 'tool', tool_call_id: tc.id, content: await executeTool(fn.name, JSON.parse(fn.arguments || '{}')) }
      }))
      msgs.push(...results)
    } else {
      return String(msg?.content || '')
    }
  }
  return 'Tool loop limit reached.'
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
      try {
        const parsed = JSON.parse(raw)
        const chunk = parsed.candidates?.[0]?.content?.parts?.[0]?.text; if (chunk) await onChunk(chunk)
        const meta = parsed.usageMetadata
        if (meta) { _lastUsage.tokens_in += meta.promptTokenCount||0; _lastUsage.tokens_out += meta.candidatesTokenCount||0 }
      } catch { /* skip */ }
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
      resetUsage(model)
      if      (p.provider === 'anthropic')   await streamAnthropic(p.api_key, model, system, messages, useTools, onChunk)
      else if (p.provider === 'openai')      await streamOpenAI(p.api_key, model, system, messages, useTools, onChunk)
      else if (p.provider === 'google')      await streamGoogle(p.api_key, model, system, messages, useTools, onChunk)
      else if (p.provider === 'openrouter')  await streamOpenRouter(p.api_key, model, system, messages, useTools, onChunk)
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
      if      (p.provider === 'anthropic')   text = await callAnthropic(p.api_key, model, system, messages, useTools)
      else if (p.provider === 'openai')      text = await callOpenAI(p.api_key, model, system, messages, useTools)
      else if (p.provider === 'google')      text = await callGoogle(p.api_key, model, system, messages, useTools)
      else if (p.provider === 'openrouter')  text = await callOpenRouter(p.api_key, model, system, messages)
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
const ZH_CRM4  = _c([32447,32034])                           // xian suo     \u7EBF\u7D22
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
  const m = message
  // Use _c()-built constants (correct codepoints, no UTF-8 literal encoding issues)
  // All ZH_* constants defined above — only ZH_CRM4 was fixed (32034 not 31034)
  const has = (...terms: string[]) => terms.some(t => m.includes(t) || m.toLowerCase().includes(t))
  const ROUTES: [string, boolean][] = [
    ['cpl',       has('cpl', 'cost per lead', ZH_CPL1, ZH_CPL2)],
    ['cpr',       has('cpr', 'cost per result', ZH_CPR1)],
    ['frequency', has('frequency', 'ad fatigue', ZH_FREQ1, ZH_FREQ2, ZH_FREQ3, ZH_FREQ4)],
    ['code',      has('code','bug','error','debug','script','function','api', ZH_CODE1,ZH_CODE2,ZH_CODE3,ZH_CODE4,ZH_CODE5,ZH_CODE6,ZH_CODE7,ZH_CODE8)],
    ['crm',       has('lead','leads','contact','crm', ZH_CRM1, ZH_CRM3, ZH_CRM4)],  // ZH_CRM4=线索 now fixed
    ['account',   has('spend','campaign','marketing','budget', ZH_ACC1,ZH_ACC2,ZH_ACC3,ZH_ACC4)],
  ]
  for (const [agentId, matches] of ROUTES) {
    if (matches) {
      const found = active.find(a => a.id === agentId)
      if (found) return found
    }
  }
  return null
}

// ── Agents that use data tools ───────────────────────────────────────
const DATA_AGENTS = new Set(['chat', 'crm', 'account', 'cpl', 'cpr', 'frequency', 'marketing', 'review', 'report'])

// ── Data extraction keyword detection ────────────────────────────────
const DATA_EXTRACT_KW = ['录入','提取','读取数据','导入','解析文件','抽取','存入系统','数据录入','extract','import data']
function needsDataExtract(msg: string): boolean {
  return DATA_EXTRACT_KW.some(k => msg.includes(k))
}

// ── Extract structured data from a file via Anthropic multimodal ─────
async function extractFileData(
  providers: ProviderRow[], fileUrl: string, fileName: string,
  fileType: string, note: string
): Promise<{ structured: Record<string,unknown>; summary: string; dataType: string }> {
  const anth = providers.find(p => p.provider === 'anthropic' && p.active)
  if (!anth?.api_key) return { structured: {}, summary: '未配置 Anthropic API Key', dataType: '' }

  const content: object[] = []
  const headers: Record<string,string> = {
    'x-api-key': anth.api_key,
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json',
  }

  if (fileType === 'image') {
    content.push({ type: 'image', source: { type: 'url', url: fileUrl } })
  } else if (fileType === 'pdf' || fileType === 'word') {
    content.push({ type: 'document', source: { type: 'url', url: fileUrl } })
    headers['anthropic-beta'] = 'pdfs-2024-09-25'
  } else {
    // Excel / CSV: fetch raw text
    try {
      const r = await fetch(fileUrl)
      const raw = await r.text()
      content.push({ type: 'text', text: `文件内容（${fileName}）：\n${raw.slice(0, 8000)}` })
    } catch { content.push({ type: 'text', text: `文件：${fileName}（无法读取内容）` }) }
  }

  content.push({
    type: 'text',
    text: (note ? `用户说明：${note}\n\n` : '') +
      '请从以上文件中提取所有关键数据字段，返回严格JSON格式：\n' +
      '{"fields":{"字段名":"值",...},"summary":"一行中文摘要","data_type":"文件类型/业务描述"}'
  })

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers,
    body: JSON.stringify({ model: anth.model || 'claude-sonnet-4-6', max_tokens: 2048, messages: [{ role: 'user', content }] })
  })
  if (!r.ok) return { structured: {}, summary: `提取失败 ${r.status}`, dataType: '' }

  const d = await r.json() as { content: { text: string }[] }
  const text = d.content?.[0]?.text || ''
  const m = text.match(/\{[\s\S]*\}/)
  if (m) {
    try {
      const parsed = JSON.parse(m[0])
      return { structured: parsed.fields || {}, summary: parsed.summary || '', dataType: parsed.data_type || '' }
    } catch { /* fall through */ }
  }
  return { structured: {}, summary: text.slice(0, 300), dataType: '' }
}

// \u2500\u2500 Workflow scheduler \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// schedule format: standard 5-field cron (MIN HOUR DOM MON DOW) or legacy daily:/weekly:/hourly/interval:
function matchCronField(field: string, value: number): boolean {
  if (field === '*') return true
  for (const part of field.split(',')) {
    if (part.includes('/')) {
      const [range, stepStr] = part.split('/'); const step = parseInt(stepStr) || 1
      let start = 0, end = 9999
      if (range !== '*') {
        if (range.includes('-')) { const [a, b] = range.split('-').map(Number); start = a; end = b }
        else start = parseInt(range)
      }
      for (let v = start; v <= value; v += step) { if (v === value) return true }
    } else if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number); if (value >= a && value <= b) return true
    } else { if (parseInt(part) === value) return true }
  }
  return false
}
function nextCronRun(expr: string, from: Date): Date {
  const [minF, hourF, domF, monF, dowF] = expr.trim().split(/\s+/)
  const d = new Date(from); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1)
  for (let i = 0; i < 527040; i++) {
    if (matchCronField(monF, d.getMonth() + 1) && matchCronField(domF, d.getDate()) &&
        matchCronField(dowF, d.getDay()) && matchCronField(hourF, d.getHours()) &&
        matchCronField(minF, d.getMinutes())) return d
    d.setMinutes(d.getMinutes() + 1)
  }
  return new Date(from.getTime() + 24 * 60 * 60 * 1000)
}
function calcNextRun(schedule: string, from = new Date()): Date {
  const s = schedule.trim()
  const now = new Date(from)
  if (/^[\d/*,\-]+([ \t]+[\d/*,\-]+){4}$/.test(s)) return nextCronRun(s, now)
  if (s === 'hourly') return new Date(now.getTime() + 60 * 60 * 1000)
  if (s.startsWith('interval:')) {
    const mins = parseInt(s.split(':')[1]) || 60
    return new Date(now.getTime() + mins * 60 * 1000)
  }
  if (s.startsWith('daily:')) {
    const parts = s.split(':')
    const h = parseInt(parts[1]), m = parseInt(parts[2]) || 0
    const next = new Date(now); next.setHours(h, m, 0, 0)
    if (next <= now) next.setDate(next.getDate() + 1)
    return next
  }
  if (s.startsWith('weekly:')) {
    const parts = s.split(':'); const targetDay = parseInt(parts[1]) % 7
    const h = parseInt(parts[2]), m = parseInt(parts[3]) || 0
    const next = new Date(now); next.setHours(h, m, 0, 0)
    let daysUntil = (targetDay - now.getDay() + 7) % 7
    if (daysUntil === 0 && next <= now) daysUntil = 7
    next.setDate(next.getDate() + daysUntil)
    return next
  }
  if (s.startsWith('monthly:')) {
    const parts = s.split(':'); const h = parseInt(parts[1]), m = parseInt(parts[2]) || 0
    const next = new Date(now); next.setDate(1); next.setHours(h, m, 0, 0)
    if (next <= now) { next.setMonth(next.getMonth() + 1); next.setDate(1) }
    return next
  }
  return new Date(now.getTime() + 60 * 60 * 1000) // fallback: +1h
}

async function learnFromGaps(): Promise<{ ok: boolean; skills_added: number; processed: number }> {
  // Fetch up to 50 unhandled gap questions
  const rows = await dbGet('agent_suggestions', 'id,message', { handled: 'eq.false' }, 'asked_at.asc', 50) as { id: string; message: string }[]
  if (!rows.length) return { ok: true, skills_added: 0, processed: 0 }

  // Load existing skills to avoid duplicates
  const existingRows = await dbGet('agent_skills', 'skill', { agent: 'eq.chat' }, 'created_at.desc', 100) as { skill: string }[]
  const existingList = existingRows.map(r => `- ${r.skill}`).join('\n')

  const [providers, defaultProvider] = await Promise.all([loadProviders(), getDefaultProvider()])
  const questions = rows.map(r => `- ${r.message}`).join('\n')

  const { text } = await callLLM(providers, defaultProvider, undefined,
    `You analyze unanswered questions and generate delegation routing rules for an AI orchestrator called Hermes.
Hermes routes to: crm (客户关系), account (财务), cpl (获客成本), cpr (转化率), frequency (频率分析), report (报告), review (文件审核).
Output format (one per line): "When user asks about [topic], delegate to [agent_id] agent."
Max 5 rules. Skip questions that don't map to any agent.

EXISTING RULES (do NOT generate rules that are semantically similar to these):
${existingList || '(none yet)'}`,
    [{ role: 'user', content: `New unanswered questions:\n${questions}` }], false)

  const rules = text.split('\n').map(l => l.trim()).filter(l => l.startsWith('When'))
  const ids = rows.map(r => r.id)

  await Promise.all([
    ...rules.map(rule => dbInsert('agent_skills', { agent: 'chat', skill: rule })),
    fetch(`${SUPABASE_URL}/rest/v1/agent_suggestions?id=in.(${ids.join(',')})`, {
      method: 'PATCH',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ handled: true }),
    }),
  ])

  return { ok: true, skills_added: rules.length, processed: rows.length }
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
    const schedule = String(wf.schedule)
    const wfId    = String(wf.id)
    const nodes   = (wf.nodes as {id:string;type:string;config:Record<string,string>}[]) || []
    const edges   = (wf.edges as {from:string;to:string}[]) || []

    let response = '', errorMsg = ''
    try {
      if (nodes.length > 0) {
        // New nodes/edges style — execute sequentially
        let context: Record<string,unknown> = { input: {} }
        const incoming = new Set(edges.map((e:{from:string;to:string}) => e.to))
        const nodeMap  = Object.fromEntries(nodes.map(n => [n.id, n]))
        const start    = nodes.find(n => !incoming.has(n.id))
        if (!start) throw new Error('No start node')
        const visited = new Set<string>()
        let cur: string|undefined = start.id
        while (cur && !visited.has(cur)) {
          visited.add(cur)
          const node = nodeMap[cur]
          if (!node) break
          if (node.type === 'agent') {
            const agent = agents.find(a => a.id === node.config?.agent_id) ?? agents.find(a => a.id === 'chat') ?? agents[0]
            const prompt = (node.config?.prompt || '{{input}}').replace('{{input}}', JSON.stringify(context.input))
            const skillText = await loadAgentSkills(agent?.id || '')
            const system = (agent?.system_prompt || 'You are a helpful assistant.') + '\n\n' + SOUL + skillText
            const { text } = await callLLM(providers, agent?.provider || defaultProvider, agent?.model, system, [{ role:'user', content:prompt }])
            context[node.id] = text; context.last_output = text
          } else if (node.type === 'condition') {
            const passed = String(context.last_output||'').toLowerCase().includes((node.config?.keyword||'').toLowerCase())
            context[node.id] = passed ? 'true' : 'false'
          } else if (node.type === 'output') {
            context.final_output = context.last_output
          } else if (node.type === 'self_learn') {
            const result = await learnFromGaps()
            const msg = `学习完成：分析 ${result.processed} 条问题，新增 ${result.skills_added} 条路由规则`
            context[node.id] = msg; context.last_output = msg
          } else if (node.type === 'skill_audit') {
            const skillRows = await dbGet('agent_skills', 'id,agent,skill', {}, 'created_at.desc', 200) as {id:string;agent:string;skill:string}[]
            if (!skillRows.length) {
              const msg = '技能库为空，跳过审计'
              context[node.id] = msg; context.last_output = msg
            } else {
              const list = skillRows.map((r,i) => `[${i+1}] agent=${r.agent}: ${r.skill}`).join('\n')
              const { text } = await callLLM(providers, defaultProvider, undefined,
                `You audit an AI routing rule library. Identify rules that are exact/near-duplicate, contradictory, or overly vague.
Return ONLY a JSON array of 1-indexed rule numbers to DELETE: [1,3] or [] if none. Nothing else.`,
                [{ role:'user', content: `Rules:\n${list}` }], false)
              const m = text.match(/\[[\d,\s]*\]/)
              const toDelete = m ? (JSON.parse(m[0]) as number[]).filter(n => n >= 1 && n <= skillRows.length) : []
              if (toDelete.length) {
                const ids = toDelete.map(n => skillRows[n-1].id)
                await fetch(`${SUPABASE_URL}/rest/v1/agent_skills?id=in.(${ids.join(',')})`, {
                  method: 'DELETE',
                  headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'return=minimal' }
                })
              }
              const msg = `技能库审计完成：共 ${skillRows.length} 条规则，删除 ${toDelete.length} 条冗余/矛盾规则`
              context[node.id] = msg; context.last_output = msg
            }
          } else if (node.type === 'prefs_compact') {
            const prefRows = await dbGet('user_prefs', 'id,key,value,confidence', {}, 'confidence.asc', 200) as {id:string;key:string;value:string;confidence:number}[]
            if (!prefRows.length) {
              const msg = '偏好库为空，跳过压缩'
              context[node.id] = msg; context.last_output = msg
            } else {
              const list = prefRows.map((r,i) => `[${i+1}] key="${r.key}" value="${r.value}" confidence=${r.confidence}`).join('\n')
              const { text } = await callLLM(providers, defaultProvider, undefined,
                `You compress a user preference store. Identify entries to DELETE: semantically duplicate of another, confidence<0.5 AND redundant, or contradicting a higher-confidence entry.
Return ONLY a JSON array of 1-indexed entry numbers to DELETE: [2,5] or [] if none. Nothing else.`,
                [{ role:'user', content: `Preferences:\n${list}` }], false)
              const m = text.match(/\[[\d,\s]*\]/)
              const toDelete = m ? (JSON.parse(m[0]) as number[]).filter(n => n >= 1 && n <= prefRows.length) : []
              if (toDelete.length) {
                const ids = toDelete.map(n => prefRows[n-1].id)
                await fetch(`${SUPABASE_URL}/rest/v1/user_prefs?id=in.(${ids.join(',')})`, {
                  method: 'DELETE',
                  headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'return=minimal' }
                })
              }
              const msg = `偏好压缩完成：共 ${prefRows.length} 条偏好，删除 ${toDelete.length} 条冗余条目`
              context[node.id] = msg; context.last_output = msg
            }
          }
          const nextEdge = edges.find((e:{from:string;to:string}) => e.from === cur)
          cur = nextEdge?.to
        }
        response = String(context.final_output || context.last_output || '')
      } else {
        // Legacy agent_id/prompt style
        const agentId = String(wf.agent_id)
        const prompt  = String(wf.prompt)
        const agent = agents.find(a => a.id === agentId)
        if (!agent) throw new Error(`Agent ${agentId} not found`)
        const skillText = await loadAgentSkills(agentId)
        const system    = (agent.system_prompt || 'You are a helpful assistant.') + '\n\n' + SOUL + skillText
        const { text }  = await callLLM(providers, agent.provider || defaultProvider, agent.model, system, [{ role: 'user', content: prompt }])
        response = text
      }
    } catch(e) {
      errorMsg = (e as Error).message
    }

    // Save run history
    await dbInsert('workflow_runs', { workflow_id: wfId, response, error: errorMsg || null, ran_at: new Date().toISOString() })

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
      const rows = await dbGet('api_integrations', 'credentials', { service: 'eq.whatsapp', active: 'eq.true' })
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
    _reqDelegated         = false
    _reqSessionId         = ''
    _reqDelegatedId       = ''
    _reqDelegatedName     = ''
    _reqHermesMode        = false
    _reqDelegationContext = ''

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
          const agent   = agents.find((a: AgentRow) => a.id === 'chat') ?? agents[0]
          const [history, skillText] = await Promise.all([loadHistory(sid, 6), loadAgentSkills(agent.id)])
          const system  = (agent.system_prompt || 'You are a helpful assistant.') + '\n\n' + SOUL + skillText
          resetUsage(agent.model || '')
          const { text: reply } = await callLLM(providers, agent.provider || defaultProvider, agent.model,
            system, [...history, { role:'user', content:text }], DATA_AGENTS.has(agent.id) || !!agent.uses_tools)
          const _waCost = calcCost(_lastUsage.used_model || agent.model || '', _lastUsage.tokens_in, _lastUsage.tokens_out)
          await Promise.all([
            dbInsert('conversations', { session_id:sid, role:'user',      content:text,  agent:agent.id }),
            dbInsert('conversations', { session_id:sid, role:'assistant', content:reply, agent:agent.id, tokens_in:_lastUsage.tokens_in, tokens_out:_lastUsage.tokens_out, cost_usd:_waCost }),
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
      // Resolve tenant + role from tenant_users
      const tuRows = await dbGet('tenant_users', 'tenant_id,role', { email: `eq.${email}` })
      let tenantId: string|null = tuRows[0]?.tenant_id ?? null
      let role: string = tuRows[0]?.role ?? 'member'
      let tenantName = ''
      if (tenantId) {
        const tRows = await dbGet('tenants', 'name', { id: `eq.${tenantId}` })
        tenantName = tRows[0]?.name ?? ''
      } else {
        // Fallback: treat as master if no tenant_users record
        const masterRows = await dbGet('tenants', 'id,name', { name: 'eq.Master' })
        if (masterRows.length) { tenantId = masterRows[0].id; role = 'master'; tenantName = masterRows[0].name }
      }
      return new Response(JSON.stringify({ ok: true, tenant_id: tenantId, role, tenant_name: tenantName, email }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
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
    // ── Alert Rules CRUD ────────────────────────────────────────────
    if (body.action === 'list_alert_rules') {
      const rows = await dbGet('alert_rules', 'id,name,metric,threshold,operator,campaign_filter,active,created_at', tenantFilters(), 'created_at.desc', 50)
      return new Response(JSON.stringify({ rules: rows }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    if (body.action === 'save_alert_rule') {
      const { name: rname, metric: rmetric, threshold: rthreshold, operator: rop, campaign_filter: rcf } = body
      if (!rname || !rmetric || rthreshold === undefined)
        return new Response(JSON.stringify({ error: 'name, metric, threshold required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const row = await dbInsertReturning('alert_rules', { name: rname, metric: rmetric, threshold: +rthreshold, operator: rop || 'gt', campaign_filter: rcf || null, active: true, tenant_id: _reqTenantId })
      return new Response(JSON.stringify({ ok: true, rule: row }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    if (body.action === 'delete_alert_rule') {
      const { rule_id } = body
      if (!rule_id) return new Response(JSON.stringify({ error: 'rule_id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const tenantQ = _reqTenantId && !_reqIsMaster ? `&tenant_id=eq.${encodeURIComponent(_reqTenantId)}` : ''
      await fetch(`${SUPABASE_URL}/rest/v1/alert_rules?id=eq.${rule_id}${tenantQ}`, {
        method: 'DELETE', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      })
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (body.action === 'check_alerts') {
      try {
        const alertFilters = { ...tenantFilters(), active: 'eq.true' }
        const rules = await dbGet('alert_rules', 'id,name,metric,threshold,operator,campaign_filter', alertFilters) as Record<string,unknown>[]
        if (!rules.length) return new Response(JSON.stringify({ ok: true, triggered: 0, checked: 0 }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
        const weekAgo = new Date(Date.now() - 7*24*3600*1000).toISOString().slice(0,10)
        const analyticsFilters = { ...tenantFilters(), date: `gte.${weekAgo}` }
        const rows = await dbGet('analytics_daily',
          'campaign_name,date,spend_myr,cpl,cpr,frequency',
          analyticsFilters, 'date.desc', 500) as Record<string,unknown>[]
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
              await dbInsert('alerts', { rule_id: rule.id, rule_name: rule.name, campaign_name: camp, metric: rule.metric, value: +value.toFixed(4), threshold: rule.threshold, tenant_id: _reqTenantId })
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

    if (body.action === 'run_workflows') {
      await runWorkflows()
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── Agent Task actions ────────────────────────────────────────────
    if (body.action === 'start_task') {
      const { goal, session_id } = body
      if (!goal) return new Response(JSON.stringify({ error:'goal required' }), { status:400, headers:{...CORS,'Content-Type':'application/json'} })
      const [providers, defaultProvider, agents] = await Promise.all([loadProviders(), getDefaultProvider(), loadAgents()])
      const { text } = await callLLM(providers, defaultProvider, undefined,
        `You are Hermes task planner. Break the user goal into 3-6 concrete steps.
Available tools:
- web_search: params {"query":"..."} — search the web
- fetch_url: params {"url":"..."} — read a webpage
- call_agent: params {"agent_id":"chat|code|crm|account","prompt":"... use {{step_N}} to reference previous step results"}
- send_notification: params {"channel":"slack","message":"... use {{step_N}}"}
Return ONLY a valid JSON array, no markdown:
[{"id":"step_1","desc":"...","tool":"...","params":{...}},...]`,
        [{ role:'user', content:`Goal: ${goal}` }], false)
      let plan: TaskStep[] = []
      try {
        const m = text.match(/\[[\s\S]*?\]/)
        if (m) plan = (JSON.parse(m[0]) as TaskStep[]).map((s,i) => ({ ...s, id:`step_${i+1}`, status:'pending', result:null }))
      } catch { plan = [{ id:'step_1', desc:goal, tool:'call_agent', params:{ agent_id:'chat', prompt:goal }, status:'pending', result:null }] }
      const task = await dbInsertReturning('agent_tasks', { goal, plan, status:'pending', session_id:session_id||null, tenant_id:_reqTenantId }) as AgentTask
      // Kick off step execution immediately (fire-and-forget self-invoke)
      fetch(`${SUPABASE_URL}/functions/v1/orchestrator`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'execute_task_step', task_id: String(task.id) })
      }).catch(() => {})
      return new Response(JSON.stringify({ ok:true, task }), { headers:{...CORS,'Content-Type':'application/json'} })
    }

    if (body.action === 'execute_task_step') {
      const [providers, defaultProvider, agents] = await Promise.all([loadProviders(), getDefaultProvider(), loadAgents()])
      if (body.task_id) {
        // Targeted: chain-triggered for a specific task
        await executeTaskSteps(String(body.task_id), providers, defaultProvider, agents).catch(()=>{})
      } else {
        // pg_cron safety net: rescue any stuck running/pending tasks
        const running = await dbGet('agent_tasks','id',{ status:'eq.running' },'updated_at.asc',3) as {id:string}[]
        const pending = await dbGet('agent_tasks','id',{ status:'eq.pending' },'created_at.asc',2) as {id:string}[]
        const ids = [...running,...pending].map(t=>t.id).slice(0,3)
        await Promise.all(ids.map(id => executeTaskSteps(id, providers, defaultProvider, agents).catch(()=>{})))
      }
      return new Response(JSON.stringify({ ok:true }), { headers:{...CORS,'Content-Type':'application/json'} })
    }

    if (body.action === 'list_tasks') {
      const rows = await dbGet('agent_tasks','id,goal,status,current_step,plan,created_at',{},'created_at.desc',30)
      return new Response(JSON.stringify({ ok:true, tasks:rows }), { headers:{...CORS,'Content-Type':'application/json'} })
    }

    if (body.action === 'get_task') {
      const rows = await dbGet('agent_tasks','*',{ id:`eq.${body.id}` })
      if (!rows[0]) return new Response(JSON.stringify({ error:'not found' }), { status:404, headers:{...CORS,'Content-Type':'application/json'} })
      return new Response(JSON.stringify({ ok:true, task:rows[0] }), { headers:{...CORS,'Content-Type':'application/json'} })
    }

    if (body.action === 'cancel_task') {
      await dbPatch('agent_tasks', String(body.id), { status:'cancelled', updated_at:new Date().toISOString() })
      return new Response(JSON.stringify({ ok:true }), { headers:{...CORS,'Content-Type':'application/json'} })
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
    if (body.action === 'learn_gaps') {
      try {
        const result = await learnFromGaps()
        return new Response(JSON.stringify(result), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      } catch(e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
    }

    // ── UGC: platform rules ───────────────────────────────────────────
    const UGC_DEFAULT_RULES: Record<string,{maxWords:string,style:string,special:string}> = {
      tiktok:      {maxWords:'旁白短句，每句≤10字',       style:'冲击口语，像真人说话，节奏快',        special:'需要字幕关键句，前3秒必须抓住注意力'},
      ig_reels:    {maxWords:'说明栏≤150字',              style:'有温度，生活感，轻松自然',            special:'说明栏配合视频，引导互动'},
      ig_feed:     {maxWords:'正文150-300字',             style:'故事感，有画面，细节丰富',            special:'需要封面框架，排版留白，适合存图'},
      fb_reels:    {maxWords:'说明栏≤120字',              style:'轻松直接，像朋友分享',                special:'说明栏简洁，CTA清晰'},
      fb_post:     {maxWords:'正文200-400字',             style:'对话感，像朋友喝咖啡聊天，真实自然',  special:'可以有Q&A格式，步骤条列，Emoji适量'},
      xiaohongshu: {maxWords:'正文200-350字',             style:'生活感强，像日记，温暖分享',          special:'标题要有吸引力，多用换行，emoji较多，适合存图'},
      youtube:     {maxWords:'说明栏≤100字',              style:'简洁专业，有SEO意识',                 special:'加入关键词，引导订阅'},
    }

    if (body.action === 'ugc_get_rules') {
      const tid = _reqTenantId || 'default'
      const rows = await dbGet('ugc_platform_rules', 'platform,max_words,style,special', { tenant_id: `eq.${tid}` })
      const result: Record<string,unknown> = { ...UGC_DEFAULT_RULES }
      for (const r of rows as {platform:string,max_words:string,style:string,special:string}[]) {
        result[r.platform] = { maxWords: r.max_words, style: r.style, special: r.special }
      }
      return new Response(JSON.stringify({ ok: true, rules: result }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (body.action === 'ugc_save_rule') {
      const { platform, max_words, style, special } = body
      if (!platform) return new Response(JSON.stringify({ error: 'platform required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const tid = _reqTenantId || 'default'
      await dbUpsert('ugc_platform_rules',
        { tenant_id: tid, platform, max_words: max_words||'', style: style||'', special: special||'', updated_at: new Date().toISOString() },
        'tenant_id,platform'
      )
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (body.action === 'ugc_reset_rule') {
      const { platform } = body
      if (!platform) return new Response(JSON.stringify({ error: 'platform required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const tid = _reqTenantId || 'default'
      await fetch(`${SUPABASE_URL}/rest/v1/ugc_platform_rules?tenant_id=eq.${encodeURIComponent(tid)}&platform=eq.${encodeURIComponent(platform)}`, {
        method: 'DELETE', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      })
      const def = UGC_DEFAULT_RULES[platform] || {}
      return new Response(JSON.stringify({ ok: true, rule: def }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (body.action === 'ugc_generate') {
      const { type, product, audience, content, duration, platforms: ugcPlatforms } = body
      if (!type || !content) return new Response(JSON.stringify({ error: 'type and content required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })

      const [providers, defaultProvider, agents] = await Promise.all([loadProviders(), getDefaultProvider(), loadAgents()])
      const ugcAgent = agents.find((a:AgentRow) => a.id === 'ugc') ?? agents.find((a:AgentRow) => a.id === 'chat') ?? agents[0]
      const sysPrompt = ugcAgent.system_prompt || 'You are a UGC content creator. Output only valid JSON.'

      // Phone CTA lookup
      const PHONES: Record<string,{num:string,wa:string,name?:string,special?:boolean}> = {
        ultra_cleaning:{num:'019-291 1001',wa:'60192911001'}, hour_clean:{num:'019-291 1001',wa:'60192911001'},
        pro_clean:{num:'016-224 2788',wa:'60162242788',name:'Aaron'}, maint_clean:{num:'019-291 1001',wa:'60192911001'},
        aircon_care:{num:'017-242 6722',wa:'60172426722',name:'午哥'}, pest_care:{num:'019-291 1001',wa:'60192911001'},
        pool_care:{num:'019-238 2788',wa:'60192382788',name:'Andy'}, handy_care:{num:'019-291 1001',wa:'60192911001'},
        home_care:{num:'019-291 1001',wa:'60192911001'}, garden_care:{num:'019-291 1001',wa:'60192911001'},
        hygiene:{num:'019-444 2549',wa:'60194442549',name:'Daniel',special:true},
        agency:{num:'019-291 1001',wa:'60192911001'}, academy:{num:'019-291 1001',wa:'60192911001'},
      }
      const ph = PHONES[product] || PHONES['ultra_cleaning']
      const cta = ph.special
        ? `想买？点导购👇\nhttps://shopee.com.my/ultracleaningmy\n大量购买？WhatsApp PM我！\nhttps://wa.me/${ph.wa}`
        : `📲 ${ph.num}${ph.name?' ('+ph.name+')':''}\nhttps://wa.me/${ph.wa}`

      let userMsg = ''
      if (type === 'script') {
        userMsg = `Product: ${product} | Audience: ${audience} | Duration: ${duration||30}s\nInput:\n${content}\n\nOutput JSON: {"voiceover":"full voiceover script with \\n for line breaks","captions":["line1","line2","line3","line4","line5"],"hook":"opening hook sentence"}`
      } else if (type === 'cover') {
        userMsg = `Product: ${product} | Audience: ${audience}\nScript:\n${content}\n\nOutput JSON with keys zh,en,ms. Each: {"covers":[{"main":"","sub":"","type":"resonance|curiosity|disbelief"},{"main":"","sub":"","type":""}],"hook":"","hookType":"resonance|curiosity|disbelief","hookLabel":"","keywords":[{"word":"","hot":true|false}]}`
      } else if (type === 'post') {
        // Load platform rules for this tenant
        const tid = _reqTenantId || 'default'
        const ruleRows = await dbGet('ugc_platform_rules', 'platform,max_words,style,special', { tenant_id: `eq.${tid}` })
        const customRules: Record<string,unknown> = {}
        for (const r of ruleRows as {platform:string,max_words:string,style:string}[]) customRules[r.platform] = r
        const selPlatforms = (ugcPlatforms as string[]) || []
        let rulesDesc = ''
        for (const pv of selPlatforms) {
          const r = (customRules[pv] || UGC_DEFAULT_RULES[pv] || {}) as {maxWords?:string,style?:string,max_words?:string}
          rulesDesc += `\n${pv}: ${r.maxWords||r.max_words||''} | ${r.style||''}`
        }
        userMsg = `Product: ${product} | Audience: ${audience}\nCTA:\n${cta}\nPlatform rules:${rulesDesc}\nScript:\n${content}\n\nOutput JSON with keys zh/en/ms. Each language has keys: ${selPlatforms.join(',')}. Each value = complete post body + 10-15 hashtags + CTA. Use \\n for line breaks.`
      }

      try {
        const { text } = await callLLM(providers, ugcAgent.provider || defaultProvider, ugcAgent.model || undefined,
          sysPrompt, [{ role: 'user', content: userMsg }], false)
        // Strip markdown fences
        const cleaned = text.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim()
        const start = cleaned.search(/[{[]/)
        const json = start >= 0 ? cleaned.slice(start) : cleaned
        return new Response(JSON.stringify({ ok: true, result: json }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      } catch(e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
    }

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

    // ── Tenant management actions (master only) ─────────────────────
    if (body.action === 'list_tenants') {
      if (!_reqIsMaster) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const rows = await dbGet('tenants', 'id,name,slug,contact_name,contact_email,active,created_at', {}, 'created_at.desc')
      return new Response(JSON.stringify({ tenants: rows }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (body.action === 'create_tenant') {
      if (!_reqIsMaster) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const { name, contact_name, contact_email } = body
      if (!name) return new Response(JSON.stringify({ error: 'name required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const row = await dbInsertReturning('tenants', { name, contact_name: contact_name||null, contact_email: contact_email||null, active: true })
      return new Response(JSON.stringify({ ok: true, tenant: row }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (body.action === 'update_tenant') {
      if (!_reqIsMaster) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const { tenant_id, active, name, contact_name, contact_email } = body
      if (!tenant_id) return new Response(JSON.stringify({ error: 'tenant_id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const patch: Record<string,unknown> = {}
      if (active !== undefined) patch.active = active
      if (name !== undefined) patch.name = name
      if (contact_name !== undefined) patch.contact_name = contact_name
      if (contact_email !== undefined) patch.contact_email = contact_email
      await dbPatch('tenants', tenant_id as string, patch)
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (body.action === 'add_tenant_user') {
      if (!_reqIsMaster) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const { tenant_id, email, role: uRole } = body
      if (!tenant_id || !email) return new Response(JSON.stringify({ error: 'tenant_id and email required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      await dbInsert('tenant_users', { tenant_id, email, role: uRole || 'member' })
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (body.action === 'get_master_summary') {
      if (!_reqIsMaster) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const tenants = await dbGet('tenants', 'id,name,active', { active: 'eq.true' })
      const results = await Promise.all((tenants as {id:string,name:string,active:boolean}[]).map(async t => {
        const [convs, alerts, reviews] = await Promise.all([
          dbGet('conversations', 'id', { tenant_id: `eq.${t.id}` }, 'id.desc', 100),
          dbGet('alerts', 'id,rule_name,triggered_at', { tenant_id: `eq.${t.id}` }, 'triggered_at.desc', 5),
          dbGet('reviews', 'id,status', { tenant_id: `eq.${t.id}`, status: 'eq.pending' }),
        ])
        return { ...t, conversation_count: convs.length, alerts, pending_reviews: reviews.length }
      }))
      return new Response(JSON.stringify({ tenants: results }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── Review agent actions ────────────────────────────────────────
    if (body.action === 'get_reviewers') {
      // Flat list of all reviewers (for manual tagging in upload modal)
      const filters = tenantFilters({ active: 'eq.true' })
      const rows = await dbGet('department_routes', 'id,reviewer_name,reviewer_email,reviewer_company_id,department', filters, 'reviewer_name.asc')
      return new Response(JSON.stringify({ reviewers: rows }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (body.action === 'get_department_routes') {
      const filters = tenantFilters({ active: 'eq.true' })
      const rows = await dbGet('department_routes', 'id,department,reviewer_name,reviewer_email,reviewer_company_id', filters, 'department.asc')
      return new Response(JSON.stringify({ routes: rows }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (body.action === 'save_department_route') {
      const { id: routeId, department, reviewer_name, reviewer_email, reviewer_company_id } = body
      if (!department || !reviewer_name || (!reviewer_email && !reviewer_company_id))
        return new Response(JSON.stringify({ error: 'department, reviewer_name, and reviewer_email or reviewer_company_id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const data = { department, reviewer_name, reviewer_email: reviewer_email||null, reviewer_company_id: reviewer_company_id||null }
      if (routeId) {
        await dbPatch('department_routes', routeId as string, data)
      } else {
        await dbInsert('department_routes', { ...data, tenant_id: _reqTenantId, active: true })
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (body.action === 'delete_department_route') {
      const { id: routeId } = body
      if (!routeId) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      await dbPatch('department_routes', routeId as string, { active: false })
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (body.action === 'submit_review') {
      const { file_name, file_type, file_content, file_url, reviewer_id, note, submitted_by } = body
      if (!file_name || !file_type)
        return new Response(JSON.stringify({ error: 'file_name and file_type required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      try {
        let route: Record<string,string>|null = null
        let department = 'Unknown'
        let summary = ''
        let key_info: Record<string,unknown> = {}
        let classification_reason = ''

        if (reviewer_id) {
          // ── Direct mode: reviewer manually chosen, no AI classification ──
          const routeRows = await dbGet('department_routes', 'id,reviewer_name,reviewer_email,reviewer_company_id,department', { id: `eq.${reviewer_id}` }, undefined, 1)
          route = (routeRows[0] as Record<string,string>|undefined) ?? null
          department = route?.department || 'Unknown'
          summary = String(note || '')
          classification_reason = '手动指定审核人'
        } else if (file_content) {
          // ── AI classification mode: paste text, auto-route by department ──
          const [providers, defaultProvider] = await Promise.all([loadProviders(), getDefaultProvider()])
          const classifyPrompt = `Analyze this document and respond with ONLY valid JSON (no markdown):\n{\n  "department": "Finance|HR|IT|Sales|Purchase|Operations|Unknown",\n  "reason": "one sentence why",\n  "key_info": { "extracted key fields": "values" },\n  "summary": "2-3 sentence summary"\n}\nDocument: ${file_name}\nContent:\n${(file_content as string).slice(0, 8000)}`
          const { text } = await callLLM(providers, defaultProvider, undefined,
            'You are a document classification expert. Analyze documents and output only valid JSON.',
            [{ role: 'user', content: classifyPrompt }], false)
          let cl: Record<string,unknown> = { department: 'Unknown', reason: '', key_info: {}, summary: '' }
          try { const m = text.match(/\{[\s\S]*\}/); if (m) cl = { ...cl, ...JSON.parse(m[0]) } } catch { /* default */ }
          department = String(cl.department)
          summary    = String(cl.summary)
          key_info   = cl.key_info as Record<string,unknown>
          classification_reason = String(cl.reason)
          const routeFilters = tenantFilters({ department: `eq.${department}`, active: 'eq.true' })
          const routes = await dbGet('department_routes', 'id,reviewer_name,reviewer_email,reviewer_company_id', routeFilters, undefined, 1)
          route = (routes[0] as Record<string,string>|undefined) ?? null
        }

        // Insert review record
        const review = await dbInsertReturning('reviews', {
          tenant_id: _reqTenantId,
          file_name, file_type,
          file_content: file_content || null,
          file_url: file_url || null,
          department,
          classification_reason,
          key_info,
          summary,
          submitted_by: submitted_by || 'unknown',
          reviewer_route_id: route?.id ?? null,
          status: 'pending',
        })

        // Email notification if reviewer has email
        let notified = false
        if (route?.reviewer_email) {
          try {
            const { SmtpClient } = await import('https://deno.land/x/denomailer@1.6.0/mod.ts')
            const client = new SmtpClient()
            await client.connectTLS({ hostname: 'smtp.gmail.com', port: 465, username: 'ks9988467@gmail.com', password: Deno.env.get('GMAIL_APP_PWD')! })
            const fileInfo = file_url ? `\n文件链接：${file_url}` : ''
            await client.send({
              from: 'Orchestrator Agent <ks9988467@gmail.com>',
              to: route.reviewer_email,
              subject: `[审核请求] ${department} - ${file_name}`,
              content: `您好 ${route.reviewer_name}，\n\n有新文件需要您审核：\n\n文件名：${file_name}\n部门：${department}${fileInfo}${summary ? '\n说明：' + summary : ''}\n\n请登录系统完成审核。\n\n提交人：${submitted_by || 'unknown'}`,
            })
            await client.close()
            await dbPatch('reviews', review.id as string, { notified_at: new Date().toISOString() })
            notified = true
          } catch { /* email failure is non-fatal */ }
        }
        // Lark webhook notification
        try {
          const lark = await getLarkConfig()
          if (lark?.webhook_url) {
            await sendLarkWebhook(lark.webhook_url,
              `📋 新文件审核请求 — ${department}`,
              `**文件：** ${file_name}\n**提交人：** ${submitted_by || 'unknown'}\n${summary ? '**摘要：** ' + summary : ''}`,
              file_url as string|undefined)
            if (!notified) { await dbPatch('reviews', review.id as string, { notified_at: new Date().toISOString() }); notified = true }
          }
        } catch { /* non-fatal */ }
        // Slack notification
        await notifySlack(`📋 新审核请求 — ${department}`, `文件：${file_name}\n提交人：${submitted_by||'unknown'}${summary ? '\n摘要：'+summary : ''}`)

        return new Response(JSON.stringify({
          ok: true,
          review_id: review.id,
          department,
          summary,
          reviewer: route ? { name: route.reviewer_name, email: route.reviewer_email||null, company_id: route.reviewer_company_id||null } : null,
          notified,
        }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      } catch(e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
    }

    // ── Document reviewer notifications ──────────────────────────────
    if (body.action === 'notify_doc_reviewers') {
      const { doc_id, doc_title, uploaded_by, reviewers } = body as any
      const revList: Array<{name:string;contact:string}> = reviewers || []
      const title    = String(doc_title || '文件')
      const uploader = String(uploaded_by || '系统')
      const dashUrl  = 'https://orchestrator-agent.ks9988467.workers.dev'
      const msg = `📋 文件审批请求\n\n文件：${title}\n上传人：${uploader}\n\n请登入系统进行审批。\n${dashUrl}`
      let sent = 0
      const results: any[] = []
      for (const rev of revList) {
        const contact = (rev.contact || '').trim()
        if (!contact) continue
        const isEmail = contact.includes('@')
        try {
          await sendNotification(isEmail ? 'sendgrid' : 'whatsapp', msg, contact)
          sent++
          results.push({ name: rev.name, channel: isEmail ? 'email' : 'whatsapp', status: 'sent' })
        } catch(e) {
          results.push({ name: rev.name, status: 'error', error: (e as Error).message })
        }
      }
      return new Response(JSON.stringify({ ok: true, sent, results }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (body.action === 'notify_doc_decision') {
      const { doc_title, decision, reviewer_name, uploaded_by } = body as any
      if (!uploaded_by) return new Response(JSON.stringify({ ok: true, sent: 0 }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      const decLabel = decision === 'approved' ? '✅ 已批准' : '❌ 已拒绝'
      const msg = `${decLabel}\n\n文件：${doc_title || '—'}\n审批人：${reviewer_name || '—'}\n\n请登入系统查看详情。`
      const isEmail = String(uploaded_by).includes('@')
      try {
        await sendNotification(isEmail ? 'sendgrid' : 'whatsapp', msg, String(uploaded_by))
        return new Response(JSON.stringify({ ok: true, sent: 1 }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      } catch(e) {
        return new Response(JSON.stringify({ ok: true, sent: 0, error: (e as Error).message }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
    }

    // ── Test LLM provider ──────────────────────────────────────────
    if (body.action === 'test_llm') {
      const targetProvider = String(body.provider || '')
      if (!targetProvider) return new Response(JSON.stringify({ ok: false, error: 'provider 参数缺失' }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      try {
        const allProviders = await loadProviders()
        const provRow = allProviders.find(p => p.provider === targetProvider)
        if (!provRow) return new Response(JSON.stringify({ ok: false, error: `Provider "${targetProvider}" 未在数据库配置` }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
        if (!provRow.api_key) return new Response(JSON.stringify({ ok: false, error: 'API Key 为空，请先保存 Key' }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
        const testModel = provRow.model || undefined
        const testMessages = [{ role: 'user', content: 'Reply with exactly one word: ok' }]
        const testSystem = 'You are a test assistant. Follow instructions exactly.'
        let text = ''
        if      (targetProvider === 'anthropic')   text = await callAnthropic(provRow.api_key, testModel, testSystem, testMessages, false)
        else if (targetProvider === 'openai')      text = await callOpenAI(provRow.api_key, testModel, testSystem, testMessages, false)
        else if (targetProvider === 'google')      text = await callGoogle(provRow.api_key, testModel, testSystem, testMessages, false)
        else if (targetProvider === 'openrouter')  text = await callOpenRouter(provRow.api_key, testModel, testSystem, testMessages)
        else return new Response(JSON.stringify({ ok: false, error: `未知 provider: ${targetProvider}` }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
        return new Response(JSON.stringify({ ok: true, response: text.slice(0, 200), model_used: testModel || '(default)' }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      } catch(e) {
        return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
    }

    // ── Test WhatsApp ───────────────────────────────────────────────
    if (body.action === 'test_whatsapp') {
      try {
        const rows = await dbGet('api_integrations', 'credentials', { service: 'eq.whatsapp', active: 'eq.true' })
        const creds = (rows[0] as any)?.credentials
        if (!creds?.phone_number_id || !creds?.access_token)
          return new Response(JSON.stringify({ error: '请先保存 WhatsApp 凭证并启用' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        const to = creds.default_recipient
        if (!to)
          return new Response(JSON.stringify({ error: '请填写默认接收号码' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        const r = await fetch(`https://graph.facebook.com/v18.0/${creds.phone_number_id}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: '✅ Orchestrator Agent — WhatsApp 连接测试成功！' } }),
        })
        const rj = await r.json() as any
        if (!r.ok) return new Response(JSON.stringify({ error: rj?.error?.message || `WhatsApp API ${r.status}` }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      } catch(e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
    }

    // ── Test SendGrid ───────────────────────────────────────────────
    if (body.action === 'test_sendgrid') {
      try {
        const rows = await dbGet('api_integrations', 'credentials', { service: 'eq.sendgrid', active: 'eq.true' }, undefined, 1)
        const creds = (rows[0] as any)?.credentials
        if (!creds?.api_key)
          return new Response(JSON.stringify({ error: '请先保存 SendGrid API Key 并启用' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        const to = creds.from_address
        if (!to)
          return new Response(JSON.stringify({ error: '请填写 From Address（测试邮件将发送到该地址）' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.api_key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: to }] }],
            from: { email: to, name: 'Orchestrator' },
            subject: '✅ Orchestrator Agent — SendGrid 连接测试',
            content: [{ type: 'text/plain', value: 'SendGrid 邮件集成配置正确，连接测试成功！' }]
          })
        })
        if (r.status === 202 || r.ok) return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
        const rj = await r.json().catch(() => ({})) as any
        return new Response(JSON.stringify({ error: rj?.errors?.[0]?.message || `SendGrid API ${r.status}` }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      } catch(e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
    }

    // ── Test Email SMTP ─────────────────────────────────────────────
    if (body.action === 'test_email_smtp') {
      try {
        const rows = await dbGet('api_integrations', 'credentials', { service: 'eq.email_smtp', active: 'eq.true' }, undefined, 1)
        const creds = (rows[0] as any)?.credentials
        if (!creds?.host || !creds?.username || !creds?.password)
          return new Response(JSON.stringify({ error: '请先保存 SMTP 配置并启用' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        const to = creds.from_address || creds.username
        const { SmtpClient } = await import('https://deno.land/x/denomailer@1.6.0/mod.ts')
        const client = new SmtpClient()
        const port = parseInt(String(creds.port || '587'))
        if (port === 465) {
          await client.connectTLS({ hostname: String(creds.host), port: 465, username: String(creds.username), password: String(creds.password) })
        } else {
          await client.connect({ hostname: String(creds.host), port, username: String(creds.username), password: String(creds.password) })
        }
        await client.send({ from: String(creds.from_address || creds.username), to, subject: '✅ Orchestrator Agent — SMTP 连接测试', content: 'SMTP 邮件集成配置正确，连接测试成功！' })
        await client.close()
        return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      } catch(e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
    }

    // ── Test Telegram ───────────────────────────────────────────────
    if (body.action === 'test_telegram') {
      try {
        const rows = await dbGet('api_integrations', 'credentials', { service: 'eq.telegram', active: 'eq.true' }, undefined, 1)
        const creds = (rows[0] as any)?.credentials
        if (!creds?.bot_token)
          return new Response(JSON.stringify({ error: '请先保存 Telegram Bot Token 并启用' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        const chatId = creds.chat_id
        if (!chatId)
          return new Response(JSON.stringify({ error: '请填写 Default Chat ID' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        const r = await fetch(`https://api.telegram.org/bot${creds.bot_token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: '✅ Orchestrator Agent — Telegram 连接测试成功！', parse_mode: 'Markdown' }),
        })
        const rj = await r.json() as any
        if (!r.ok || !rj.ok) return new Response(JSON.stringify({ error: rj?.description || `Telegram API ${r.status}` }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      } catch(e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
    }

    if (body.action === 'test_lark') {
      const { webhook_url } = body
      if (!webhook_url) return new Response(JSON.stringify({ error: 'webhook_url required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      try {
        await sendLarkWebhook(String(webhook_url), '✅ 连接测试成功', '系统连接正常，Lark 群组机器人已配置。')
        return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      } catch(e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
    }

    if (body.action === 'create_lark_task') {
      const { title, description, due_date } = body
      if (!title) return new Response(JSON.stringify({ error: 'title required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const lark = await getLarkConfig()
      if (!lark?.app_id || !lark?.app_secret) return new Response(JSON.stringify({ error: '未配置 Lark App ID/Secret，请先在 API 集成页面配置' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const token = await getLarkToken(lark.app_id, lark.app_secret)
      if (!token) return new Response(JSON.stringify({ error: '获取 Lark token 失败，检查 App ID/Secret' }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const dueMs = due_date ? new Date(String(due_date)).getTime() : undefined
      const taskId = await createLarkTask(token, String(title), String(description || ''), dueMs)
      return new Response(JSON.stringify({ ok: true, task_id: taskId }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (body.action === 'list_reviews') {
      const { status: sf, department: df } = body
      const filters = tenantFilters()
      if (sf) filters['status'] = `eq.${sf}`
      if (df) filters['department'] = `eq.${df}`
      const rows = await dbGet('reviews', 'id,file_name,file_type,file_url,department,status,submitted_by,summary,classification_reason,key_info,review_notes,created_at,reviewed_at,notified_at', filters, 'created_at.desc', 50)
      return new Response(JSON.stringify({ reviews: rows }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (body.action === 'update_review_status') {
      const { review_id, status: newStatus, review_notes } = body
      if (!review_id || !newStatus) return new Response(JSON.stringify({ error: 'review_id and status required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      await dbPatch('reviews', review_id as string, { status: newStatus, review_notes: review_notes||null, reviewed_at: new Date().toISOString() })
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── RAG: embed text ─────────────────────────────────────────────
    if (body.action === 'embed') {
      const { text: embedText } = body
      if (!embedText) return new Response(JSON.stringify({ error: 'text required' }), { status:400, headers:{...CORS,'Content-Type':'application/json'} })
      const providers = await loadProviders()
      const embedding = await getEmbedding(String(embedText), providers)
      if (!embedding) return new Response(JSON.stringify({ error: 'Embedding failed: no provider available (OpenAI/Google/OpenRouter)' }), { status:500, headers:{...CORS,'Content-Type':'application/json'} })
      return new Response(JSON.stringify({ embedding }), { headers:{...CORS,'Content-Type':'application/json'} })
    }

    // ── RAG: ingest document chunks ─────────────────────────────────
    if (body.action === 'kb_ingest') {
      const { kb_id, source_name, content: rawContent } = body
      if (!kb_id || !rawContent) return new Response(JSON.stringify({ error:'kb_id and content required' }), { status:400, headers:{...CORS,'Content-Type':'application/json'} })
      const providers = await loadProviders()
      // Split into ~500-char chunks
      const text = String(rawContent)
      const chunks: string[] = []
      const chunkSize = 500, overlap = 50
      for (let i = 0; i < text.length; i += chunkSize - overlap) chunks.push(text.slice(i, i + chunkSize))
      // Embed all chunks using fallback chain
      const errs: string[] = []
      const results = await Promise.all(chunks.map(async (chunk, idx) => {
        const embedding = await getEmbedding(chunk, providers)
        if (!embedding) { errs.push(`embed_${idx}:all_providers_failed`); return null }
        // pgvector via PostgREST requires string format "[n1,n2,...]"
        const embeddingStr = `[${embedding.join(',')}]`
        const ir = await fetch(`${SUPABASE_URL}/rest/v1/kb_chunks`, {
          method: 'POST',
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ kb_id, source_name: source_name||'upload', chunk_index: idx, content: chunk, embedding: embeddingStr, tenant_id: _reqTenantId }),
        })
        if (!ir.ok) { errs.push(`insert_${idx}:${ir.status}:${await ir.text()}`); return null }
        return true
      }))
      const saved = results.filter(r => r === true).length
      return new Response(JSON.stringify({ ok:true, chunks: chunks.length, saved, errors: errs }), { headers:{...CORS,'Content-Type':'application/json'} })
    }

    // ── RAG: semantic search ─────────────────────────────────────────
    if (body.action === 'kb_search') {
      const { kb_id, query, limit: kLimit } = body
      if (!kb_id || !query) return new Response(JSON.stringify({ error:'kb_id and query required' }), { status:400, headers:{...CORS,'Content-Type':'application/json'} })
      const providers = await loadProviders()
      const qEmbed = await getEmbedding(String(query).slice(0, 500), providers)
      if (!qEmbed) return new Response(JSON.stringify({ error:'Embedding failed: no provider available' }), { status:500, headers:{...CORS,'Content-Type':'application/json'} })
      const n = Math.min(Number(kLimit)||5, 20)
      const rows = await fetch(`${SUPABASE_URL}/rest/v1/rpc/kb_match`, {
        method:'POST',
        headers:{ apikey:SUPABASE_KEY, Authorization:`Bearer ${SUPABASE_KEY}`, 'Content-Type':'application/json' },
        body: JSON.stringify({ query_embedding: qEmbed, match_kb_id: kb_id, match_count: n }),
      }).then(res => res.ok ? res.json() : [])
      return new Response(JSON.stringify({ results: rows }), { headers:{...CORS,'Content-Type':'application/json'} })
    }

    // ── KB CRUD ──────────────────────────────────────────────────────
    if (body.action === 'list_kbs') {
      const rows = await dbGet('knowledge_bases','id,name,description,agent_id,created_at',tenantFilters(),undefined,50)
      return new Response(JSON.stringify({ kbs: rows }), { headers:{...CORS,'Content-Type':'application/json'} })
    }
    if (body.action === 'create_kb') {
      const { name, description, agent_id } = body
      if (!name) return new Response(JSON.stringify({ error:'name required' }), { status:400, headers:{...CORS,'Content-Type':'application/json'} })
      const row = await dbInsertReturning('knowledge_bases',{ name, description:description||'', agent_id:agent_id||null, tenant_id:_reqTenantId })
      return new Response(JSON.stringify({ ok:true, kb: row }), { headers:{...CORS,'Content-Type':'application/json'} })
    }
    if (body.action === 'delete_kb') {
      const { kb_id } = body
      if (!kb_id) return new Response(JSON.stringify({ error:'kb_id required' }), { status:400, headers:{...CORS,'Content-Type':'application/json'} })
      const tenantQ = _reqTenantId && !_reqIsMaster ? `&tenant_id=eq.${encodeURIComponent(_reqTenantId)}` : ''
      await fetch(`${SUPABASE_URL}/rest/v1/knowledge_bases?id=eq.${kb_id}${tenantQ}`,{
        method:'DELETE', headers:{ apikey:SUPABASE_KEY, Authorization:`Bearer ${SUPABASE_KEY}` }
      })
      return new Response(JSON.stringify({ ok:true }), { headers:{...CORS,'Content-Type':'application/json'} })
    }
    if (body.action === 'list_kb_chunks') {
      const { kb_id } = body
      if (!kb_id) return new Response(JSON.stringify({ error:'kb_id required' }), { status:400, headers:{...CORS,'Content-Type':'application/json'} })
      const rows = await dbGet('kb_chunks','id,source_name,chunk_index,content,created_at',{ kb_id:`eq.${kb_id}` },'chunk_index.asc',200)
      return new Response(JSON.stringify({ chunks: rows }), { headers:{...CORS,'Content-Type':'application/json'} })
    }

    // ── Agent version history ────────────────────────────────────────
    if (body.action === 'save_agent_version') {
      const { agent_id, system_prompt, provider, model: aModel, note } = body
      if (!agent_id) return new Response(JSON.stringify({ error:'agent_id required' }), { status:400, headers:{...CORS,'Content-Type':'application/json'} })
      const vRows = await dbGet('agent_versions','version',{ agent_id:`eq.${agent_id}` },'version.desc',1)
      const nextVer = ((vRows[0] as {version:number}|undefined)?.version ?? 0) + 1
      await dbInsert('agent_versions',{ agent_id, version:nextVer, system_prompt:system_prompt||'', provider:provider||null, model:aModel||null, note:note||'' })
      return new Response(JSON.stringify({ ok:true, version:nextVer }), { headers:{...CORS,'Content-Type':'application/json'} })
    }
    if (body.action === 'list_agent_versions') {
      const { agent_id } = body
      if (!agent_id) return new Response(JSON.stringify({ error:'agent_id required' }), { status:400, headers:{...CORS,'Content-Type':'application/json'} })
      const rows = await dbGet('agent_versions','id,version,provider,model,note,saved_at',{ agent_id:`eq.${agent_id}` },'version.desc',20)
      return new Response(JSON.stringify({ versions: rows }), { headers:{...CORS,'Content-Type':'application/json'} })
    }
    if (body.action === 'restore_agent_version') {
      const { agent_id, version } = body
      if (!agent_id || !version) return new Response(JSON.stringify({ error:'agent_id and version required' }), { status:400, headers:{...CORS,'Content-Type':'application/json'} })
      const rows = await dbGet('agent_versions','system_prompt,provider,model',{ agent_id:`eq.${agent_id}`, version:`eq.${version}` })
      const v = rows[0] as {system_prompt:string;provider:string;model:string}|undefined
      if (!v) return new Response(JSON.stringify({ error:'Version not found' }), { status:404, headers:{...CORS,'Content-Type':'application/json'} })
      await dbPatch('agents', agent_id as string, { system_prompt:v.system_prompt, provider:v.provider||null, model:v.model||null, updated_at:new Date().toISOString() })
      _cacheAgents = null
      return new Response(JSON.stringify({ ok:true }), { headers:{...CORS,'Content-Type':'application/json'} })
    }

    // ── Workflow CRUD + runner ────────────────────────────────────────
    if (body.action === 'list_workflows') {
      const rows = await dbGet('workflows','id,name,description,active,created_at',tenantFilters(),'created_at.desc',50)
      return new Response(JSON.stringify({ workflows: rows }), { headers:{...CORS,'Content-Type':'application/json'} })
    }
    if (body.action === 'save_workflow') {
      const { id: wfId, name, description, nodes, edges, schedule } = body
      if (!name) return new Response(JSON.stringify({ error:'name required' }), { status:400, headers:{...CORS,'Content-Type':'application/json'} })
      const data: Record<string,unknown> = { name, description:description||'', nodes:nodes||[], edges:edges||[], updated_at:new Date().toISOString() }
      if (schedule) { data.schedule = schedule; data.next_run = calcNextRun(schedule as string).toISOString() }
      else { data.schedule = null; data.next_run = null }
      if (wfId) { await dbPatch('workflows', wfId as string, data); return new Response(JSON.stringify({ ok:true, id:wfId }), { headers:{...CORS,'Content-Type':'application/json'} }) }
      const row = await dbInsertReturning('workflows',{ ...data, tenant_id:_reqTenantId, active:true })
      return new Response(JSON.stringify({ ok:true, id:row.id }), { headers:{...CORS,'Content-Type':'application/json'} })
    }
    if (body.action === 'delete_workflow') {
      const { id: wfId } = body
      if (!wfId) return new Response(JSON.stringify({ error:'id required' }), { status:400, headers:{...CORS,'Content-Type':'application/json'} })
      await dbPatch('workflows', wfId as string, { active:false })
      return new Response(JSON.stringify({ ok:true }), { headers:{...CORS,'Content-Type':'application/json'} })
    }
    if (body.action === 'run_workflow') {
      const { id: wfId, input: wfInput } = body
      if (!wfId) return new Response(JSON.stringify({ error:'id required' }), { status:400, headers:{...CORS,'Content-Type':'application/json'} })
      const wfRows = await dbGet('workflows','nodes,edges',{ id:`eq.${wfId}` })
      const wf = wfRows[0] as { nodes:{id:string;type:string;config:Record<string,string>}[]; edges:{from:string;to:string}[] }|undefined
      if (!wf) return new Response(JSON.stringify({ error:'Workflow not found' }), { status:404, headers:{...CORS,'Content-Type':'application/json'} })
      const [providers, defaultProvider, agents] = await Promise.all([loadProviders(), getDefaultProvider(), loadAgents()])
      let context: Record<string,unknown> = { input: wfInput || {} }
      let errorMsg = ''
      try {
        const incoming = new Set(wf.edges.map((e:{from:string;to:string}) => e.to))
        const nodeMap = Object.fromEntries(wf.nodes.map(n => [n.id, n]))
        const start = wf.nodes.find(n => !incoming.has(n.id))
        if (!start) throw new Error('No start node found')
        const visited = new Set<string>()
        let cur: string|undefined = start.id
        while (cur && !visited.has(cur)) {
          visited.add(cur)
          const node = nodeMap[cur]
          if (!node) break
          if (node.type === 'agent') {
            const agent = agents.find(a => a.id === node.config?.agent_id) ?? agents.find(a => a.id === 'chat') ?? agents[0]
            const prompt = (node.config?.prompt || '{{input}}').replace('{{input}}', JSON.stringify(context.input))
            const skillText = await loadAgentSkills(agent?.id || '')
            const system = (agent?.system_prompt || 'You are a helpful assistant.') + '\n\n' + SOUL + skillText
            const { text } = await callLLM(providers, agent?.provider || defaultProvider, agent?.model, system, [{ role:'user', content:prompt }])
            context[node.id] = text; context.last_output = text
          } else if (node.type === 'condition') {
            const passed = String(context.last_output||'').toLowerCase().includes((node.config?.keyword||'').toLowerCase())
            context[node.id] = passed ? 'true' : 'false'
          } else if (node.type === 'output') {
            context.final_output = context.last_output
          } else if (node.type === 'self_learn') {
            const result = await learnFromGaps()
            const msg = `学习完成：分析 ${result.processed} 条问题，新增 ${result.skills_added} 条路由规则`
            context[node.id] = msg; context.last_output = msg
          } else if (node.type === 'skill_audit') {
            const skillRows = await dbGet('agent_skills','id,agent,skill',{},'created_at.desc',200) as {id:string;agent:string;skill:string}[]
            if (!skillRows.length) { context.last_output = '技能库为空，跳过审计' }
            else {
              const list = skillRows.map((r,i)=>`[${i+1}] agent=${r.agent}: ${r.skill}`).join('\n')
              const { text } = await callLLM(providers, defaultProvider, undefined,
                `You audit an AI routing rule library. Identify rules that are exact/near-duplicate, contradictory, or overly vague. Return ONLY a JSON array of 1-indexed rule numbers to DELETE: [1,3] or [] if none. Nothing else.`,
                [{ role:'user', content:`Rules:\n${list}` }], false)
              const m = text.match(/\[[\d,\s]*\]/)
              const toDelete = m ? (JSON.parse(m[0]) as number[]).filter(n=>n>=1&&n<=skillRows.length) : []
              if (toDelete.length) {
                const ids = toDelete.map(n=>skillRows[n-1].id)
                await fetch(`${SUPABASE_URL}/rest/v1/agent_skills?id=in.(${ids.join(',')})`,{ method:'DELETE', headers:{ apikey:SUPABASE_KEY, Authorization:`Bearer ${SUPABASE_KEY}`, Prefer:'return=minimal' } })
              }
              const msg = `技能库审计完成：共 ${skillRows.length} 条规则，删除 ${toDelete.length} 条冗余/矛盾规则`
              context[node.id] = msg; context.last_output = msg
            }
          } else if (node.type === 'prefs_compact') {
            const prefRows = await dbGet('user_prefs','id,key,value,confidence',{},'confidence.asc',200) as {id:string;key:string;value:string;confidence:number}[]
            if (!prefRows.length) { context.last_output = '偏好库为空，跳过压缩' }
            else {
              const list = prefRows.map((r,i)=>`[${i+1}] key="${r.key}" value="${r.value}" confidence=${r.confidence}`).join('\n')
              const { text } = await callLLM(providers, defaultProvider, undefined,
                `You compress a user preference store. Identify entries to DELETE: semantically duplicate, confidence<0.5 AND redundant, or contradicting a higher-confidence entry. Return ONLY a JSON array of 1-indexed entry numbers to DELETE: [2,5] or [] if none. Nothing else.`,
                [{ role:'user', content:`Preferences:\n${list}` }], false)
              const m = text.match(/\[[\d,\s]*\]/)
              const toDelete = m ? (JSON.parse(m[0]) as number[]).filter(n=>n>=1&&n<=prefRows.length) : []
              if (toDelete.length) {
                const ids = toDelete.map(n=>prefRows[n-1].id)
                await fetch(`${SUPABASE_URL}/rest/v1/user_prefs?id=in.(${ids.join(',')})`,{ method:'DELETE', headers:{ apikey:SUPABASE_KEY, Authorization:`Bearer ${SUPABASE_KEY}`, Prefer:'return=minimal' } })
              }
              const msg = `偏好压缩完成：共 ${prefRows.length} 条偏好，删除 ${toDelete.length} 条冗余条目`
              context[node.id] = msg; context.last_output = msg
            }
          }
          const nextEdge = wf.edges.find((e:{from:string;to:string}) => e.from === cur)
          cur = nextEdge?.to
        }
      } catch(e) { errorMsg = (e as Error).message }
      const response = String(context.final_output || context.last_output || '')
      await dbInsert('workflow_runs', { workflow_id: wfId, response, error: errorMsg || null, ran_at: new Date().toISOString() })
      return new Response(JSON.stringify({ ok:!errorMsg, output:context, error:errorMsg }), { headers:{...CORS,'Content-Type':'application/json'} })
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

    // ── Streaming chat action ───────────────────────────────────────
    if (body.stream === true) {
      const { message: smsg, session_id: ssid, target_agent: sta, system_prompt_override: sPromptOverride } = body
      const reqFiles = Array.isArray(body.files) ? (body.files as Array<{url:string;name:string;type:string}>) : []
      if (!smsg && !body.file_url && !reqFiles.length) return new Response(JSON.stringify({ error: 'message required' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const sid2 = ssid || crypto.randomUUID()

      // ── Multiple files → joint Anthropic analysis ───────────────────
      if (reqFiles.length > 1) {
        const { readable, writable } = new TransformStream()
        const writer = writable.getWriter()
        const encoder = new TextEncoder()
        const sseM = async (data: object) => writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        ;(async () => {
          try {
            const [providers, defaultProvider, agents] = await Promise.all([loadProviders(), getDefaultProvider(), loadAgents()])
            const anth = providers.find(p => p.provider === 'anthropic' && p.active)
            if (!anth?.api_key) throw new Error('多文件分析需要 Anthropic API Key')
            const userMsg = smsg || `请分析以下 ${reqFiles.length} 个文件`
            // Build multimodal content blocks
            const contentBlocks: object[] = []
            for (const f of reqFiles) {
              const isImage = ['image'].includes(f.type)
              if (isImage) {
                contentBlocks.push({ type: 'image', source: { type: 'url', url: f.url } })
              } else {
                contentBlocks.push({ type: 'document', source: { type: 'url', url: f.url }, title: f.name })
              }
            }
            contentBlocks.push({ type: 'text', text: userMsg })
            for (const ch of `⏳ 正在分析 ${reqFiles.length} 个文件…`) await sseM({ chunk: ch })
            const r = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: { 'x-api-key': anth.api_key, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'pdfs-2024-09-25', 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: anth.model || 'claude-sonnet-4-6', max_tokens: 4096,
                system: SOUL + '\n\n用中文回答，结构清晰。',
                messages: [{ role: 'user', content: contentBlocks }] })
            })
            if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`)
            const d = await r.json() as { content: {type:string;text:string}[]; usage?: {input_tokens:number;output_tokens:number} }
            const text = d.content?.find(b => b.type === 'text')?.text || ''
            if (d.usage) { _lastUsage.tokens_in = d.usage.input_tokens; _lastUsage.tokens_out = d.usage.output_tokens; _lastUsage.used_model = anth.model || '' }
            const _mc = calcCost(_lastUsage.used_model, _lastUsage.tokens_in, _lastUsage.tokens_out)
            const fileNames = reqFiles.map(f => f.name).join('、')
            for (const ch of ('\n\n' + text)) await sseM({ chunk: ch })
            await dbInsert('conversations', { session_id: sid2, role: 'user', content: `[多文件分析] ${fileNames}\n${userMsg}`, agent: 'chat', tenant_id: _reqTenantId })
            const aRow = await dbInsertReturning('conversations', { session_id: sid2, role: 'assistant', content: text, agent: 'chat', tenant_id: _reqTenantId, tokens_in: _lastUsage.tokens_in, tokens_out: _lastUsage.tokens_out, cost_usd: _mc })
            await sseM({ done: true, agent: 'chat', agent_name: '文件分析', session_id: sid2, provider: 'anthropic', conversation_id: aRow.id, tokens_in: _lastUsage.tokens_in, tokens_out: _lastUsage.tokens_out, cost_usd: _mc })
          } catch(e) {
            await sseM({ error: (e as Error).message })
          } finally {
            await writer.close()
          }
        })()
        return new Response(readable, { headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
      }

      // ── File attached → data extraction if keyword detected ─────────
      if (body.file_url && body.file_name && needsDataExtract(smsg || '')) {
        const { readable, writable } = new TransformStream()
        const writer = writable.getWriter()
        const encoder = new TextEncoder()
        const ssed = async (data: object) => writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        ;(async () => {
          try {
            const [providers] = await Promise.all([loadProviders()])
            const file_name = String(body.file_name)
            const file_url  = String(body.file_url)
            const extMap: Record<string,string> = { pdf:'pdf', doc:'word', docx:'word', xls:'excel', xlsx:'excel', csv:'excel', jpg:'image', jpeg:'image', png:'image', gif:'image', webp:'image' }
            const ext = file_name.split('.').pop()?.toLowerCase() ?? ''
            const file_type = extMap[ext] ?? 'pdf'
            const note = (smsg || '').replace(new RegExp(DATA_EXTRACT_KW.join('|'), 'g'), '').trim()

            for (const ch of `⏳ 正在读取 ${file_name}，请稍候…`) await ssed({ chunk: ch })

            const { structured, summary, dataType } = await extractFileData(providers, file_url, file_name, file_type, note)

            // Store in data_entries
            await dbInsert('data_entries', {
              file_name, file_url, file_type,
              data_type: dataType,
              structured_data: structured,
              summary,
              tenant_id: _reqTenantId
            })

            // Build result message
            const fields = Object.entries(structured)
            let msg = `✅ 数据已提取录入\n\n📄 **${file_name}**`
            if (dataType) msg += `\n🏷️ 类型：${dataType}`
            if (summary) msg += `\n📝 摘要：${summary}`
            if (fields.length > 0) {
              msg += `\n\n**提取字段（${fields.length} 项）：**\n`
              for (const [k, v] of fields.slice(0, 25)) msg += `• **${k}**：${v}\n`
              if (fields.length > 25) msg += `…还有 ${fields.length - 25} 项\n`
            }
            msg += '\n可在「📊 数据」页面查看所有录入记录。'

            for (const ch of msg) await ssed({ chunk: ch })

            await dbInsert('conversations', { session_id: sid2, role: 'user', content: `[数据录入] ${file_name}`, agent: 'data', tenant_id: _reqTenantId })
            const aRow = await dbInsertReturning('conversations', { session_id: sid2, role: 'assistant', content: msg, agent: 'data', tenant_id: _reqTenantId })
            await ssed({ done: true, agent: 'data', session_id: sid2, conversation_id: aRow.id })
          } catch(e) {
            await ssed({ error: (e as Error).message })
          } finally {
            await writer.close()
          }
        })()
        return new Response(readable, { headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
      }

      // ── File attached in chat → run review workflow directly ────────
      if (body.file_url && body.file_name) {
        const { readable, writable } = new TransformStream()
        const writer = writable.getWriter()
        const encoder = new TextEncoder()
        const sse2 = async (data: object) => writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        ;(async () => {
          try {
            const [providers, defaultProvider] = await Promise.all([loadProviders(), getDefaultProvider()])
            const file_name = String(body.file_name)
            const file_url  = String(body.file_url)
            const extMap: Record<string,string> = { pdf:'pdf', doc:'word', docx:'word', xls:'excel', xlsx:'excel', csv:'excel', jpg:'image', jpeg:'image', png:'image', gif:'image', webp:'image' }
            const ext = file_name.split('.').pop()?.toLowerCase() ?? ''
            const file_type = extMap[ext] ?? 'pdf'
            const note = smsg && !smsg.startsWith('请审核这份文件') ? String(smsg) : ''
            const submitted_by = String(body.submitted_by || 'chat')
            const submitted_by_staff_id = body.submitted_by_staff_id ? String(body.submitted_by_staff_id) : null

            // AI classify
            let department = 'General', summary = '', key_info: Record<string,unknown> = {}, classification_reason = ''
            try {
              const { text } = await callLLM(providers, defaultProvider, undefined,
                `You are a document classifier. Analyze the filename and return JSON only:
{"department":"Finance|HR|Legal|Procurement|General","summary":"one line description in Chinese","key_info":{},"reason":"why this department in Chinese"}`,
                [{ role:'user', content: `File: ${file_name}${note ? '\nNote: '+note : ''}` }], false)
              const m = text.match(/\{[\s\S]*\}/)
              if (m) {
                const cl = JSON.parse(m[0])
                department = String(cl.department || 'General')
                summary = String(cl.summary || '')
                key_info = cl.key_info || {}
                classification_reason = String(cl.reason || '')
              }
            } catch { /* use defaults */ }

            // Find reviewer by department
            const routeFilters = tenantFilters({ department: `eq.${department}`, active: 'eq.true' })
            const routes = await dbGet('department_routes', 'id,reviewer_name,reviewer_email,reviewer_company_id,department', routeFilters, undefined, 1)
            const route = (routes[0] as Record<string,string>|undefined) ?? null

            // Insert review record
            const review = await dbInsertReturning('reviews', {
              tenant_id: _reqTenantId, file_name, file_type, file_url,
              file_content: null, department, classification_reason, key_info, summary,
              submitted_by, submitted_by_staff_id, reviewer_route_id: route?.id ?? null, status: 'pending',
            })

            // Send email notification
            let notified = false
            if (route?.reviewer_email) {
              try {
                const { SmtpClient } = await import('https://deno.land/x/denomailer@1.6.0/mod.ts')
                const client = new SmtpClient()
                await client.connectTLS({ hostname: 'smtp.gmail.com', port: 465, username: 'ks9988467@gmail.com', password: Deno.env.get('GMAIL_APP_PWD')! })
                await client.send({
                  from: 'Orchestrator Agent <ks9988467@gmail.com>',
                  to: route.reviewer_email,
                  subject: `[审核请求] ${department} - ${file_name}`,
                  content: `您好 ${route.reviewer_name}，\n\n有新文件需要您审核：\n\n文件名：${file_name}\n部门：${department}\n文件链接：${file_url}${summary ? '\n摘要：'+summary : ''}${note ? '\n备注：'+note : ''}\n\n请登录系统完成审核。\n\n提交人：${submitted_by}`,
                })
                await client.close()
                await dbPatch('reviews', review.id as string, { notified_at: new Date().toISOString() })
                notified = true
              } catch { /* email failure non-fatal */ }
            }
            // Lark webhook notification
            try {
              const lark = await getLarkConfig()
              if (lark?.webhook_url) {
                await sendLarkWebhook(lark.webhook_url,
                  `📋 新文件审核请求 — ${department}`,
                  `**文件：** ${file_name}\n**提交人：** ${submitted_by}\n${summary ? '**摘要：** ' + summary : ''}${note ? '\n**备注：** ' + note : ''}`,
                  String(file_url))
                if (!notified) { await dbPatch('reviews', review.id as string, { notified_at: new Date().toISOString() }); notified = true }
              }
            } catch { /* non-fatal */ }

            // Build confirmation message
            let confirmMsg = `✅ 文件已提交审核\n\n📄 **${file_name}**\n🏷️ 部门：${department}`
            if (summary) confirmMsg += `\n📝 摘要：${summary}`
            if (route) {
              confirmMsg += `\n👤 审核人：${route.reviewer_name}`
              confirmMsg += notified ? `\n📧 已发送邮件通知` : `\n⚠️ 邮件发送失败（检查审核人邮箱配置）`
            } else {
              confirmMsg += `\n⚠️ 未找到「${department}」部门审核人，请在文件审核 → 审核路由配置中添加`
            }
            confirmMsg += `\n\n可在「📋 文件审核」查看审核进度。`

            // Stream confirmation char by char
            for (const ch of confirmMsg) { await sse2({ chunk: ch }) }

            // Save to conversation history
            await dbInsert('conversations', { session_id: sid2, role: 'user', content: smsg || `[文件] ${file_name}`, agent: 'review', tenant_id: _reqTenantId })
            const aRow = await dbInsertReturning('conversations', { session_id: sid2, role: 'assistant', content: confirmMsg, agent: 'review', tenant_id: _reqTenantId })
            await sse2({ done: true, agent: 'review', agent_name: '文件审核', session_id: sid2, provider: 'system', conversation_id: aRow.id })
          } catch(e) {
            await sse2({ error: (e as Error).message })
          } finally {
            await writer.close()
          }
        })()
        return new Response(readable, { headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
      }
      const [sproviders, sdefProv, sagents] = await Promise.all([loadProviders(), getDefaultProvider(), loadAgents()])
      _reqProviders = sproviders; _reqAgents = sagents; _reqDefaultProvider = sdefProv
      _reqSessionId = sid2
      let sagent: AgentRow
      if (sta) sagent = sagents.find((a:AgentRow) => a.id === sta) ?? sagents.find((a:AgentRow) => a.id === 'chat') ?? sagents[0]
      else     sagent = sagents.find((a:AgentRow) => a.id === 'chat') ?? sagents[0]
      const [shistory, sskillText] = await Promise.all([loadHistory(sid2, 10), loadAgentSkills(sagent.id)])
      const sSubAgents = sagents.filter((a:AgentRow) => a.active && a.id !== 'chat')
      const sAgentList = sSubAgents.map((a:AgentRow) => `- ${a.id}：${a.name}${(a as AgentRow & {description?:string}).description ? '（' + (a as AgentRow & {description?:string}).description + '）' : ''}`).join('\n')
      const sHermesInject = sagent.id === 'chat'
        ? `\n\n**专项 Agent 列表（必须通过 delegate_to_agent 工具调用）：**\n${sAgentList}\n\n委托规则：\n1. 凡是上述 Agent 职责范围内的请求，必须委托，不得自己回答。\n2. 只有纯粹的闲聊、系统问题、无法判断归属时才自己回答。\n3. 宁可委托错了再说，也不要自己尝试完成专项任务。\n\n跨域分析规则：\n4. 如果问题同时涉及 leads/客户数据 AND 广告花费/CPL/成效，先委托 crm agent，再委托 account agent，最后自己综合输出结论。\n5. 每次委托后阅读结果，再决定是否需要下一步委托。\n6. 综合完毕后用中文给出清晰结论，不让用户二次追问。`
        : ''
      const sTodayStr = new Date().toISOString().slice(0, 10)
      const ssystem  = (sPromptOverride || sagent.system_prompt || 'You are a helpful assistant.') + (sPromptOverride ? '' : sHermesInject) + `\n\n**今天日期：${sTodayStr}**（所有查询默认以此为基准）` + (SOUL ? '\n\n' + SOUL : '') + sskillText
      const suseTools = DATA_AGENTS.has(sagent.id) || !!sagent.uses_tools
      _reqHermesMode = (sagent.id === 'chat')   // restrict Hermes to delegate_to_agent only
      const smessages: {role:string;content:string}[] = [...shistory, { role:'user', content:smsg }]

      const { readable, writable } = new TransformStream()
      const writer  = writable.getWriter()
      const encoder = new TextEncoder()
      const sse = async (data: object) => writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))

      ;(async () => {
        let fullText = ''
        try {
          // ── Auto web search: LLM decides if real-time info needed ──────
          let finalMessages = smessages
          let finalSystem = ssystem
          let webSearched = false
          try {
            const { text: intent } = await callLLM(
              sproviders, sdefProv, undefined,
              'Reply SEARCH or CHAT only. SEARCH: needs current news, prices, today\'s events, latest releases, real-time data. CHAT: everything else.',
              [{ role: 'user', content: smsg || '' }], false
            )
            if (intent.trim().toUpperCase().includes('SEARCH')) {
              const orProvider = sproviders.find((p: ProviderRow) => p.provider === 'openrouter')
              if (!orProvider) {
                await sse({ chunk: '⚠️ 未配置 OpenRouter API Key，无法实时搜索。请在 LLM 配置中添加 openrouter provider。\n\n' })
              } else {
              await sse({ chunk: '🔍 *正在搜索最新信息…*\n\n' })
              try {
                const { text: sr } = await withTimeout(callLLM(
                  sproviders, 'openrouter', 'perplexity/sonar',
                  '你是搜索助手。用中文返回详细、准确、最新的搜索结果，包含关键事实和来源。',
                  [{ role: 'user', content: smsg || '' }]
                ), 50_000)
                webSearched = true
                finalMessages = [...shistory, { role: 'user', content: `${smsg}\n\n[网络搜索结果]\n${sr}` }]
                // When search is done: bypass Hermes delegation, answer directly
                finalSystem = (sPromptOverride || sagent.system_prompt || 'You are a helpful assistant.')
                  + '\n\n' + SOUL + sskillText
                  + '\n\n[系统指令] 已通过网络搜索获取最新信息。请直接基于上面的 [网络搜索结果] 用中文给出清晰准确的回答。不要委托、不要说不知道。'
                _reqHermesMode = false  // allow direct answer, skip delegation
              } catch(se) {
                await sse({ chunk: `⚠️ 搜索失败 (${(se as Error).message.slice(0,80)})，基于已有知识回答：\n\n` })
              }
              } // end else (orProvider exists)
            }
          } catch { /* intent check failed — proceed without search */ }

          const usedProvider = await streamWithFallback(
            sproviders, sagent.provider || sdefProv, sagent.model, finalSystem, finalMessages, suseTools,
            async (chunk) => { fullText += chunk; await sse({ chunk }) }
          )
          // Save to DB with token usage
          const _cost = calcCost(_lastUsage.used_model || sagent.model || '', _lastUsage.tokens_in, _lastUsage.tokens_out)
          const sInserts: Promise<unknown>[] = [
            dbInsert('conversations', { session_id: sid2, role: 'user', content: smsg, agent: sagent.id, tenant_id: _reqTenantId }),
          ]
          if (sagent.id === 'chat' && !_reqDelegated && smsg.trim().length > 10) {
            sInserts.push(dbInsert('agent_suggestions', { message: smsg.trim(), session_id: sid2, tenant_id: _reqTenantId }))
            learnFromGaps().catch(() => {})  // 立即异步学习，不阻塞响应
          }
          await Promise.all(sInserts)
          const aRow = await dbInsertReturning('conversations', { session_id: sid2, role: 'assistant', content: fullText, agent: _reqDelegatedId || sagent.id, tenant_id: _reqTenantId, tokens_in: _lastUsage.tokens_in, tokens_out: _lastUsage.tokens_out, cost_usd: _cost })
          await sse({ done: true, agent: sagent.id, agent_name: sagent.name, delegated_agent: _reqDelegatedId || undefined, delegated_agent_name: _reqDelegatedName || undefined, session_id: sid2, provider: usedProvider, conversation_id: aRow.id, tokens_in: _lastUsage.tokens_in, tokens_out: _lastUsage.tokens_out, cost_usd: _cost, web_searched: webSearched })
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
    const { message, session_id, target_agent, system_prompt_override: promptOverride } = body
    if (!message) return new Response(
      JSON.stringify({ error: 'message required' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
    const sid = session_id || crypto.randomUUID()

    // I: cached loaders (parallel)
    const [providers, defaultProvider, agents] = await Promise.all([
      loadProviders(), getDefaultProvider(), loadAgents()
    ])
    // Expose to executeTool (module-level, reset per request)
    _reqProviders       = providers
    _reqAgents          = agents
    _reqDefaultProvider = defaultProvider
    _reqSessionId       = sid

    // Hermes: chat agent is the orchestrator and entry point for all messages.
    // target_agent from UI allows manual override to a specific agent.
    let agent: AgentRow
    if (target_agent) {
      agent = agents.find((a: AgentRow) => a.id === target_agent)
        ?? agents.find((a: AgentRow) => a.id === 'chat')
        ?? agents[0]
    } else {
      agent = agents.find((a: AgentRow) => a.id === 'chat') ?? agents[0]
    }

    // ── Smart pre-routing: keyword-based direct dispatch (zero LLM calls)
    // keywordRoute() matches Chinese/English keywords deterministically.
    // Reliable, instant, no rate-limit risk. Falls back to Hermes only for
    // pure chat, meta questions, or truly ambiguous requests.
    let routedDirectly = false
    if (!target_agent && agent.id === 'chat' && !promptOverride) {
      const kwAgent = keywordRoute(message, agents)
      if (kwAgent) {
        agent = kwAgent
        routedDirectly = true
        _reqDelegatedId = kwAgent.id
        _reqDelegatedName = kwAgent.name || kwAgent.id
      }
    }

    // A: load history + skills in parallel
    const [history, skillText] = await Promise.all([
      loadHistory(sid, 10),
      loadAgentSkills(agent.id),
    ])

    // Build dynamic agent list for Hermes system prompt (only when Hermes handles directly)
    const todayStr = new Date().toISOString().slice(0, 10)
    const dateInject = `\n\n**今天日期：${todayStr}**（所有查询默认以此为基准）`
    let system: string
    if (agent.id === 'chat') {
      const subAgents = agents.filter((a: AgentRow) => a.active && a.id !== 'chat')
      const agentList = subAgents.map((a: AgentRow) => `- ${a.id}：${a.name}${(a as AgentRow & {description?:string}).description ? '（' + (a as AgentRow & {description?:string}).description + '）' : ''}`).join('\n')
      const hermesInject = `\n\n**专项 Agent 列表（必须通过 delegate_to_agent 工具调用）：**\n${agentList}\n\n委托规则：\n1. 凡是上述 Agent 职责范围内的请求，必须委托，不得自己回答。\n2. 只有纯粹的闲聊、系统问题、无法判断归属时才自己回答。\n3. 宁可委托错了再说，也不要自己尝试完成专项任务。\n\n跨域分析规则：\n4. 如果问题同时涉及 leads/客户数据 AND 广告花费/CPL/成效，先委托 crm agent，再委托 account agent，最后自己综合输出结论。\n5. 每次委托后阅读结果，再决定是否需要下一步委托。\n6. 综合完毕后用中文给出清晰结论，不让用户二次追问。`
      system = (agent.system_prompt || 'You are a helpful assistant.') + hermesInject + dateInject + (SOUL ? '\n\n' + SOUL : '') + skillText
    } else {
      // Sub-agent: inject today's date + soul, no Hermes routing instructions
      const hermesCtx = routedDirectly
        ? `\n\n**[系统上下文]** 你是被调度系统直接分配的专项 Agent。用户原始问题：${message}\n请基于对话历史给出专业回答。`
        : ''
      system = (promptOverride || agent.system_prompt || 'You are a helpful assistant.') + hermesCtx + dateInject + (SOUL ? '\n\n' + SOUL : '') + skillText
    }
    const useTools = DATA_AGENTS.has(agent.id) || !!agent.uses_tools
    _reqHermesMode = (agent.id === 'chat')   // restrict Hermes to delegate_to_agent only

    // A: build messages with history prefix
    const messages: { role: string; content: string }[] = [
      ...history,
      { role: 'user', content: message },
    ]

    const { text: response, usedProvider } = await callLLM(
      providers, agent.provider || defaultProvider, agent.model, system, messages, useTools
    )

    const saves: Promise<unknown>[] = [
      dbInsert('conversations', { session_id:sid, role:'user',      content:message,  agent:agent.id, tenant_id:_reqTenantId }),
      dbInsert('conversations', { session_id:sid, role:'assistant', content:response, agent: _reqDelegatedId || agent.id, tenant_id:_reqTenantId }),
    ]
    // Log uncovered questions (chat answered directly without delegating)
    if (agent.id === 'chat' && !_reqDelegated && message.trim().length > 10) {
      saves.push(dbInsert('agent_suggestions', { message: message.trim(), session_id: sid, tenant_id: _reqTenantId }))
      learnFromGaps().catch(() => {})  // 立即异步学习，不阻塞响应
    }
    await Promise.all(saves)
    extractPrefs(message, response, providers, defaultProvider)
    return new Response(
      JSON.stringify({ agent:agent.id, agent_name:agent.name, delegated_agent: _reqDelegatedId||undefined, delegated_agent_name: _reqDelegatedName||undefined, response, session_id:sid, provider:usedProvider }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    )

  } catch(e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status:500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
})
