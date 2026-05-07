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

// ── Module-level cache (reused across requests in same isolate) ──────
interface CacheEntry<T> { data: T; expires: number }
let _cacheProviders: CacheEntry<ProviderRow[]> | null = null
let _cacheAgents:    CacheEntry<AgentRow[]>    | null = null
let _cacheDefProv:   CacheEntry<string>        | null = null
const CACHE_TTL = 60_000 // 60 s

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

// ── Tool definitions ─────────────────────────────────────────────────
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
]

// ── Tool executor ────────────────────────────────────────────────────
async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    if (name === 'query_leads') {
      const filters: Record<string,string> = {}
      if (args.label)     filters['labels'] = `ilike.*${args.label}*`
      if (args.date_from) filters['date']   = `gte.${args.date_from}`
      if (args.date_to)   filters['date']   = `lte.${args.date_to}`
      const limit = Math.min(Number(args.limit) || 20, 100)
      const rows = await dbGet('leads', 'date,name,phone,labels', filters, 'date.desc', limit)
      return JSON.stringify({ count: rows.length, leads: rows })
    }

    if (name === 'query_ad_reports') {
      const filters: Record<string,string> = {}
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
      const filters: Record<string,string> = {}
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
      const filters: Record<string,string> = {}
      if (args.date_from) filters['starts'] = `gte.${args.date_from}`
      if (args.date_to)   filters['ends']   = `lte.${args.date_to}`
      const rows = await dbGet('ad_reports', 'campaign_name,frequency,impressions,reach,ctr_all,amount_spent_myr', filters, 'frequency.desc', 100)
      return JSON.stringify({ count: rows.length, data: rows })
    }

    return JSON.stringify({ error: `Unknown tool: ${name}` })
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message })
  }
}

// ── List models (proxy) ──────────────────────────────────────────────
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

// ── Types ────────────────────────────────────────────────────────────
interface ProviderRow { provider: string; api_key: string; model: string; active: boolean }
interface AgentRow    { id: string; name: string; system_prompt: string; provider: string|null; model: string|null; active: boolean }

// ── Config loaders (with module-level cache) ─────────────────────────
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
// ── Multi-turn history loader ─────────────────────────────────────────
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

// ── LLM callers with Tool Use ────────────────────────────────────────
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

  while (iterations++ < 5) {
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
  while (iterations++ < 5) {
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
  while (iterations++ < 5) {
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

// ── Streaming helpers ────────────────────────────────────────────────
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

// ── LLM dispatcher with fallback ─────────────────────────────────────
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
  if (!ordered.length) throw new Error('No active LLM providers. Add an API key in LLM 配置.')
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

// ── Intent classification ────────────────────────────────────────────
async function classifyIntent(message: string, agents: AgentRow[], providers: ProviderRow[], defaultProvider: string): Promise<AgentRow> {
  const active = agents.filter(a => a.active)
  if (active.length === 0) throw new Error('No active agents.')
  if (active.length === 1) return active[0]
  const list = active.map(a => `${a.id}: ${a.name} — ${a.system_prompt?.slice(0, 80) ?? ''}`).join('\n')
  const system = `You are a message router. Given a user message, reply with ONLY the agent id (one word, no punctuation) that best handles it.\n\nAgents:\n${list}`
  try {
    const { text } = await callLLM(providers, defaultProvider, undefined, system, [{ role:'user', content:message }], false)
    const id = text.trim().toLowerCase().replace(/[^a-z_]/g, '')
    return active.find(a => a.id === id) ?? active.find(a => a.id === 'chat') ?? active[0]
  } catch { return active.find(a => a.id === 'chat') ?? active[0] }
}

// ── Keyword pre-routing (fast path, skips LLM classification) ────────
// NOTE: Chinese chars have no \b word boundary in JS — never wrap Chinese with \b
const KEYWORD_ROUTES: { pattern: RegExp; agent: string }[] = [
  { pattern: /\bcpl\b|cost.?per.?lead|每个客户成本|每条线索成本/i,                              agent: 'cpl'       },
  { pattern: /\bcpr\b|cost.?per.?result|每个结果成本/i,                                        agent: 'cpl'       },
  { pattern: /\bfrequency\b|频率|广告疲劳|广告频次|重复曝光|ad.?fatigue/i,                      agent: 'frequency' },
  { pattern: /\b(code|bug|error|debug|script|function|api)\b|代码|编程|脚本|报错|函数|调试|程序/i, agent: 'code'   },
  { pattern: /客户|潜在客户|联系人|线索|\b(lead|leads|contact|crm)\b/i,                         agent: 'crm'       },
  { pattern: /\b(spend|campaign|ad\s?report|marketing)\b|广告|投放|营销|花费/i,                 agent: 'account'   },
]
function keywordRoute(message: string, agents: AgentRow[]): AgentRow | null {
  const active = agents.filter(a => a.active)
  for (const { pattern, agent: agentId } of KEYWORD_ROUTES) {
    if (pattern.test(message)) {
      const found = active.find(a => a.id === agentId)
      if (found) return found
    }
  }
  return null
}

// ── Agents that use data tools ───────────────────────────────────────
const DATA_AGENTS = new Set(['crm', 'account', 'cpl', 'cpr', 'frequency', 'marketing'])

// ── Background pref extraction ───────────────────────────────────────
async function extractPrefs(message: string, response: string, providers: ProviderRow[], defaultProvider: string) {
  try {
    const { text } = await callLLM(providers, defaultProvider, undefined,
      'Extract user preferences. Reply with JSON array: [{"key":"...","value":"..."}] or [].',
      [{ role:'user', content:message }, { role:'assistant', content:response }], false)
    const m = text.match(/\[.*\]/s)
    if (!m) return
    const prefs = JSON.parse(m[0]) as {key:string,value:string}[]
    await Promise.all(prefs.filter(p=>p.key&&p.value).map(p => dbUpsert('user_prefs', {key:p.key,value:p.value,confidence:0.7}, 'key')))
  } catch { /* silent */ }
}

// ── Main handler ─────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const body = await req.json()

    // ── List models action ──────────────────────────────────────────
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

    // ── OTP: send ──────────────────────────────────────────────────
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
      // Send email via Gmail SMTP using fetch to SMTP2Go-like approach — use denomailer
      try {
        const { SmtpClient } = await import('https://deno.land/x/denomailer@1.6.0/mod.ts')
        const client = new SmtpClient()
        await client.connectTLS({ hostname: 'smtp.gmail.com', port: 465, username: 'ks9988467@gmail.com', password: Deno.env.get('GMAIL_APP_PWD')! })
        await client.send({
          from: 'Orchestrator Agent <ks9988467@gmail.com>',
          to: email,
          subject: `验证码：${code}`,
          content: `您的 Orchestrator Agent 验证码是：\n\n${code}\n\n10 分钟内有效，请勿分享给他人。`,
        })
        await client.close()
      } catch(e) {
        return new Response(JSON.stringify({ error: `发送失败：${(e as Error).message}` }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── OTP: verify ────────────────────────────────────────────────
    if (body.action === 'verify_otp') {
      const { email, code } = body
      if (!email || !code) return new Response(JSON.stringify({ error: 'email and code required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const rows = await fetch(`${SUPABASE_URL}/rest/v1/otp_requests?email=eq.${encodeURIComponent(email)}&code=eq.${encodeURIComponent(code)}&used=eq.false&expires_at=gte.${new Date().toISOString()}&order=id.desc&limit=1`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      }).then(r => r.json())
      if (!rows?.length) return new Response(JSON.stringify({ ok: false, error: '验证码无效或已过期' }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      // Mark used
      await fetch(`${SUPABASE_URL}/rest/v1/otp_requests?id=eq.${rows[0].id}`, {
        method: 'PATCH',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ used: true })
      })
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── Learn from feedback action ──────────────────────────────────
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

    // ── Streaming chat action ───────────────────────────────────────
    if (body.stream === true) {
      const { message: smsg, session_id: ssid, target_agent: sta } = body
      if (!smsg) return new Response(JSON.stringify({ error: 'message required' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const sid2 = ssid || crypto.randomUUID()
      const [sproviders, sdefProv, sagents] = await Promise.all([loadProviders(), getDefaultProvider(), loadAgents()])
      let sagent: AgentRow
      if (sta) sagent = sagents.find((a:AgentRow) => a.id === sta) ?? await classifyIntent(smsg, sagents, sproviders, sdefProv)
      else     sagent = keywordRoute(smsg, sagents) ?? await classifyIntent(smsg, sagents, sproviders, sdefProv)
      const [shistory, sskillText] = await Promise.all([loadHistory(sid2, 10), loadAgentSkills(sagent.id)])
      const ssystem  = (sagent.system_prompt || 'You are a helpful assistant.') + (SOUL ? '\n\n' + SOUL : '') + sskillText
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
          await dbInsert('conversations', { session_id: sid2, role: 'user', content: smsg, agent: sagent.id })
          const aRow = await dbInsertReturning('conversations', { session_id: sid2, role: 'assistant', content: fullText, agent: sagent.id })
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

    // ── Chat action ─────────────────────────────────────────────────
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

    // E: keyword pre-routing → skip LLM classify when obvious
    // target_agent (from UI) takes highest priority
    let agent: AgentRow
    if (target_agent) {
      agent = agents.find((a: AgentRow) => a.id === target_agent)
        ?? await classifyIntent(message, agents, providers, defaultProvider)
    } else {
      agent = keywordRoute(message, agents)
        ?? await classifyIntent(message, agents, providers, defaultProvider)
    }

    // A: load history + skills in parallel
    const [history, skillText] = await Promise.all([
      loadHistory(sid, 10),
      loadAgentSkills(agent.id),
    ])
    const system   = (agent.system_prompt || 'You are a helpful assistant.')
      + (SOUL ? '\n\n' + SOUL : '')
      + skillText
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
      dbInsert('conversations', { session_id:sid, role:'user',      content:message,  agent:agent.id }),
      dbInsert('conversations', { session_id:sid, role:'assistant', content:response, agent:agent.id }),
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
