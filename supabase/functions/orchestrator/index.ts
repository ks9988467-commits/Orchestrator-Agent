import "jsr:@supabase/functions-js/edge-runtime.d.ts"
// Orchestrator HTTP handler. Helpers live in sibling modules: db.ts / storage.ts
// (portable data and files), state.ts (shared mutable state), http.ts (CORS, rate
// limits), auth.ts (sessions, roles), llm.ts, tools.ts, automation.ts, kb.ts / kb-sync.ts.
import { ROLE_RANK, SESSION_TTL_MS, authenticate, constantTimeEqual, masterEmailList, randomToken, requiredRole, sha256Hex } from './auth.ts'
import { type AutomationRule, buildActionMessage, calcNextRun, checkRuleTrigger, learnFromGaps, runWorkflows, sendLarkWebhook, sendNotification, withTimeout } from './automation.ts'
import { dbDelete, dbGet, dbGetPage, dbInsert, dbInsertReturning, dbPatch, dbPatchWhere, dbRpc, dbUpsert } from './db.ts'
import { clientIp, corsFor, rateLimited, tooManyRequests } from './http.ts'
import { SYNC_DIR, SYNC_INTERVAL_DAYS, summarize, syncKbId } from './kb-sync.ts'
import { ingestText, runKbSync } from './kb.ts'
import { DATA_AGENTS, SOUL, calcCost, callAnthropic, callGoogle, callLLM, callOpenAI, callOpenRouter, getDefaultProvider, getEmbedding, keywordRoute, listModels, loadAgentSkills, loadAgents, loadHistory, loadKbContext, loadProviders, resetUsage, streamWithFallback } from './llm.ts'
import { type AgentRow, type ProviderRow, R, llmUsage, shared, tenantFilters } from './state.ts'
import { BUCKETS, INLINE_TYPES, MAX_FILE_BYTES, USE_LOCAL_STORAGE, contentTypeFor, deleteFile, isValidName, nameFromUrl, objectName, publicUrl, putFile, readFile, signedUrl, verifySignedDownload } from './storage.ts'

// Search text for an ilike filter, wrapped in `*` wildcards. `"` and `\` are
// removed so the pattern can sit inside quotes in an or=(…) list.
function likePattern(s: unknown): string {
  return `*${String(s ?? '').replace(/["\\]/g, '').trim()}*`
}

// Rows imported from the dashboard: keep allowed columns, drop blank values
// ('' would be rejected by date/numeric columns) and give every row the same
// keys — a batch insert rejects rows whose keys differ.
function normalizeImportRows(rows: unknown, cols: string[]): Record<string, unknown>[] {
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

async function insertInChunks(table: string, rows: Record<string, unknown>[]): Promise<{ inserted: number; error?: string }> {
  let inserted = 0
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100)
    const r = await dbInsert(table, chunk)
    if (!r.ok) return { inserted, error: r.error || 'insert failed' }
    inserted += chunk.length
  }
  return { inserted }
}

// ── DB helpers moved to ./db.ts (dbGet/dbPatch/dbInsert/dbUpsert/dbInsertReturning)
//    Imported at top. Same signatures; backend switched by env DB_DRIVER.

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
Deno.serve(async (req: Request) => {
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

    // ── Session: who am I / logout ───────────────────────────────────
    if (body.action === 'whoami') {
      const tRows = R.tenantId ? await dbGet('tenants', 'name', { id: `eq.${R.tenantId}` }, undefined, 1) : []
      return new Response(JSON.stringify({ ok: true, email: R.email, role: R.role, tenant_id: R.tenantId, tenant_name: tRows[0]?.name ?? '' }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    if (body.action === 'logout') {
      if (R.authHash) await dbPatchWhere('sessions', { token_hash: `eq.${R.authHash}` }, { revoked_at: new Date().toISOString() })
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
      const email = String(body.email || '').trim().toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return new Response(JSON.stringify({ error: 'valid email required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      // Only emails that can log in get a code. The response is the same either way, so
      // this cannot be used to find out which emails are registered.
      const canLogIn = masterEmailList().includes(email) || (await dbGet('tenant_users', 'id', { email: `eq.${email}` }, undefined, 1)).length > 0
      if (!canLogIn) return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      // Rate limit per email: one code a minute, five an hour
      const hourAgo = new Date(Date.now() - 3600_000).toISOString()
      const recent = await dbGet('otp_requests', 'created_at', { email: `eq.${email}`, created_at: `gte.${hourAgo}` }, 'created_at.desc', 5) as { created_at: string }[]
      if (recent.length >= 5 || (recent[0] && Date.now() - Date.parse(recent[0].created_at) < 60_000)) {
        return new Response(JSON.stringify({ error: '请求太频繁，请稍后再试' }), { status: 429, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0')
      // Only a hash of the code is stored
      await dbInsert('otp_requests', { email, code: await sha256Hex(`${email}:${code}`) })
      if (Deno.env.get('OTP_DEV_ECHO') === 'true') {
        // Local development only: print the code and hand it back to the login page instead of emailing it
        console.log(`[OTP_DEV_ECHO] ${email}: ${code}`)
        return new Response(JSON.stringify({ ok: true, dev_code: code }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
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
      const email = String(body.email || '').trim().toLowerCase()
      const code = String(body.code || '').trim()
      if (!email || !code) return new Response(JSON.stringify({ error: 'email and code required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      // Only the newest unused, unexpired code for this email counts
      const rows = await dbGet('otp_requests', 'id,code,attempts', {
        email: `eq.${email}`, used: 'eq.false', expires_at: `gte.${new Date().toISOString()}`,
      }, 'id.desc', 1) as { id: number; code: string; attempts: number }[]
      if (!rows.length) return new Response(JSON.stringify({ ok: false, error: '\u9A8C\u8BC1\u7801\u65E0\u6548\u6216\u5DF2\u8FC7\u671F' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const otp = rows[0]
      if (!constantTimeEqual(otp.code, await sha256Hex(`${email}:${code}`))) {
        // Five wrong guesses use the code up
        const attempts = (otp.attempts || 0) + 1
        await dbPatch('otp_requests', String(otp.id), attempts >= 5 ? { attempts, used: true } : { attempts })
        return new Response(JSON.stringify({ ok: false, error: attempts >= 5 ? '\u9519\u8BEF\u6B21\u6570\u8FC7\u591A\uFF0C\u8BF7\u91CD\u65B0\u83B7\u53D6\u9A8C\u8BC1\u7801' : '\u9A8C\u8BC1\u7801\u65E0\u6548\u6216\u5DF2\u8FC7\u671F' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      await dbPatch('otp_requests', String(otp.id), { used: true })
      // Master = an email listed in MASTER_EMAILS (comma-separated). Everyone else needs a
      // tenant_users row — an unknown email is refused, never treated as master.
      const isMasterEmail = masterEmailList().includes(email)
      const tuRows = await dbGet('tenant_users', 'tenant_id,role', { email: `eq.${email}` })
      let tenantId: string|null = tuRows[0]?.tenant_id ?? null
      let role: string = tuRows[0]?.role === 'admin' ? 'admin' : 'member'
      let tenantName = ''
      if (isMasterEmail) {
        role = 'master'
        const masterRows = await dbGet('tenants', 'id,name', { name: 'eq.Master' })
        if (masterRows.length) { tenantId = masterRows[0].id; tenantName = masterRows[0].name }
      } else if (!tuRows.length) {
        return new Response(JSON.stringify({ ok: false, error: '该邮箱没有访问权限，请联系管理员' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
      } else if (tenantId) {
        const tRows = await dbGet('tenants', 'name', { id: `eq.${tenantId}` })
        tenantName = tRows[0]?.name ?? ''
      }
      // Issue a session: the token goes to the browser once, only its hash is kept
      const token = randomToken()
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()
      const sIns = await dbInsert('sessions', { token_hash: await sha256Hex(token), email, tenant_id: tenantId, role, expires_at: expiresAt })
      if (!sIns.ok) return new Response(JSON.stringify({ ok: false, error: '登录失败，请重试' }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
      return new Response(JSON.stringify({ ok: true, token, expires_at: expiresAt, tenant_id: tenantId, role, tenant_name: tenantName, email }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // \u2500\u2500 Tenant management (master only) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    if (body.action === 'list_tenants') {
      // Master check (R.isMaster comes from the authenticated session)
      if (!R.isMaster) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
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

    if (body.action === 'get_master_summary') {
      if (!R.isMaster) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const tenants = await dbGet('tenants', 'id,name,slug,active')
      const now = new Date()
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10)
      const summary = await Promise.all((tenants as Record<string,unknown>[]).filter(t => t.active).map(async t => {
        const tid = String(t.id)
        const [analRows, leadRows, alertRows] = await Promise.all([
          dbGet('analytics_daily', 'spend_myr,new_contacts', { tenant_id: `eq.${tid}`, date: `gte.${monthStart}` }, undefined, 1000),
          dbGet('leads', 'id', { tenant_id: `eq.${tid}`, date: `gte.${monthStart}` }, undefined, 500),
          dbGet('automation_logs', 'id', { tenant_id: `eq.${tid}`, read: 'eq.false' }, 'triggered_at.desc', 10),
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

    // \u2500\u2500 Check alerts \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    // \u2500\u2500 Workflow CRUD (from dashboard) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    if (body.action === 'delete_workflow') {
      const { id } = body
      if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      await dbDelete('workflow_runs', { workflow_id: `eq.${id}` })
      await dbDelete('workflows', { id: `eq.${id}` })
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (body.action === 'run_workflows') {
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
      const tid = R.tenantId || 'default'
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
      const tid = R.tenantId || 'default'
      await dbUpsert('ugc_platform_rules',
        { tenant_id: tid, platform, max_words: max_words||'', style: style||'', special: special||'', updated_at: new Date().toISOString() },
        'tenant_id,platform'
      )
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (body.action === 'ugc_reset_rule') {
      const { platform } = body
      if (!platform) return new Response(JSON.stringify({ error: 'platform required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const tid = R.tenantId || 'default'
      await dbDelete('ugc_platform_rules', { tenant_id: `eq.${tid}`, platform: `eq.${platform}` })
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
        const tid = R.tenantId || 'default'
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
        // Prefer OpenRouter cheap model for UGC (cost ~10x lower than Anthropic)
        const orProvider = providers.find(p => p.provider === 'openrouter' && p.active && p.api_key?.trim())
        const ugcProvider = orProvider ? 'openrouter' : (ugcAgent.provider || defaultProvider)
        const ugcModel = orProvider ? 'google/gemini-flash-1.5' : (ugcAgent.model || undefined)
        const { text } = await callLLM(providers, ugcProvider, ugcModel,
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

    // ── Automation: run all due rules (called by pg_cron every 15 min) ──
    if (body.action === 'automation_run') {
      const tenantFilter: Record<string,string> = { enabled: 'eq.true' }
      if (body.tenant_id) tenantFilter['tenant_id'] = `eq.${String(body.tenant_id)}`
      const rules = await dbGet('automation_rules', '*', tenantFilter, undefined, 100) as AutomationRule[]
      const triggered: string[] = []
      const errors:    string[] = []
      const now = new Date().toISOString()

      for (const rule of rules) {
        try {
          const { trigger, data } = await checkRuleTrigger(rule)
          // Always update last_run_at
          await dbPatch('automation_rules', String(rule.id), { last_run_at: now })
          if (!trigger) continue

          const msg = buildActionMessage(rule, data)
          const tid = String(rule.tenant_id || 'default')

          // Execute action
          if (rule.action_type === 'whatsapp_push') {
            const cfg       = (rule.action_config || {}) as Record<string, string>
            const recipient = cfg.recipient
            await sendNotification('whatsapp', msg, recipient)
          }
          // Always log (dashboard_alert, chat_message, whatsapp_push all get a log entry)
          await dbInsert('automation_logs', {
            rule_id:      rule.id,
            tenant_id:    tid,
            trigger_data: data,
            action_taken: String(rule.action_type || ''),
            message:      msg,
            status:       'ok',
            read:         false,
          })
          // Update last_triggered_at
          await dbPatch('automation_rules', String(rule.id), { last_triggered_at: now })
          triggered.push(String(rule.name || rule.id))
        } catch(e) {
          errors.push(`${rule.name}: ${(e as Error).message}`)
        }
      }
      return new Response(
        JSON.stringify({ ok: true, checked: rules.length, triggered: triggered.length, triggered_names: triggered, errors }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    // ── Proactive AI: daily report (called by pg_cron once daily) ──────
    // Generates an LLM-written daily ops summary per tenant, logs it to
    // automation_logs (shown in dashboard alert panel), and optionally
    // pushes via WhatsApp/Email/Telegram if a channel is configured.
    if (body.action === 'daily_report') {
      const providers       = await loadProviders()
      const defaultProvider = await getDefaultProvider()
      const tenants = body.tenant_id
        ? [{ id: String(body.tenant_id), name: String(body.tenant_name || '') }]
        : (await dbGet('tenants', 'id,name', { active: 'eq.true' }) as {id:string;name:string}[])
      const results: object[] = []

      for (const t of tenants) {
        const tid = t.id
        try {
          // Source: analytics_daily (pre-aggregated by day+campaign, refreshed
          // daily by pg_cron). Same source as the dashboard analytics tab — no
          // row-cap issues, and ad spend + lead_count are aligned by date.
          const rows = await dbGet('analytics_daily', 'date,campaign_name,spend_myr,results,lead_count',
            { tenant_id: `eq.${tid}` }, 'date.desc', 3000) as Record<string,string|number>[]
          if (!rows.length) { results.push({ tenant: tid, ok: true, skipped: 'no analytics data' }); continue }

          // Anchor on the latest available date (= today in production).
          const anchorStr = String(rows[0].date).slice(0,10)
          const anchor    = new Date(anchorStr + 'T00:00:00Z')

          // Bucket by day; aggregate per-campaign for the anchor day only
          const byDay: Record<string,{spend:number;results:number;leads:number}> = {}
          const campAgg: Record<string,{spend:number;results:number}> = {}
          for (const r of rows) {
            const day = String(r.date || '').slice(0,10)
            if (!byDay[day]) byDay[day] = { spend:0, results:0, leads:0 }
            byDay[day].spend   += Number(r.spend_myr)   || 0
            byDay[day].results += Number(r.results)     || 0
            byDay[day].leads   += Number(r.lead_count)  || 0
            if (day === anchorStr) {
              const c = String(r.campaign_name || '未知')
              if (!campAgg[c]) campAgg[c] = { spend:0, results:0 }
              campAgg[c].spend   += Number(r.spend_myr) || 0
              campAgg[c].results += Number(r.results)   || 0
            }
          }

          const avg = (arr:number[]) => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0
          const priorDays = Array.from({length:7}, (_,i)=> new Date(anchor.getTime()-(i+1)*86400000).toISOString().slice(0,10))
          const todaySpend   = byDay[anchorStr]?.spend   || 0
          const todayResults = byDay[anchorStr]?.results || 0
          const todayLeads   = byDay[anchorStr]?.leads   || 0
          const todayCpl     = todayResults > 0 ? todaySpend / todayResults : 0
          const avgSpend     = avg(priorDays.map(d => byDay[d]?.spend || 0))
          const avgLeads     = avg(priorDays.map(d => byDay[d]?.leads || 0))
          const avgCpl       = avg(priorDays.map(d => { const a = byDay[d]; return a && a.results > 0 ? a.spend/a.results : 0 }).filter(v => v > 0))

          const campList = Object.entries(campAgg)
            .map(([name,v]) => ({ name, spend:+v.spend.toFixed(0), results:v.results, cpl: v.results > 0 ? +(v.spend/v.results).toFixed(2) : 0 }))
            .filter(c => c.results > 0).sort((a,b) => a.cpl - b.cpl)

          const pct = (today:number, a:number) => a > 0 ? +(((today-a)/a)*100).toFixed(0) : 0
          const digest = {
            报告日期: anchorStr,
            今日: { 新线索: todayLeads, 花费MYR: +todaySpend.toFixed(0), 结果数: todayResults, CPL_MYR: +todayCpl.toFixed(2) },
            过去7天均值: { 新线索: +avgLeads.toFixed(1), 花费MYR: +avgSpend.toFixed(0), CPL_MYR: +avgCpl.toFixed(2) },
            环比: { 线索: `${pct(todayLeads,avgLeads)}%`, 花费: `${pct(todaySpend,avgSpend)}%`, CPL: `${pct(todayCpl,avgCpl)}%` },
            最佳campaign: campList[0] || null,
            最差campaign: campList.length > 1 ? campList[campList.length-1] : null,
          }

          const system = `你是资深运营分析助理。根据提供的数据生成「每日运营摘要」，用中文，简洁专业。严格按以下四部分输出（每部分用 emoji 标题开头）：\n📊 Leads 动态\n💰 广告成效\n🚨 异常提醒（仅在确有异常时列出，否则写"无明显异常"）\n✅ 行动建议（2-3 条具体可执行）\n要求：只使用提供的数字，绝不编造；每条一句话；CPL/花费带 MYR 单位。`
          const { text } = await callLLM(providers, defaultProvider, null, system,
            [{ role:'user', content: `数据（JSON）：\n${JSON.stringify(digest, null, 2)}` }])

          const message = `📋 每日运营摘要（${anchorStr}）\n\n${text}`
          await dbInsert('automation_logs', {
            rule_id: null, tenant_id: tid, trigger_data: digest,
            action_taken: 'daily_report', message, status: 'ok', read: false,
          })

          // Channel-ready delivery — silent no-op if credentials are missing
          const channel = String(body.channel || '')
          if (channel === 'whatsapp' || channel === 'email' || channel === 'telegram') {
            await sendNotification(channel, message, body.recipient ? String(body.recipient) : undefined)
          }
          results.push({ tenant: tid, ok: true, date: anchorStr })
        } catch(e) {
          results.push({ tenant: tid, error: (e as Error).message })
        }
      }
      return new Response(JSON.stringify({ ok: true, reports: results }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } })
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

    // ── Conversation log (对话日志) ─────────────────────────────────────
    // Replaces the dashboard's direct supabase-js queries on `conversations`.
    // The role filter is `log_role`, not `role`: every request body already
    // carries `role` (the session role that sets R.isMaster).
    if (body.action === 'conversation_crud') {
      const m = String(body.method || 'list')

      if (m === 'list') {
        const filt: Record<string,string> = {}
        if (body.agent)    filt['agent'] = `eq.${String(body.agent)}`
        if (body.log_role) filt['role']  = `eq.${String(body.log_role)}`
        if (body.feedback === 'good' || body.feedback === 'bad') filt['feedback'] = `eq.${body.feedback}`
        else if (body.feedback === 'none') filt['feedback'] = 'is.null'
        const limit  = Math.min(Math.max(Number(body.limit) || 200, 1), 500)
        const offset = Math.max(Number(body.offset) || 0, 0)
        const { rows, count } = await dbGetPage('conversations',
          'id,role,agent,content,created_at,cost_usd,tokens_in,tokens_out,feedback',
          tenantFilters(filt), 'created_at.desc', limit, offset)
        return new Response(JSON.stringify({ ok: true, rows, count }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      if (m === 'set_feedback') {
        const id = String(body.id || '')
        if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        const feedback = body.feedback === 'good' || body.feedback === 'bad' ? body.feedback : null
        await dbPatchWhere('conversations', tenantFilters({ id: `eq.${id}` }), { feedback })
        return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      if (m === 'delete_all') {
        // `id > 0` matches every row — dbDelete deliberately refuses an empty filter
        const filt: Record<string,string> = { id: 'gt.0' }
        if (body.agent) filt['agent'] = `eq.${String(body.agent)}`
        await dbDelete('conversations', tenantFilters(filt))
        return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ error: 'unknown method' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── LLM provider config (LLM 配置) ──────────────────────────────────
    // API keys never leave the server: `list` returns has_key + the last 4 chars.
    if (body.action === 'provider_config_crud') {
      const m = String(body.method || 'list')
      const PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter']

      if (m === 'list') {
        const rows = await dbGet('provider_config', 'provider,api_key,model,active') as ProviderRow[]
        const providers = rows.map(r => {
          const key = (r.api_key || '').trim()
          return { provider: r.provider, model: r.model || null, active: !!r.active, has_key: !!key, key_hint: key ? key.slice(-4) : '' }
        })
        const pref = await dbGet('user_prefs', 'value', { key: 'eq.default_provider' }, undefined, 1)
        return new Response(JSON.stringify({ ok: true, providers, default_provider: pref[0]?.value ?? null }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      if (m === 'save') {
        const provider = String(body.provider || '')
        if (!PROVIDERS.includes(provider)) return new Response(JSON.stringify({ error: 'unknown provider' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        const fields: Record<string, unknown> = { provider }
        if (body.model !== undefined)  fields.model  = body.model ? String(body.model).trim() : null
        if (body.active !== undefined) fields.active = !!body.active
        // a blank api_key means "keep the stored key"
        if (typeof body.api_key === 'string' && body.api_key.trim()) fields.api_key = body.api_key.trim()
        await dbUpsert('provider_config', fields, 'provider')
        shared.providers = null
        return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      if (m === 'set_default') {
        const provider = String(body.provider || '')
        if (!PROVIDERS.includes(provider)) return new Response(JSON.stringify({ error: 'unknown provider' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        await dbUpsert('user_prefs', { key: 'default_provider', value: provider, confidence: 1.0 }, 'key')
        shared.defProv = null
        return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ error: 'unknown method' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── Agents (Agent 管理) ─────────────────────────────────────────────
    // The update payload goes in `data`, keeping it clear of reserved body keys.
    if (body.action === 'agent_crud') {
      const m = String(body.method || 'list')

      if (m === 'list') {
        const agents = await dbGet('agents', 'id,name,active,provider,model,description,system_prompt,uses_tools', {}, 'id.asc')
        return new Response(JSON.stringify({ ok: true, agents }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      if (m === 'update') {
        const id = String(body.id || '')
        if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        const d = (body.data || {}) as Record<string, unknown>
        const patch: Record<string, unknown> = {}
        for (const k of ['name', 'description', 'system_prompt']) if (d[k] !== undefined) patch[k] = d[k]
        for (const k of ['provider', 'model']) if (d[k] !== undefined) patch[k] = d[k] || null
        for (const k of ['active', 'uses_tools']) if (d[k] !== undefined) patch[k] = !!d[k]
        if (!Object.keys(patch).length) return new Response(JSON.stringify({ error: 'nothing to update' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        patch.updated_at = new Date().toISOString()
        await dbPatch('agents', id, patch)
        shared.agents = null
        return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      if (m === 'create') {
        // Insert only: an id that already exists is an error, never an overwrite
        // (the create-from-gap flow takes its id from an LLM suggestion).
        const d = (body.data || {}) as Record<string, unknown>
        const id = String(d.id || '').trim()
        if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        const row: Record<string, unknown> = { id, active: d.active === undefined ? true : !!d.active }
        for (const k of ['name', 'description', 'system_prompt']) if (d[k] !== undefined) row[k] = d[k]
        for (const k of ['provider', 'model']) if (d[k] !== undefined) row[k] = d[k] || null
        if (d.uses_tools !== undefined) row.uses_tools = !!d.uses_tools
        const existing = await dbGet('agents', 'id', { id: `eq.${id}` }, undefined, 1)
        if (existing.length) return new Response(JSON.stringify({ error: `Agent ID "${id}" 已存在` }), { status: 409, headers: { ...CORS, 'Content-Type': 'application/json' } })
        const ins = await dbInsert('agents', row)
        if (!ins.ok) return new Response(JSON.stringify({ error: ins.error || 'insert failed' }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
        shared.agents = null
        return new Response(JSON.stringify({ ok: true, id }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      if (m === 'delete') {
        const id = String(body.id || '')
        if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        await dbDelete('agents', { id: `eq.${id}` })
        shared.agents = null
        return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ error: 'unknown method' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── Agent skills (技能库) ────────────────────────────────────────────
    if (body.action === 'agent_skill_crud') {
      const m = String(body.method || 'list')

      if (m === 'list') {
        const skills = await dbGet('agent_skills', 'id,agent,skill,created_at', {}, 'created_at.desc')
        return new Response(JSON.stringify({ ok: true, skills }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      if (m === 'delete') {
        const id = String(body.id || '')
        if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        await dbDelete('agent_skills', { id: `eq.${id}` })
        return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      if (m === 'delete_agent') {
        const agent = String(body.agent || '')
        if (!agent) return new Response(JSON.stringify({ error: 'agent required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        await dbDelete('agent_skills', { agent: `eq.${agent}` })
        return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ error: 'unknown method' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── Agent suggestions / knowledge gaps (缺口问题) ─────────────────────
    if (body.action === 'agent_suggestion_crud') {
      const m = String(body.method || 'list')

      if (m === 'list') {
        const limit = Math.min(Math.max(Number(body.limit) || 100, 1), 500)
        const suggestions = await dbGet('agent_suggestions', 'id,message,session_id,asked_at,handled,tenant_id', tenantFilters(), 'asked_at.desc', limit)
        return new Response(JSON.stringify({ ok: true, suggestions }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      if (m === 'mark_handled' || m === 'delete') {
        const id = String(body.id || '')
        if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        if (m === 'mark_handled') await dbPatchWhere('agent_suggestions', tenantFilters({ id: `eq.${id}` }), { handled: true })
        else await dbDelete('agent_suggestions', tenantFilters({ id: `eq.${id}` }))
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

    // ── Staff (员工) ─────────────────────────────────────────────────────
    if (body.action === 'staff_crud') {
      const m = String(body.method || 'list')
      if (m === 'list') {
        const filt: Record<string, string> = body.active_only ? { active: 'eq.true' } : {}
        const staff = await dbGet('staff', 'id,name,avatar,role,department,active', tenantFilters(filt), 'name.asc')
        return new Response(JSON.stringify({ ok: true, staff }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      if (m === 'save') {
        const d = (body.data || {}) as Record<string, unknown>
        const name = String(d.name ?? '').trim()
        if (!name) return new Response(JSON.stringify({ error: 'name required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        const fields: Record<string, unknown> = { name }
        for (const k of ['avatar', 'role', 'department']) fields[k] = String(d[k] ?? '').trim() || null
        const id = String(body.id || '')
        if (id) {
          await dbPatchWhere('staff', tenantFilters({ id: `eq.${id}` }), fields)
        } else {
          const ins = await dbInsert('staff', { ...fields, tenant_id: R.tenantId || 'default' })
          if (!ins.ok) return new Response(JSON.stringify({ error: ins.error || 'insert failed' }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
        }
        return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      if (m === 'set_active') {
        const id = String(body.id || '')
        if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        await dbPatchWhere('staff', tenantFilters({ id: `eq.${id}` }), { active: !!body.active })
        return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ error: 'unknown method' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── Team tasks (任务) ─────────────────────────────────────────────────
    // Not `list_tasks` — that name belongs to the agent task runner.
    if (body.action === 'staff_task_crud') {
      const m = String(body.method || 'list')
      const STATUSES = ['todo', 'in_progress', 'done']
      const PRIORITIES = ['high', 'normal', 'low']

      if (m === 'list') {
        const filt: Record<string, string> = {}
        if (body.status)      filt['status']      = `eq.${String(body.status)}`
        if (body.assignee_id) filt['assignee_id'] = `eq.${String(body.assignee_id)}`
        const tasks = await dbGet('tasks', 'id,title,description,assignee_id,created_by,priority,status,due_date,updated_at,created_at',
          tenantFilters(filt), 'created_at.desc') as Record<string, unknown>[]
        // Attach assignee / creator here: postgres mode has no PostgREST resource embedding
        const ids = [...new Set(tasks.flatMap(t => [t.assignee_id, t.created_by]).filter(Boolean).map(String))]
        const people = ids.length ? await dbGet('staff', 'id,name,avatar', { id: `in.(${ids.join(',')})` }) as { id: string; name: string; avatar: string | null }[] : []
        const byId = new Map(people.map(p => [p.id, p]))
        for (const t of tasks) {
          const a = byId.get(String(t.assignee_id))
          const c = byId.get(String(t.created_by))
          t.assignee = a ? { id: a.id, name: a.name, avatar: a.avatar } : null
          t.creator  = c ? { id: c.id, name: c.name } : null
        }
        return new Response(JSON.stringify({ ok: true, tasks }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      if (m === 'save') {
        const d = (body.data || {}) as Record<string, unknown>
        const title = String(d.title ?? '').trim()
        if (!title) return new Response(JSON.stringify({ error: 'title required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        const fields: Record<string, unknown> = {
          title,
          description: String(d.description ?? '').trim() || null,
          assignee_id: d.assignee_id || null,
          priority:    PRIORITIES.includes(String(d.priority)) ? String(d.priority) : 'normal',
          due_date:    d.due_date || null,
          updated_at:  new Date().toISOString(),
        }
        const id = String(body.id || '')
        if (id) {
          await dbPatchWhere('tasks', tenantFilters({ id: `eq.${id}` }), fields)   // creator is set once, on create
        } else {
          const ins = await dbInsert('tasks', { ...fields, created_by: d.created_by || null, tenant_id: R.tenantId || 'default' })
          if (!ins.ok) return new Response(JSON.stringify({ error: ins.error || 'insert failed' }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
        }
        return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      if (m === 'set_status' || m === 'delete') {
        const id = String(body.id || '')
        if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        if (m === 'delete') {
          await dbDelete('tasks', tenantFilters({ id: `eq.${id}` }))
        } else {
          const status = String(body.status || '')
          if (!STATUSES.includes(status)) return new Response(JSON.stringify({ error: 'unknown status' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
          await dbPatchWhere('tasks', tenantFilters({ id: `eq.${id}` }), { status, updated_at: new Date().toISOString() })
        }
        return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ error: 'unknown method' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── Direct messages (消息) ────────────────────────────────────────────
    // The dashboard polls `poll` instead of subscribing to Supabase Realtime.
    if (body.action === 'direct_message_crud') {
      type DmRow = { id: string; from_id: string; to_id: string; content: string; read_at: string | null; created_at: string }
      const m = String(body.method || 'list')
      const isId = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
      const me = String(body.me || ''), peer = String(body.peer || '')
      const DM_COLS = 'id,from_id,to_id,content,read_at,created_at'
      // Marks only these rows read, so a message arriving mid-request stays unread for the next poll
      const markRead = async (rows: DmRow[]) => {
        const ids = rows.filter(r => r.to_id === me && !r.read_at).map(r => r.id)
        if (ids.length) await dbPatchWhere('direct_messages', { id: `in.(${ids.join(',')})` }, { read_at: new Date().toISOString() })
      }

      if (m === 'list') {
        if (!isId(me) || !isId(peer)) return new Response(JSON.stringify({ error: 'me and peer (staff ids) required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        const rows = await dbGet('direct_messages', DM_COLS,
          tenantFilters({ or: `(and(from_id.eq.${me},to_id.eq.${peer}),and(from_id.eq.${peer},to_id.eq.${me}))` }), 'created_at.desc', 100) as DmRow[]
        rows.reverse()   // the newest 100, oldest first
        await markRead(rows)
        return new Response(JSON.stringify({ ok: true, messages: rows }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      if (m === 'send') {
        const content = String(body.content ?? '').trim()
        if (!isId(me) || !isId(peer) || !content) return new Response(JSON.stringify({ error: 'me, peer and content required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        const message = await dbInsertReturning('direct_messages', { from_id: me, to_id: peer, content, tenant_id: R.tenantId || 'default' })
        return new Response(JSON.stringify({ ok: true, message }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      if (m === 'poll') {
        // messages: unread from the open thread's peer (now marked read); unread_from: other senders with unread messages
        if (!isId(me)) return new Response(JSON.stringify({ error: 'me (staff id) required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        const unread = await dbGet('direct_messages', DM_COLS, tenantFilters({ to_id: `eq.${me}`, read_at: 'is.null' }), 'created_at.asc', 200) as DmRow[]
        const messages = isId(peer) ? unread.filter(r => r.from_id === peer) : []
        await markRead(messages)
        const unread_from = [...new Set(unread.filter(r => r.from_id !== peer).map(r => r.from_id))]
        return new Response(JSON.stringify({ ok: true, messages, unread_from }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ error: 'unknown method' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── Document approval (文件审批) ─────────────────────────────────────
    // Attachments are uploaded first via POST <base>/files/documents. The
    // document status is recomputed here after every reviewer decision.
    if (body.action === 'document_crud') {
      const m = String(body.method || 'list')
      const DOC_COLS = 'id,title,notes,file_url,file_name,file_type,file_size,status,uploaded_by,tenant_id,created_at'

      if (m === 'list') {
        const filt: Record<string, string> = {}
        if (body.status) filt['status'] = `eq.${String(body.status)}`
        let docs = await dbGet('documents', DOC_COLS, tenantFilters(filt), 'created_at.desc', 100) as Record<string, unknown>[]
        // Members see only documents they uploaded or review
        const viewer = R.email
        if (R.role === 'member') {
          const mine = await dbGet('document_reviewers', 'document_id', { contact: `eq.${viewer}` }) as { document_id: string }[]
          const reviewing = new Set(mine.map(r => r.document_id))
          docs = docs.filter(d => d.uploaded_by === viewer || reviewing.has(String(d.id)))
        }
        const ids = docs.map(d => String(d.id))
        const revs = ids.length ? await dbGet('document_reviewers', 'document_id,decision', { document_id: `in.(${ids.join(',')})` }) as { document_id: string; decision: string | null }[] : []
        for (const d of docs) {
          d.decisions = revs.filter(r => r.document_id === d.id).map(r => r.decision)
          d.file_url = await signedUrl(d.file_url as string | null, 3600)
        }
        return new Response(JSON.stringify({ ok: true, documents: docs }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      if (m === 'get') {
        const id = String(body.id || '')
        if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        const [doc] = await dbGet('documents', DOC_COLS, tenantFilters({ id: `eq.${id}` }), undefined, 1)
        if (!doc) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } })
        const reviewers = await dbGet('document_reviewers', 'id,document_id,name,contact,decision,comment,decided_at,created_at', { document_id: `eq.${id}` }, 'created_at.asc')
        // Same rule as list: a member sees only documents they uploaded or review
        if (R.role === 'member' && String(doc.uploaded_by || '').trim().toLowerCase() !== R.email
            && !reviewers.some((r: { contact: string | null }) => String(r.contact || '').trim().toLowerCase() === R.email)) {
          return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } })
        }
        doc.file_url = await signedUrl(doc.file_url, 3600)
        return new Response(JSON.stringify({ ok: true, document: doc, reviewers }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      if (m === 'create') {
        const d = (body.data || {}) as Record<string, unknown>
        const title = String(d.title ?? '').trim()
        const reviewers = (Array.isArray(body.reviewers) ? body.reviewers as Record<string, unknown>[] : [])
          .map(r => ({ name: String(r?.name ?? '').trim(), contact: String(r?.contact ?? '').trim() || null }))
          .filter(r => r.name)
        if (!title) return new Response(JSON.stringify({ error: 'title required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        if (!reviewers.length) return new Response(JSON.stringify({ error: 'at least one reviewer required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        const doc = await dbInsertReturning('documents', {
          title, notes: String(d.notes ?? '').trim() || null,
          file_url: d.file_url || null, file_name: d.file_name || null, file_type: d.file_type || null,
          file_size: d.file_size ? Number(d.file_size) : null, status: 'pending',
          // the uploader is the logged-in user; only internal callers may name one
          tenant_id: R.tenantId, uploaded_by: R.email || d.uploaded_by || null,
        })
        const ins = await dbInsert('document_reviewers', reviewers.map(r => ({ document_id: doc.id, ...r })))
        if (!ins.ok) {
          await dbDelete('documents', { id: `eq.${doc.id}` })   // no document without reviewers
          return new Response(JSON.stringify({ error: ins.error || 'insert failed' }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
        }
        return new Response(JSON.stringify({ ok: true, id: doc.id }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      if (m === 'decide') {
        const reviewerId = String(body.reviewer_id || '')
        const decision = String(body.decision || '')
        if (!reviewerId || !['approved', 'rejected'].includes(decision)) return new Response(JSON.stringify({ error: 'reviewer_id and decision (approved | rejected) required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        const [rev] = await dbGet('document_reviewers', 'id,document_id,contact', { id: `eq.${reviewerId}` }, undefined, 1)
        if (!rev) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } })
        const [revDoc] = await dbGet('documents', 'id', tenantFilters({ id: `eq.${rev.document_id}` }), undefined, 1)
        if (!revDoc) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } })
        // A member may only record the decision on their own reviewer row
        if (R.role === 'member' && String(rev.contact || '').trim().toLowerCase() !== R.email) {
          return new Response(JSON.stringify({ error: '只能填写你自己的审批' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
        }
        await dbPatch('document_reviewers', reviewerId, { decision, comment: String(body.comment ?? '').trim() || null, decided_at: new Date().toISOString() })
        const all = await dbGet('document_reviewers', 'decision', { document_id: `eq.${rev.document_id}` }) as { decision: string | null }[]
        const approved = all.filter(r => r.decision === 'approved').length
        const rejected = all.filter(r => r.decision === 'rejected').length
        const status = rejected > 0 ? 'rejected' : approved === all.length ? 'approved' : approved > 0 ? 'partial' : 'pending'
        await dbPatch('documents', String(rev.document_id), { status })
        return new Response(JSON.stringify({ ok: true, status }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      if (m === 'delete') {
        const id = String(body.id || '')
        if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        const [doc] = await dbGet('documents', 'id,file_url,uploaded_by', tenantFilters({ id: `eq.${id}` }), undefined, 1)
        if (!doc) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } })
        // A member may only delete documents they uploaded
        if (R.role === 'member' && String(doc.uploaded_by || '').trim().toLowerCase() !== R.email) {
          return new Response(JSON.stringify({ error: '只能删除你自己上传的文件' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
        }
        await dbDelete('documents', { id: `eq.${id}` })   // reviewers go with it (ON DELETE CASCADE)
        // Best effort: the record is already gone, and a leftover file is harmless
        const name = doc.file_url ? nameFromUrl('documents', String(doc.file_url)) : null
        let file_deleted = false
        if (name) {
          try { await deleteFile('documents', name); file_deleted = true } catch (e) { console.error('deleteFile documents', name, e) }
        }
        return new Response(JSON.stringify({ ok: true, file_deleted }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ error: 'unknown method' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── API integrations (API 集成) ─────────────────────────────────────
    // Secret credential values are masked in `list`; on `save`, a value that is
    // still masked keeps the stored secret. webhook_url stays visible because the
    // Lark/Slack test buttons read it straight from the input.
    if (body.action === 'integration_crud') {
      const m = String(body.method || 'list')
      const MASK = '••••••••'
      const isSecret = (k: string) => /secret|token|password|api_key/i.test(k)

      if (m === 'list') {
        const rows = await dbGet('api_integrations', 'service,active,credentials,updated_at') as
          { service: string; active: boolean; credentials: Record<string, unknown> | null; updated_at: string | null }[]
        const integrations = rows.map(r => ({
          service: r.service,
          active: !!r.active,
          updated_at: r.updated_at,
          credentials: Object.fromEntries(Object.entries(r.credentials || {}).map(([k, v]) =>
            [k, isSecret(k) && typeof v === 'string' && v ? (v.length > 8 ? MASK + v.slice(-4) : MASK) : v])),
        }))
        return new Response(JSON.stringify({ ok: true, integrations }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      if (m === 'save') {
        const service = String(body.service || '').trim()
        if (!service) return new Response(JSON.stringify({ error: 'service required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        const fields: Record<string, unknown> = { service, updated_at: new Date().toISOString() }
        if (body.active !== undefined) fields.active = !!body.active
        if (body.credentials && typeof body.credentials === 'object') {
          const existing = await dbGet('api_integrations', 'credentials', { service: `eq.${service}` }, undefined, 1)
          const stored = (existing[0]?.credentials || {}) as Record<string, unknown>
          fields.credentials = Object.fromEntries(Object.entries(body.credentials as Record<string, unknown>).map(([k, v]) =>
            [k, typeof v === 'string' && v.startsWith(MASK) ? (stored[k] ?? null) : v]))
        }
        await dbUpsert('api_integrations', fields, 'service')
        return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
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

    // ── Automation CRUD (dashboard API) ───────────────────────────────
    if (body.action === 'automation_crud') {
      const { method: crudMethod, rule_id, data: crudData } = body
      const tid = R.tenantId || String(body.tenant_id || 'default')

      if (crudMethod === 'list') {
        const rules = await dbGet('automation_rules',
          'id,name,description,trigger_type,trigger_config,action_type,action_config,enabled,last_run_at,last_triggered_at,created_by,created_at',
          { tenant_id: `eq.${tid}` }, 'created_at.desc', 50)
        return new Response(JSON.stringify({ ok: true, rules }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      if (crudMethod === 'create') {
        await dbInsert('automation_rules', { ...(crudData as object || {}), tenant_id: tid })
        return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      if (crudMethod === 'update') {
        if (!rule_id) return new Response(JSON.stringify({ error: 'rule_id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        await dbPatchWhere('automation_rules', { id: `eq.${rule_id}`, tenant_id: `eq.${tid}` },
          { ...(crudData as object || {}), updated_at: new Date().toISOString() })
        return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      if (crudMethod === 'delete') {
        if (!rule_id) return new Response(JSON.stringify({ error: 'rule_id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        await dbDelete('automation_rules', { id: `eq.${rule_id}`, tenant_id: `eq.${tid}` })
        return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      if (crudMethod === 'get_logs') {
        const logFilters: Record<string,string> = { tenant_id: `eq.${tid}` }
        if (rule_id) logFilters['rule_id'] = `eq.${String(rule_id)}`
        const logs = await dbGet('automation_logs',
          'id,rule_id,triggered_at,action_taken,message,status,read',
          logFilters, 'triggered_at.desc', 50)
        return new Response(JSON.stringify({ ok: true, logs }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      if (crudMethod === 'mark_read') {
        if (!rule_id) return new Response(JSON.stringify({ error: 'log_id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        await dbPatchWhere('automation_logs', { id: `eq.${rule_id}`, tenant_id: `eq.${tid}` }, { read: true })
        return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      if (crudMethod === 'unread_count') {
        const { count } = await dbGetPage('automation_logs', 'id', { tenant_id: `eq.${tid}`, read: 'eq.false' }, undefined, 0)
        return new Response(JSON.stringify({ ok: true, count }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ error: 'invalid method' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
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
    if (body.action === 'create_tenant') {
      if (!R.isMaster) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const { name, contact_name, contact_email } = body
      if (!name) return new Response(JSON.stringify({ error: 'name required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const row = await dbInsertReturning('tenants', { name, contact_name: contact_name||null, contact_email: contact_email||null, active: true })
      return new Response(JSON.stringify({ ok: true, tenant: row }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (body.action === 'update_tenant') {
      if (!R.isMaster) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
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
      if (!R.isMaster) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
      // The new user's role is `user_role`: `role` is the caller's own session role.
      // master is granted only through MASTER_EMAILS, never stored here.
      const tenant_id = body.tenant_id
      const email = String(body.email || '').trim().toLowerCase()   // login lookups are lower-case
      const userRole = String(body.user_role || 'member')
      if (!tenant_id || !email) return new Response(JSON.stringify({ error: 'tenant_id and email required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      if (!['admin', 'member'].includes(userRole)) return new Response(JSON.stringify({ error: 'user_role must be admin or member' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      await dbUpsert('tenant_users', { tenant_id, email, role: userRole }, 'email,tenant_id')
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
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

    // ── RAG: ingest document chunks ─────────────────────────────────
    if (body.action === 'kb_ingest') {
      const { kb_id, source_name, content: rawContent } = body
      if (!kb_id || !rawContent) return new Response(JSON.stringify({ error:'kb_id and content required' }), { status:400, headers:{...CORS,'Content-Type':'application/json'} })
      // Re-ingesting the same source replaces its chunks rather than duplicating them
      const r = await ingestText(String(kb_id), String(source_name || 'upload'), String(rawContent), R.tenantId)
      if (r.error) return new Response(JSON.stringify({ error: r.error }), { status:500, headers:{...CORS,'Content-Type':'application/json'} })
      return new Response(JSON.stringify({ ok:true, chunks: r.chunks, saved: r.saved, model: r.model, errors: r.errors }), { headers:{...CORS,'Content-Type':'application/json'} })
    }

    // ── Folder sync status / run now ─────────────────────────────────
    if (body.action === 'kb_sync') {
      const m = String(body.method || 'status')
      if (!SYNC_DIR) return new Response(JSON.stringify({ ok: true, enabled: false }), { headers:{...CORS,'Content-Type':'application/json'} })
      if (m === 'status') {
        const kbId = await syncKbId()
        const [kb] = await dbGet('knowledge_bases', 'id,name,synced_at,sync_attempted_at,sync_result', { id: `eq.${kbId}` }, undefined, 1)
        const { count } = await dbGetPage('kb_sync_files', 'path', { kb_id: `eq.${kbId}` }, undefined, 0)
        return new Response(JSON.stringify({
          ok: true, enabled: true, dir: SYNC_DIR, interval_days: SYNC_INTERVAL_DAYS, running: shared.kbSyncRunning,
          kb_id: kbId, kb_name: kb?.name, synced_at: kb?.synced_at ?? null, attempted_at: kb?.sync_attempted_at ?? null,
          result: kb?.sync_result ?? null, files: count,
        }), { headers:{...CORS,'Content-Type':'application/json'} })
      }
      if (m === 'run') {
        const r = await runKbSync()
        if (!r.ok) return new Response(JSON.stringify({ error: r.error }), { status: r.error === '同步正在进行中' ? 409 : 500, headers:{...CORS,'Content-Type':'application/json'} })
        return new Response(JSON.stringify({ ok: true, result: r.result, summary: summarize(r.result!) }), { headers:{...CORS,'Content-Type':'application/json'} })
      }
      return new Response(JSON.stringify({ error: 'unknown method' }), { status: 400, headers:{...CORS,'Content-Type':'application/json'} })
    }

    // ── RAG: semantic search ─────────────────────────────────────────
    if (body.action === 'kb_search') {
      const { kb_id, query, limit: kLimit } = body
      if (!kb_id || !query) return new Response(JSON.stringify({ error:'kb_id and query required' }), { status:400, headers:{...CORS,'Content-Type':'application/json'} })
      const providers = await loadProviders()
      // Pin query embedding to the KB's model so vectors are comparable
      const kbRows = await dbGet('knowledge_bases', 'embed_model', { id: `eq.${kb_id}` }) as {embed_model?:string}[]
      const er = await getEmbedding(String(query).slice(0, 500), providers, kbRows[0]?.embed_model || undefined)
      if (!er) return new Response(JSON.stringify({ error:'Embedding failed: no provider available' }), { status:500, headers:{...CORS,'Content-Type':'application/json'} })
      const n = Math.min(Number(kLimit)||5, 20)
      const rows = await dbRpc('kb_match', { query_embedding: er.vector, match_kb_id: kb_id, match_count: n })
      return new Response(JSON.stringify({ results: rows }), { headers:{...CORS,'Content-Type':'application/json'} })
    }

    // ── KB CRUD ──────────────────────────────────────────────────────
    if (body.action === 'list_kbs') {
      const rows = await dbGet('knowledge_bases','id,name,description,agent_id,created_at',tenantFilters(),'created_at.desc',50)
      return new Response(JSON.stringify({ kbs: rows }), { headers:{...CORS,'Content-Type':'application/json'} })
    }
    if (body.action === 'create_kb') {
      const { name, description, agent_id } = body
      if (!name) return new Response(JSON.stringify({ error:'name required' }), { status:400, headers:{...CORS,'Content-Type':'application/json'} })
      const row = await dbInsertReturning('knowledge_bases',{ name, description:description||'', agent_id:agent_id||null, tenant_id:R.tenantId })
      return new Response(JSON.stringify({ ok:true, kb: row }), { headers:{...CORS,'Content-Type':'application/json'} })
    }
    if (body.action === 'delete_kb') {
      const { kb_id } = body
      if (!kb_id) return new Response(JSON.stringify({ error:'kb_id required' }), { status:400, headers:{...CORS,'Content-Type':'application/json'} })
      const own = await dbGet('knowledge_bases','id',tenantFilters({ id: `eq.${kb_id}` }),undefined,1)
      if (!own.length) return new Response(JSON.stringify({ error:'not found' }), { status:404, headers:{...CORS,'Content-Type':'application/json'} })
      await dbDelete('kb_chunks', { kb_id: `eq.${kb_id}` })   // kb_chunks has no foreign key to cascade from
      await dbDelete('kb_sync_files', { kb_id: `eq.${kb_id}` })
      await dbDelete('knowledge_bases', { id: `eq.${kb_id}` })
      return new Response(JSON.stringify({ ok:true }), { headers:{...CORS,'Content-Type':'application/json'} })
    }
    if (body.action === 'count_kb_chunks') {
      const { kb_id } = body
      if (!kb_id) return new Response(JSON.stringify({ error:'kb_id required' }), { status:400, headers:{...CORS,'Content-Type':'application/json'} })
      const { count } = await dbGetPage('kb_chunks','id',{ kb_id:`eq.${kb_id}` },undefined,0)
      return new Response(JSON.stringify({ count }), { headers:{...CORS,'Content-Type':'application/json'} })
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
      shared.agents = null
      return new Response(JSON.stringify({ ok:true }), { headers:{...CORS,'Content-Type':'application/json'} })
    }

    // ── Workflow CRUD + runner ────────────────────────────────────────
    if (body.action === 'list_workflows') {
      const rows = await dbGet('workflows','id,name,description,active,created_at',tenantFilters(),'created_at.desc',50)
      return new Response(JSON.stringify({ workflows: rows }), { headers:{...CORS,'Content-Type':'application/json'} })
    }
    if (body.action === 'list_workflow_runs') {
      const { id: wfId } = body
      if (!wfId) return new Response(JSON.stringify({ error:'id required' }), { status:400, headers:{...CORS,'Content-Type':'application/json'} })
      const rows = await dbGet('workflow_runs','ran_at,response,error',{ workflow_id:`eq.${wfId}` },'ran_at.desc',10)
      return new Response(JSON.stringify({ runs: rows }), { headers:{...CORS,'Content-Type':'application/json'} })
    }
    if (body.action === 'save_workflow') {
      const { id: wfId, name, description, nodes, edges, schedule } = body
      if (!name) return new Response(JSON.stringify({ error:'name required' }), { status:400, headers:{...CORS,'Content-Type':'application/json'} })
      const data: Record<string,unknown> = { name, description:description||'', nodes:nodes||[], edges:edges||[], updated_at:new Date().toISOString() }
      if (schedule) { data.schedule = schedule; data.next_run = calcNextRun(schedule as string).toISOString() }
      else { data.schedule = null; data.next_run = null }
      if (wfId) { await dbPatch('workflows', wfId as string, data); return new Response(JSON.stringify({ ok:true, id:wfId }), { headers:{...CORS,'Content-Type':'application/json'} }) }
      const row = await dbInsertReturning('workflows',{ ...data, tenant_id:R.tenantId, active:true })
      return new Response(JSON.stringify({ ok:true, id:row.id }), { headers:{...CORS,'Content-Type':'application/json'} })
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
                await dbDelete('agent_skills', { id: `in.(${ids.join(',')})` })
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
                await dbDelete('user_prefs', { id: `in.(${ids.join(',')})` })
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
})
