// ── Channel Economics (CAC / ROAS / LTV:CAC) ───────────────────────────
let _cacSpend = {}   // { source: spendMYR } — persists across recomputes

function initCacPage() {
  loadChannelMetrics()
  loadCacBookings()
}

async function loadChannelMetrics() {
  const head = document.getElementById('cacHead')
  const body = document.getElementById('cacBody')
  if (!body) return
  const margin = +(document.getElementById('cacMargin')?.value) || 40
  const ltv    = +(document.getElementById('cacLtv')?.value)    || 0
  body.innerHTML = '<tr><td style="padding:30px;text-align:center;color:var(--ink-4)">计算中…</td></tr>'
  try {
    const r = await fetch(EDGE_URL, { method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+SUPABASE_ANON},
      body: JSON.stringify(orchBody({ action:'channel_metrics', margin_pct:margin, ltv_per_customer:ltv, spend_by_source:_cacSpend })) })
    const d = await r.json()
    if (!d.ok) throw new Error(d.error || '计算失败')
    const cols = ['渠道','Leads','成交','营收(RM)','花费(RM)','转化率','CAC','ROAS','LTV:CAC']
    head.innerHTML = `<tr>${cols.map(c=>`<th>${c}</th>`).join('')}</tr>`
    const fmtNum = v => v == null ? '<span style="color:var(--ink-5)">—</span>' : v
    const roasColor = v => v == null ? '' : (v >= 1 ? 'color:var(--green-ink);font-weight:600' : 'color:var(--rose);font-weight:600')
    const ltvColor  = v => v == null ? '' : (v >= 3 ? 'color:var(--green-ink);font-weight:600' : (v >= 1 ? 'color:var(--amber)' : 'color:var(--rose);font-weight:600'))
    const rowHtml = (c, isTotal) => `<tr style="${isTotal?'border-top:2px solid var(--border);font-weight:600;background:var(--bg-1)':''}">
      <td class="name" style="${isTotal?'font-weight:700':''}">${esc(c.source||'合计')}</td>
      <td>${c.leads}</td>
      <td>${c.customers}</td>
      <td class="num">RM ${(+c.value).toFixed(0)}</td>
      <td>${isTotal ? 'RM '+(+c.spend).toFixed(0) : `<input type="number" value="${c.spend||''}" placeholder="0" data-src="${esc(c.source)}" onchange="onCacSpendChange(this)" style="width:90px;background:var(--bg-1);border:1px solid var(--border);border-radius:5px;padding:4px 7px;font-size:12px;outline:none">`}</td>
      <td>${c.conversion_pct}%</td>
      <td>${fmtNum(c.cac!=null?'RM '+c.cac:null)}</td>
      <td style="${roasColor(c.roas)}">${fmtNum(c.roas!=null?c.roas+'x':null)}</td>
      <td style="${ltvColor(c.ltv_cac)}">${fmtNum(c.ltv_cac!=null?c.ltv_cac+':1':null)}</td>
    </tr>`
    body.innerHTML = (d.channels||[]).map(c=>rowHtml(c,false)).join('') + (d.channels?.length ? rowHtml(d.totals,true) : '')
      || '<tr><td style="padding:30px;text-align:center;color:var(--ink-4)">暂无数据</td></tr>'
  } catch(e) {
    body.innerHTML = `<tr><td style="padding:20px;color:var(--rose)">加载失败：${esc(e.message)}</td></tr>`
  }
}

function onCacSpendChange(input) {
  const src = input.dataset.src
  const val = +input.value || 0
  if (val > 0) _cacSpend[src] = val; else delete _cacSpend[src]
  loadChannelMetrics()
}

async function addBooking() {
  const source = document.getElementById('bkSource')?.value.trim()
  const amount = +(document.getElementById('bkAmount')?.value)
  const msg    = document.getElementById('bkMsg')
  if (!source) { msg.textContent = '请填写渠道来源'; msg.style.color = 'var(--rose)'; return }
  if (!amount || amount <= 0) { msg.textContent = '请填写有效成交金额'; msg.style.color = 'var(--rose)'; return }
  msg.textContent = '提交中…'; msg.style.color = 'var(--ink-3)'
  try {
    const r = await fetch(EDGE_URL, { method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+SUPABASE_ANON},
      body: JSON.stringify(orchBody({ action:'booking_crud', method:'create', data:{
        campaign_source: source,
        customer_name: document.getElementById('bkName')?.value.trim() || null,
        amount_myr: amount,
        service_type: document.getElementById('bkService')?.value.trim() || null,
      } })) })
    const d = await r.json()
    if (!d.ok) throw new Error(d.error || '添加失败')
    msg.textContent = '✅ 已添加'; msg.style.color = '#059669'
    document.getElementById('bkSource').value = ''
    document.getElementById('bkName').value = ''
    document.getElementById('bkAmount').value = ''
    document.getElementById('bkService').value = ''
    loadCacBookings(); loadChannelMetrics()
  } catch(e) { msg.textContent = '失败：'+e.message; msg.style.color = 'var(--rose)' }
}

async function loadCacBookings() {
  const el = document.getElementById('cacBookings')
  if (!el) return
  try {
    const r = await fetch(EDGE_URL, { method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+SUPABASE_ANON},
      body: JSON.stringify(orchBody({ action:'booking_crud', method:'list' })) })
    const d = await r.json()
    const rows = d.bookings || []
    if (!rows.length) { el.innerHTML = '<p style="color:var(--ink-4);font-size:12px;padding:12px">暂无成交记录</p>'; return }
    el.innerHTML = `<div style="background:var(--bg-0);border:1px solid var(--border);border-radius:var(--r-lg);overflow:hidden">` +
      rows.map((b,i)=>`<div style="display:flex;align-items:center;gap:12px;padding:11px 16px;${i<rows.length-1?'border-bottom:1px solid var(--bg-1)':''}">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:500;color:var(--ink-1)">${esc(b.customer_name||'(未具名)')} · <span style="color:var(--red)">${esc(b.campaign_source||'(未标注)')}</span></div>
          <div style="font-size:11px;color:var(--ink-4)">${esc(b.service_type||'')} ${fmtTime(b.booked_at)}</div>
        </div>
        <div style="font-size:14px;font-weight:700;color:var(--green-ink);font-family:monospace">RM ${(+b.amount_myr).toFixed(0)}</div>
        <button onclick="deleteBooking('${b.id}')" class="alr-del" title="删除">✕</button>
      </div>`).join('') + `</div>`
  } catch(e) { el.innerHTML = `<p style="color:var(--rose);font-size:12px;padding:12px">加载失败：${esc(e.message)}</p>` }
}

async function deleteBooking(id) {
  if (!confirm('确认删除这条成交记录？')) return
  await fetch(EDGE_URL, { method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+SUPABASE_ANON},
    body: JSON.stringify(orchBody({ action:'booking_crud', method:'delete', booking_id:id })) })
  loadCacBookings(); loadChannelMetrics()
}

// ── Home Overview ──────────────────────────────────────────────────────
async function renderHome() {
  const el = document.getElementById('homeContent')
  if (!el) return

  // Master view: per-tenant KPI cards
  if (_session.role === 'master') {
    el.innerHTML = '<div style="color:#4e6285;font-size:13px;padding:10px 0">加载客户汇总…</div>'
    try {
      const r = await fetch(EDGE_URL, { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(orchBody({ action: 'get_master_summary' })) })
      const d = await r.json()
      const summary = d.summary || []
      el.innerHTML = `
        <div><div class="home-section-title">本月各客户概览</div>
        <div class="home-metrics">
          ${summary.map(t => `
            <div class="metric-card" style="min-width:200px">
              <div class="mc-icon">🏢</div>
              <div class="mc-label">${esc(t.name)}</div>
              <div class="mc-value">RM ${(t.month_spend||0).toFixed(0)}</div>
              <div style="display:flex;gap:12px;margin-top:6px">
                <div><div class="mc-sub">线索</div><div style="font-size:13px;font-weight:600;color:#c8d3e8">${t.month_leads||0}</div></div>
                <div><div class="mc-sub">CPL</div><div style="font-size:13px;font-weight:600;color:${t.cpl&&t.cpl>80?'#f59e0b':'#c8d3e8'}">${t.cpl?'RM '+t.cpl:'—'}</div></div>
                <div><div class="mc-sub">预警</div><div style="font-size:13px;font-weight:600;color:${t.alerts>0?'#f59e0b':'#4e6285'}">${t.alerts}</div></div>
              </div>
            </div>`).join('')}
        </div></div>`
    } catch(e) {
      el.innerHTML = `<div style="color:#d11a13;font-size:13px">加载失败：${esc(e.message)}</div>`
    }
    return
  }

  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10)
  const todayStr = now.toISOString().slice(0,10)
  try {
    const [analRes, leadRes, alertRes, convRes, agentRes, gapsRes, skillsRes, todayConvRes] = await Promise.all([
      db.from('analytics_daily').select('spend_myr,results,new_contacts,campaign_name').gte('date', monthStart),
      db.from('leads').select('id,name,date,labels').gte('date', monthStart).order('date', {ascending:false}).limit(100),
      db.from('alerts').select('id,rule_name,campaign_name,metric,value,triggered_at').order('triggered_at', {ascending:false}).limit(10),
      db.from('conversations').select('id,role,content,agent,created_at').eq('role','user').order('created_at', {ascending:false}).limit(6),
      db.from('agents').select('id,name,active').eq('active', true),
      db.from('agent_suggestions').select('id').eq('handled', false).limit(100),
      db.from('agent_skills').select('id').limit(500),
      db.from('conversations').select('id').eq('role','user').gte('created_at', todayStr + 'T00:00:00'),
    ])
    const anal = analRes.data || []
    const leads = leadRes.data || []
    const alerts = alertRes.data || []
    const convs = convRes.data || []
    const activeAgents = agentRes.data || []
    const gaps = gapsRes.data || []
    const skills = skillsRes.data || []
    const todayConvs = todayConvRes.data || []
    let totalSpend = 0, totalContacts = 0, totalResults = 0
    const campaigns = new Set()
    for (const r of anal) {
      totalSpend += Number(r.spend_myr) || 0
      totalContacts += Number(r.new_contacts) || 0
      totalResults += Number(r.results) || 0
      if (r.campaign_name) campaigns.add(r.campaign_name)
    }
    const avgCPL = totalContacts > 0 ? (totalSpend / totalContacts) : null
    const monthLabel = now.toLocaleDateString('zh',{month:'long'})
    el.innerHTML = `
      <div>
        <div class="home-section-title">${monthLabel}指标（${monthStart.slice(5)} 至今）</div>
        <div class="home-metrics">
          <div class="metric-card">
            <div class="mc-icon">💰</div>
            <div class="mc-label">本月花费</div>
            <div class="mc-value">RM ${totalSpend.toFixed(0)}</div>
            <div class="mc-sub">广告总投放</div>
          </div>
          <div class="metric-card">
            <div class="mc-icon">👥</div>
            <div class="mc-label">本月线索</div>
            <div class="mc-value">${leads.length}</div>
            <div class="mc-sub">新增联系人</div>
          </div>
          <div class="metric-card ${avgCPL && avgCPL > 80 ? 'warn-card' : avgCPL && avgCPL < 40 ? 'good-card' : ''}">
            <div class="mc-icon">📊</div>
            <div class="mc-label">平均 CPL</div>
            <div class="mc-value">${avgCPL ? 'RM ' + avgCPL.toFixed(1) : '—'}</div>
            <div class="mc-sub">每条线索成本</div>
          </div>
          <div class="metric-card">
            <div class="mc-icon">🎯</div>
            <div class="mc-label">转化结果</div>
            <div class="mc-value">${totalResults}</div>
            <div class="mc-sub">本月总 Results</div>
          </div>
          <div class="metric-card">
            <div class="mc-icon">📢</div>
            <div class="mc-label">活跃系列</div>
            <div class="mc-value">${campaigns.size}</div>
            <div class="mc-sub">广告系列数</div>
          </div>
          <div class="metric-card ${alerts.length > 0 ? 'warn-card' : ''}">
            <div class="mc-icon">🔔</div>
            <div class="mc-label">预警记录</div>
            <div class="mc-value">${alerts.length}</div>
            <div class="mc-sub">近期触发</div>
          </div>
        </div>
      </div>
      <div>
        <div class="home-section-title">AI 系统状态</div>
        <div class="home-metrics">
          <div class="metric-card">
            <div class="mc-icon">💬</div>
            <div class="mc-label">今日对话</div>
            <div class="mc-value">${todayConvs.length}</div>
            <div class="mc-sub">用户消息数</div>
          </div>
          <div class="metric-card">
            <div class="mc-icon">🤖</div>
            <div class="mc-label">活跃 Agent</div>
            <div class="mc-value">${activeAgents.length}</div>
            <div class="mc-sub">${activeAgents.map(a => esc(a.name)).join(' · ').slice(0,40) || '—'}</div>
          </div>
          <div class="metric-card ${gaps.length > 10 ? 'warn-card' : ''}">
            <div class="mc-icon">❓</div>
            <div class="mc-label">未覆盖问题</div>
            <div class="mc-value">${gaps.length}</div>
            <div class="mc-sub" style="cursor:pointer;text-decoration:underline;color:#ffd405" onclick="nav('routing')">待学习 →</div>
          </div>
          <div class="metric-card">
            <div class="mc-icon">🧠</div>
            <div class="mc-label">已学技能</div>
            <div class="mc-value">${skills.length}</div>
            <div class="mc-sub" style="cursor:pointer;text-decoration:underline;color:#ffd405" onclick="nav('skills')">查看 →</div>
          </div>
        </div>
      </div>
      <div class="home-row">
        <div class="home-panel" style="flex:1.3">
          <div class="home-section-title">最近对话</div>
          ${convs.length ? convs.map(c => {
            const isHermes = !c.agent || c.agent === 'chat'
            return `
            <div style="padding:8px 0;border-bottom:1px solid #eee;display:flex;gap:10px;align-items:center">
              <span style="font-size:10px;background:${isHermes?'#f0f0f0':'#ffd405'};color:${isHermes?'#77787b':'#000'};border-radius:4px;padding:2px 6px;font-weight:700;white-space:nowrap;flex-shrink:0">${esc((c.agent||'chat').toUpperCase())}</span>
              <span style="font-size:12px;color:#555;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${esc((c.content||'').slice(0,55))}</span>
              <span style="font-size:10px;color:var(--ink-5);white-space:nowrap;flex-shrink:0">${fmtTime(c.created_at).split(' ')[1]||''}</span>
            </div>`}).join('') : '<div style="color:var(--ink-5);font-size:12px;padding:8px 0">暂无对话记录</div>'}
        </div>
        <div class="home-panel" style="flex:1">
          <div class="home-section-title">近期预警</div>
          ${alerts.length ? alerts.slice(0,6).map(a => `
            <div style="padding:7px 0;border-bottom:1px solid #eee">
              <div style="font-size:12px;color:#f59e0b;font-weight:600">${esc(a.rule_name||'')}</div>
              <div style="font-size:11px;color:var(--ink-4);margin-top:2px">${esc(a.campaign_name||'')} · ${esc(a.metric||'')} = ${Number(a.value).toFixed(2)}</div>
            </div>`).join('') : '<div style="color:var(--ink-5);font-size:12px;padding:8px 0">✓ 暂无预警</div>'}
        </div>
      </div>`
  } catch(e) {
    el.innerHTML = `<div style="color:#d11a13;font-size:13px">加载失败：${esc(e.message)}</div>`
  }
}

function shareLink() {
  const url = window.location.href
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => toast('🔗 链接已复制，可直接发给团队成员', 'success'))
  } else {
    prompt('复制此链接分享给团队成员：', url)
  }
}

// ── Apply session UI after login ──────────────────────────────────────
function applySessionUI() {
  // Show/hide master-only nav items
  document.querySelectorAll('.master-only').forEach(el => {
    el.style.display = _session.role === 'master' ? '' : 'none'
  })
  // Show tenant name in sidebar footer
  const tnEl = document.getElementById('tenantNameBadge')
  if (tnEl) tnEl.textContent = _session.tenant_name || (_session.role === 'master' ? '✦ Master' : '')
}

// ── 客户管理 (master only) ─────────────────────────────────────────────
async function loadTenantsPage() {
  const el = document.getElementById('tenantsContent')
  if (!el) return
  el.innerHTML = '<div style="color:#4e6285;font-size:13px;padding:20px 0">加载中…</div>'
  try {
    const r = await fetch(EDGE_URL, { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(orchBody({ action: 'list_tenants' })) })
    const d = await r.json()
    if (!d.ok) throw new Error(d.error || 'failed')
    const tenants = d.tenants || []
    el.innerHTML = `
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px">
        ${tenants.map(t => `
          <div style="background:var(--bg-0);border:1px solid var(--border);border-radius:var(--r-lg);padding:16px 18px;min-width:200px;flex:1;max-width:280px">
            <div style="font-size:14px;font-weight:700;color:var(--ink-1);margin-bottom:4px">${esc(t.name)}</div>
            <div style="font-size:11px;color:var(--ink-4);margin-bottom:10px">@${esc(t.slug)} · ${t.active ? '✅ 活跃' : '⏸ 停用'}</div>
            <div style="display:flex;gap:10px;flex-wrap:wrap">
              <div><div style="font-size:10px;color:var(--ink-3)">本月花费</div><div style="font-size:16px;font-weight:700;color:var(--ink-1)">RM ${(t.total_spend||0).toFixed(0)}</div></div>
              <div><div style="font-size:10px;color:var(--ink-3)">线索数</div><div style="font-size:16px;font-weight:700;color:var(--ink-1)">${t.lead_count||0}</div></div>
            </div>
            ${t.contact_email ? `<div style="font-size:11px;color:var(--ink-3);margin-top:8px">${esc(t.contact_name||'')} · ${esc(t.contact_email)}</div>` : ''}
            <div style="margin-top:10px;display:flex;gap:6px">
              <button onclick="toggleTenant('${esc(t.id)}',${!t.active})" style="font-size:11px;padding:4px 10px;border-radius:5px;border:1px solid var(--border);background:none;color:var(--ink-2);cursor:pointer">${t.active ? '停用' : '启用'}</button>
            </div>
          </div>`).join('')}
      </div>
      `
  } catch(e) {
    el.innerHTML = `<div style="color:#d11a13;font-size:13px">加载失败：${esc(e.message)}</div>`
  }
}


function switchAgentTab(tab, btn) {
  document.querySelectorAll('#atab-config,#atab-skills,#atab-gaps').forEach(b => b.classList.remove('active'))
  if (btn) btn.classList.add('active')
  else document.getElementById('atab-' + tab).classList.add('active')
  document.getElementById('agentConfigPanel').style.display = tab === 'config' ? 'flex' : 'none'
  document.getElementById('agentSkillsPanel').style.display = tab === 'skills' ? 'flex' : 'none'
  document.getElementById('agentGapsPanel').style.display   = tab === 'gaps'   ? 'flex' : 'none'
  if (tab === 'skills') {
    if (!pageLoaded['skills']) { pageLoaded['skills'] = true; loadSkillsPage() }
    else if (window._selectedSkillAgent) loadSkills(window._selectedSkillAgent)
  }
  if (tab === 'gaps') {
    if (!pageLoaded['gaps']) { pageLoaded['gaps'] = true; loadGapsPage() }
  }
  if (tab === 'review') {
    if (!pageLoaded['review']) { pageLoaded['review'] = true; loadDocs() }
  }
}

async function loadGapsPage() {
  const wrap = document.getElementById('gapsTableWrap')
  if (!wrap) return
  wrap.innerHTML = '<div style="color:var(--ink-3);font-size:13px;padding:20px 0">加载中…</div>'
  try {
    const { data, error } = await db.from('agent_suggestions')
      .select('id,message,session_id,asked_at,handled,tenant_id')
      .order('asked_at', { ascending: false })
      .limit(100)
    if (error) throw error
    if (!data || !data.length) {
      wrap.innerHTML = '<div style="color:var(--ink-3);font-size:13px;padding:20px 0;text-align:center">暂无缺口问题记录</div>'
      return
    }
    const rows = data.map(r => {
      const time = new Date(r.asked_at).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' })
      const sid = r.session_id ? r.session_id.slice(0, 8) : '—'
      const handled = r.handled
      return `<tr>
        <td style="max-width:420px;word-break:break-word">${esc(r.message)}</td>
        <td style="white-space:nowrap;color:var(--ink-3);font-size:12px">${time}</td>
        <td style="white-space:nowrap;color:var(--ink-5);font-size:11px;font-family:monospace">${sid}</td>
        <td style="text-align:center">
          <span class="alert-badge ${handled ? 'low' : 'med'}">${handled ? '已处理' : '待处理'}</span>
        </td>
        <td style="text-align:center;white-space:nowrap">
          ${!handled ? `<button class="sm-btn" style="background:#7c3aed;font-size:11px;padding:4px 10px" onclick="createAgentFromGap(this.dataset.msg,this.dataset.id)" data-msg="${esc(r.message)}" data-id="${r.id}">🤖 建 Agent</button>` : ''}
          ${!handled ? `<button class="sm-btn" style="background:#16a34a;font-size:11px;padding:4px 10px;margin-left:4px" onclick="markGapHandled('${r.id}',this)">标记处理</button>` : ''}
          <button class="sm-btn" style="background:#ef4444;font-size:11px;padding:4px 10px;margin-left:4px" onclick="deleteGap('${r.id}',this)">删除</button>
        </td>
      </tr>`
    }).join('')
    wrap.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="font-size:10px;color:var(--ink-5);text-transform:uppercase;letter-spacing:.05em">
        <th style="text-align:left;padding:0 10px 10px 0;font-weight:500">问题内容</th>
        <th style="text-align:left;padding:0 10px 10px;font-weight:500">时间</th>
        <th style="text-align:left;padding:0 10px 10px;font-weight:500">会话</th>
        <th style="text-align:center;padding:0 10px 10px;font-weight:500">状态</th>
        <th style="text-align:center;padding:0 0 10px 10px;font-weight:500">操作</th>
      </tr></thead>
      <tbody id="gapsTbody">${rows}</tbody>
    </table>`
  } catch(e) {
    wrap.innerHTML = `<div style="color:#d11a13;font-size:13px;padding:20px 0">加载失败：${esc(e.message)}</div>`
  }
}

async function markGapHandled(id, btn) {
  btn.disabled = true
  const { error } = await db.from('agent_suggestions').update({ handled: true }).eq('id', id)
  if (!error) {
    const row = btn.closest('tr')
    if (row) {
      const badge = row.querySelector('.alert-badge'); if (badge) { badge.className = 'alert-badge low'; badge.textContent = '已处理' }
      btn.remove()
    }
  } else { btn.disabled = false; alert('操作失败') }
}

async function deleteGap(id, btn) {
  btn.disabled = true
  const { error } = await db.from('agent_suggestions').delete().eq('id', id)
  if (!error) { const row = btn.closest('tr'); if (row) row.remove() }
  else { btn.disabled = false; alert('删除失败') }
}

// ── Create Agent From Gap ─────────────────────────────────────────────
let _caGapId = null

function closeCreateAgentModal() {
  document.getElementById('createAgentModalBg').classList.remove('open')
  _caGapId = null
}

async function createAgentFromGap(message, gapId) {
  _caGapId = gapId
  // populate gap message display
  const msgEl = document.getElementById('createAgentGapMsg')
  if (msgEl) msgEl.textContent = message
  // clear form
  ;['caId','caName','caDesc'].forEach(id => { const el = document.getElementById(id); if(el) el.value = '' })
  const promptEl = document.getElementById('caPrompt')
  if (promptEl) promptEl.value = ''
  // show modal
  document.getElementById('createAgentModalBg').classList.add('open')
  // show analyzing indicator
  const analyzeEl = document.getElementById('createAgentAnalyzing')
  if (analyzeEl) analyzeEl.style.display = 'block'
  const createBtn = document.getElementById('caCreateBtn')
  if (createBtn) createBtn.disabled = true

  // call Hermes to generate agent config via streaming
  const systemPrompt = `你是 Hermes，AI 系统的主控大脑。用户发来一个"缺口问题"——即当前没有专项 Agent 能处理的问题。你的任务是分析这个问题，然后设计一个新 Agent 来处理它。

请以 JSON 格式输出，字段如下（不要输出任何其他内容，只输出 JSON）：
{
  "id": "agent_id_lowercase_no_space",
  "name": "Agent 名称（中文）",
  "description": "一句话说明该 Agent 的职责",
  "system_prompt": "完整的 System Prompt，指导该 Agent 如何处理相关问题（用中文，100-300字）"
}

缺口问题：${message}`

  try {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON },
      body: JSON.stringify(orchBody({
        message: `请为以下缺口问题设计一个新 Agent，输出 JSON 配置：\n\n${message}`,
        stream: true,
        system_prompt_override: systemPrompt,
        target_agent: 'hermes'
      }))
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = '', fullText = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const raw = line.slice(5).trim()
        if (!raw || raw === '[DONE]') continue
        try {
          const d = JSON.parse(raw)
          if (d.chunk) fullText += d.chunk
        } catch(_) {}
      }
    }
    // extract JSON from response (may have markdown fences)
    let jsonStr = fullText
    const fenceMatch = fullText.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenceMatch) jsonStr = fenceMatch[1]
    else {
      const brace = fullText.indexOf('{')
      const lastBrace = fullText.lastIndexOf('}')
      if (brace !== -1 && lastBrace !== -1) jsonStr = fullText.slice(brace, lastBrace + 1)
    }
    let cfg = {}
    try { cfg = JSON.parse(jsonStr) } catch(_) { throw new Error('Hermes 返回格式有误，请手动填写') }
    // fill form
    const idEl = document.getElementById('caId')
    const nameEl = document.getElementById('caName')
    const descEl = document.getElementById('caDesc')
    const prmEl = document.getElementById('caPrompt')
    if (idEl)   idEl.value   = cfg.id          || ''
    if (nameEl) nameEl.value = cfg.name         || ''
    if (descEl) descEl.value = cfg.description  || ''
    if (prmEl)  prmEl.value  = cfg.system_prompt || ''
    toast('Hermes 已生成配置，请检查后确认创建', 'success')
  } catch(e) {
    toast('分析失败：' + e.message + '。请手动填写。', 'error')
  } finally {
    if (analyzeEl) analyzeEl.style.display = 'none'
    if (createBtn) createBtn.disabled = false
  }
}

async function confirmCreateAgent() {
  const id   = (document.getElementById('caId')?.value   || '').trim()
  const name = (document.getElementById('caName')?.value || '').trim()
  const desc = (document.getElementById('caDesc')?.value || '').trim()
  const prom = (document.getElementById('caPrompt')?.value || '').trim()
  if (!id)   { toast('请填写 Agent ID', 'error'); return }
  if (!name) { toast('请填写 Agent 名称', 'error'); return }
  if (!prom) { toast('请填写 System Prompt', 'error'); return }
  const btn = document.getElementById('caCreateBtn')
  if (btn) btn.disabled = true
  try {
    // insert agent
    const agentRow = { id, name, description: desc || null, system_prompt: prom, provider: 'anthropic', model: 'claude-opus-4-5', active: true }
    const { error: aErr } = await db.from('agents').upsert(agentRow)
    if (aErr) throw new Error(aErr.message)
    // mark gap handled
    if (_caGapId) {
      await db.from('agent_suggestions').update({ handled: true }).eq('id', _caGapId)
    }
    toast(`Agent "${name}" 创建成功！`, 'success')
    closeCreateAgentModal()
    // refresh gaps and agents pages
    pageLoaded['gaps'] = false
    loadGapsPage()
    pageLoaded['agents'] = false
    if (document.getElementById('page-agents')?.classList.contains('active')) loadAgents()
  } catch(e) {
    toast('创建失败：' + e.message, 'error')
    if (btn) btn.disabled = false
  }
}

async function triggerLearnGaps(btn) {
  btn.disabled = true
  const orig = btn.textContent
  btn.textContent = '分析中…'
  try {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON },
      body: JSON.stringify(orchBody({ action: 'learn_gaps' }))
    })
    const data = await res.json()
    if (data.error) throw new Error(data.error)
    toast(`处理 ${data.processed} 个问题，生成 ${data.skills_added} 条路由规则`, 'success')
    pageLoaded['gaps'] = false
    loadGapsPage()
    // Refresh skills if on that tab
    if (document.getElementById('atab-skills')?.classList.contains('active')) loadSkillsPage()
  } catch(e) {
    toast('分析失败：' + e.message, 'error')
  } finally {
    btn.disabled = false
    btn.textContent = orig
  }
}

function toggleCronHint() {
  const el = document.getElementById('cronHint')
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none'
}

function copyCronSql() {
  const sql = document.getElementById('cronSql')?.textContent || ''
  navigator.clipboard.writeText(sql).then(() => toast('已复制 SQL', 'success')).catch(() => toast('复制失败', 'error'))
}

function switchLogsTab(tab, btn) {
  document.querySelectorAll('#ltab-logs,#ltab-prefs').forEach(b => b.classList.remove('active'))
  if (btn) btn.classList.add('active')
  else document.getElementById('ltab-' + tab).classList.add('active')
  document.getElementById('logsMainPanel').style.display = tab === 'logs' ? 'flex' : 'none'
  document.getElementById('logsPrefsPanel').style.display = tab === 'prefs' ? 'flex' : 'none'
  if (tab === 'prefs' && typeof loadPrefs === 'function') loadPrefs()
}

// ── Sidebar dots ──────────────────────────────────────────────────────
async function loadSidebarDots() {
  try {
    const {data} = await db.from('provider_config').select('provider,active,model')
    ;(data||[]).forEach(r => {
      const dot = document.getElementById('dot-'+r.provider)
      if (dot) dot.className = 'dot' + (r.active ? ' on' : '')
      const mdl = document.getElementById('pvdm-'+r.provider)
      if (mdl) mdl.textContent = r.active && r.model ? r.model.split('/').pop() : ''
    })
  } catch {}
}
// ── Helpers ───────────────────────────────────────────────────────────
function esc(t) { return String(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleDateString('zh') + ' ' + d.toLocaleTimeString('zh',{hour:'2-digit',minute:'2-digit'})
}
