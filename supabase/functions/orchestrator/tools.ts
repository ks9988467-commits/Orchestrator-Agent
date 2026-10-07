// Tool definitions the agents can call, and their execution.
import { sendNotification } from './automation.ts'
import { dbGet, dbInsert, dbPatchWhere, dbRpc, dbUpsert } from './db.ts'
import { DATA_AGENTS, SOUL, callLLM, getEmbedding, loadAgentSkills, loadHistory, loadKbContext, loadProviders } from './llm.ts'
import { R, tenantFilters } from './state.ts'

// ── Tool definitions ─────────────────────────────────────────────────
export const TOOL_DEFS = [
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
  {
    name: 'create_automation',
    description: '帮用户建立自动化规则。当用户描述重复性痛点、希望自动监控某指标或事件时调用。建立后向用户确认触发条件和动作详情。',
    parameters: {
      type: 'object',
      properties: {
        name:           { type: 'string', description: '规则名称，简短描述（如：CPL超标告警）' },
        description:    { type: 'string', description: '规则描述（可选）' },
        trigger_type:   { type: 'string', enum: ['schedule','threshold','event','anomaly','pattern'], description: 'schedule=定时执行; threshold=指标超标触发; event=事件触发; anomaly=异常检测(今日vs7天均值); pattern=周期规律检测' },
        trigger_config: { type: 'object', description: '触发配置。schedule: {"interval_hours":24}; threshold: {"metric":"cpl","operator":"gt","value":15,"days":3}; event: {"event":"uncontacted_leads","hours":24,"min_count":1}; anomaly: {"metric":"cpl|spend|leads","deviation_pct":50,"direction":"above|below|either"}; pattern: {"metric":"cpl|spend|leads","day_of_week":1,"threshold_pct":30,"direction":"above|below|either"}' },
        action_type:    { type: 'string', enum: ['dashboard_alert','chat_message','whatsapp_push'], description: 'dashboard_alert=Dashboard显示预警; chat_message=在对话中推送消息; whatsapp_push=WhatsApp推送' },
        action_config:  { type: 'object', description: '动作配置。template: 消息模板（支持 {value},{count},{date},{cpl},{days} 占位符）; recipient: WhatsApp号码（whatsapp_push时必填）' },
      },
      required: ['name', 'trigger_type', 'trigger_config', 'action_type', 'action_config'],
    },
  },
  {
    name: 'list_automations',
    description: '列出当前用户的所有自动化规则，包括启用状态和最后触发时间。',
    parameters: {
      type: 'object',
      properties: {
        enabled_only: { type: 'boolean', description: '只显示已启用的规则（默认显示全部）' },
      },
      required: [],
    },
  },
  {
    name: 'toggle_automation',
    description: '启用或停用一条自动化规则。',
    parameters: {
      type: 'object',
      properties: {
        rule_id: { type: 'string', description: '规则 ID（UUID）' },
        enabled: { type: 'boolean', description: 'true = 启用，false = 停用' },
      },
      required: ['rule_id', 'enabled'],
    },
  },
  {
    name: 'respond_directly',
    description: 'Use ONLY for pure greetings ("你好", "hi"), meta questions about yourself ("你是谁", "你能做什么"), or truly off-topic messages. NEVER use for any business queries — those must always go through delegate_to_agent.',
    parameters: {
      type: 'object',
      properties: {
        response: { type: 'string', description: '直接回复的文本内容' },
      },
      required: ['response'],
    },
  },
]

// \u2500\u2500 Tool executor \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
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
      R.delegated = true
      const targetId     = String(args.agent_id || '').toLowerCase().trim()
      const originalQuery = String(args.query   || '')
      const target       = R.agents.find(a => a.id === targetId && a.active)
      if (!target) return JSON.stringify({ error: `Agent '${targetId}' not found or inactive. Available: ${R.agents.filter(a=>a.active&&a.id!=='chat').map(a=>a.id).join(', ')}` })
      R.delegatedId   = target.id
      R.delegatedName = target.name || target.id
      // Load session history + sub-agent skills + KB context in parallel
      const [history, subSkills, subKbCtx] = await Promise.all([
        R.sessionId ? loadHistory(R.sessionId, 10) : Promise.resolve([]),
        loadAgentSkills(target.id),
        loadKbContext(),
      ])
      // Build augmented query: if previous delegations have context, pass it along
      const query = R.delegationContext
        ? `[参考——前步骤已收集信息]\n${R.delegationContext}\n\n---\n当前任务：${originalQuery}`
        : originalQuery
      // Hermes context injected into sub-agent system prompt
      const hermesCtx = `\n\n**[系统上下文]** 你是被 Hermes 调度系统委派的专项 Agent。当前用户问题：${originalQuery}\n请结合对话历史，给出专业回答。`
      const sys      = (target.system_prompt || 'You are a helpful assistant.') + hermesCtx + '\n\n' + SOUL + subSkills + subKbCtx
      const useTools = DATA_AGENTS.has(target.id) || !!target.uses_tools
      R.hermesMode = false  // sub-agents get full tool access
      const messages = [...history, { role: 'user', content: query }]
      const { text } = await callLLM(R.providers, target.provider || R.defaultProvider, target.model, sys, messages, useTools)
      // Accumulate result for subsequent delegations (first 300 chars summary)
      const summary = text.slice(0, 300).replace(/\n+/g, ' ')
      R.delegationContext += (R.delegationContext ? '\n' : '') + `[${target.name || targetId}]: ${summary}`
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
      const SIM_THRESHOLD = 0.45   // drop chunks below this cosine similarity (irrelevant)
      const providers = await loadProviders()
      const kbFilters = tenantFilters()
      if (args.kb_id) kbFilters['id'] = `eq.${args.kb_id}`
      const kbs = await dbGet('knowledge_bases', 'id,name,embed_model', kbFilters, undefined, 10) as Record<string,string>[]
      if (!kbs.length) return JSON.stringify({ results: [], message: '尚未建立知识库，请先在知识库页面录入文档。' })
      // Embed the query PER KB using that KB's recorded model family, so query and
      // chunk vectors are always in the same space. Cache by family to avoid re-embedding.
      const embedCache: Record<string, number[] | null> = {}
      const allResults: Array<Record<string,unknown>> = []
      for (const kb of kbs.slice(0, 5)) {
        const fam = kb.embed_model || ''   // '' = let getEmbedding pick default order
        if (!(fam in embedCache)) {
          const e = await getEmbedding(query, providers, fam || undefined)
          embedCache[fam] = e ? e.vector : null
        }
        const qEmbed = embedCache[fam]
        if (!qEmbed) continue
        const rows = await dbRpc('kb_match', { query_embedding: qEmbed, match_kb_id: kb.id, match_count: limit })
        for (const row of rows as Record<string,unknown>[]) {
          allResults.push({ ...row, kb_name: kb.name })
        }
      }
      if (!Object.values(embedCache).some(Boolean)) return JSON.stringify({ error: '知识库搜索需要 Embedding API。请在 LLM Providers 中配置 OpenAI、Google 或 OpenRouter key。' })
      // Filter by relevance threshold, then sort + top N
      const relevant = allResults.filter(r => ((r.similarity as number) || 0) >= SIM_THRESHOLD)
      relevant.sort((a, b) => ((b.similarity as number) || 0) - ((a.similarity as number) || 0))
      const top = relevant.slice(0, limit)
      if (!top.length) return JSON.stringify({ results: [], message: '知识库中未找到与该问题相关的内容（相似度均低于阈值）。' })
      return JSON.stringify({
        results: top.map(r => ({
          kb:         r.kb_name,
          source:     r.source_name,
          content:    r.content,
          similarity: +((r.similarity as number) * 100).toFixed(1),
        }))
      })
    }

    if (name === 'create_automation') {
      const tid = R.tenantId || 'default'
      await dbInsert('automation_rules', {
        tenant_id:      tid,
        name:           String(args.name || ''),
        description:    String(args.description || ''),
        trigger_type:   String(args.trigger_type || 'schedule'),
        trigger_config: args.trigger_config || {},
        action_type:    String(args.action_type || 'dashboard_alert'),
        action_config:  args.action_config || {},
        created_by:     'agent',
        enabled:        true,
      })
      return JSON.stringify({ ok: true, message: `规则「${args.name}」已建立并启用。触发方式：${args.trigger_type}，动作：${args.action_type}` })
    }

    if (name === 'list_automations') {
      const filters = tenantFilters()
      if (args.enabled_only) filters['enabled'] = 'eq.true'
      const rules = await dbGet('automation_rules',
        'id,name,description,trigger_type,trigger_config,action_type,enabled,last_triggered_at,created_at',
        filters, 'created_at.desc', 20)
      return JSON.stringify({ count: (rules as unknown[]).length, rules })
    }

    if (name === 'toggle_automation') {
      const ruleId = String(args.rule_id || '')
      if (!ruleId) return JSON.stringify({ error: 'rule_id required' })
      const tid = R.tenantId || 'default'
      await dbPatchWhere('automation_rules', { id: `eq.${ruleId}`, tenant_id: `eq.${tid}` },
        { enabled: Boolean(args.enabled), updated_at: new Date().toISOString() })
      return JSON.stringify({ ok: true, message: `规则已${args.enabled ? '启用' : '停用'}` })
    }

    if (name === 'respond_directly') {
      // Special sentinel: callAnthropic checks for this prefix to break the tool loop early
      return `__RESPOND_DIRECTLY__${String(args.response || '')}`
    }

    return JSON.stringify({ error: `Unknown tool: ${name}` })
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message })
  }
}

// \u2500\u2500 LLM callers with Tool Use \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Tools available to Hermes (router-only): cannot use sub-agent tools directly
export const HERMES_TOOL_NAMES = new Set(['delegate_to_agent', 'remember', 'learn_gaps', 'learn',
  'create_automation', 'list_automations', 'toggle_automation', 'respond_directly'])

export function getActiveTools() {
  const all = TOOL_DEFS
  return R.hermesMode ? all.filter(t => HERMES_TOOL_NAMES.has(t.name)) : all
}
