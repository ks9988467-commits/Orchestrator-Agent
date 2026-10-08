// Automation and workflow actions (dashboard CRUD and the scheduler entry points).
import { type AutomationRule, buildActionMessage, calcNextRun, checkRuleTrigger, learnFromGaps, runWorkflows, sendNotification } from '../automation.ts'
import { dbDelete, dbGet, dbGetPage, dbInsert, dbInsertReturning, dbPatch, dbPatchWhere } from '../db.ts'
import { SOUL, callLLM, getDefaultProvider, loadAgentSkills, loadAgents, loadProviders } from '../llm.ts'
import { type Body, R, tenantFilters } from '../state.ts'

// Returns the response for one of this module's actions, or undefined for any other action
export async function handleWorkflowActions(body: Body, CORS: Record<string, string>): Promise<Response | undefined> {
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
    const context: Record<string,unknown> = { input: wfInput || {} }
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
}
