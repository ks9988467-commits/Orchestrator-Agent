// Configuration actions: LLM providers, API integrations, agents, skills, gaps, logs, UGC rules, connection tests.
import { learnFromGaps, sendLarkWebhook } from '../automation.ts'
import { dbDelete, dbGet, dbGetPage, dbInsert, dbPatch, dbPatchWhere, dbUpsert } from '../db.ts'
import { callAnthropic, callGoogle, callLLM, callOpenAI, callOpenRouter, getDefaultProvider, listModels, loadAgents, loadProviders } from '../llm.ts'
import { type AgentRow, type Body, type ProviderRow, R, shared, tenantFilters } from '../state.ts'

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

// Returns the response for one of this module's actions, or undefined for any other action
export async function handleConfigActions(body: Body, CORS: Record<string, string>): Promise<Response | undefined> {
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

  // \u2500\u2500 Learn from feedback action \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  if (body.action === 'learn_gaps') {
    try {
      const result = await learnFromGaps()
      return new Response(JSON.stringify(result), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    } catch(e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
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
}
