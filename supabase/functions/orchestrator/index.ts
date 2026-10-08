import "jsr:@supabase/functions-js@2.116.0/edge-runtime.d.ts"
// Orchestrator HTTP handler. Helpers live in sibling modules: db.ts / storage.ts
// (portable data and files), state.ts (shared mutable state), http.ts (CORS, rate
// limits), auth.ts (sessions, roles), llm.ts, tools.ts, automation.ts, kb.ts / kb-sync.ts.
// Dashboard actions are handled in actions/*.ts; this file keeps the HTTP entry
// (files, WhatsApp, auth gate) and the chat flow.
import { handleConfigActions } from './actions/config.ts'
import { handleDataActions } from './actions/data.ts'
import { handleKbActions } from './actions/kb.ts'
import { handleSessionActions } from './actions/session.ts'
import { handleTeamActions } from './actions/team.ts'
import { handleWorkflowActions } from './actions/workflow.ts'
import { ROLE_RANK, authenticate, requiredRole } from './auth.ts'
import { learnFromGaps, sendNotification, withTimeout } from './automation.ts'
import { dbGet, dbInsert, dbInsertReturning, dbUpsert } from './db.ts'
import { clientIp, corsFor, rateLimited, tooManyRequests } from './http.ts'
import { DATA_AGENTS, SOUL, calcCost, callLLM, getDefaultProvider, keywordRoute, loadAgentSkills, loadAgents, loadHistory, loadKbContext, loadProviders, resetUsage, streamWithFallback } from './llm.ts'
import { type AgentRow, type ProviderRow, R, llmUsage, withRequestContext } from './state.ts'
import { BUCKETS, INLINE_TYPES, MAX_FILE_BYTES, USE_LOCAL_STORAGE, contentTypeFor, isValidName, objectName, publicUrl, putFile, readFile, signedUrl, verifySignedDownload } from './storage.ts'

// ── Data extraction keyword detection ────────────────────────────────
const DATA_EXTRACT_KW =['录入','提取','读取数据','导入','解析文件','抽取','存入系统','数据录入','extract','import data']

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
      const r = await fetch(await signedUrl(fileUrl, 300) || fileUrl)   // our own files need a signed link
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
// Each request runs in its own context, so R / llmUsage are never shared between concurrent requests
Deno.serve((req: Request) => withRequestContext(async () => {
  const CORS = corsFor(req)   // every Response below spreads these headers
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  // ── File storage ──────────────────────────────────────────────────
  // POST <base>/files/<bucket>         upload; raw file body, original name in x-file-name
  // GET  <base>/files/<bucket>/<name>  download (local driver; Supabase serves its own URLs)
  const fileRoute = new URL(req.url).pathname.match(/\/files\/([a-z0-9-]+)(?:\/([^/]+))?\/?$/)
  if (fileRoute) {
    const [, bucket, rawName] = fileRoute
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
    const decode = (s: string) => { try { return decodeURIComponent(s) } catch { return '' } }
    if (!BUCKETS.includes(bucket)) return json({ error: 'unknown bucket' }, 404)
    if (req.method === 'POST' && !rawName) {
      const wait = rateLimited(`upload:${clientIp(req)}`, 30)
      if (wait) return tooManyRequests(wait, CORS)
      if (!await authenticate(req)) return json({ error: 'unauthorized' }, 401)
      const original = decode(req.headers.get('x-file-name') || '')
      if (!original) return json({ error: 'x-file-name header required' }, 400)
      if (Number(req.headers.get('content-length') || 0) > MAX_FILE_BYTES) return json({ error: '文件超过 50 MB' }, 413)
      const data = new Uint8Array(await req.arrayBuffer())
      if (!data.length) return json({ error: 'empty file' }, 400)
      if (data.length > MAX_FILE_BYTES) return json({ error: '文件超过 50 MB' }, 413)
      const name = objectName(original)
      const type = req.headers.get('content-type') || 'application/octet-stream'
      try {
        await putFile(bucket, name, data, type)
      } catch (e) {
        console.error('putFile', bucket, name, e)
        return json({ error: (e as Error).message }, 500)
      }
      return json({ ok: true, url: publicUrl(bucket, name), name, size: data.length, type })
    }
    if (req.method === 'GET' && rawName && USE_LOCAL_STORAGE) {
      const name = decode(rawName)
      if (!isValidName(name)) return json({ error: 'not found' }, 404)
      // Only signed, unexpired links (the backend signs file_url when it returns one)
      const q = new URL(req.url).searchParams
      if (!await verifySignedDownload(bucket, name, q.get('exp'), q.get('sig'))) return json({ error: '链接无效或已过期' }, 403)
      const data = await readFile(bucket, name)
      if (!data) return json({ error: 'not found' }, 404)
      const type = contentTypeFor(name)
      const headers: Record<string, string> = {
        ...CORS, 'Content-Type': type, 'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `${INLINE_TYPES.has(type) ? 'inline' : 'attachment'}; filename="${name}"`,
      }
      // No scripts for anything served from here (Chrome refuses to render a PDF under a sandbox CSP)
      if (type !== 'application/pdf') headers['Content-Security-Policy'] = 'sandbox'
      return new Response(data, { headers })
    }
    return json({ error: 'method not allowed' }, 405)
  }

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

    // Per-request context. Identity is set by the authentication step below — never read from the body.
    R.tenantId = null
    R.isMaster = false
    R.role     = 'member'
    R.email    = ''
    R.authHash = ''
    R.delegated         = false
    R.sessionId         = ''
    R.delegatedId       = ''
    R.delegatedName     = ''
    R.hermesMode        = false
    R.delegationContext = ''

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
          const _waCost = calcCost(llmUsage.used_model || agent.model || '', llmUsage.tokens_in, llmUsage.tokens_out)
          await Promise.all([
            dbInsert('conversations', { session_id:sid, role:'user',      content:text,  agent:agent.id }),
            dbInsert('conversations', { session_id:sid, role:'assistant', content:reply, agent:agent.id, tokens_in:llmUsage.tokens_in, tokens_out:llmUsage.tokens_out, cost_usd:_waCost }),
          ])
          await sendNotification('whatsapp', reply, from)
        }
      } catch { /* silent — always return 200 to Meta */ }
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── Authentication ───────────────────────────────────────────────
    // Public: the OTP login actions (and the WhatsApp webhook above). Everything else needs a
    // session token, or the internal secret for self-invokes and schedulers.
    if (body.action === 'send_otp' || body.action === 'verify_otp') {
      // Login attempts: 30 a minute per IP (on top of the per-email limits inside the actions)
      const wait = rateLimited(`otp:${clientIp(req)}`, 30)
      if (wait) return tooManyRequests(wait, CORS)
    } else {
      const auth = await authenticate(req)
      if (!auth) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } })
      // 120 requests a minute per session; internal callers (schedulers, self-invokes) are not limited
      if (auth.kind === 'session') {
        const wait = rateLimited(`api:${auth.tokenHash}`, 120)
        if (wait) return tooManyRequests(wait, CORS)
      }
      if (auth.kind === 'internal') {
        // Internal callers act across tenants unless they name one
        R.isMaster = true
        R.role     = 'master'
        R.tenantId = body.tenant_id ? String(body.tenant_id) : null
      } else {
        R.tenantId = auth.tenantId
        R.role     = auth.role
        R.isMaster = auth.role === 'master'
        R.email    = auth.email
        R.authHash = auth.tokenHash
        // Code that reads the session fields from the body sees the verified values. A
        // non-master is pinned to its own tenant; a master may name the tenant it acts on
        // (update_tenant / add_tenant_user use tenant_id for the target tenant).
        if (auth.role !== 'master') body.tenant_id = auth.tenantId ?? undefined
        body.role = auth.role
      }
      // Minimum role for this action (ACTION_ROLES)
      const need = requiredRole(body.action ? String(body.action) : '', String(body.method || 'list'))
      if ((ROLE_RANK[R.role] ?? 0) < ROLE_RANK[need]) {
        return new Response(JSON.stringify({ error: '没有权限执行此操作' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
    }

    // ── Actions (actions/*.ts) ─────────────────────────────────────────
    // Each handler answers its own actions and returns undefined for the rest;
    // anything unanswered falls through to the chat flow below.
    for (const handle of [handleSessionActions, handleConfigActions, handleDataActions, handleTeamActions, handleWorkflowActions, handleKbActions]) {
      const res = await handle(body, CORS)
      if (res) return res
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
        const sseM = (data: object) => writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        ;(async () => {
          try {
            const providers = await loadProviders()
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
            if (d.usage) { llmUsage.tokens_in = d.usage.input_tokens; llmUsage.tokens_out = d.usage.output_tokens; llmUsage.used_model = anth.model || '' }
            const _mc = calcCost(llmUsage.used_model, llmUsage.tokens_in, llmUsage.tokens_out)
            const fileNames = reqFiles.map(f => f.name).join('、')
            for (const ch of ('\n\n' + text)) await sseM({ chunk: ch })
            await dbInsert('conversations', { session_id: sid2, role: 'user', content: `[多文件分析] ${fileNames}\n${userMsg}`, agent: 'chat', tenant_id: R.tenantId })
            const aRow = await dbInsertReturning('conversations', { session_id: sid2, role: 'assistant', content: text, agent: 'chat', tenant_id: R.tenantId, tokens_in: llmUsage.tokens_in, tokens_out: llmUsage.tokens_out, cost_usd: _mc })
            await sseM({ done: true, agent: 'chat', agent_name: '文件分析', session_id: sid2, provider: 'anthropic', conversation_id: aRow.id, tokens_in: llmUsage.tokens_in, tokens_out: llmUsage.tokens_out, cost_usd: _mc })
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
        const ssed = (data: object) => writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
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
              tenant_id: R.tenantId
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

            await dbInsert('conversations', { session_id: sid2, role: 'user', content: `[数据录入] ${file_name}`, agent: 'data', tenant_id: R.tenantId })
            const aRow = await dbInsertReturning('conversations', { session_id: sid2, role: 'assistant', content: msg, agent: 'data', tenant_id: R.tenantId })
            await ssed({ done: true, agent: 'data', session_id: sid2, conversation_id: aRow.id })
          } catch(e) {
            await ssed({ error: (e as Error).message })
          } finally {
            await writer.close()
          }
        })()
        return new Response(readable, { headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
      }

      const [sproviders, sdefProv, sagents] = await Promise.all([loadProviders(), getDefaultProvider(), loadAgents()])
      R.providers = sproviders; R.agents = sagents; R.defaultProvider = sdefProv
      R.sessionId = sid2
      let sagent: AgentRow
      if (sta) sagent = sagents.find((a:AgentRow) => a.id === sta) ?? sagents.find((a:AgentRow) => a.id === 'chat') ?? sagents[0]
      else     sagent = sagents.find((a:AgentRow) => a.id === 'chat') ?? sagents[0]

      // ── Smart pre-routing (same logic as non-streaming path) ──────────
      let sroutedDirectly = false
      if (sagent.id === 'chat' && !sPromptOverride) {
        const skwAgent = keywordRoute(smsg || '', sagents)
        if (skwAgent) {
          sagent = skwAgent
          sroutedDirectly = true
          R.delegatedId = skwAgent.id
          R.delegatedName = skwAgent.name || skwAgent.id
        }
      }

      const [shistory, sskillText, skbCtx] = await Promise.all([loadHistory(sid2, 10), loadAgentSkills(sagent.id), loadKbContext()])
      const sSubAgents = sagents.filter((a:AgentRow) => a.active && a.id !== 'chat')
      const sAgentList = sSubAgents.map((a:AgentRow) => `- ${a.id}：${a.name}${(a as AgentRow & {description?:string}).description ? '（' + (a as AgentRow & {description?:string}).description + '）' : ''}`).join('\n')
      const sHermesInject = sagent.id === 'chat'
        ? `\n\n**专项 Agent 列表（必须通过 delegate_to_agent 工具调用）：**\n${sAgentList}\n\n**关键词路由表（见到这些词 → 立即委托，不思考）：**\n- 线索/leads/新客/潜在客/跟进/转化/CRM/客户数量 → crm\n- 广告/花费/CPL/CPR/投放/成效/预算/ROAS/campaign/ad_report → account\n- 代码/bug/报错/debug/程序/开发/API/函数 → code\n\n委托规则：\n1. 只要用户问题含上述关键词，必须立刻委托对应 Agent，不得自行作答。\n2. 即使问题只有几个字（如"最近新线索？"），只要包含关键词，也必须委托。\n3. 只有纯粹的闲聊（"你好"、"谢谢"）或系统问题（"你是谁"）才自己回答。\n4. 宁可委托错了再说，也不要自己尝试完成专项任务。\n\n跨域分析规则：\n5. 如果问题同时涉及 leads/客户数据 AND 广告花费/CPL/成效，先委托 crm agent，再委托 account agent，最后自己综合输出结论。\n6. 每次委托后阅读结果，再决定是否需要下一步委托。\n7. 综合完毕后用中文给出清晰结论，不让用户二次追问。`
        : sroutedDirectly
          ? `\n\n**[系统上下文]** 你是被调度系统直接分配的专项 Agent。用户原始问题：${smsg}\n请基于对话历史给出专业回答。`
          : ''
      const sTodayStr = new Date().toISOString().slice(0, 10)
      const ssystem  = (sPromptOverride || sagent.system_prompt || 'You are a helpful assistant.') + (sPromptOverride ? '' : sHermesInject) + `\n\n**今天日期：${sTodayStr}**（所有查询默认以此为基准）` + (SOUL ? '\n\n' + SOUL : '') + sskillText + skbCtx
      const suseTools = DATA_AGENTS.has(sagent.id) || !!sagent.uses_tools
      R.hermesMode = (sagent.id === 'chat')   // restrict Hermes to delegate_to_agent only
      const smessages: {role:string;content:string}[] = [...shistory, { role:'user', content:smsg }]

      const { readable, writable } = new TransformStream()
      const writer  = writable.getWriter()
      const encoder = new TextEncoder()
      const sse = (data: object) => writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))

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
                R.hermesMode = false  // allow direct answer, skip delegation
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
          const _cost = calcCost(llmUsage.used_model || sagent.model || '', llmUsage.tokens_in, llmUsage.tokens_out)
          const sInserts: Promise<unknown>[] = [
            dbInsert('conversations', { session_id: sid2, role: 'user', content: smsg, agent: sagent.id, tenant_id: R.tenantId }),
          ]
          if (sagent.id === 'chat' && !R.delegated && smsg.trim().length > 10) {
            sInserts.push(dbInsert('agent_suggestions', { message: smsg.trim(), session_id: sid2, tenant_id: R.tenantId }))
            learnFromGaps().catch(() => {})  // 立即异步学习，不阻塞响应
          }
          await Promise.all(sInserts)
          const aRow = await dbInsertReturning('conversations', { session_id: sid2, role: 'assistant', content: fullText, agent: R.delegatedId || sagent.id, tenant_id: R.tenantId, tokens_in: llmUsage.tokens_in, tokens_out: llmUsage.tokens_out, cost_usd: _cost })
          await sse({ done: true, agent: sagent.id, agent_name: sagent.name, delegated_agent: R.delegatedId || undefined, delegated_agent_name: R.delegatedName || undefined, session_id: sid2, provider: usedProvider, conversation_id: aRow.id, tokens_in: llmUsage.tokens_in, tokens_out: llmUsage.tokens_out, cost_usd: _cost, web_searched: webSearched })
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
    R.providers       = providers
    R.agents          = agents
    R.defaultProvider = defaultProvider
    R.sessionId       = sid

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
    // Also applies when user explicitly targets 'chat' — that means they want
    // Hermes to coordinate, so keyword routing should still fire.
    let routedDirectly = false
    if (agent.id === 'chat' && !promptOverride) {
      const kwAgent = keywordRoute(message, agents)
      if (kwAgent) {
        agent = kwAgent
        routedDirectly = true
        R.delegatedId = kwAgent.id
        R.delegatedName = kwAgent.name || kwAgent.id
      }
    }

    // A: load history + skills + KB context in parallel
    const [history, skillText, kbCtx] = await Promise.all([
      loadHistory(sid, 10),
      loadAgentSkills(agent.id),
      loadKbContext(),
    ])

    // Build dynamic agent list for Hermes system prompt (only when Hermes handles directly)
    const todayStr = new Date().toISOString().slice(0, 10)
    const dateInject = `\n\n**今天日期：${todayStr}**（所有查询默认以此为基准）`
    let system: string
    if (agent.id === 'chat') {
      const subAgents = agents.filter((a: AgentRow) => a.active && a.id !== 'chat')
      const agentList = subAgents.map((a: AgentRow) => `- ${a.id}：${a.name}${(a as AgentRow & {description?:string}).description ? '（' + (a as AgentRow & {description?:string}).description + '）' : ''}`).join('\n')
      const hermesInject = `\n\n**专项 Agent 列表（必须通过 delegate_to_agent 工具调用）：**\n${agentList}\n\n**关键词路由表（见到这些词 → 立即委托，不思考）：**\n- 线索/leads/新客/潜在客/跟进/转化/CRM/客户数量 → crm\n- 广告/花费/CPL/CPR/投放/成效/预算/ROAS/campaign/ad_report → account\n- 代码/bug/报错/debug/程序/开发/API/函数 → code\n\n委托规则：\n1. 只要用户问题含上述关键词，必须立刻委托对应 Agent，不得自行作答。\n2. 即使问题只有几个字（如"最近新线索？"），只要包含关键词，也必须委托。\n3. 只有纯粹的闲聊（"你好"、"谢谢"）或系统问题（"你是谁"）才自己回答。\n4. 宁可委托错了再说，也不要自己尝试完成专项任务。\n\n跨域分析规则：\n5. 如果问题同时涉及 leads/客户数据 AND 广告花费/CPL/成效，先委托 crm agent，再委托 account agent，最后自己综合输出结论。\n6. 每次委托后阅读结果，再决定是否需要下一步委托。\n7. 综合完毕后用中文给出清晰结论，不让用户二次追问。\n\n**自动化助手能力（直接使用，无需委托）：**\n- 当用户描述重复性痛点、说"每次都..."、"经常..."、"老是..."、"烦死了"等，主动问：「要不要我帮你设一个自动规则？」\n- 用 create_automation 工具建立规则，不需要跳转页面，对话里直接完成\n- 建规则前先确认：触发条件（什么情况触发）、动作（做什么）、频率\n- 建好后向用户回报规则摘要，包含触发条件和动作类型\n- 用 list_automations 查看所有规则；用 toggle_automation 启用/停用\n- 支持触发类型：schedule（定时）、threshold（指标超标，如 CPL > 15）、event（事件，如线索超 24h 未跟进）\n- 支持动作：dashboard_alert（Dashboard 预警）、chat_message（对话中推送）、whatsapp_push（WhatsApp 通知，需先配置凭证）`
      system = (agent.system_prompt || 'You are a helpful assistant.') + hermesInject + dateInject + (SOUL ? '\n\n' + SOUL : '') + skillText
      // Hermes itself doesn't search KB directly — it delegates to sub-agents who will
    } else {
      // Sub-agent: inject today's date + soul + KB context
      const hermesCtx = routedDirectly
        ? `\n\n**[系统上下文]** 你是被调度系统直接分配的专项 Agent。用户原始问题：${message}\n请基于对话历史给出专业回答。`
        : ''
      system = (promptOverride || agent.system_prompt || 'You are a helpful assistant.') + hermesCtx + dateInject + (SOUL ? '\n\n' + SOUL : '') + skillText + kbCtx
    }
    const useTools = DATA_AGENTS.has(agent.id) || !!agent.uses_tools
    R.hermesMode = (agent.id === 'chat')   // restrict Hermes to delegate_to_agent only

    // A: build messages with history prefix
    const messages: { role: string; content: string }[] = [
      ...history,
      { role: 'user', content: message },
    ]

    const { text: response, usedProvider } = await callLLM(
      providers, agent.provider || defaultProvider, agent.model, system, messages, useTools
    )

    const saves: Promise<unknown>[] = [
      dbInsert('conversations', { session_id:sid, role:'user',      content:message,  agent:agent.id, tenant_id:R.tenantId }),
      dbInsert('conversations', { session_id:sid, role:'assistant', content:response, agent: R.delegatedId || agent.id, tenant_id:R.tenantId }),
    ]
    // Log uncovered questions (chat answered directly without delegating)
    if (agent.id === 'chat' && !R.delegated && message.trim().length > 10) {
      saves.push(dbInsert('agent_suggestions', { message: message.trim(), session_id: sid, tenant_id: R.tenantId }))
      learnFromGaps().catch(() => {})  // 立即异步学习，不阻塞响应
    }
    await Promise.all(saves)
    extractPrefs(message, response, providers, defaultProvider)
    return new Response(
      JSON.stringify({ agent:agent.id, agent_name:agent.name, delegated_agent: R.delegatedId||undefined, delegated_agent_name: R.delegatedName||undefined, response, session_id:sid, provider:usedProvider }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    )

  } catch(e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status:500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
}))
