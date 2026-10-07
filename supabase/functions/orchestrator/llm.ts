// LLM access: provider config loaders, chat / streaming calls per provider, embeddings,
// token accounting, intent classification and keyword routing.
import { dbGet } from './db.ts'
import { type AgentRow, CACHE_TTL, type ProviderRow, R, llmUsage, shared, tenantFilters } from './state.ts'
import { executeTool, getActiveTools } from './tools.ts'

export const SOUL = `
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
export const COST_PER_M: Record<string,[number,number]> = {
  'claude-3-5-sonnet':[3,15],'claude-sonnet':[3,15],'claude-3-7-sonnet':[3,15],
  'claude-3-5-haiku':[0.8,4],'claude-haiku':[0.8,4],
  'claude-opus':[15,75],
  'gpt-4o-mini':[0.15,0.6],'gpt-4o':[2.5,10],'gpt-4':[30,60],'o1-mini':[3,12],'o3-mini':[1.1,4.4],
  'gemini-2.0-flash':[0.1,0.4],'gemini-1.5-flash':[0.075,0.3],'gemini-1.5-pro':[3.5,10.5],'gemini-2.5':[1.25,10],
}

export function resetUsage(model='') { Object.assign(llmUsage, { tokens_in: 0, tokens_out: 0, used_model: model }) }

export function calcCost(model: string, tokensIn: number, tokensOut: number): number {
  const key = Object.keys(COST_PER_M).find(k => (model||'').toLowerCase().includes(k)) ?? ''
  const [inP, outP] = COST_PER_M[key] ?? [2.5, 10]
  return Number(((tokensIn * inP + tokensOut * outP) / 1_000_000).toFixed(6))
}

// \u2500\u2500 List models (proxy) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
export async function listModels(provider: string, apiKey: string): Promise<string[]> {
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

// \u2500\u2500 Config loaders (with module-level cache) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// ── Embedding helper: OpenAI → Google → OpenRouter fallback ──────────────
// All providers normalised to 768 dims:
//   OpenAI  text-embedding-3-small  (dimensions=768 param)
//   Google  text-embedding-004      (native 768)
//   OpenRouter  openai/text-embedding-3-small  (dimensions=768)
// Embedding result carries the model FAMILY so a KB's chunks and its queries
// always use the same vector space. Families: 'oai768' (OpenAI + OpenRouter, same
// underlying text-embedding-3-small@768) and 'goo768' (Google text-embedding-004).
// preferModel pins the family (used when querying a KB that was ingested with a
// specific model) so cross-model fallback can't silently corrupt similarity.
export interface EmbedResult { vector: number[]; model: string }

export async function getEmbedding(text: string, providers: ProviderRow[], preferModel?: string): Promise<EmbedResult | null> {
  const input = String(text).slice(0, 8000)
  const want = (fam: string) => !preferModel || preferModel === fam

  // oai768 family — OpenAI first, then OpenRouter (identical model). Exhaust this
  // family before Google so a fallback stays within the same vector space.
  if (want('oai768')) {
    const oai = providers.find(p => p.provider === 'openai' && p.active && p.api_key?.trim())
    if (oai?.api_key) {
      const r = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${oai.api_key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'text-embedding-3-small', input, dimensions: 768 }),
      })
      if (r.ok) { const d = await r.json() as { data: [{ embedding: number[] }] }; if (d.data?.[0]?.embedding) return { vector: d.data[0].embedding, model: 'oai768' } }
    }
    const or_ = providers.find(p => p.provider === 'openrouter' && p.active && p.api_key?.trim())
    if (or_?.api_key) {
      const r = await fetch('https://openrouter.ai/api/v1/embeddings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${or_.api_key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'openai/text-embedding-3-small', input, dimensions: 768 }),
      })
      if (r.ok) { const d = await r.json() as { data: [{ embedding: number[] }] }; if (d.data?.[0]?.embedding) return { vector: d.data[0].embedding, model: 'oai768' } }
    }
  }

  // goo768 family — Google text-embedding-004 (different vector space)
  if (want('goo768')) {
    const goo = providers.find(p => p.provider === 'google' && p.active && p.api_key?.trim())
    if (goo?.api_key) {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${goo.api_key}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: { parts: [{ text: input }] }, taskType: 'RETRIEVAL_DOCUMENT' }) }
      )
      if (r.ok) { const d = await r.json() as { embedding?: { values: number[] } }; if (d.embedding?.values) return { vector: d.embedding.values, model: 'goo768' } }
    }
  }

  return null  // requested family unavailable / all providers exhausted
}

// Sentence-aware chunker: splits on sentence boundaries (CJK 。！？ + ASCII .!? + newline),
// then greedily packs sentences into ~size-char chunks with a tail `overlap` carried into
// the next chunk for context continuity. A single oversized sentence is hard-split.
export function chunkText(text: string, size = 500, overlap = 50): string[] {
  const sentences = String(text).split(/(?<=[。！？!?\n])/).map(s => s.trim()).filter(Boolean)
  const out: string[] = []
  let cur = ''
  for (const s of sentences) {
    if (cur && (cur.length + s.length) > size) {
      out.push(cur)
      cur = (overlap > 0 ? cur.slice(-overlap) : '') + s
    } else {
      cur += (cur ? '' : '') + s
    }
    while (cur.length > size * 1.6) { out.push(cur.slice(0, size)); cur = cur.slice(size - overlap) }
  }
  if (cur.trim()) out.push(cur)
  return out.length ? out : [String(text)]
}

export async function loadProviders(): Promise<ProviderRow[]> {
  if (shared.providers && Date.now() < shared.providers.expires) return shared.providers.data
  const rows = await dbGet('provider_config', 'provider,api_key,model,active')
  const data  = (rows as ProviderRow[]).filter(r => r.active && r.api_key?.trim())
  shared.providers = { data, expires: Date.now() + CACHE_TTL }
  return data
}

export async function getDefaultProvider(): Promise<string> {
  if (shared.defProv && Date.now() < shared.defProv.expires) return shared.defProv.data
  const rows = await dbGet('user_prefs', 'value', { key: 'eq.default_provider' })
  const data  = rows[0]?.value ?? 'anthropic'
  shared.defProv = { data, expires: Date.now() + CACHE_TTL }
  return data
}

export async function loadAgents(): Promise<AgentRow[]> {
  if (shared.agents && Date.now() < shared.agents.expires) return shared.agents.data
  const data = await dbGet('agents', 'id,name,system_prompt,provider,model,active,description,uses_tools')
  shared.agents = { data: data as AgentRow[], expires: Date.now() + CACHE_TTL }
  return data as AgentRow[]
}

export async function loadAgentSkills(agentId: string): Promise<string> {
  const rows = await dbGet('agent_skills', 'skill', { agent: `eq.${agentId}` }, 'created_at.desc', 20)
  if (!rows.length) return ''
  return '\n\nLearned skills:\n' + (rows as {skill:string}[]).map(r => `- ${r.skill}`).join('\n')
}

export async function loadKbContext(): Promise<string> {
  try {
    const filters = tenantFilters()
    const kbs = await dbGet('knowledge_bases', 'id,name,description', filters, undefined, 10) as {id:string; name:string; description?:string}[]
    if (!kbs.length) return ''
    const list = kbs.map(kb => `  • ${kb.name}${kb.description ? '（' + kb.description + '）' : ''} [id:${kb.id}]`).join('\n')
    return `\n\n**知识库（已启用）：**\n${list}\n当用户询问公司产品、服务、政策、SOP、FAQ 或任何专业知识时，请立即调用 search_knowledge_base 工具查询，不要凭记忆作答。`
  } catch { return '' }
}

// \u2500\u2500 Multi-turn history loader \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
export async function loadHistory(sessionId: string, limit = 10): Promise<{role:string; content:string}[]> {
  if (!sessionId) return []
  // Fetch last N user+assistant rows, then reverse so oldest first
  const rows = await dbGet('conversations', 'role,content',
    { session_id: `eq.${sessionId}` },
    'id.desc', limit)
  return (rows as {role:string; content:string}[])
    .filter(r => r.role === 'user' || r.role === 'assistant')
    .reverse()
}

export async function callAnthropic(apiKey: string, model: string, system: string, messages: object[], useTools = false): Promise<string> {
  const body: Record<string,unknown> = {
    model: model || 'claude-sonnet-4-6',
    max_tokens: 4096,
    system,
    messages,
  }
  if (useTools) {
    body.tools = getActiveTools().map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }))
    // Force Hermes to always use a tool — prevents fallback to direct text answer without routing
    if (R.hermesMode) body.tool_choice = { type: 'any' }
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
      const toolResults: { type: string; tool_use_id: unknown; content: string }[] = []
      for (const b of toolUseBlocks) {
        const result = await executeTool(String(b.name), (b.input as Record<string,unknown>) || {})
        // respond_directly: return the response text immediately, skip the rest of the loop
        if (result.startsWith('__RESPOND_DIRECTLY__')) {
          return result.slice('__RESPOND_DIRECTLY__'.length)
        }
        toolResults.push({ type: 'tool_result', tool_use_id: b.id, content: result })
      }
      msgs.push({ role: 'user', content: toolResults })
    } else {
      const text = (resp.content as Record<string,unknown>[]).find(b => b.type === 'text')
      return String(text?.text || '')
    }
  }
  return 'Tool loop limit reached.'
}

export async function callOpenAI(apiKey: string, model: string, system: string, messages: object[], useTools = false): Promise<string> {
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

export async function callGoogle(apiKey: string, model: string, system: string, messages: object[], useTools = false): Promise<string> {
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
export type ChunkFn = (text: string) => Promise<void>

/** Fake-stream pre-computed text word-by-word (used after tool calls) */

export async function streamText(text: string, onChunk: ChunkFn): Promise<void> {
  const tokens = text.match(/\S+\s*/g) ?? [text]
  for (const token of tokens) {
    await onChunk(token)
    await new Promise(r => setTimeout(r, 12))
  }
}

export async function streamAnthropic(apiKey: string, model: string, system: string, messages: object[], useTools: boolean, onChunk: ChunkFn): Promise<void> {
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
        if (evt.type === 'message_start')    llmUsage.tokens_in  += evt.message?.usage?.input_tokens  || 0
        if (evt.type === 'message_delta')    llmUsage.tokens_out += evt.usage?.output_tokens           || 0
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text)
          await onChunk(evt.delta.text)
      } catch { /* skip */ }
    }
  }
}

export async function streamOpenAI(apiKey: string, model: string, system: string, messages: object[], useTools: boolean, onChunk: ChunkFn): Promise<void> {
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
        if (parsed.usage) { llmUsage.tokens_in += parsed.usage.prompt_tokens||0; llmUsage.tokens_out += parsed.usage.completion_tokens||0 }
      } catch { /* skip */ }
    }
  }
}

export async function streamOpenRouter(apiKey: string, model: string, system: string, messages: object[], useTools: boolean, onChunk: ChunkFn): Promise<void> {
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
        if (parsed.usage) { llmUsage.tokens_in += parsed.usage.prompt_tokens||0; llmUsage.tokens_out += parsed.usage.completion_tokens||0 }
      } catch { /* skip */ }
    }
  }
}

export async function callOpenRouter(apiKey: string, model: string, system: string, messages: object[], useTools = false): Promise<string> {
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
    if (resp.usage) { llmUsage.tokens_in += resp.usage.prompt_tokens||0; llmUsage.tokens_out += resp.usage.completion_tokens||0 }
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

export async function streamGoogle(apiKey: string, model: string, system: string, messages: object[], useTools: boolean, onChunk: ChunkFn): Promise<void> {
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
        if (meta) { llmUsage.tokens_in += meta.promptTokenCount||0; llmUsage.tokens_out += meta.candidatesTokenCount||0 }
      } catch { /* skip */ }
    }
  }
}

export async function streamWithFallback(
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
export async function callLLM(
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
export async function classifyIntent(message: string, agents: AgentRow[], providers: ProviderRow[], defaultProvider: string): Promise<AgentRow> {
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
export const _c = (cps: number[]) => cps.map(c => String.fromCharCode(c)).join('')

export const ZH_CRM1  = _c([23458,25143])                           // ke hu        \u5BA2\u6237

export const ZH_CRM2  = _c([27969,22312,23458,25143])               // qian zai ke hu \u6F5C\u5728\u5BA2\u6237

export const ZH_CRM3  = _c([32852,31995,20154])                     // lian xi ren  \u8054\u7CFB\u4EBA

export const ZH_CRM4  = _c([32447,32034])                           // xian suo     \u7EBF\u7D22

export const ZH_ACC1  = _c([24191,21578])                           // guang gao    \u5E7F\u544A

export const ZH_ACC2  = _c([25237,25918])                           // tou fang     \u6295\u653E

export const ZH_ACC3  = _c([33829,38144])                           // ying xiao    \u8425\u9500

export const ZH_ACC4  = _c([33457,36153])                           // hua fei      \u82B1\u8D39

export const ZH_CODE1 = _c([20195,30721])                           // dai ma       \u4EE3\u7801

export const ZH_CODE2 = _c([32534,31243])                           // bian cheng   \u7F16\u7A0B

export const ZH_CODE3 = _c([33073,26412])                           // jiao ben     \u811A\u672C

export const ZH_CODE4 = _c([25253,38169])                           // bao cuo      \u62A5\u9519

export const ZH_CODE5 = _c([20989,25968])                           // han shu      \u51FD\u6570

export const ZH_CODE6 = _c([35843,35797])                           // tiao shi     \u8C03\u8BD5

export const ZH_CODE7 = _c([31243,24207])                           // cheng xu     \u7A0B\u5E8F

export const ZH_CODE8 = _c([31639,27861])                           // suan fa      \u7B97\u6CD5

export const ZH_CPL1  = _c([27599,20010,23458,25143,25104,26412])  // mei ge ke hu cheng ben \u6BCF\u4E2A\u5BA2\u6237\u6210\u672C

export const ZH_CPL2  = _c([27599,26465,32447,31034,25104,26412])  // mei tiao xian suo cheng ben \u6BCF\u6761\u7EBF\u7D22\u6210\u672C

export const ZH_CPR1  = _c([27599,20010,32467,26524,25104,26412])  // mei ge jie guo cheng ben \u6BCF\u4E2A\u7ED3\u679C\u6210\u672C

export const ZH_FREQ1 = _c([39057,29575])                           // pin lv       \u9891\u7387

export const ZH_FREQ2 = _c([24191,21578,30130,21155])               // guang gao pi lao \u5E7F\u544A\u75B2\u52B3

export const ZH_FREQ3 = _c([24191,21578,39057,27425])               // guang gao pin ci \u5E7F\u544A\u9891\u6B21

export const ZH_FREQ4 = _c([37325,22797,26149,20809])               // chong fu bao guang \u91CD\u590D\u66DD\u5149

export function keywordRoute(message: string, agents: AgentRow[]): AgentRow | null {
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
export const DATA_AGENTS = new Set(['chat', 'crm', 'account', 'cpl', 'cpr', 'frequency', 'marketing', 'review', 'report'])
