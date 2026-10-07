// Automation rules, notifications (Slack / Lark / WhatsApp / email), cron schedules,
// workflow runner and learning from knowledge gaps.
import { dbDelete, dbGet, dbInsert, dbPatch, dbPatchWhere } from './db.ts'
import { SOUL, callLLM, getDefaultProvider, loadAgentSkills, loadAgents, loadProviders } from './llm.ts'

// Timeout wrapper for a single LLM call inside a workflow step
export function withTimeout<T>(p: Promise<T>, ms = 20_000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`步骤超时 (${ms/1000}s)`)), ms))
  ])
}

// ── Slack webhook ─────────────────────────────────────────────────────
export async function sendSlackWebhook(webhookUrl: string, text: string, mrkdwn?: string) {
  const blocks = mrkdwn ? [{ type:'section', text:{ type:'mrkdwn', text: mrkdwn } }] : undefined
  const payload: Record<string,unknown> = { text }
  if (blocks) payload.blocks = blocks
  await fetch(webhookUrl, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload),
  })
}

// ── Lark helpers ────────────────────────────────────────────────────
export async function sendLarkWebhook(webhookUrl: string, title: string, bodyMd: string, fileUrl?: string) {
  const elements: unknown[] = [{ tag: 'div', text: { tag: 'lark_md', content: bodyMd } }]
  if (fileUrl) elements.push({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '查看文件' }, type: 'primary', url: fileUrl }] })
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg_type: 'interactive', card: { header: { title: { tag: 'plain_text', content: title }, template: 'red' }, elements } }),
  })
}

// ── Automation helpers ────────────────────────────────────────────
export type AutomationRule = Record<string, unknown>

export type TriggerResult  = { trigger: boolean; data: Record<string, unknown> }

export async function checkRuleTrigger(rule: AutomationRule): Promise<TriggerResult> {
  const cfg = (rule.trigger_config || {}) as Record<string, unknown>
  const tid = String(rule.tenant_id || 'default')

  if (rule.trigger_type === 'schedule') {
    const intervalHours = Number(cfg.interval_hours) || 24
    const lastRun = rule.last_run_at ? new Date(String(rule.last_run_at)) : null
    if (!lastRun) return { trigger: true, data: { reason: 'first_run' } }
    const elapsedH = (Date.now() - lastRun.getTime()) / 3600000
    return { trigger: elapsedH >= intervalHours, data: { elapsed_hours: +elapsedH.toFixed(1), interval_hours: intervalHours } }
  }

  if (rule.trigger_type === 'threshold') {
    const metric   = String(cfg.metric   || 'cpl')
    const operator = String(cfg.operator || 'gt')
    const value    = Number(cfg.value    || 0)
    const days     = Number(cfg.days     || 3)

    if (metric === 'cpl') {
      const dateFrom = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
      const rows = await dbGet('ad_reports', 'starts,amount_spent_myr,results',
        { tenant_id: `eq.${tid}`, starts: `gte.${dateFrom}` }, 'starts.asc', 500) as Record<string, number|string>[]
      const byDay: Record<string, { spend: number; results: number }> = {}
      for (const r of rows) {
        const day = String(r.starts || '').slice(0, 10)
        if (!byDay[day]) byDay[day] = { spend: 0, results: 0 }
        byDay[day].spend   += Number(r.amount_spent_myr) || 0
        byDay[day].results += Number(r.results) || 0
      }
      const entries = Object.values(byDay).slice(-days)
      const exceeded = entries.filter(d => {
        const cpl = d.results > 0 ? d.spend / d.results : 0
        return operator === 'gt' ? cpl > value : operator === 'lt' ? cpl < value : cpl === value
      })
      const totalCPL = entries.reduce((s, d) => s + (d.results > 0 ? d.spend / d.results : 0), 0)
      const avgCPL   = entries.length > 0 ? totalCPL / entries.length : 0
      return {
        trigger: exceeded.length >= days,
        data: { metric: 'cpl', avg_cpl: +avgCPL.toFixed(2), days_exceeded: exceeded.length, required_days: days, threshold: value },
      }
    }

    if (metric === 'spend') {
      const dateFrom = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
      const rows = await dbGet('ad_reports', 'amount_spent_myr',
        { tenant_id: `eq.${tid}`, starts: `gte.${dateFrom}` }, undefined, 500) as Record<string, number>[]
      const total   = rows.reduce((s, r) => s + (Number(r.amount_spent_myr) || 0), 0)
      const exceeded = operator === 'gt' ? total > value : operator === 'lt' ? total < value : total === value
      return { trigger: exceeded, data: { metric: 'spend', total_spend: +total.toFixed(2), threshold: value } }
    }
  }

  if (rule.trigger_type === 'event') {
    const event    = String(cfg.event || '')
    const hours    = Number(cfg.hours || 24)
    const minCount = Number(cfg.min_count || 1)

    if (event === 'uncontacted_leads') {
      const since = new Date(Date.now() - hours * 3600000).toISOString()
      // Leads created more than N hours ago (not the most recent window)
      const rows = await dbGet('leads', 'id,name,created_at',
        { tenant_id: `eq.${tid}`, created_at: `lte.${since}` },
        'created_at.desc', 50)
      return {
        trigger: (rows as unknown[]).length >= minCount,
        data: { event: 'uncontacted_leads', count: (rows as unknown[]).length, hours_threshold: hours },
      }
    }

    if (event === 'new_leads') {
      const since = String(rule.last_triggered_at || rule.last_run_at || new Date(Date.now() - 3600000).toISOString())
      const rows  = await dbGet('leads', 'id', { tenant_id: `eq.${tid}`, created_at: `gte.${since}` }, undefined, 100)
      return { trigger: (rows as unknown[]).length > 0, data: { event: 'new_leads', count: (rows as unknown[]).length } }
    }
  }

  // ── Anomaly: today's value vs 7-day average, trigger on % deviation ──
  if (rule.trigger_type === 'anomaly') {
    const metric       = String(cfg.metric        || 'cpl')
    const deviationPct = Number(cfg.deviation_pct || 50)
    const direction    = String(cfg.direction     || 'above')  // above|below|either

    const todayStr    = new Date().toISOString().slice(0, 10)
    const sevenAgoStr = new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 10) // 8d back to exclude today

    const cmpFn = (today: number, avg: number): boolean => {
      if (avg === 0) return false
      const pct = ((today - avg) / avg) * 100
      if (direction === 'above')  return pct > deviationPct
      if (direction === 'below')  return pct < -deviationPct
      return Math.abs(pct) > deviationPct
    }

    if (metric === 'cpl') {
      const rows = await dbGet('ad_reports', 'starts,amount_spent_myr,results',
        { tenant_id: `eq.${tid}`, starts: `gte.${sevenAgoStr}` }, 'starts.asc', 500) as Record<string, number|string>[]
      const byDay: Record<string, { spend: number; results: number }> = {}
      for (const r of rows) {
        const day = String(r.starts || '').slice(0, 10)
        if (!byDay[day]) byDay[day] = { spend: 0, results: 0 }
        byDay[day].spend   += Number(r.amount_spent_myr) || 0
        byDay[day].results += Number(r.results) || 0
      }
      const todayData   = byDay[todayStr] || { spend: 0, results: 0 }
      const todayCPL    = todayData.results > 0 ? todayData.spend / todayData.results : 0
      const pastDays    = Object.entries(byDay).filter(([d]) => d < todayStr)
      const pastCPLs    = pastDays.map(([, d]) => d.results > 0 ? d.spend / d.results : 0).filter(v => v > 0)
      const avgCPL      = pastCPLs.length > 0 ? pastCPLs.reduce((a, b) => a + b, 0) / pastCPLs.length : 0
      const devPct      = avgCPL > 0 ? ((todayCPL - avgCPL) / avgCPL) * 100 : 0
      return {
        trigger: cmpFn(todayCPL, avgCPL),
        data: { metric: 'cpl', today_cpl: +todayCPL.toFixed(2), avg_7d_cpl: +avgCPL.toFixed(2), deviation_pct: +devPct.toFixed(1), threshold_pct: deviationPct },
      }
    }

    if (metric === 'spend') {
      const rows = await dbGet('ad_reports', 'starts,amount_spent_myr',
        { tenant_id: `eq.${tid}`, starts: `gte.${sevenAgoStr}` }, undefined, 500) as Record<string, number|string>[]
      const byDay: Record<string, number> = {}
      for (const r of rows) {
        const day = String(r.starts || '').slice(0, 10)
        byDay[day] = (byDay[day] || 0) + (Number(r.amount_spent_myr) || 0)
      }
      const todaySpend = byDay[todayStr] || 0
      const pastSpends = Object.entries(byDay).filter(([d]) => d < todayStr).map(([, v]) => v)
      const avgSpend   = pastSpends.length > 0 ? pastSpends.reduce((a, b) => a + b, 0) / pastSpends.length : 0
      const devPct     = avgSpend > 0 ? ((todaySpend - avgSpend) / avgSpend) * 100 : 0
      return {
        trigger: cmpFn(todaySpend, avgSpend),
        data: { metric: 'spend', today_spend: +todaySpend.toFixed(2), avg_7d_spend: +avgSpend.toFixed(2), deviation_pct: +devPct.toFixed(1), threshold_pct: deviationPct },
      }
    }

    if (metric === 'leads') {
      const todayStart  = `${todayStr}T00:00:00.000Z`
      const todayEnd    = `${todayStr}T23:59:59.999Z`
      const weekAgoStr  = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
      const [todayRows, pastRows] = await Promise.all([
        dbGet('leads', 'id', { tenant_id: `eq.${tid}`, created_at: `gte.${todayStart}`, created_at2: `lte.${todayEnd}` }, undefined, 1000),
        dbGet('leads', 'id,created_at', { tenant_id: `eq.${tid}`, created_at: `gte.${weekAgoStr}T00:00:00.000Z`, created_at2: `lte.${todayStr}T00:00:00.000Z` }, undefined, 5000),
      ])
      const todayCount  = (todayRows as unknown[]).length
      const byDay: Record<string, number> = {}
      for (const r of pastRows as Record<string, string>[]) {
        const day = String(r.created_at || '').slice(0, 10)
        byDay[day] = (byDay[day] || 0) + 1
      }
      const pastCounts = Object.values(byDay)
      const avgCount   = pastCounts.length > 0 ? pastCounts.reduce((a, b) => a + b, 0) / pastCounts.length : 0
      const devPct     = avgCount > 0 ? ((todayCount - avgCount) / avgCount) * 100 : 0
      return {
        trigger: cmpFn(todayCount, avgCount),
        data: { metric: 'leads', today_count: todayCount, avg_7d_count: +avgCount.toFixed(1), deviation_pct: +devPct.toFixed(1), threshold_pct: deviationPct },
      }
    }
  }

  // ── Pattern: specific day_of_week vs 4-week baseline, trigger on that day ──
  if (rule.trigger_type === 'pattern') {
    const metric       = String(cfg.metric        || 'cpl')
    const dayOfWeek    = Number(cfg.day_of_week   ?? -1)  // 0=Sun … 6=Sat, -1=any
    const thresholdPct = Number(cfg.threshold_pct || 30)
    const direction    = String(cfg.direction     || 'above')

    const todayDOW = new Date().getDay()  // 0=Sun … 6=Sat
    // Only trigger on the specified day (if day_of_week is set)
    if (dayOfWeek >= 0 && todayDOW !== dayOfWeek) {
      return { trigger: false, data: { reason: 'not_target_day', today_dow: todayDOW, target_dow: dayOfWeek } }
    }

    const days28Ago = new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10)
    const todayStr  = new Date().toISOString().slice(0, 10)

    if (metric === 'cpl' || metric === 'spend') {
      const col  = metric === 'cpl' ? 'starts,amount_spent_myr,results' : 'starts,amount_spent_myr'
      const rows = await dbGet('ad_reports', col,
        { tenant_id: `eq.${tid}`, starts: `gte.${days28Ago}` }, 'starts.asc', 2000) as Record<string, number|string>[]
      const byDay: Record<string, { spend: number; results: number }> = {}
      for (const r of rows) {
        const day = String(r.starts || '').slice(0, 10)
        if (!byDay[day]) byDay[day] = { spend: 0, results: 0 }
        byDay[day].spend   += Number(r.amount_spent_myr) || 0
        byDay[day].results += Number(r.results)          || 0
      }
      const getVal = (d: { spend: number; results: number }) =>
        metric === 'spend' ? d.spend : (d.results > 0 ? d.spend / d.results : 0)

      const targetDayVals: number[] = []
      const allVals: number[] = []
      for (const [day, d] of Object.entries(byDay)) {
        if (day >= todayStr) continue
        const v = getVal(d); if (v === 0) continue
        allVals.push(v)
        const dow = new Date(day).getDay()
        if (dayOfWeek < 0 || dow === dayOfWeek) targetDayVals.push(v)
      }
      const targetAvg = targetDayVals.length > 0 ? targetDayVals.reduce((a, b) => a + b, 0) / targetDayVals.length : 0
      const overallAvg = allVals.length > 0 ? allVals.reduce((a, b) => a + b, 0) / allVals.length : 0
      const devPct     = overallAvg > 0 ? ((targetAvg - overallAvg) / overallAvg) * 100 : 0
      const triggered  = overallAvg > 0 && (
        direction === 'above'  ? devPct > thresholdPct  :
        direction === 'below'  ? devPct < -thresholdPct :
        Math.abs(devPct) > thresholdPct
      )
      return {
        trigger: triggered,
        data: { metric, day_of_week: dayOfWeek, target_day_avg: +targetAvg.toFixed(2), overall_avg: +overallAvg.toFixed(2), deviation_pct: +devPct.toFixed(1), threshold_pct: thresholdPct, samples: targetDayVals.length },
      }
    }

    if (metric === 'leads') {
      const rows = await dbGet('leads', 'created_at',
        { tenant_id: `eq.${tid}`, created_at: `gte.${days28Ago}T00:00:00.000Z` }, undefined, 5000) as Record<string, string>[]
      const byDay: Record<string, number> = {}
      for (const r of rows) {
        const day = String(r.created_at || '').slice(0, 10)
        byDay[day] = (byDay[day] || 0) + 1
      }
      const targetDayVals: number[] = []
      const allVals: number[] = []
      for (const [day, count] of Object.entries(byDay)) {
        if (day >= todayStr) continue
        allVals.push(count)
        const dow = new Date(day).getDay()
        if (dayOfWeek < 0 || dow === dayOfWeek) targetDayVals.push(count)
      }
      const targetAvg  = targetDayVals.length > 0 ? targetDayVals.reduce((a, b) => a + b, 0) / targetDayVals.length : 0
      const overallAvg = allVals.length > 0 ? allVals.reduce((a, b) => a + b, 0) / allVals.length : 0
      const devPct     = overallAvg > 0 ? ((targetAvg - overallAvg) / overallAvg) * 100 : 0
      const triggered  = overallAvg > 0 && (
        direction === 'above'  ? devPct > thresholdPct  :
        direction === 'below'  ? devPct < -thresholdPct :
        Math.abs(devPct) > thresholdPct
      )
      return {
        trigger: triggered,
        data: { metric: 'leads', day_of_week: dayOfWeek, target_day_avg: +targetAvg.toFixed(1), overall_avg: +overallAvg.toFixed(1), deviation_pct: +devPct.toFixed(1), threshold_pct: thresholdPct, samples: targetDayVals.length },
      }
    }
  }

  return { trigger: false, data: {} }
}

export function buildActionMessage(rule: AutomationRule, data: Record<string, unknown>): string {
  const cfg      = (rule.action_config || {}) as Record<string, unknown>
  const template = String(cfg.template || '')
  if (template) {
    return template
      .replace(/{date}/g,  new Date().toLocaleDateString('zh-CN'))
      .replace(/{cpl}/g,   String(data.avg_cpl   || ''))
      .replace(/{count}/g, String(data.count      || ''))
      .replace(/{value}/g, String(data.threshold  || cfg.value || ''))
      .replace(/{days}/g,  String(data.days_exceeded || data.days || ''))
      .replace(/{spend}/g, String(data.total_spend || ''))
  }
  // Default messages
  if (rule.trigger_type === 'threshold' && data.metric === 'cpl') {
    return `⚠️ CPL告警 — ${rule.name}\n\n过去 ${data.required_days || ''} 天 CPL 平均：MYR ${data.avg_cpl}\n已连续 ${data.days_exceeded || ''} 天超过目标 MYR ${data.threshold}。\n\n建议检查广告创意和受众设置。`
  }
  if (rule.trigger_type === 'event' && data.event === 'uncontacted_leads') {
    return `📋 跟进提醒 — ${rule.name}\n\n有 ${data.count} 条线索超过 ${data.hours_threshold} 小时未跟进。\n请尽快安排跟进，避免客户流失。`
  }
  if (rule.trigger_type === 'schedule') {
    return `📊 定时报告 — ${rule.name}\n已于 ${new Date().toLocaleString('zh-CN')} 触发执行。`
  }
  if (rule.trigger_type === 'anomaly') {
    const metric = String(data.metric || '')
    if (metric === 'cpl')   return `🚨 CPL 异常 — ${rule.name}\n今日 CPL：MYR ${data.today_cpl}，较过去7天均值 MYR ${data.avg_7d_cpl} 偏差 ${data.deviation_pct}%。\n建议立即检查广告成效。`
    if (metric === 'spend') return `🚨 花费异常 — ${rule.name}\n今日花费：MYR ${data.today_spend}，较过去7天均值 MYR ${data.avg_7d_spend} 偏差 ${data.deviation_pct}%。\n建议检查预算设置。`
    if (metric === 'leads') return `🚨 线索量异常 — ${rule.name}\n今日线索：${data.today_count} 条，较过去7天均值 ${data.avg_7d_count} 偏差 ${data.deviation_pct}%。\n建议检查广告投放状态。`
  }
  if (rule.trigger_type === 'pattern') {
    const DOW_ZH = ['周日','周一','周二','周三','周四','周五','周六']
    const dow    = Number(data.day_of_week ?? -1)
    const dowStr = dow >= 0 ? DOW_ZH[dow] : '今天'
    const metric = String(data.metric || '')
    if (metric === 'cpl')   return `📈 CPL 周期规律 — ${rule.name}\n${dowStr} CPL 均值 MYR ${data.target_day_avg}，较整体均值 MYR ${data.overall_avg} 偏高 ${data.deviation_pct}%（基于 ${data.samples} 周数据）。`
    if (metric === 'spend') return `📈 花费周期规律 — ${rule.name}\n${dowStr} 花费均值 MYR ${data.target_day_avg}，较整体均值 MYR ${data.overall_avg} 偏差 ${data.deviation_pct}%（基于 ${data.samples} 周数据）。`
    if (metric === 'leads') return `📈 线索量周期规律 — ${rule.name}\n${dowStr} 平均 ${data.target_day_avg} 条，较整体均值 ${data.overall_avg} 偏差 ${data.deviation_pct}%（基于 ${data.samples} 周数据）。`
  }
  return `🔔 ${rule.name} 已触发（${rule.trigger_type}）`
}

// ── Notification helper ───────────────────────────────────────────
export async function sendNotification(channel: string, message: string, recipient?: string): Promise<void> {
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

// \u2500\u2500 Workflow scheduler \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// schedule format: standard 5-field cron (MIN HOUR DOM MON DOW) or legacy daily:/weekly:/hourly/interval:
export function matchCronField(field: string, value: number): boolean {
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

export function nextCronRun(expr: string, from: Date): Date {
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

export function calcNextRun(schedule: string, from = new Date()): Date {
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

export async function learnFromGaps(): Promise<{ ok: boolean; skills_added: number; processed: number }> {
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
    dbPatchWhere('agent_suggestions', { id: `in.(${ids.join(',')})` }, { handled: true }),
  ])

  return { ok: true, skills_added: rules.length, processed: rows.length }
}

export async function runWorkflows() {
  // Find all active workflows due to run
  const due = await dbGet('workflows', '*', { active: 'eq.true', next_run: `lte.${new Date().toISOString()}` }) as Record<string, unknown>[]
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
                await dbDelete('agent_skills', { id: `in.(${ids.join(',')})` })
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
                await dbDelete('user_prefs', { id: `in.(${ids.join(',')})` })
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
    await dbPatch('workflows', String(wfId), { last_run: new Date().toISOString(), next_run: nextRun.toISOString(), run_count: Number(wf.run_count || 0) + 1 })
  }
}
