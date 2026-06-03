// ── Lock Screen ───────────────────────────────────────────────────────
const LOCK_PWD = 'orchestrator2024'
const LOCK_KEY = 'oa_unlocked'
const LOCK_TTL = 24 * 60 * 60 * 1000
;(function(){
  try {
    const s = localStorage.getItem(LOCK_KEY)
    if (s && Date.now() < JSON.parse(s).exp) {
      document.getElementById('lockScreen').classList.add('hidden')
    }
  } catch {}
})()
function checkLock() {
  const v = document.getElementById('lockInput').value
  if (v === LOCK_PWD) {
    localStorage.setItem(LOCK_KEY, JSON.stringify({ exp: Date.now() + LOCK_TTL }))
    document.getElementById('lockScreen').classList.add('hidden')
    document.getElementById('lockInput').value = ''
    document.getElementById('lockErr').textContent = ''
  } else {
    document.getElementById('lockErr').textContent = '密码错误，请重试'
    document.getElementById('lockInput').value = ''
    document.getElementById('lockInput').focus()
  }
}
function showOtpView() {
  document.getElementById('lockPwdView').style.display = 'none'
  document.getElementById('lockOtpView').style.display = 'block'
}
function showPwdView() {
  document.getElementById('lockOtpView').style.display = 'none'
  document.getElementById('lockPwdView').style.display = 'block'
}
async function sendOtp() {
  const email = document.getElementById('lockEmailInput').value.trim()
  const errEl = document.getElementById('lockOtpErr')
  if (!email) { errEl.textContent = '请输入邮箱'; return }
  errEl.textContent = '发送中…'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const r = await fetch(EDGE_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'send_otp', email }), signal: ctrl.signal })
    clearTimeout(timer)
    const d = await r.json()
    if (d.ok) {
      document.getElementById('lockOtpStep1').style.display = 'none'
      document.getElementById('lockOtpStep2').style.display = 'block'
    } else { errEl.textContent = d.error || '发送失败' }
  } catch(e) { clearTimeout(timer); errEl.textContent = e.name === 'AbortError' ? '请求超时，请重试' : '网络错误，请重试' }
}
async function verifyOtp() {
  const email = document.getElementById('lockEmailInput').value.trim()
  const code  = document.getElementById('lockCodeInput').value.trim()
  const errEl = document.getElementById('lockCodeErr')
  if (!code) { errEl.textContent = '请输入验证码'; return }
  errEl.textContent = '验证中…'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const r = await fetch(EDGE_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'verify_otp', email, code }), signal: ctrl.signal })
    clearTimeout(timer)
    const d = await r.json()
    if (d.ok) {
      localStorage.setItem(LOCK_KEY, JSON.stringify({ exp: Date.now() + LOCK_TTL }))
      _session = { tenant_id: d.tenant_id || null, role: d.role || 'member', tenant_name: d.tenant_name || '', email: d.email || email || '' }
      localStorage.setItem('_orch_session', JSON.stringify(_session))
      document.getElementById('lockScreen').classList.add('hidden')
      applySessionUI()
    } else { errEl.textContent = d.error || '验证码错误' }
  } catch(e) { clearTimeout(timer); errEl.textContent = e.name === 'AbortError' ? '请求超时，请重试' : '网络错误，请重试' }
}
// ─────────────────────────────────────────────────────────────────────

const SUPABASE_URL  = 'https://ontumerafhimxvqtsijr.supabase.co'
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9udHVtZXJhZmhpbXh2cXRzaWpyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwNDA3MzksImV4cCI6MjA5MjYxNjczOX0.wkUyEzOd-9y1hOTg1ZMRE908IvzsT2O4qvDT_vg1UcI'
const EDGE_URL      = `${SUPABASE_URL}/functions/v1/orchestrator`
const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON)
const AGENT_ICONS   = {chat:'💬', crm:'🤝', account:'📊', code:'💻', cpl:'💰', cpr:'🎯', frequency:'🔁', marketing:'📣'}
const PROVIDER_LABELS = {anthropic:'Anthropic · Claude', openai:'OpenAI · GPT', google:'Google · Gemini'}

let sessionId = crypto.randomUUID()

// ── Tenant session (populated after OTP login) ─────────────────────
let _session = { tenant_id: null, role: 'member', tenant_name: '', email: '' }
;(function() {
  try {
    const s = localStorage.getItem('_orch_session')
    if (s) _session = JSON.parse(s)
  } catch {}
})()
function orchBody(extra) {
  const base = {}
  if (_session.tenant_id) base.tenant_id = _session.tenant_id
  if (_session.role)      base.role       = _session.role
  return Object.assign(base, extra)
}

/**
 * 通用 API 请求封装
 */
async function apiCall(action, payload = {}, options = {}) {
  const body = orchBody({ action, ...payload });
  const ctrl = new AbortController();
  const timeout = options.timeout || 30000;
  const timer = setTimeout(() => ctrl.abort(), timeout);

  try {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    clearTimeout(timer);

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }

    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('请求超时，请重试');
    if (e.message === 'Failed to fetch') throw new Error('网络错误，请检查连接后重试');
    throw e;
  }
}

function newSession() {
  sessionId = crypto.randomUUID()
  document.getElementById('sessionInfo').textContent = 'Session: ' + sessionId.slice(0,8)
  document.getElementById('messages').innerHTML = `
    <div class="msg ai"><div class="msg-meta"><span class="agent-tag hermes">ORCHESTRATOR</span></div><div class="md">新对话已开始。</div></div>`
}

// ── Page nav ──────────────────────────────────────────────────────────
const _pageCache = {}
const CACHE_TTL = 2 * 60 * 1000 // 2 分钟缓存
const pageLoaded = {}

function toggleSidebar() {
  document.getElementById('sidebar')?.classList.toggle('open')
  document.getElementById('sidebarOverlay')?.classList.toggle('open')
}
function closeSidebar() {
  document.getElementById('sidebar')?.classList.remove('open')
  document.getElementById('sidebarOverlay')?.classList.remove('open')
}

function showPage(id, btn) {
  closeSidebar()  // close mobile drawer on navigation
  // Skills are embedded inside Agents page — redirect to agents + switch tab
  if (id === 'skills') {
    const agentsBtn = document.querySelector('.nav-item[onclick*="agents"]')
    showPage('agents', agentsBtn || btn)
    switchAgentTab('skills', null)
    if (btn && agentsBtn && btn !== agentsBtn) btn.classList.remove('active')
    return
  }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'))
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'))
  document.getElementById(id+'Page').classList.add('active')
  btn.classList.add('active')
  // Pages that always re-fetch on navigation
  const alwaysReload = new Set(['logs','data','agents','llm','notes','usage','tasks','staff','review','agtask','kb'])
  if (alwaysReload.has(id)) pageLoaded[id] = false
  if (!pageLoaded[id]) { pageLoaded[id] = true; loadPage(id) }
  // Auto-refresh logs every 30s; stop when leaving
  if (_logsRefreshTimer) { clearInterval(_logsRefreshTimer); _logsRefreshTimer = null }
  if (id === 'logs') _logsRefreshTimer = setInterval(loadLogs, 30000)
}
function loadPage(id) {
  if (id === 'home')      renderHome()
  if (id === 'tenants')   loadTenantsPage()
  if (id === 'agents')    loadAgents()
  if (id === 'llm')       loadLLM()
  if (id === 'api')       loadIntegrations()
  if (id === 'logs')      { initLogsAgentFilter(); loadLogs() }
  if (id === 'data')      initDataPage()
  if (id === 'workflows') loadWorkflowsPage()
  if (id === 'notes')     loadNotesPage()
  if (id === 'usage')     loadUsagePage()
  if (id === 'skills')    loadSkillsPage()
  if (id === 'workflow')  loadWorkflowPage()
  if (id === 'agtask')   loadAgentTasksPage()
  if (id === 'tasks')     loadTasks()
  if (id === 'staff')     loadStaffPage()
  if (id === 'msg')       loadMsgPage()
  if (id === 'review')    loadDocs()
  if (id === 'ugc')       initUGCPage()
  if (id === 'kb')        loadKbPage()
  if (id === 'cac')       initCacPage()
}

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

// ── Chat ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('sessionInfo').textContent = 'Session: ' + sessionId.slice(0,8)
  loadSidebarDots()
  applySessionUI()
  document.getElementById('inputBox').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg() }
  })
  // Badge: load on init + refresh every 2 min
  setTimeout(loadAlertBadge, 3000)
  setInterval(loadAlertBadge, 120000)
})

function addMsg(role, text, agent='', provider='') {
  const box = document.getElementById('messages')
  const isAtBottom = box.scrollHeight - box.scrollTop <= box.clientHeight + 100
  const div = document.createElement('div')
  div.className = 'msg ' + (role === 'user' ? 'user' : 'ai')
  if (role !== 'user') {
    const md = typeof marked !== 'undefined' ? marked.parse(text) : esc(text)
    div.innerHTML = `<div class="msg-meta"><span class="agent-tag${(!agent || agent==='orchestrator'||agent==='chat') ? ' hermes' : ''}">${agent ? esc(agent).toUpperCase() : 'AI'}</span></div><div class="md">${md}</div>`
  } else {
    div.textContent = text
  }
  box.appendChild(div)
  if (isAtBottom) box.scrollTop = box.scrollHeight
  return div
}

// ── Streaming helpers ────────────────────────────────────────────────
function createStreamBubble() {
  const box = document.getElementById('messages')
  const isAtBottom = box.scrollHeight - box.scrollTop <= box.clientHeight + 100
  const div = document.createElement('div')
  div.className = 'msg ai'
  div.innerHTML = `<div class="msg-meta"><span class="agent-tag hermes">AI</span></div><div class="md"></div><span class="stream-cursor">▌</span>`
  box.appendChild(div)
  if (isAtBottom) box.scrollTop = box.scrollHeight
  return div
}
function updateStreamBubble(div, text, agentName, agentId) {
  const md = typeof marked !== 'undefined' ? marked.parse(text) : esc(text)
  if (agentName || agentId) {
    const m = div.querySelector('.msg-meta')
    if (m) {
      const name = (agentName || agentId).toUpperCase()
      const isHermes = !agentId || agentId === 'chat'
      m.innerHTML = `<span class="agent-tag${isHermes ? ' hermes' : ''}">${esc(name)}</span>`
    }
  }
  const mdEl = div.querySelector('.md'); if (mdEl) mdEl.innerHTML = md

  const box = document.getElementById('messages')
  const isAtBottom = box.scrollHeight - box.scrollTop <= box.clientHeight + 150
  if (isAtBottom) box.scrollTop = box.scrollHeight
}
function finalizeStreamBubble(div, convId, agentName, agentId) {
  const cursor = div.querySelector('.stream-cursor')
  if (cursor) cursor.remove()
  if (agentName || agentId) {
    const m = div.querySelector('.msg-meta')
    if (m) { const name=(agentName||agentId).toUpperCase(); const isHermes=!agentId||agentId==='chat'; m.innerHTML=`<span class="agent-tag${isHermes?' hermes':''}">${esc(name)}</span>` }
  }
  if (convId) {
    const fb = document.createElement('div')
    fb.className = 'chat-fb'
    const goodBtn = document.createElement('button')
    goodBtn.className = 'fb-btn good'
    goodBtn.textContent = '👍'
    goodBtn.dataset.convId = String(convId)
    goodBtn.addEventListener('click', function() { submitFeedback(this.dataset.convId, 'good', this) })
    const badBtn = document.createElement('button')
    badBtn.className = 'fb-btn bad'
    badBtn.textContent = '👎'
    badBtn.dataset.convId = String(convId)
    badBtn.addEventListener('click', function() { submitFeedback(this.dataset.convId, 'bad', this) })
    fb.appendChild(goodBtn)
    fb.appendChild(badBtn)
    div.appendChild(fb)
  }
}

let _chatFiles = []
function onChatFile(input) {
  const newFiles = Array.from(input.files); if (!newFiles.length) return
  // Deduplicate by name+size
  newFiles.forEach(function(f) {
    if (!_chatFiles.find(function(x){ return x.name===f.name && x.size===f.size })) _chatFiles.push(f)
  })
  _renderAttachStrip()
  input.value = ''
}
function _renderAttachStrip() {
  const strip = document.getElementById('attachStrip')
  const nameEl = document.getElementById('attachName')
  if (!strip || !nameEl) return
  if (!_chatFiles.length) { strip.style.display = 'none'; nameEl.innerHTML = ''; return }
  strip.style.display = 'flex'
  if (_chatFiles.length === 1) {
    nameEl.textContent = _chatFiles[0].name + ' (' + (_chatFiles[0].size/1024).toFixed(0) + ' KB)'
  } else {
    nameEl.innerHTML = _chatFiles.length + ' 个文件：' + _chatFiles.map(function(f){ return '<b>'+esc(f.name)+'</b>' }).join('、')
  }
}
function removeChatFile(idx) {
  _chatFiles.splice(idx, 1)
  _renderAttachStrip()
}
function clearChatAttach() {
  _chatFiles = []
  const strip = document.getElementById('attachStrip')
  const nameEl = document.getElementById('attachName')
  if (strip) strip.style.display = 'none'
  if (nameEl) nameEl.textContent = ''
}

async function sendMsg() {
  const box = document.getElementById('inputBox')
  const msg = box.value.trim()
  const filesToSend = _chatFiles.slice()
  if (!msg && !filesToSend.length) return
  box.value = ''
  box.style.height = 'auto'
  clearChatAttach()
  const fileLabel = filesToSend.length === 1 ? '📎 ' + filesToSend[0].name
                  : filesToSend.length > 1   ? '📎 ' + filesToSend.length + ' 个文件：' + filesToSend.map(f=>f.name).join('、')
                  : ''
  addMsg('user', msg ? (fileLabel ? msg + '\n' + fileLabel : msg) : fileLabel)
  const btn = document.getElementById('sendBtn')
  btn.disabled = true
  const bubble = createStreamBubble()

  // Upload all files in parallel
  let uploadedFiles = []
  if (filesToSend.length > 0) {
    updateStreamBubble(bubble, filesToSend.length > 1 ? '正在上传 ' + filesToSend.length + ' 个文件…' : '正在上传文件…', null)
    try {
      const extMap = { pdf:'pdf', doc:'word', docx:'word', xls:'excel', xlsx:'excel', csv:'excel', jpg:'image', jpeg:'image', png:'image', gif:'image', webp:'image' }
      uploadedFiles = await Promise.all(filesToSend.map(async function(f) {
        const fname = Date.now() + '_' + Math.random().toString(36).slice(2,6) + '_' + f.name.replace(/[^a-zA-Z0-9._-]/g, '_')
        const up = await fetch(SUPABASE_URL + '/storage/v1/object/review-files/' + fname, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + SUPABASE_ANON, 'Content-Type': f.type || 'application/octet-stream', 'x-upsert': 'false' },
          body: f,
        })
        if (!up.ok) throw new Error('上传失败 ' + f.name + ': ' + up.status)
        const ext = (f.name.split('.').pop()||'').toLowerCase()
        return { url: SUPABASE_URL + '/storage/v1/object/public/review-files/' + fname, name: f.name, type: extMap[ext] || 'pdf' }
      }))
    } catch(e) {
      updateStreamBubble(bubble, '⚠️ ' + e.message, null)
      const cur = bubble.querySelector('.stream-cursor'); if (cur) cur.remove()
      btn.disabled = false; return
    }
  }

  try {
    // Extract text from non-image files so Agent can read the content
    let extractedContext = ''
    for (const f of filesToSend) {
      const ext = (f.name.split('.').pop()||'').toLowerCase()
      try {
        if (ext === 'txt') {
          const t = await f.text()
          extractedContext += `\n\n[文件内容: ${f.name}]\n${t.slice(0,12000)}`
        } else if (ext === 'pdf' && typeof pdfjsLib !== 'undefined') {
          pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
          const buf = await f.arrayBuffer()
          const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
          let pdfText = ''
          for (let i = 1; i <= Math.min(pdf.numPages, 20); i++) {
            const page = await pdf.getPage(i)
            const ct   = await page.getTextContent()
            pdfText += ct.items.map(it => it.str).join(' ') + '\n'
          }
          extractedContext += `\n\n[PDF内容: ${f.name}（${pdf.numPages}页）]\n${pdfText.slice(0,12000)}`
        } else if ((ext === 'docx' || ext === 'doc') && typeof mammoth !== 'undefined') {
          const buf = await f.arrayBuffer()
          const res = await mammoth.extractRawText({ arrayBuffer: buf })
          extractedContext += `\n\n[Word文档内容: ${f.name}]\n${res.value.slice(0,12000)}`
        } else if ((ext === 'xlsx' || ext === 'xls' || ext === 'csv') && typeof XLSX !== 'undefined') {
          let sheetText = ''
          if (ext === 'csv') {
            sheetText = (await f.text()).slice(0, 8000)
          } else {
            const buf = await f.arrayBuffer()
            const wb  = XLSX.read(new Uint8Array(buf), { type:'array' })
            const ws  = wb.Sheets[wb.SheetNames[0]]
            sheetText = XLSX.utils.sheet_to_csv(ws).slice(0, 8000)
          }
          extractedContext += `\n\n[表格内容: ${f.name}]\n${sheetText}`
        }
      } catch(parseErr) {
        extractedContext += `\n\n[${f.name} 解析失败: ${parseErr.message}]`
      }
    }

    // Single file → use legacy file_url path (review workflow + data extraction)
    // Multiple files → use files[] path (joint analysis)
    const submitter = _msgMyId ? (_msgStaff.find(function(s){return s.id===_msgMyId})?.name||'chat') : 'chat'
    let filePayload = {}
    if (uploadedFiles.length === 1) {
      filePayload = { file_url: uploadedFiles[0].url, file_name: uploadedFiles[0].name, file_type: uploadedFiles[0].type,
                      submitted_by: submitter, submitted_by_staff_id: _msgMyId||undefined }
    } else if (uploadedFiles.length > 1) {
      filePayload = { files: uploadedFiles }
    }
    const defaultMsg = uploadedFiles.length === 1 ? '请分析这份文件：' + uploadedFiles[0].name
                     : uploadedFiles.length > 1   ? '请分析以下 ' + uploadedFiles.length + ' 个文件'
                     : ''
    const finalMsg = (msg || defaultMsg) + extractedContext
    const payload = orchBody(Object.assign({ message: finalMsg, session_id: sessionId, stream: true }, filePayload))
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON },
      body: JSON.stringify(payload)
    })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    const reader  = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = '', fullText = ''
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n'); buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim(); if (!raw) continue
          try {
            const evt = JSON.parse(raw)
            if (evt.chunk !== undefined) {
              fullText += evt.chunk
              updateStreamBubble(bubble, fullText, null)
            } else if (evt.done) {
              sessionId = evt.session_id || sessionId
              document.getElementById('sessionInfo').textContent = 'Session: ' + sessionId.slice(0,8)
              const displayName = evt.delegated_agent_name || evt.agent_name || evt.agent
              const displayId   = evt.delegated_agent   || evt.agent
              updateStreamBubble(bubble, fullText, displayName, displayId)
              finalizeStreamBubble(bubble, evt.conversation_id, displayName, displayId)
              if (evt.web_searched) {
                const meta = bubble.querySelector('.msg-meta')
                if (meta) { const tag = document.createElement('span'); tag.className = 'agent-tag'; tag.style.cssText = 'background:#f0f9ff;color:#0369a1;border:1px solid #bae6fd;font-size:10px'; tag.textContent = '🔍 已搜索'; meta.appendChild(tag) }
              }
            } else if (evt.error) {
              updateStreamBubble(bubble, '⚠️ ' + evt.error, null)
            }
          } catch { /* skip malformed */ }
        }
      }
    } finally {
      const cursor = bubble.querySelector('.stream-cursor')
      if (cursor) cursor.remove()
    }
  } catch(e) {
    updateStreamBubble(bubble, '⚠️ 连接失败：' + e.message, null)
    const cursor = bubble.querySelector('.stream-cursor'); if (cursor) cursor.remove()
  }
  btn.disabled = false
  box.focus()
}

// ── Agents ────────────────────────────────────────────────────────────
async function loadAgents() {
  try {
    const {data:agents} = await db.from('agents').select('*').order('id')

    _agentsMap = {}
    ;(agents||[]).forEach(a => _agentsMap[a.id] = a)
    const list = document.getElementById('agentList')
    list.innerHTML = (agents||[]).map(a => `
      <div class="agent-list-item" id="ali-${esc(a.id)}" onclick="selectAgentById('${esc(a.id)}')">
        <span class="ali-dot${a.active?' on':''}"></span>
        <span class="ali-name">${esc(a.name)}</span>
        <span class="ali-pvd">${esc(a.provider||'—')}</span>
      </div>`).join('')
    if (_currentAgentId) {
      const cur = (agents||[]).find(a => a.id === _currentAgentId)
      if (cur) { selectAgent(cur); highlightListItem(cur.id) }
    }
  } catch(e) {
    document.getElementById('agentList').innerHTML = `<p style="color:#d11a13;font-size:12px;padding:8px">加载失败</p>`
  }
}

let _currentAgentId = null
let _aeTestConvId = null
let _agentsMap = {}

function highlightListItem(id) {
  document.querySelectorAll('.agent-list-item').forEach(el => el.classList.remove('active'))
  const el = document.getElementById('ali-'+id)
  if (el) el.classList.add('active')
}

function selectAgentById(id) {
  const agent = _agentsMap[id]
  if (agent) selectAgent(agent)
}

function selectAgent(agent) {
  if (typeof agent === 'string') agent = JSON.parse(agent)
  _currentAgentId = agent.id
  _aeTestConvId = null
  highlightListItem(agent.id)
  const editor = document.getElementById('agentEditor')
  const icon = AGENT_ICONS[agent.id] || '🤖'
  editor.innerHTML = `
    <div class="ae-top">
      <div class="ae-icon">${icon}</div>
      <h3>${esc(agent.name)}</h3>
      <div class="ae-toggle">
        <span>${agent.active ? '已启用' : '已停用'}</span>
        <label class="ts-wrap" title="启用/停用">
          <input type="checkbox" id="aeActive" ${agent.active?'checked':''} onchange="aeToggleActive()">
          <span class="ts-slider"></span>
        </label>
      </div>
      <div class="ae-toggle" style="margin-left:12px" title="允许该 Agent 调用数据查询工具（CRM/财务/分析等）">
        <span style="font-size:11px;color:var(--ink-4)">数据工具</span>
        <label class="ts-wrap">
          <input type="checkbox" id="aeUseTools" ${agent.uses_tools?'checked':''}>
          <span class="ts-slider"></span>
        </label>
      </div>
    </div>
    <div class="ae-body">
      <input type="hidden" id="aeId" value="${esc(agent.id)}">
      <div class="ae-field">
        <label>Agent 名称</label>
        <input type="text" id="aeName" value="${esc(agent.name||'')}" placeholder="Chat Agent">
      </div>
      <div class="ae-field">
        <label>描述</label>
        <input type="text" id="aeDesc" value="${esc(agent.description||'')}" placeholder="简短说明职责">
      </div>
      <div class="ae-row">
        <div class="ae-field">
          <label>Provider</label>
          <select id="aeProvider" onchange="aeProviderChanged()">
            <option value="">（全局默认）</option>
            <option value="anthropic"${agent.provider==='anthropic'?' selected':''}>Anthropic</option>
            <option value="openai"${agent.provider==='openai'?' selected':''}>OpenAI</option>
            <option value="google"${agent.provider==='google'?' selected':''}>Google</option>
            <option value="openrouter"${agent.provider==='openrouter'?' selected':''}>🔀 OpenRouter</option>
          </select>
        </div>
        <div class="ae-field">
          <label>Model</label>
          <select id="aeModel">
            <option value="${esc(agent.model||'')}" selected>${esc(agent.model) || '（Provider 默认）'}</option>
          </select>
        </div>
      </div>
      <div class="ae-field">
        <div class="ae-prompt-label">
          <span>System Prompt</span>
          <span class="ae-char" id="aeChar">0 字</span>
        </div>
        <div class="ae-prompt-wrap">
          <textarea id="aePrompt" rows="9" oninput="aeUpdateChar()" placeholder="You are a helpful assistant…">${esc(agent.system_prompt||'')}</textarea>
        </div>
      </div>
    </div>
    <div class="ae-test-section">
      <div class="ae-test-hd">── 测试对话</div>
      <div class="ae-test-msgs" id="aeTestMsgs"></div>
      <div class="ae-test-bar">
        <input type="text" id="aeTestInput" placeholder="输入测试消息…" onkeydown="if(event.key==='Enter')aeTestSend()">
        <button class="btn-primary" style="padding:8px 14px;font-size:12px;white-space:nowrap" onclick="aeTestSend()">发送</button>
      </div>
    </div>
    <div class="ae-footer">
      <button class="btn-danger" onclick="deleteAgent()">删除</button>
      <div style="display:flex;align-items:center;gap:10px">
        <button class="btn-secondary" style="font-size:12px;padding:7px 12px" onclick="showAgentVersions('${esc(agent.id)}')">📜 版本历史</button>
        <span class="ae-save-msg" id="aeSaveMsg"></span>
        <button class="btn-primary" onclick="saveAgent()">保存更改</button>
      </div>
    </div>`
  aeUpdateChar()
}

function aeUpdateChar() {
  const ta = document.getElementById('aePrompt')
  const el = document.getElementById('aeChar')
  if (ta && el) el.textContent = ta.value.length + ' 字'
}

async function aeToggleActive() {
  const chk = document.getElementById('aeActive')
  const lbl = chk?.closest('.ae-toggle')?.querySelector('span')
  if (lbl) lbl.textContent = chk.checked ? '已启用' : '已停用'
  const id = document.getElementById('aeId')?.value
  if (id) {
    await db.from('agents').update({active: chk.checked, updated_at: new Date().toISOString()}).eq('id', id)
    const dot = document.querySelector(`#ali-${id} .ali-dot`)
    if (dot) { dot.classList.toggle('on', chk.checked) }
  }
}

async function aeProviderChanged(preselect) {
  const provider = document.getElementById('aeProvider')?.value
  const modelSel = document.getElementById('aeModel')
  if (!modelSel) return
  if (!provider) { modelSel.innerHTML = '<option value="">（Provider 默认）</option>'; return }
  modelSel.innerHTML = '<option value="" disabled selected>获取中…</option>'
  try {
    const r = await fetch(EDGE_URL, { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'list_models', provider }) })
    const { models } = await r.json()
    modelSel.innerHTML = '<option value="">（Provider 默认）</option>' +
      (models||[]).map(m => `<option value="${esc(m)}"${m===preselect?' selected':''}>${esc(m)}</option>`).join('')
  } catch { modelSel.innerHTML = '<option value="" disabled selected>加载失败</option>' }
}

async function aeTestSend() {
  const input = document.getElementById('aeTestInput')
  const msgs = document.getElementById('aeTestMsgs')
  const msg = input?.value.trim()
  if (!msg || !msgs) return
  input.value = ''
  const agentId = document.getElementById('aeId')?.value
  const appendTestMsg = (role, text, html) => {
    const d = document.createElement('div')
    d.className = `ae-tmsg ${role}`
    if (html) d.innerHTML = html
    else d.textContent = text
    msgs.appendChild(d)
    msgs.scrollTop = msgs.scrollHeight
    return d
  }
  appendTestMsg('user', msg)
  // Streaming bubble for AI response
  const bubble = document.createElement('div')
  bubble.className = 'ae-tmsg ai'
  bubble.innerHTML = '<span class="stream-cursor">▌</span>'
  msgs.appendChild(bubble)
  msgs.scrollTop = msgs.scrollHeight
  try {
    const r = await fetch(EDGE_URL, { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+SUPABASE_ANON},
      body: JSON.stringify(orchBody({ message: msg, session_id: _aeTestConvId, target_agent: agentId, system_prompt_override: document.getElementById('aePrompt')?.value || undefined, stream: true })) })
    if (!r.ok || !r.body) {
      const data = await r.json().catch(() => ({}))
      _aeTestConvId = data.session_id || _aeTestConvId
      const text = data.response || data.error || '无响应'
      const md = typeof marked !== 'undefined' ? marked.parse(text) : esc(text)
      bubble.innerHTML = md
      return
    }
    const reader = r.body.getReader()
    const decoder = new TextDecoder()
    let buf = '', fullText = ''
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n'); buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim(); if (!raw) continue
          try {
            const evt = JSON.parse(raw)
            if (evt.chunk !== undefined) {
              fullText += evt.chunk
              const md = typeof marked !== 'undefined' ? marked.parse(fullText) : esc(fullText)
              bubble.innerHTML = md + '<span class="stream-cursor">▌</span>'
              msgs.scrollTop = msgs.scrollHeight
            } else if (evt.done) {
              _aeTestConvId = evt.session_id || _aeTestConvId
              const md = typeof marked !== 'undefined' ? marked.parse(fullText) : esc(fullText)
              const agentLabel = evt.delegated_agent_name || evt.agent_name || evt.agent || ''
              bubble.innerHTML = md + (agentLabel ? `<div style="font-size:11px;color:var(--ink-4);margin-top:6px;border-top:1px solid #eee;padding-top:4px">↳ ${esc(agentLabel)}</div>` : '')
            } else if (evt.error) {
              bubble.innerHTML = esc('⚠️ ' + evt.error)
            }
          } catch { /* skip malformed */ }
        }
      }
    } finally {
      const cursor = bubble.querySelector('.stream-cursor')
      if (cursor) cursor.remove()
    }
  } catch(e) {
    bubble.textContent = '请求失败：' + e.message
    const cursor = bubble.querySelector('.stream-cursor')
    if (cursor) cursor.remove()
  }
}

async function saveAgent() {
  const id = document.getElementById('aeId')?.value
  if (!id) return
  const data = {
    name:          document.getElementById('aeName')?.value.trim(),
    description:   document.getElementById('aeDesc')?.value.trim(),
    system_prompt: document.getElementById('aePrompt')?.value.trim(),
    provider:      document.getElementById('aeProvider')?.value || null,
    model:         document.getElementById('aeModel')?.value || null,
    active:        document.getElementById('aeActive')?.checked ?? true,
    uses_tools:    document.getElementById('aeUseTools')?.checked ?? false,
    updated_at:    new Date().toISOString(),
  }
  const msg = document.getElementById('aeSaveMsg')
  msg.textContent = '保存中…'; msg.className = 'ae-save-msg'
  const {error} = await db.from('agents').update(data).eq('id', id)
  if (error) { msg.className = 'ae-save-msg err'; msg.textContent = error.message; return }
  // Auto-save version history
  fetch(EDGE_URL, { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'save_agent_version', agent_id:id, system_prompt:data.system_prompt, provider:data.provider, model:data.model, note:'Auto-saved on edit' })
  }).catch(()=>{})
  msg.className = 'ae-save-msg ok'; msg.textContent = '✓ 已保存'
  delete _pageCache['agents']
  const li = document.getElementById('ali-'+id)
  if (li) {
    li.querySelector('.ali-name').textContent = data.name
    li.querySelector('.ali-pvd').textContent = data.provider || '—'
  }
  if (_agentsMap[id]) {
    _agentsMap[id] = { ..._agentsMap[id], ...data }
  }
  setTimeout(() => { if (msg) msg.textContent = '' }, 3000)
}

async function deleteAgent() {
  const id = document.getElementById('aeId')?.value
  const name = document.getElementById('aeName')?.value
  if (!id) return
  if (!confirm(`确定删除 Agent「${name}」？此操作不可撤销。`)) return
  const { error } = await db.from('agents').delete().eq('id', id)
  if (error) { alert('删除失败：' + error.message); return }
  _currentAgentId = null
  document.getElementById('agentEditor').innerHTML = '<div class="ae-placeholder">← 选择一个 Agent 开始编辑</div>'
  delete _pageCache['agents']
  loadAgents()
}

async function newAgent() {
  const id = 'agent_' + Date.now()
  const {error} = await db.from('agents').insert({
    id, name: '新 Agent', description: '', system_prompt: '', active: true,
  })
  if (error) { alert('创建失败：' + error.message); return }
  delete _pageCache['agents']
  _currentAgentId = id
  await loadAgents()
  const newLi = document.getElementById('ali-' + id)
  if (newLi) newLi.click()
}

// ── Data page ─────────────────────────────────────────────────────────
let _dataTab = 'leads'
const DATA_PAGE_SIZE = 50
let _anData = []
let _anCharts = {}
const AN_BENCHMARKS = { cpl: 20, ctr: 1.5 } // Malaysia Facebook avg 2024

async function initDataPage() {
  // Load account list
  const sel = document.getElementById('accountSelector')
  try {
    const { data } = await db.from('accounts').select('id,name').eq('active', true).order('name')
    if (data && data.length > 1) {
      sel.innerHTML = '<option value="">所有账户</option>' +
        data.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')
      sel.style.display = ''
    } else {
      sel.style.display = 'none'
    }
  } catch { sel.style.display = 'none' }
  switchDataTab(_dataTab, true)
}

function onAccountChange() {
  if (_dataTab === 'leads')     loadLeads(1)
  if (_dataTab === 'adreports') loadAdReports(1)
  if (_dataTab === 'analytics') loadAnalytics()
}

function switchDataTab(tab, force = false) {
  if (_dataTab === tab && !force) return
  _dataTab = tab
  document.querySelectorAll('.data-tab').forEach(el => el.classList.remove('active'))
  const tabEl = document.getElementById('dtab-' + tab)
  if (tabEl) tabEl.classList.add('active')
  // leads / adreports / entries 共用 dataTableWrap + dataStats + dataPagination
  // analytics / alerts 有自己的容器，需隐藏共用区域
  const useShared = tab === 'leads' || tab === 'adreports' || tab === 'entries'
  const statsEl = document.getElementById('dataStats')
  const wrapEl  = document.getElementById('dataTableWrap')
  const pageEl  = document.getElementById('dataPagination')
  if (statsEl) statsEl.style.display = useShared ? '' : 'none'
  if (wrapEl)  wrapEl.style.display  = useShared ? '' : 'none'
  if (pageEl)  pageEl.style.display  = useShared ? '' : 'none'
  document.getElementById('dt-leads').style.display        = tab === 'leads'     ? 'flex' : 'none'
  document.getElementById('dt-adreports').style.display    = tab === 'adreports' ? 'flex' : 'none'
  document.getElementById('dt-entries').style.display      = tab === 'entries'   ? 'flex' : 'none'
  document.getElementById('dt-analytics').style.display    = tab === 'analytics' ? 'flex' : 'none'
  document.getElementById('dataAlertsPanel').style.display = tab === 'alerts'    ? 'flex' : 'none'
  if (tab === 'leads')     loadLeads(1)
  if (tab === 'adreports') loadAdReports(1)
  if (tab === 'entries')   loadDataEntries()
  if (tab === 'analytics') loadAnalytics()
  if (tab === 'alerts')    { loadAlertRules(); loadAlertHistory(); clearAlertBadge() }
}

async function loadDataEntries() {
  const wrap = document.getElementById('dataTableWrap')
  const search = document.getElementById('dEntriesSearch')?.value.trim() || ''
  const ftype  = document.getElementById('dEntriesType')?.value || ''
  wrap.innerHTML = '<p style="color:var(--ink-5);font-size:13px;padding:30px;text-align:center">加载中…</p>'
  try {
    let q = db.from('data_entries').select('*', { count: 'exact' }).order('created_at', { ascending: false }).limit(50)
    if (search) q = q.ilike('file_name', `%${search}%`)
    if (ftype)  q = q.eq('file_type', ftype)
    const { data, count } = await q
    const entries = data || []
    document.getElementById('dEntriesCount').textContent = `共 ${count || 0} 条`
    if (entries.length === 0) {
      wrap.innerHTML = `<div style="text-align:center;padding:60px 0;color:var(--ink-5)">
        <div style="font-size:32px;margin-bottom:12px">📥</div>
        <p style="font-size:13px">暂无录入记录</p>
        <p style="font-size:12px;margin-top:6px">在对话框上传文件并输入「录入」即可提取数据</p>
      </div>`
      return
    }
    wrap.innerHTML = `<div style="background:#fff;border:1px solid #e5e5e5;border-radius:10px;overflow:hidden">` +
      entries.map((e, i) => {
        const fields = Object.entries(e.structured_data || {})
        const fieldPreview = fields.slice(0, 3).map(([k,v]) => `<span style="background:#f5f5f5;border-radius:4px;padding:2px 7px;font-size:11px;color:#555">${esc(k)}: ${esc(String(v).slice(0,30))}</span>`).join(' ')
        const typeIcon = {pdf:'📄',word:'📝',excel:'📊',image:'🖼️'}[e.file_type] || '📄'
        return `<div style="display:flex;align-items:flex-start;gap:12px;padding:14px 16px;${i < entries.length-1 ? 'border-bottom:1px solid #f0f0f0' : ''}">
          <span style="font-size:22px;flex-shrink:0;margin-top:2px">${typeIcon}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:#111;margin-bottom:3px">${esc(e.file_name)}</div>
            ${e.data_type ? `<div style="font-size:11px;color:#da0d15;margin-bottom:4px">🏷️ ${esc(e.data_type)}</div>` : ''}
            ${e.summary ? `<div style="font-size:12px;color:#555;margin-bottom:6px">${esc(e.summary)}</div>` : ''}
            <div style="display:flex;flex-wrap:wrap;gap:4px">${fieldPreview}${fields.length > 3 ? `<span style="font-size:11px;color:var(--ink-5)">+${fields.length-3}项</span>` : ''}</div>
          </div>
          <div style="flex-shrink:0;text-align:right">
            <div style="font-size:11px;color:var(--ink-5)">${fmtTime(e.created_at)}</div>
            <div style="margin-top:6px;display:flex;gap:4px">
              <button onclick='showEntryDetail(${JSON.stringify(e).replace(/'/g,"&#x27;")})' style="background:#f5f5f5;border:1px solid #e0e0e0;border-radius:5px;padding:3px 9px;font-size:11px;color:#555;cursor:pointer">查看</button>
            </div>
          </div>
        </div>`
      }).join('') + `</div>`
  } catch(e) {
    wrap.innerHTML = `<p style="color:#d11a13;font-size:12px;padding:20px">加载失败：${esc(e.message)}</p>`
  }
}

function showEntryDetail(entry) {
  const fields = Object.entries(entry.structured_data || {})
  const rows = fields.map(([k,v]) => `<div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid #f5f5f5">
    <span style="width:140px;flex-shrink:0;font-size:12px;color:var(--ink-3);font-weight:500">${esc(k)}</span>
    <span style="flex:1;font-size:12px;color:#111;word-break:break-all">${esc(String(v))}</span>
  </div>`).join('')
  const html = `<div id="entryDetailModal" onclick="if(event.target===this)this.remove()" style="position:fixed;inset:0;background:#00000055;z-index:300;display:flex;align-items:center;justify-content:center">
    <div style="background:#fff;border-radius:12px;padding:24px;width:520px;max-width:92vw;max-height:80vh;overflow:auto;box-shadow:0 8px 32px #0002">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
        <span style="font-size:20px">📥</span>
        <h3 style="font-size:14px;font-weight:700;color:#111;flex:1">${esc(entry.file_name)}</h3>
        <button onclick="document.getElementById('entryDetailModal').remove()" style="background:none;border:none;font-size:18px;color:var(--ink-5);cursor:pointer">✕</button>
      </div>
      ${entry.summary ? `<p style="font-size:12px;color:#555;margin-bottom:12px;padding:8px 12px;background:#f9f9f9;border-radius:6px">${esc(entry.summary)}</p>` : ''}
      <div style="font-size:11px;color:var(--ink-5);margin-bottom:8px">共 ${fields.length} 个字段</div>
      ${rows || '<p style="color:var(--ink-5);font-size:12px">无提取字段</p>'}
    </div>
  </div>`
  document.body.insertAdjacentHTML('beforeend', html)
}

function dataTagHtml(labels) {
  if (!labels) return ''
  const matches = [...String(labels).matchAll(/\[([^\]]+)\]/g)]
  if (matches.length === 0) {
    return `<span class="dtag">${esc(String(labels))}</span>`
  }
  return matches.map(m => {
    const t = m[1]
    const cls = /google/i.test(t) ? 'google' : /potential|follow/i.test(t) ? 'potential' : /meta|facebook/i.test(t) ? 'meta' : ''
    return `<span class="dtag ${cls}">${esc(t)}</span>`
  }).join('')
}

function renderPagination(page, total, onPage) {
  const totalPages = Math.ceil(total / DATA_PAGE_SIZE)
  const pg = document.getElementById('dataPagination')
  if (totalPages <= 1) { pg.innerHTML = ''; return }
  const pages = []
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || Math.abs(i - page) <= 2) pages.push(i)
    else if (pages[pages.length-1] !== '…') pages.push('…')
  }
  pg.innerHTML = `
    <button class="pg-btn" onclick="${onPage}(${page-1})" ${page<=1?'disabled':''}>←</button>
    ${pages.map(p => p === '…'
      ? `<span class="pg-info">…</span>`
      : `<button class="pg-btn ${p===page?'active':''}" onclick="${onPage}(${p})">${p}</button>`
    ).join('')}
    <button class="pg-btn" onclick="${onPage}(${page+1})" ${page>=totalPages?'disabled':''}>→</button>
    <span class="pg-info">${page} / ${totalPages} 页，共 ${total} 条</span>`
}

function showDataStats(stats) {
  const el = document.getElementById('dataStats')
  if (!stats?.length) { el.style.display = 'none'; return }
  el.style.display = 'flex'
  el.innerHTML = stats.map(s => `
    <div class="dstat ${s.cls||''}">
      <div class="dstat-val">${s.val}</div>
      <div class="dstat-lbl">${s.lbl}</div>
    </div>`).join('')
}

let _leadsCache = [], _adsCache = []

async function loadLeads(page = 1) {
  const wrap = document.getElementById('dataTableWrap')
  wrap.innerHTML = '<p style="color:#333;font-size:13px;padding:40px 0;text-align:center">加载中…</p>'
  const search = document.getElementById('dLeadsSearch')?.value.trim()
  const from   = document.getElementById('dLeadsFrom')?.value
  const to     = document.getElementById('dLeadsTo')?.value
  const label  = document.getElementById('dLeadsLabel')?.value.trim()
  try {
    const acct = document.getElementById('accountSelector')?.value
    let q = db.from('leads').select('*', { count: 'exact' })
      .order('date', { ascending: false })
      .range((page-1)*DATA_PAGE_SIZE, page*DATA_PAGE_SIZE - 1)
    if (search) q = q.or(`name.ilike.%${search}%,phone.ilike.%${search}%`)
    if (from)   q = q.gte('date', from)
    if (to)     q = q.lte('date', to)
    if (label)  q = q.ilike('labels', `%${label}%`)
    if (acct)   q = q.eq('account_id', acct)
    const { data, count, error } = await q
    if (error) throw error
    _leadsCache = data || []
    document.getElementById('dLeadsCount').textContent = `共 ${count} 条`
    // Stats
    const googleCount = (data||[]).filter(r => r.labels?.includes('[Google]')).length
    const potentialCount = (data||[]).filter(r => r.labels?.includes('[potential]')).length
    showDataStats([
      { val: count, lbl: '总 Leads', cls: 'blue' },
      { val: googleCount, lbl: 'Google 来源' },
      { val: potentialCount, lbl: '潜在客户', cls: 'green' },
    ])
    if (!data?.length) { wrap.innerHTML = '<p style="color:#333;font-size:13px;padding:40px 0;text-align:center">无数据</p>'; return }
    wrap.innerHTML = `<table class="data-table">
      <thead><tr><th>日期</th><th>姓名</th><th>电话</th><th>标签</th></tr></thead>
      <tbody>${data.map(r => `<tr>
        <td class="num">${r.date||''}</td>
        <td class="name">${esc(r.name||'')}</td>
        <td class="num">${esc(r.phone||'')}</td>
        <td><div class="data-tags">${dataTagHtml(r.labels)}</div></td>
      </tr>`).join('')}</tbody>
    </table>`
    renderPagination(page, count, 'loadLeads')
  } catch(e) {
    wrap.innerHTML = `<p style="color:#d11a13;font-size:13px;padding:40px 0;text-align:center">加载失败：${esc(e.message)}</p>`
  }
}

async function loadAdReports(page = 1) {
  const wrap = document.getElementById('dataTableWrap')
  wrap.innerHTML = '<p style="color:#333;font-size:13px;padding:40px 0;text-align:center">加载中…</p>'
  const search = document.getElementById('dAdsSearch')?.value.trim()
  const from   = document.getElementById('dAdsFrom')?.value
  const to     = document.getElementById('dAdsTo')?.value
  try {
    const acctAds = document.getElementById('accountSelector')?.value
    let q = db.from('ad_reports').select('campaign_name,day,amount_spent_myr,results,cost_per_result,frequency,cpm,ctr_all,link_clicks,new_messaging_contacts', { count: 'exact' })
      .order('amount_spent_myr', { ascending: false })
      .range((page-1)*DATA_PAGE_SIZE, page*DATA_PAGE_SIZE - 1)
    if (search)   q = q.ilike('campaign_name', `%${search}%`)
    if (from)     q = q.gte('day', from)
    if (to)       q = q.lte('day', to)
    if (acctAds)  q = q.eq('account_id', acctAds)
    const { data, count, error } = await q
    if (error) throw error
    _adsCache = data || []
    document.getElementById('dAdsCount').textContent = `共 ${count} 条`
    // Stats
    const totalSpend = (data||[]).reduce((s,r) => s + (Number(r.amount_spent_myr)||0), 0)
    const totalResults = (data||[]).reduce((s,r) => s + (Number(r.results)||0), 0)
    const avgFreq = (data||[]).length ? ((data||[]).reduce((s,r)=>s+(Number(r.frequency)||0),0)/(data||[]).length) : 0
    showDataStats([
      { val: 'MYR ' + totalSpend.toFixed(0), lbl: '本页合计花费', cls: 'amber' },
      { val: totalResults, lbl: '本页合计结果', cls: 'blue' },
      { val: totalSpend > 0 && totalResults > 0 ? 'MYR ' + (totalSpend/totalResults).toFixed(2) : '—', lbl: '本页均 CPR', cls: 'green' },
      { val: avgFreq.toFixed(2), lbl: '本页均频', cls: avgFreq > 3 ? 'amber' : '' },
    ])
    if (!data?.length) { wrap.innerHTML = '<p style="color:#333;font-size:13px;padding:40px 0;text-align:center">无数据</p>'; return }
    wrap.innerHTML = `<table class="data-table">
      <thead><tr><th>活动名称</th><th>日期</th><th>花费(MYR)</th><th>结果</th><th>CPR</th><th>频率</th><th>CPM</th><th>CTR</th><th>点击</th><th>新联系</th></tr></thead>
      <tbody>${data.map(r => `<tr>
        <td class="name" style="max-width:200px" title="${esc(r.campaign_name||'')}">${esc(r.campaign_name||'')}</td>
        <td class="num">${r.day||''}</td>
        <td class="spend">${r.amount_spent_myr!=null?Number(r.amount_spent_myr).toFixed(2):''}</td>
        <td class="num">${r.results??''}</td>
        <td class="num">${r.cost_per_result!=null?Number(r.cost_per_result).toFixed(2):''}</td>
        <td class="num" style="color:${Number(r.frequency)>3?'#f59e0b':'#666'}">${r.frequency!=null?Number(r.frequency).toFixed(2):''}</td>
        <td class="num">${r.cpm!=null?Number(r.cpm).toFixed(2):''}</td>
        <td class="num">${r.ctr_all!=null?(Number(r.ctr_all)*100).toFixed(2)+'%':''}</td>
        <td class="num">${r.link_clicks??''}</td>
        <td class="num">${r.new_messaging_contacts??''}</td>
      </tr>`).join('')}</tbody>
    </table>`
    renderPagination(page, count, 'loadAdReports')
  } catch(e) {
    wrap.innerHTML = `<p style="color:#d11a13;font-size:13px;padding:40px 0;text-align:center">加载失败：${esc(e.message)}</p>`
  }
}

async function exportExcel(tab) {
  const btnId = tab === 'leads' ? 'exportLeadsBtn' : tab === 'adreports' ? 'exportAdsBtn' : 'exportAnBtn'
  const btn = document.getElementById(btnId)
  const origText = btn ? btn.textContent : ''
  if (btn) { btn.textContent = '导出中…'; btn.disabled = true }
  try {
    let data = [], filename = tab, sheetName = tab
    if (tab === 'leads') {
      const search = document.getElementById('dLeadsSearch')?.value.trim()
      const from   = document.getElementById('dLeadsFrom')?.value
      const to     = document.getElementById('dLeadsTo')?.value
      const label  = document.getElementById('dLeadsLabel')?.value.trim()
      let q = db.from('leads').select('date,name,phone,email,labels,campaign_source,created_at').order('date', { ascending: false })
      if (search) q = q.or(`name.ilike.%${search}%,phone.ilike.%${search}%`)
      if (from)   q = q.gte('date', from)
      if (to)     q = q.lte('date', to)
      if (label)  q = q.ilike('labels', `%${label}%`)
      const { data: d, error } = await q; if (error) throw error
      data = d || []; filename = 'leads'; sheetName = 'Leads'
    } else if (tab === 'adreports') {
      const search = document.getElementById('dAdsSearch')?.value.trim()
      const from   = document.getElementById('dAdsFrom')?.value
      const to     = document.getElementById('dAdsTo')?.value
      let q = db.from('ad_reports').select('campaign_name,day,amount_spent_myr,results,cost_per_result,frequency,cpm,ctr_all,link_clicks,new_messaging_contacts').order('day', { ascending: false })
      if (search) q = q.ilike('campaign_name', `%${search}%`)
      if (from)   q = q.gte('day', from)
      if (to)     q = q.lte('day', to)
      const { data: d, error } = await q; if (error) throw error
      data = d || []; filename = 'ad_reports'; sheetName = '广告报告'
    } else if (tab === 'analytics') {
      const thead = document.getElementById('analyticsHead')
      const tbody = document.getElementById('analyticsBody')
      if (!thead || !tbody) { toast('无分析数据', 'error'); return }
      const headers = [...thead.querySelectorAll('th')].map(th => th.textContent.trim()).filter(Boolean)
      data = [...tbody.querySelectorAll('tr')].map(tr => {
        const cells = tr.querySelectorAll('td'); if (!cells.length) return null
        const row = {}; headers.forEach((h, i) => { if (cells[i]) row[h] = cells[i].textContent.trim() }); return row
      }).filter(Boolean)
      filename = 'analytics'; sheetName = '分析'
    }
    if (!data.length) { toast('没有数据可导出', 'error'); return }
    if (typeof XLSX !== 'undefined') {
      const ws = XLSX.utils.json_to_sheet(data)
      const keys = Object.keys(data[0])
      ws['!cols'] = keys.map(k => ({ wch: Math.max(k.length + 2, ...data.slice(0,200).map(r => String(r[k]||'').length), 8) }))
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, sheetName)
      XLSX.writeFile(wb, filename + '_' + new Date().toISOString().slice(0,10) + '.xlsx')
    } else {
      // 降级 CSV
      const keys = Object.keys(data[0])
      const csv = [keys.join(','), ...data.map(r => keys.map(k => { const v = r[k]??''; return String(v).includes(',') ? '"'+String(v).replace(/"/g,'""')+'"' : String(v) }).join(','))].join('\n')
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿'+csv],{type:'text/csv;charset=utf-8'})); a.download = filename+'_'+new Date().toISOString().slice(0,10)+'.csv'; a.click()
    }
  } catch(e) { toast('导出失败: ' + e.message, 'error') }
  finally { if (btn) { btn.textContent = origText; btn.disabled = false } }
}
// 兼容旧调用
const exportCSV = exportExcel

// ── CSV Import ─────────────────────────────────────────────────────────
let _importType = ''
let _importRows = []
let _importMapped = []    // 列名映射后、准备写入 DB 的行
let _importConflicts = {} // { phone: existing_id } 扫描到的冲突

function triggerImport(type) {
  _importType = type
  _importRows = []; _importMapped = []; _importConflicts = {}
  document.getElementById('importConflictZone').style.display = 'none'
  document.getElementById('importPreview').textContent = '请选择文件…'
  document.getElementById('importConfirmBtn').disabled = true
  document.getElementById('importModalTitle').textContent = type === 'leads' ? '导入 Leads CSV' : '导入广告报告 CSV'
  document.getElementById('importModalDesc').textContent = type === 'leads'
    ? '支持 CSV / Excel。Leads 字段：date, name, phone, email, labels, campaign_source'
    : '支持 CSV / Excel。字段：campaign_name, day, amount_spent_myr, results, cost_per_result 等'
  // 只在 Leads 时显示批量标签/日期字段
  const extra = document.getElementById('importLeadsExtra')
  if (extra) { extra.style.display = type === 'leads' ? 'flex' : 'none' }
  document.getElementById('importModalBg').classList.add('open')
  setTimeout(() => document.getElementById('csvFileInput').click(), 100)
}

function closeImportModal() {
  document.getElementById('importModalBg').classList.remove('open')
  document.getElementById('csvFileInput').value = ''
  document.getElementById('importConflictZone').style.display = 'none'
  _importMapped = []; _importConflicts = {}
}

function _parseCSVLine(line) {
  const result = []; let cur = '', inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++ } else inQ = !inQ }
    else if (c === ',' && !inQ) { result.push(cur.trim()); cur = '' }
    else cur += c
  }
  result.push(cur.trim()); return result
}

function _showImportPreview(rows, headers) {
  _importRows = rows
  _importMapped = []; _importConflicts = {}
  document.getElementById('importConflictZone').style.display = 'none'
  const preview = '共 ' + rows.length + ' 行\n列名：' + headers.join(', ') + '\n\n前 3 行预览：\n' +
    rows.slice(0,3).map(function(r,i){ return (i+1) + '. ' + Object.entries(r).slice(0,4).map(function(kv){ return kv[0]+'='+kv[1] }).join(', ') }).join('\n')
  document.getElementById('importPreview').textContent = preview
  document.getElementById('importConfirmBtn').disabled = rows.length === 0
}

function onCSVFileSelected(event) {
  const file = event.target.files[0]; if (!file) return
  const ext = (file.name.split('.').pop()||'').toLowerCase()
  if ((ext === 'xlsx' || ext === 'xls') && typeof XLSX !== 'undefined') {
    // Excel 解析
    const reader = new FileReader()
    reader.onload = function(e) {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const raw = XLSX.utils.sheet_to_json(ws, { defval: '' })
        if (!raw.length) { document.getElementById('importPreview').textContent = '文件为空或无数据行'; return }
        const headers = Object.keys(raw[0])
        _showImportPreview(raw, headers)
      } catch(err) { document.getElementById('importPreview').textContent = '解析失败：' + err.message }
    }
    reader.readAsArrayBuffer(file)
  } else {
    // CSV 解析
    const reader = new FileReader()
    reader.onload = function(e) {
      const text = e.target.result.replace(/\r\n/g,'\n').replace(/\r/g,'\n')
      const lines = text.split('\n').filter(l => l.trim())
      if (lines.length < 2) { document.getElementById('importPreview').textContent = '文件为空或无数据行'; return }
      const headers = _parseCSVLine(lines[0]).map(h => h.replace(/^﻿/,'').trim())
      const rows = lines.slice(1).map(line => {
        const vals = _parseCSVLine(line), row = {}
        headers.forEach((h, i) => { if (vals[i] !== undefined && vals[i] !== '') row[h] = vals[i] })
        return row
      }).filter(r => Object.keys(r).length > 0)
      _showImportPreview(rows, headers)
    }
    reader.readAsText(file, 'UTF-8')
  }
}

// 列名映射：把 _importRows 转为可写入 DB 的行数组
function _mapImportRows() {
  const LEAD_ALIASES = {'日期':'date','姓名':'name','名字':'name','电话':'phone','手机':'phone',
    '邮箱':'email','标签':'labels','label':'labels','来源':'campaign_source','source':'campaign_source'}
  const LEAD_COLS = new Set(['date','name','phone','email','labels','campaign_source','account_id'])
  const ADS_COLS  = new Set(['campaign_name','day','amount_spent_myr','results','cost_per_result','frequency','cpm','ctr_all','link_clicks','new_messaging_contacts','account_id'])
  const allowedCols = _importType === 'leads' ? LEAD_COLS : ADS_COLS
  const batchLabel = (document.getElementById('importLabelTag')?.value || '').trim()
  const batchDate  = (document.getElementById('importDateTag')?.value  || '').trim()
  return _importRows.map(function(r) {
    const out = {}
    for (const k in r) {
      if (!k || k.startsWith('__')) continue
      const key = k.toLowerCase().replace(/\s+/g,'_')
      const mapped = _importType === 'leads' ? (LEAD_ALIASES[k] || LEAD_ALIASES[key] || key) : key
      if (allowedCols.has(mapped)) out[mapped] = r[k]
    }
    if (_importType === 'leads') {
      if (batchLabel && !out.labels) out.labels = batchLabel
      if (batchDate  && !out.date)   out.date   = batchDate
    }
    return out
  }).filter(function(r) { return Object.keys(r).length > 0 })
}

async function confirmImport() {
  if (!_importRows.length) return
  const btn = document.getElementById('importConfirmBtn')
  const cz  = document.getElementById('importConflictZone')
  cz.style.display = 'none'

  const mapped = _mapImportRows()
  if (!mapped.length) { toast('没有有效数据行', 'error'); return }
  _importMapped = mapped
  _importConflicts = {}

  // 广告报告：不需要去重，直接导入
  if (_importType !== 'leads') { await executeImport('insert'); return }

  // Leads：先扫描手机号冲突
  btn.textContent = '扫描重复中…'; btn.disabled = true
  try {
    const phones = [...new Set(mapped.map(r => String(r.phone || '')).filter(p => p))]
    for (let i = 0; i < phones.length; i += 100) {
      const chunk = phones.slice(i, i + 100)
      const { data, error } = await db.from('leads').select('id, phone').in('phone', chunk)
      if (error) throw error
      for (const row of (data || [])) _importConflicts[String(row.phone)] = row.id
    }

    const conflictCount = Object.keys(_importConflicts).length
    if (conflictCount === 0) { await executeImport('insert'); return }

    // 显示冲突报告
    const newCount = mapped.length - conflictCount
    const sample   = Object.keys(_importConflicts).slice(0, 6).join('、')
    document.getElementById('importConflictMsg').textContent =
      `⚠️ 发现 ${conflictCount} 条重复电话号码（共上传 ${mapped.length} 条）`
    document.getElementById('importConflictPreview').textContent =
      '重复示例：' + sample + (conflictCount > 6 ? ' …' : '')
    document.getElementById('importSkipBtn').textContent =
      `跳过重复，仅导入 ${newCount} 条新增`
    document.getElementById('importOverwriteBtn').textContent =
      `覆盖重复（更新 ${conflictCount} + 新增 ${newCount} 条）`
    cz.style.display = 'block'
    btn.textContent = '确认导入'; btn.disabled = false
  } catch(e) {
    toast('扫描失败: ' + e.message, 'error')
    btn.textContent = '确认导入'; btn.disabled = false
  }
}

// mode: 'insert' | 'skip' | 'overwrite'
async function executeImport(mode) {
  const btn = document.getElementById('importConfirmBtn')
  const cz  = document.getElementById('importConflictZone')
  btn.disabled = true; cz.style.display = 'none'
  const table = _importType === 'leads' ? 'leads' : 'ad_reports'
  const rows  = _importMapped
  let toInsert = rows
  let deleteIds = []

  if (mode === 'skip') {
    // 只插入不在冲突表里的行
    toInsert = rows.filter(r => !_importConflicts[String(r.phone || '')])
  } else if (mode === 'overwrite') {
    // 先删旧记录，再插入全部（CSV 内部同一手机号只保留最后一行）
    deleteIds = Object.values(_importConflicts)
    const seen = new Set()
    toInsert = rows.filter(r => {
      const ph = String(r.phone || '')
      if (!ph) return true
      if (seen.has(ph)) return false
      seen.add(ph); return true
    })
  }

  let inserted = 0
  btn.textContent = '导入中…'
  try {
    // 删除冲突旧记录（overwrite 模式）
    for (let i = 0; i < deleteIds.length; i += 100) {
      const { error } = await db.from(table).delete().in('id', deleteIds.slice(i, i + 100))
      if (error) throw error
    }
    // 插入新行
    for (let i = 0; i < toInsert.length; i += 100) {
      const { error } = await db.from(table).insert(toInsert.slice(i, i + 100))
      if (error) throw error
      inserted += Math.min(100, toInsert.length - i)
      btn.textContent = '导入中… ' + inserted + '/' + toInsert.length
    }
    closeImportModal()
    const overwriteCount = deleteIds.length
    const msg = mode === 'skip'
      ? `✅ 导入完成：新增 ${inserted} 条，跳过 ${Object.keys(_importConflicts).length} 条重复`
      : mode === 'overwrite'
      ? `✅ 导入完成：覆盖 ${overwriteCount} 条，新增 ${inserted - overwriteCount} 条`
      : `✅ 成功导入 ${inserted} 条`
    toast(msg, 'success')
    if (_importType === 'leads') loadLeads(1); else loadAdReports(1)
  } catch(e) {
    toast('导入失败: ' + e.message, 'error')
    btn.textContent = '确认导入'; btn.disabled = false
  }
}

function openLogModal(el) {
  const title = el.dataset.title || ''
  const content = decodeURIComponent(el.dataset.content || '')
  document.getElementById('logModalTitle').textContent = title
  document.getElementById('logModalBody').textContent = content
  document.getElementById('logModal').classList.add('open')
}
function closeLogModal() { document.getElementById('logModal').classList.remove('open') }

// ── Logs (Dify-inspired) ───────────────────────────────────────────────
let _logsAgentFilterInited = false
async function initLogsAgentFilter() {
  if (_logsAgentFilterInited) return
  _logsAgentFilterInited = true
  const sel = document.getElementById('logsAgentFilter')
  if (!sel) return
  try {
    const {data:agents} = await db.from('agents').select('id,name').order('id')
    const cur = sel.value
    sel.innerHTML = '<option value="">全部 Agent</option>' +
      (agents||[]).map(a => `<option value="${esc(a.id)}"${a.id===cur?' selected':''}>${esc(a.name)}</option>`).join('')
  } catch { /* keep default */ }
}

async function loadLogs() {
  const body = document.getElementById('logsBody')
  body.innerHTML = '<div class="log-empty">加载中…</div>'
  try {
    let q = db.from('conversations').select('*', { count: 'exact' }).order('created_at', {ascending:false}).limit(200)
    const af = document.getElementById('logsAgentFilter')?.value
    const rf = document.getElementById('logsRoleFilter')?.value
    const ff = document.getElementById('logsFeedbackFilter')?.value
    if (af) q = q.eq('agent', af)
    if (rf) q = q.eq('role', rf)
    if (ff === 'good') q = q.eq('feedback', 'good')
    else if (ff === 'bad') q = q.eq('feedback', 'bad')
    else if (ff === 'none') q = q.is('feedback', null)
    const {data, error, count} = await q
    if (error) throw error
    if (!data?.length) { body.innerHTML = '<div class="log-empty">暂无记录</div>'; return }
    document.getElementById('logsCount').textContent = data.length + ' / ' + count + ' 条'
    body.innerHTML = data.map(r => {
      const fbBtns = r.role === 'assistant' ? `
        <div class="fb-btns">
          <button class="fb-btn good${r.feedback==='good'?' active':''}" onclick="submitFeedback('${r.id}','good',this)">👍</button>
          <button class="fb-btn bad${r.feedback==='bad'?' active':''}" onclick="submitFeedback('${r.id}','bad',this)">👎</button>
        </div>` : '<span></span>'
      const agId = r.agent || 'chat'
      const isHermes = agId === 'chat'
      const agentTag = `<span style="display:inline-flex;align-items:center;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;border-radius:4px;padding:2px 7px;background:${isHermes?'#f0f0f0':'#ffd405'};color:${isHermes?'#77787b':'#000'}">${esc(agId)}</span>`
      const metaTime = `<span class="log-time" style="display:flex;flex-direction:column;gap:2px">
        <span>${fmtTime(r.created_at)}</span>
        ${r.cost_usd>0?`<span style="color:var(--green-ink);font-size:10px">$${Number(r.cost_usd).toFixed(4)}</span>`:''}
        ${r.tokens_in||r.tokens_out?`<span style="color:var(--ink-5);font-size:10px">${(r.tokens_in||0)+' ↑ '+(r.tokens_out||0)+' ↓'}</span>`:''}
      </span>`
      return `
      <div class="log-row">
        <span class="log-role ${r.role}">${r.role==='user'?'User':'AI'}</span>
        <span class="log-agent">${agentTag}</span>
        <span class="log-content" style="cursor:pointer" title="点击查看全文" data-title="${encodeURIComponent((r.role==="user"?"👤 ":"🤖 ")+(r.agent||"")+" · "+new Date(r.created_at).toLocaleString())}" data-content="${encodeURIComponent(r.content||"")}" onclick="openLogModal(this)">${esc(r.content)}</span>
        ${metaTime}
        ${fbBtns}
      </div>`
    }).join('')
  } catch(e) {
    body.innerHTML = `<div class="log-empty" style="color:#d11a13">加载失败：${esc(e.message)}</div>`
  }
}
async function reloadLogs() { _logsAgentFilterInited = false; await initLogsAgentFilter(); loadLogs() }

async function clearAllLogs() {
  const agent = document.getElementById('logsAgentFilter')?.value
  const label = agent ? `Agent「${agent}」的` : '全部'
  if (!confirm(`确认删除${label}对话记录？此操作不可撤销。`)) return
  const body = document.getElementById('logsBody')
  body.innerHTML = '<div class="log-empty">删除中…</div>'
  let q = db.from('conversations').delete().neq('id', 0)
  if (agent) q = q.eq('agent', agent)
  const { error } = await q
  if (error) { body.innerHTML = `<div class="log-empty" style="color:#d11a13">删除失败：${esc(error.message)}</div>`; return }
  document.getElementById('logsCount').textContent = '已清空'
  reloadLogs()
}

async function submitFeedback(id, val, btn) {
  const row = btn.closest('.fb-btns, .chat-fb')
  const current = btn.classList.contains('active') ? null : val
  await db.from('conversations').update({feedback: current}).eq('id', id)
  if (!row) return
  row.querySelectorAll('.fb-btn').forEach(b => b.classList.remove('active'))
  if (current) {
    btn.classList.add('active')
    // 触发学习（静默后台，不阻塞 UI）
    fetch(EDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON },
      body: JSON.stringify(orchBody({ action: 'learn', conversation_id: id, feedback: current }))
    }).catch(() => {})
  }
}

// ── LLM Config ────────────────────────────────────────────────────────
async function loadLLM() {
  try {
    const [{data:providers}, {data:pref}, {data:agents}] = await Promise.all([
      db.from('provider_config').select('*'),
      db.from('user_prefs').select('value').eq('key','default_provider').maybeSingle(),
      db.from('agents').select('id,name,provider,model').order('id'),
    ])
    if (pref?.value) document.getElementById('defaultSel').value = pref.value
    ;(providers||[]).forEach(r => {
      const p = r.provider
      const keyEl = document.getElementById('key-'+p)
      if (keyEl) {
        keyEl.value = r.api_key ? '••••••••' + r.api_key.slice(-4) : ''
        keyEl.dataset.masked = r.api_key ? 'true' : 'false'
      }
      if (r.model)   document.getElementById('model-'+p).value = r.model
      const cb = document.getElementById('active-'+p)
      if (cb) cb.checked = !!r.active
      ;['cdot-','dot-'].forEach(pre => {
        const el = document.getElementById(pre+p)
        if (el) el.className = 'dot'+(r.active?' on':'')
      })
    })
    document.getElementById('agentLLMTable').innerHTML = (agents||[]).map(a => `
      <tr>
        <td style="font-size:13px;color:var(--ink-5)">${esc(a.name)}</td>
        <td>
          <select id="allm-${a.id}">
            <option value="">（全局默认）</option>
            <option value="anthropic"   ${a.provider==='anthropic'?'selected':''}>Anthropic</option>
            <option value="openai"      ${a.provider==='openai'?'selected':''}>OpenAI</option>
            <option value="google"      ${a.provider==='google'?'selected':''}>Google</option>
            <option value="openrouter"  ${a.provider==='openrouter'?'selected':''}>🔀 OpenRouter</option>
          </select>
        </td>
        <td><input type="text" id="amdl-${a.id}" value="${esc(a.model||'')}" placeholder="默认"></td>
        <td><button class="sm-btn" onclick="saveAgentLLM('${a.id}')">保存</button></td>
      </tr>`).join('')
    document.getElementById('syncMsg').textContent = '✓ 已从 Supabase 同步'
    document.getElementById('syncMsg').style.color = '#22c55e'
  } catch(e) {
    document.getElementById('syncMsg').textContent = '⚠ 读取失败（'+e.message+'）— 仍可直接填写保存'
    document.getElementById('syncMsg').style.color = '#f59e0b'
  }
}

function toggleShow(p) {
  const el = document.getElementById('key-'+p)
  el.type = el.type==='password'?'text':'password'
}

async function fetchModels(p) {
  const keyEl = document.getElementById('key-'+p)
  if (keyEl.dataset.masked === 'true') {
    const listEl = document.getElementById('models-'+p)
    if (listEl) listEl.innerHTML = '<option value="" disabled selected>请先输入真实 API Key</option>'
    return
  }
  const key = keyEl.value.trim()
  const listEl = document.getElementById('models-'+p)
  if (!key) { listEl.innerHTML = '<option value="" disabled selected>请先填写 API Key</option>'; listEl.style.display = 'block'; return }
  listEl.innerHTML = '<option value="" disabled selected>获取中…</option>'
  listEl.style.display = 'block'
  try {
    const res  = await fetch(EDGE_URL, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:'list_models', provider:p, api_key:key})})
    const data = await res.json()
    if (data.error) { listEl.innerHTML = `<option value="" disabled selected>加载失败</option>`; return }
    const current = document.getElementById('model-'+p).value.trim()
    const models = data.models || []
    listEl.innerHTML = `<option value="">— 选择模型 —</option>` +
      models.map(m => `<option value="${esc(m)}"${m===current?' selected':''}>${esc(m)}</option>`).join('')
    listEl.style.display = 'block'
  } catch(e) {
    listEl.innerHTML = '<option value="" disabled selected>加载失败</option>'
    listEl.style.display = 'block'
  }
}

function selectModel(p, model) {
  if (model) document.getElementById('model-'+p).value = model
}
async function toggleActive(p, active) {
  ;['cdot-','dot-'].forEach(pre => { const el=document.getElementById(pre+p); if(el) el.className='dot'+(active?' on':'') })
  await db.from('provider_config').upsert({provider:p,active},{onConflict:'provider'})
  loadSidebarDots()
}
async function saveProvider(p) {
  const keyEl = document.getElementById('key-'+p)
  const key   = keyEl.dataset.masked === 'true' ? null : keyEl.value.trim()
  const model = document.getElementById('model-'+p).value.trim()
  const cb    = document.getElementById('active-'+p)
  // 如果填了新 key，自动启用；否则读复选框状态
  let active = cb?.checked ?? true
  if (key) active = true
  if (cb) cb.checked = active
  const msgEl = document.getElementById('msg-'+p)
  if (key === '') { msgEl.className='status-txt err'; msgEl.textContent='请输入 API Key'; return }
  msgEl.className='status-txt'; msgEl.textContent='保存中…'
  const updateData = { model, active }
  if (key) updateData.api_key = key
  const {error} = await db.from('provider_config').upsert({provider:p,...updateData},{onConflict:'provider'})
  msgEl.className = 'status-txt '+(error?'err':'ok')
  msgEl.textContent = error ? error.message : '✓ 已保存'
  if (!error) {
    ;['cdot-','dot-'].forEach(pre => { const el=document.getElementById(pre+p); if(el) el.className='dot'+(active?' on':'') })
    loadSidebarDots()
  }
}
async function testLlm(p) {
  const msgEl = document.getElementById('msg-'+p)
  msgEl.className = 'status-txt'; msgEl.textContent = '测试中…'
  let rawText = ''
  try {
    const r = await fetch(EDGE_URL, { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+SUPABASE_ANON},
      body: JSON.stringify(orchBody({ action:'test_llm', provider:p })) })
    rawText = await r.text()
    let d
    try { d = JSON.parse(rawText) } catch { d = null }
    if (!d) {
      msgEl.className = 'status-txt err'
      msgEl.textContent = '✗ 非 JSON 响应: ' + rawText.slice(0, 120)
      return
    }
    if (d.ok) {
      msgEl.className = 'status-txt ok'
      msgEl.textContent = `✓ 连接正常 · 模型: ${d.model_used} · 回复: "${String(d.response||'').trim().slice(0,40)}"`
    } else {
      msgEl.className = 'status-txt err'
      msgEl.textContent = '✗ ' + (d.error || JSON.stringify(d).slice(0, 120))
    }
  } catch(e) {
    msgEl.className = 'status-txt err'
    msgEl.textContent = '✗ 网络错误: ' + e.message + (rawText ? ' | 原始: ' + rawText.slice(0,80) : '')
  }
}
async function saveAgentLLM(id) {
  const provider = document.getElementById('allm-'+id).value || null
  const model    = document.getElementById('amdl-'+id).value.trim() || null
  const btn = document.querySelector(`#allm-${id}`)?.closest('tr')?.querySelector('.sm-btn')
  const {error} = await db.from('agents').update({provider,model,updated_at:new Date().toISOString()}).eq('id',id)
  if (btn) { btn.textContent=error?'✗ 失败':'✓ 已保存'; setTimeout(()=>btn.textContent='保存',2000) }
}
async function saveDefault() {
  const p = document.getElementById('defaultSel').value
  const m = document.getElementById('defaultMsg')
  m.textContent='保存中…'; m.className='status-txt'
  const {error} = await db.from('user_prefs').upsert({key:'default_provider',value:p,confidence:1.0},{onConflict:'key'})
  m.className='status-txt '+(error?'err':'ok')
  m.textContent = error ? error.message : `✓ 已设为 ${PROVIDER_LABELS[p]}`
}

// ── API Integrations ──────────────────────────────────────────────────
const INT_LABELS = {
  whatsapp:'WhatsApp', email_smtp:'Email SMTP', sendgrid:'SendGrid',
  telegram:'Telegram', lark:'Lark 飞书', slack:'Slack',
  facebook_ads:'Facebook Ads', google_ads:'Google Ads', tiktok_ads:'TikTok Ads', google_analytics:'GA4',
  hubspot:'HubSpot', zoho_crm:'Zoho CRM', stripe:'Stripe', xero:'Xero',
  google_sheets:'Google Sheets', shopify:'Shopify', notion:'Notion', airtable:'Airtable'
}

function testComingSoon(service) {
  const label = INT_LABELS[service] || service
  toast(`${label} 数据同步功能开发中，凭证已可配置保存`, 'info')
}

function copyWAUrl(btn) {
  const url = 'https://ontumerafhimxvqtsijr.supabase.co/functions/v1/whatsapp-webhook'
  navigator.clipboard.writeText(url)
    .then(() => {
      const orig = btn.textContent
      btn.textContent = '已复制 ✓'
      setTimeout(() => btn.textContent = orig, 2000)
    })
    .catch(() => {
      prompt('请手动复制 Webhook URL：', url)
    })
}
async function loadIntegrations() {
  try {
    const {data} = await db.from('api_integrations').select('*')
    // Status strip
    const strip = document.getElementById('intStatusStrip')
    if (!data?.length) {
      strip.innerHTML = '<span style="color:#444;font-size:12px">暂无集成配置</span>'
      return
    }
    strip.innerHTML = (data||[]).map(r =>
      `<span class="int-chip${r.active?' on':''}"><span class="dot${r.active?' on':''}"></span>${INT_LABELS[r.service]||r.service}</span>`
    ).join('')
    ;(data||[]).forEach(r => {
      const cb = document.getElementById('iactive-'+r.service)
      if (cb) cb.checked = !!r.active
      const dot = document.getElementById('idot-'+r.service)
      if (dot) dot.className = 'dot'+(r.active?' on':'')
      Object.entries(r.credentials||{}).forEach(([k,v]) => {
        const el = document.getElementById(`int-${r.service}-${k}`)
        if (el && v) el.value = v
      })
    })
  } catch {}
}
async function toggleIntegration(service, active) {
  const dot = document.getElementById('idot-'+service)
  if (dot) dot.className = 'dot'+(active?' on':'')
  await db.from('api_integrations').upsert({service,active},{onConflict:'service'})
  await loadIntegrations()
}
async function saveIntegration(service, keys) {
  const credentials = {}
  keys.forEach(k => {
    const el = document.getElementById(`int-${service}-${k}`)
    credentials[k] = el?.value.trim() || null
  })
  const active = document.getElementById('iactive-'+service)?.checked
  const msg = document.getElementById('imsg-'+service)
  msg.className='status-txt'; msg.textContent='保存中…'
  const {error} = await db.from('api_integrations').upsert(
    { service, credentials, active, updated_at: new Date().toISOString() },
    { onConflict: 'service' }
  )
  msg.className='status-txt '+(error?'err':'ok')
  msg.textContent = error ? error.message : '✓ 已保存'
  if (!error) loadIntegrations()
}

async function testEmailSmtp() {
  const msg = document.getElementById('imsg-email_smtp')
  msg.className = 'status-txt'; msg.textContent = '发送测试邮件中…'
  try {
    const r = await fetch(EDGE_URL, { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(orchBody({ action:'test_email_smtp' })) })
    const d = await r.json()
    if (d.ok) { msg.className='status-txt ok'; msg.textContent='✓ 测试邮件已发送（发往 From Address）'; toast('SMTP 测试邮件已发送', 'success') }
    else { msg.className='status-txt err'; msg.textContent = d.error||'发送失败'; toast(d.error||'SMTP 测试失败', 'error') }
  } catch(e) { msg.className='status-txt err'; msg.textContent='网络错误'; toast('SMTP 连接失败', 'error') }
}
async function testWhatsApp() {
  const msg = document.getElementById('imsg-whatsapp')
  msg.className = 'status-txt'; msg.textContent = '发送测试消息中…'
  try {
    const r = await fetch(EDGE_URL, { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(orchBody({ action:'test_whatsapp' })) })
    const d = await r.json()
    if (d.ok) { msg.className='status-txt ok'; msg.textContent='✓ 测试消息已发送，请检查手机 WhatsApp'; toast('WhatsApp 测试消息已发送', 'success') }
    else { msg.className='status-txt err'; msg.textContent = d.error||'发送失败'; toast(d.error||'WhatsApp 测试失败', 'error') }
  } catch(e) { msg.className='status-txt err'; msg.textContent='网络错误'; toast('WhatsApp 连接失败', 'error') }
}
async function testSendGrid() {
  const msg = document.getElementById('imsg-sendgrid')
  msg.className = 'status-txt'; msg.textContent = '发送测试邮件中…'
  try {
    const r = await fetch(EDGE_URL, { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(orchBody({ action:'test_sendgrid' })) })
    const d = await r.json()
    if (d.ok) { msg.className='status-txt ok'; msg.textContent='✓ 测试邮件已发送（发往 From Address）'; toast('SendGrid 测试邮件已发送', 'success') }
    else { msg.className='status-txt err'; msg.textContent = d.error||'发送失败'; toast(d.error||'SendGrid 测试失败', 'error') }
  } catch(e) { msg.className='status-txt err'; msg.textContent='网络错误'; toast('SendGrid 连接失败', 'error') }
}
async function testTelegram() {
  const msg = document.getElementById('imsg-telegram')
  msg.className = 'status-txt'; msg.textContent = '发送测试消息中…'
  try {
    const r = await fetch(EDGE_URL, { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(orchBody({ action:'test_telegram' })) })
    const d = await r.json()
    if (d.ok) { msg.className='status-txt ok'; msg.textContent='✓ 测试消息已发送，请检查 Telegram'; toast('Telegram 测试消息已发送', 'success') }
    else { msg.className='status-txt err'; msg.textContent = d.error||'发送失败'; toast(d.error||'Telegram 测试失败', 'error') }
  } catch(e) { msg.className='status-txt err'; msg.textContent='网络错误'; toast('Telegram 连接失败', 'error') }
}
async function testLarkWebhook() {
  const url = document.getElementById('int-lark-webhook_url')?.value?.trim()
  const msg = document.getElementById('imsg-lark')
  if (!url) { toast('请先填写 Webhook URL', 'error'); return }
  msg.className = 'status-txt'; msg.textContent = '测试中…'
  const r = await fetch(EDGE_URL, { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(orchBody({ action:'test_lark', webhook_url: url })) })
  const d = await r.json()
  if (d.ok) { msg.className='status-txt ok'; msg.textContent='✓ 测试成功，请检查 Lark 群'; toast('Lark 测试消息已发送', 'success') }
  else { msg.className='status-txt err'; msg.textContent = d.error||'发送失败'; toast(d.error||'Lark 测试失败', 'error') }
}
function copyLarkWebhook(btn) {
  const url = 'https://ontumerafhimxvqtsijr.supabase.co/functions/v1/lark-webhook'
  navigator.clipboard?.writeText(url).then(() => { btn.textContent='✓ 已复制'; setTimeout(()=>btn.textContent='复制接收 URL',2000) })
    .catch(() => prompt('请手动复制 Lark 接收 URL：', url))
}
async function testSlackWebhook() {
  const url = document.getElementById('int-slack-webhook_url')?.value?.trim()
  const msg = document.getElementById('imsg-slack')
  if (!url) { toast('请先填写 Slack Webhook URL', 'error'); return }
  msg.className = 'status-txt'; msg.textContent = '测试中…'
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON },
      body: JSON.stringify({ text: '✅ Orchestrator Agent — Slack 连接测试成功！' })
    })
    if (r.ok) { msg.className='status-txt ok'; msg.textContent='✓ 测试成功，请检查 Slack 频道'; toast('Slack 测试消息已发送', 'success') }
    else { msg.className='status-txt err'; msg.textContent='发送失败，请检查 URL'; toast('Slack 测试失败', 'error') }
  } catch { msg.className='status-txt err'; msg.textContent='网络错误'; toast('Slack 连接失败', 'error') }
}

// ══════════════════════════════════════════════════════════════════════
// UGC STUDIO
// ══════════════════════════════════════════════════════════════════════
var _ugcRules = null
var _ugcState = { script:'', captions:[], covers:null, posts:null, selPlatforms:['tiktok','ig_reels','fb_post'] }
var _ugcTabInit = {}

var UGC_PRODUCTS = [
  {v:'ultra_cleaning',l:'🏢 ULTRA CLEANING'},{v:'hour_clean',l:'🕐 HOUR CLEAN'},
  {v:'pro_clean',l:'✨ PRO CLEAN'},{v:'maint_clean',l:'🔧 MAINT CLEAN'},
  {v:'aircon_care',l:'❄️ AIRCON CARE'},{v:'pest_care',l:'🐀 PEST CARE'},
  {v:'pool_care',l:'🏊 POOL CARE'},{v:'handy_care',l:'🔨 HANDY CARE'},
  {v:'home_care',l:'🏠 HOME CARE'},{v:'garden_care',l:'🌿 GARDEN CARE'},
  {v:'hygiene',l:'🧴 HYGIENE'},{v:'agency',l:'👔 AGENCY'},{v:'academy',l:'🎓 ACADEMY'}
]
var UGC_AUDIENCES = [{v:'homeowner',l:'住家业主'},{v:'business',l:'企业主 / 老板'},{v:'sme',l:'中小企业'},{v:'general',l:'一般大众'}]
var UGC_PLATFORMS = [
  {v:'tiktok',l:'TikTok',i:'🎵'},{v:'ig_reels',l:'IG Reels',i:'📸'},{v:'ig_feed',l:'IG Feed',i:'🖼️'},
  {v:'fb_reels',l:'FB Reels',i:'▶️'},{v:'fb_post',l:'FB Post',i:'📘'},
  {v:'xiaohongshu',l:'小红书',i:'📕'},{v:'youtube',l:'YouTube Shorts',i:'▷'}
]
var UGC_LANGS = [{v:'zh',n:'中文',f:'🇨🇳'},{v:'en',n:'English',f:'🇬🇧'},{v:'ms',n:'Bahasa',f:'🇲🇾'}]
var UGC_DEFAULT_RULES = {
  tiktok:{maxWords:'旁白短句，每句≤10字',style:'冲击口语，像真人说话，节奏快',special:'需要字幕关键句，前3秒必须抓住注意力'},
  ig_reels:{maxWords:'说明栏≤150字',style:'有温度，生活感，轻松自然',special:'说明栏配合视频，引导互动'},
  ig_feed:{maxWords:'正文150-300字',style:'故事感，有画面，细节丰富',special:'需要封面框架，排版留白，适合存图'},
  fb_reels:{maxWords:'说明栏≤120字',style:'轻松直接，像朋友分享',special:'说明栏简洁，CTA清晰'},
  fb_post:{maxWords:'正文200-400字',style:'对话感，像朋友喝咖啡聊天，真实自然',special:'可以有Q&A格式，步骤条列，Emoji适量'},
  xiaohongshu:{maxWords:'正文200-350字',style:'生活感强，像日记，温暖分享',special:'标题要有吸引力，多用换行，emoji较多，适合存图'},
  youtube:{maxWords:'说明栏≤100字',style:'简洁专业，有SEO意识',special:'加入关键词，引导订阅'}
}

function ugcProdOpts(selId) {
  return '<select id="'+selId+'" style="width:100%;background:#f9f9f9;border:1px solid #e5e5e5;border-radius:8px;color:#111;font-family:inherit;font-size:13px;padding:9px 12px;outline:none">'
    + UGC_PRODUCTS.map(function(p){ return '<option value="'+p.v+'">'+p.l+'</option>' }).join('') + '</select>'
}
function ugcAudOpts(selId) {
  return '<select id="'+selId+'" style="width:100%;background:#f9f9f9;border:1px solid #e5e5e5;border-radius:8px;color:#111;font-family:inherit;font-size:13px;padding:9px 12px;outline:none">'
    + UGC_AUDIENCES.map(function(a){ return '<option value="'+a.v+'">'+a.l+'</option>' }).join('') + '</select>'
}

async function initUGCPage() {
  var el = document.getElementById('ugcPage')
  if (!el) return
  if (_ugcRules === null) {
    try {
      var r = await fetch(EDGE_URL, {method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+SUPABASE_ANON}, body:JSON.stringify(orchBody({action:'ugc_get_rules'}))})
      var d = await r.json()
      _ugcRules = d.rules || UGC_DEFAULT_RULES
    } catch(e) { _ugcRules = UGC_DEFAULT_RULES }
  }
  el.innerHTML = '<div class="ugc-wrap">'
    + '<div class="ugc-tabs">'
    + '<div class="ugc-tab active" id="ugc-t-settings" onclick="ugcShowTab(\'settings\',this)">⚙️ 平台设定</div>'
    + '<div class="ugc-tab" id="ugc-t-script"   onclick="ugcShowTab(\'script\',this)">✍️ 脚本工坊</div>'
    + '<div class="ugc-tab" id="ugc-t-cover"    onclick="ugcShowTab(\'cover\',this)">🎨 封面套件</div>'
    + '<div class="ugc-tab" id="ugc-t-post"     onclick="ugcShowTab(\'post\',this)">📱 社群贴文</div>'
    + '<div class="ugc-tab" id="ugc-t-preview"  onclick="ugcShowTab(\'preview\',this)">📄 完整预览</div>'
    + '</div>'
    + '<div class="ugc-body" id="ugc-body"></div>'
    + '</div>'
  ugcShowTab('settings', document.getElementById('ugc-t-settings'))
}

function ugcShowTab(tab, el) {
  document.querySelectorAll('.ugc-tab').forEach(function(t){ t.classList.remove('active') })
  if (el) el.classList.add('active')
  var body = document.getElementById('ugc-body')
  if (!body) return
  if (tab === 'settings') ugcBuildSettings(body)
  else if (tab === 'script') ugcBuildScript(body)
  else if (tab === 'cover')  ugcBuildCover(body)
  else if (tab === 'post')   ugcBuildPost(body)
  else if (tab === 'preview') ugcBuildPreview(body)
}

// ── Settings ──
function ugcBuildSettings(el) {
  var html = '<div class="ugc-section-title">⚙️ 平台设定</div>'
    + '<div class="ugc-section-sub">每个平台的写作规则存入 Supabase，多人共用。</div>'
  UGC_PLATFORMS.forEach(function(p) {
    var r = (_ugcRules && _ugcRules[p.v]) || UGC_DEFAULT_RULES[p.v] || {}
    html += '<div class="ugc-rule-card" id="ugcr-'+p.v+'">'
      + '<div class="ugc-rule-head" onclick="ugcToggleRule(\''+p.v+'\')">'
      + '<span style="font-size:14px;font-weight:600;color:#111">'+p.i+' '+p.l+'</span>'
      + '<span style="color:var(--ink-5);font-size:12px" id="ugcrc-'+p.v+'">▼</span>'
      + '</div>'
      + '<div class="ugc-rule-body" id="ugcrb-'+p.v+'">'
      + '<div style="margin-bottom:10px"><label class="ugc-field-label">字数 / 长度限制</label>'
      + '<input type="text" id="ugcw-'+p.v+'" value="'+esc(r.maxWords||'')+'" style="width:100%;background:#f9f9f9;border:1px solid #e5e5e5;border-radius:8px;color:#111;font-family:inherit;font-size:13px;padding:9px 12px;outline:none"></div>'
      + '<div style="margin-bottom:10px"><label class="ugc-field-label">写作风格</label>'
      + '<input type="text" id="ugcs-'+p.v+'" value="'+esc(r.style||'')+'" style="width:100%;background:#f9f9f9;border:1px solid #e5e5e5;border-radius:8px;color:#111;font-family:inherit;font-size:13px;padding:9px 12px;outline:none"></div>'
      + '<div style="margin-bottom:12px"><label class="ugc-field-label">特殊要求</label>'
      + '<textarea id="ugcsp-'+p.v+'" rows="2" style="width:100%;background:#f9f9f9;border:1px solid #e5e5e5;border-radius:8px;color:#111;font-family:inherit;font-size:13px;padding:9px 12px;outline:none;resize:vertical">'+esc(r.special||'')+'</textarea></div>'
      + '<div style="display:flex;align-items:center;gap:10px">'
      + '<button class="btn-primary btn-sm" onclick="ugcSaveRule(\''+p.v+'\')">保存</button>'
      + '<button class="btn-secondary btn-sm" onclick="ugcResetRule(\''+p.v+'\')">恢复默认</button>'
      + '<span class="ugc-save-ok" id="ugcok-'+p.v+'">✓ 已保存</span>'
      + '</div></div></div>'
  })
  el.innerHTML = html
}

function ugcToggleRule(v) {
  var b = document.getElementById('ugcrb-'+v), c = document.getElementById('ugcrc-'+v)
  if (!b) return
  var open = b.classList.toggle('open')
  if (c) c.textContent = open ? '▲' : '▼'
}

async function ugcSaveRule(v) {
  var w = document.getElementById('ugcw-'+v), s = document.getElementById('ugcs-'+v), sp = document.getElementById('ugcsp-'+v)
  if (!w) return
  var rule = {maxWords:w.value, style:s?s.value:'', special:sp?sp.value:''}
  if (_ugcRules) _ugcRules[v] = rule
  try {
    await fetch(EDGE_URL, {method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+SUPABASE_ANON},
      body:JSON.stringify(orchBody({action:'ugc_save_rule', platform:v, max_words:rule.maxWords, style:rule.style, special:rule.special}))})
    var ok = document.getElementById('ugcok-'+v)
    if (ok) { ok.style.display='inline'; setTimeout(function(){ ok.style.display='none' }, 1500) }
    toast('规则已保存', 'success')
  } catch(e) { toast('保存失败：'+e.message, 'error') }
}

async function ugcResetRule(v) {
  var def = UGC_DEFAULT_RULES[v] || {}
  if (_ugcRules) _ugcRules[v] = def
  try {
    await fetch(EDGE_URL, {method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+SUPABASE_ANON},
      body:JSON.stringify(orchBody({action:'ugc_reset_rule', platform:v}))})
    toast('已恢复默认', 'success')
  } catch(e) {}
  // Rebuild settings UI with updated defaults
  var body = document.getElementById('ugc-body')
  if (body) ugcBuildSettings(body)
}

// ── Script ──
function ugcBuildScript(el) {
  var html = '<div class="ugc-section-title">✍️ 脚本工坊</div>'
    + '<div class="ugc-section-sub">输入概念 / 草稿 / 完整脚本 → AI 生成旁白 + 字幕关键句</div>'
    + '<div class="ugc-card">'
    + '<div class="ugc-mode-toggle">'
    + '<div class="ugc-mode-btn active" id="ugcm-concept" onclick="ugcSetMode(\'concept\')">💡 只有概念</div>'
    + '<div class="ugc-mode-btn" id="ugcm-draft" onclick="ugcSetMode(\'draft\')">📝 有草稿</div>'
    + '<div class="ugc-mode-btn" id="ugcm-full" onclick="ugcSetMode(\'full\')">✅ 完整脚本</div>'
    + '</div>'
    + '<label class="ugc-field-label" id="ugcsl-label">输入概念 / 痛点</label>'
    + '<textarea id="ugcScriptInput" rows="5" style="width:100%;background:#f9f9f9;border:1px solid #e5e5e5;border-radius:8px;color:#111;font-family:inherit;font-size:13px;padding:10px 12px;outline:none;resize:vertical;margin-bottom:14px" placeholder="例如：很多客户以为看不到老鼠就没问题，其实老鼠留下的污染物才是最可怕的…"></textarea>'
    + '<div class="ugc-grid2" style="margin-bottom:14px">'
    + '<div><label class="ugc-field-label">产品线</label>'+ugcProdOpts('ugcsProd')+'</div>'
    + '<div><label class="ugc-field-label">目标受众</label>'+ugcAudOpts('ugcsAud')+'</div>'
    + '</div>'
    + '<div style="margin-bottom:16px"><label class="ugc-field-label">视频时长</label>'
    + '<select id="ugcsDur" style="width:100%;background:#f9f9f9;border:1px solid #e5e5e5;border-radius:8px;color:#111;font-family:inherit;font-size:13px;padding:9px 12px;outline:none">'
    + '<option value="15">15秒</option><option value="30" selected>30秒</option><option value="60">60秒</option><option value="90">90秒</option></select></div>'
    + '<button class="btn-primary" id="ugcsBtnGen" onclick="ugcGenScript(this)" style="width:100%;justify-content:center">⚡ 生成脚本</button>'
    + '</div>'
    + '<div id="ugcsErr" style="display:none;background:#fff0f0;border:1px solid #fca5a5;border-radius:8px;padding:12px;color:#dc2626;font-size:12px;margin-bottom:12px"></div>'
    + '<div id="ugcsResult"></div>'
  el.innerHTML = html
  if (_ugcState.script) ugcRenderScriptResult()
}

function ugcSetMode(m) {
  ['concept','draft','full'].forEach(function(x) {
    var b = document.getElementById('ugcm-'+x)
    if (b) b.classList.toggle('active', x===m)
  })
  var lbl = document.getElementById('ugcsl-label'), ta = document.getElementById('ugcScriptInput')
  if (!lbl || !ta) return
  if (m==='concept') { lbl.textContent='输入概念 / 痛点'; ta.placeholder='例如：很多人以为看不到老鼠就没问题…'; ta.rows=5 }
  else if (m==='draft') { lbl.textContent='贴入草稿'; ta.placeholder='有大概方向，AI 帮你完善成脚本…'; ta.rows=7 }
  else { lbl.textContent='贴入完整脚本'; ta.placeholder='AI 帮整理成旁白脚本 + 字幕句…'; ta.rows=9 }
}

async function ugcGenScript(btn) {
  var ta = document.getElementById('ugcScriptInput')
  if (!ta || !ta.value.trim()) { ugcShowErr('ugcsErr','请先输入内容。'); return }
  var prod = document.getElementById('ugcsProd'), aud = document.getElementById('ugcsAud'), dur = document.getElementById('ugcsDur')
  btn.disabled = true; btn.textContent = '生成中…'
  ugcHideErr('ugcsErr')
  try {
    var r = await fetch(EDGE_URL, {method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+SUPABASE_ANON},
      body:JSON.stringify(orchBody({action:'ugc_generate', type:'script',
        product:prod?prod.value:'ultra_cleaning', audience:aud?aud.value:'general',
        duration:dur?dur.value:'30', content:ta.value.trim()}))})
    var d = await r.json()
    if (!d.ok) throw new Error(d.error||'生成失败')
    var parsed = ugcParseJSON(d.result)
    _ugcState.script = parsed.voiceover || ''
    _ugcState.captions = parsed.captions || []
    ugcRenderScriptResult()
  } catch(e) { ugcShowErr('ugcsErr', e.message) }
  btn.disabled = false; btn.textContent = '⚡ 生成脚本'
}

function ugcRenderScriptResult() {
  var el = document.getElementById('ugcsResult')
  if (!el || !_ugcState.script) return
  var html = '<div class="ugc-card">'
    + '<div class="ugc-card-header"><span class="ugc-card-label">旁白脚本</span>'
    + '<button class="btn-secondary btn-sm" onclick="ugcCopy(\''+_ugcState.script.replace(/'/g,'&#x27;').replace(/\n/g,'\\n')+'\',this)">复制</button></div>'
    + '<div class="ugc-script-body">'+_ugcState.script.replace(/\n/g,'<br>')+'</div></div>'
  if (_ugcState.captions.length) {
    html += '<div class="ugc-card"><div class="ugc-card-header"><span class="ugc-card-label">字幕关键句</span></div>'
      + '<div class="ugc-caption-list">'
      + _ugcState.captions.map(function(c){ return '<div class="ugc-caption-item">▸ '+esc(c)+'</div>' }).join('')
      + '</div>'
      + '<button class="btn-secondary" style="margin-top:12px;font-size:12px;padding:7px 14px" onclick="ugcSendToCoverPost()">→ 带入封面 + 贴文</button></div>'
  }
  el.innerHTML = html
}

function ugcSendToCoverPost() {
  // Pre-fill cover and post input fields when user switches to those tabs
  _ugcTabInit.coverScript = _ugcState.script
  _ugcTabInit.postScript  = _ugcState.script
  var tab = document.getElementById('ugc-t-cover')
  ugcShowTab('cover', tab)
  toast('脚本已带入封面工坊', 'success')
}

// ── Cover ──
function ugcBuildCover(el) {
  var prefill = _ugcTabInit.coverScript || ''
  delete _ugcTabInit.coverScript
  var html = '<div class="ugc-section-title">🎨 封面套件</div>'
    + '<div class="ugc-section-sub">大标 + 小标 + Hook × 3语</div>'
    + '<div class="ugc-card">'
    + '<label class="ugc-field-label">字幕 / 脚本内容</label>'
    + '<textarea id="ugcCoverInput" rows="6" style="width:100%;background:#f9f9f9;border:1px solid #e5e5e5;border-radius:8px;color:#111;font-family:inherit;font-size:13px;padding:10px 12px;outline:none;resize:vertical;margin-bottom:14px" placeholder="贴入字幕或脚本内容…">'+esc(prefill)+'</textarea>'
    + '<div class="ugc-grid2" style="margin-bottom:16px">'
    + '<div><label class="ugc-field-label">产品线</label>'+ugcProdOpts('ugccProd')+'</div>'
    + '<div><label class="ugc-field-label">目标受众</label>'+ugcAudOpts('ugccAud')+'</div>'
    + '</div>'
    + '<button class="btn-primary" id="ugccBtnGen" onclick="ugcGenCover(this)" style="width:100%;justify-content:center">⚡ 生成封面套件</button></div>'
    + '<div id="ugccErr" style="display:none;background:#fff0f0;border:1px solid #fca5a5;border-radius:8px;padding:12px;color:#dc2626;font-size:12px;margin-bottom:12px"></div>'
    + '<div id="ugccResult"></div>'
  el.innerHTML = html
  if (_ugcState.covers) ugcRenderCoverResult()
}

async function ugcGenCover(btn) {
  var ta = document.getElementById('ugcCoverInput')
  if (!ta || !ta.value.trim()) { ugcShowErr('ugccErr','请先贴入内容。'); return }
  var prod = document.getElementById('ugccProd'), aud = document.getElementById('ugccAud')
  btn.disabled = true; btn.textContent = '生成中…'
  ugcHideErr('ugccErr')
  try {
    var r = await fetch(EDGE_URL, {method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+SUPABASE_ANON},
      body:JSON.stringify(orchBody({action:'ugc_generate', type:'cover',
        product:prod?prod.value:'ultra_cleaning', audience:aud?aud.value:'general',
        content:ta.value.trim()}))})
    var d = await r.json()
    if (!d.ok) throw new Error(d.error||'生成失败')
    _ugcState.covers = ugcParseJSON(d.result)
    ugcRenderCoverResult()
  } catch(e) { ugcShowErr('ugccErr', e.message) }
  btn.disabled = false; btn.textContent = '⚡ 生成封面套件'
}

function ugcRenderCoverResult() {
  var el = document.getElementById('ugccResult')
  if (!el || !_ugcState.covers) return
  var data = _ugcState.covers
  var TYPE_LABEL = {resonance:'共鸣型',curiosity:'好奇型',disbelief:'质疑型'}
  var html = '<div class="ugc-card"><div class="ugc-card-header"><span class="ugc-card-label">封面套件</span></div>'
    + '<div class="ugc-lang-tabs">'
    + UGC_LANGS.map(function(l,i){ return '<button class="ugc-lang-tab'+(i===0?' active':'')+'" onclick="ugcLangSwitch(this,\'ugcc-lang\',\''+l.v+'\')">' + l.f+' '+l.n+'</button>' }).join('')
    + '</div>'
  UGC_LANGS.forEach(function(lang, i) {
    var d = data[lang.v] || {}
    var active = i===0 ? ' active' : ''
    html += '<div class="ugc-lang-panel'+active+'" id="ugcc-lang-'+lang.v+'">'
    // Covers
    html += '<div class="ugc-result"><div class="ugc-result-head"><span class="ugc-result-tag">封面标题</span></div>'
      + '<div class="ugc-result-body"><div class="ugc-cover-grid">'
    var covers = d.covers || []
    covers.forEach(function(c, ci) {
      html += '<div class="ugc-cover-card"><div class="ugc-cover-tag">V'+(ci+1)+' · '+(TYPE_LABEL[c.type]||c.type||'')+'</div>'
        + '<div class="ugc-cover-main">'+esc(c.main||'')+'</div>'
        + '<div class="ugc-cover-sub">'+esc(c.sub||'')+'</div></div>'
    })
    html += '</div></div></div>'
    // Hook
    html += '<div class="ugc-result" style="margin-top:10px"><div class="ugc-result-head"><span class="ugc-result-tag">前3秒 Hook</span>'
      + '<button class="btn-secondary btn-sm" onclick="ugcCopy(\''+esc(d.hook||'').replace(/'/g,'&#x27;')+'\',this)">复制</button></div>'
      + '<div class="ugc-result-body"><div class="ugc-hook">&#x201c;'+esc(d.hook||'')+'&#x201d;</div></div></div>'
    // Keywords
    html += '<div class="ugc-result" style="margin-top:10px"><div class="ugc-result-head"><span class="ugc-result-tag">痛点关键词</span></div>'
      + '<div class="ugc-result-body"><div class="ugc-kw-list">'
    var kws = d.keywords || []
    kws.forEach(function(k) { html += '<span class="ugc-kw'+(k.hot?' hot':'')+'">'+( k.hot?'🔥 ':'')+esc(k.word||k)+'</span>' })
    html += '</div></div></div></div>'
  })
  html += '</div>'
  el.innerHTML = html
}

// ── Post ──
function ugcBuildPost(el) {
  var prefill = _ugcTabInit.postScript || ''
  delete _ugcTabInit.postScript
  var html = '<div class="ugc-section-title">📱 社群贴文</div>'
    + '<div class="ugc-section-sub">选平台 → 按各平台规则生成完整贴文 × 3语</div>'
    + '<div class="ugc-card">'
    + '<label class="ugc-field-label">字幕 / 脚本内容</label>'
    + '<textarea id="ugcPostInput" rows="6" style="width:100%;background:#f9f9f9;border:1px solid #e5e5e5;border-radius:8px;color:#111;font-family:inherit;font-size:13px;padding:10px 12px;outline:none;resize:vertical;margin-bottom:14px" placeholder="贴入字幕或脚本内容…">'+esc(prefill)+'</textarea>'
    + '<div class="ugc-grid2" style="margin-bottom:14px">'
    + '<div><label class="ugc-field-label">产品线</label>'+ugcProdOpts('ugcpProd')+'</div>'
    + '<div><label class="ugc-field-label">目标受众</label>'+ugcAudOpts('ugcpAud')+'</div>'
    + '</div>'
    + '<div style="margin-bottom:16px"><label class="ugc-field-label">选择平台（最多3个）<span id="ugcpCnt" style="color:#da0d15;margin-left:8px">已选 '+_ugcState.selPlatforms.length+'/3</span></label>'
    + '<div class="ugc-platform-grid" id="ugcpGrid">'
    + UGC_PLATFORMS.map(function(p) {
        var sel = _ugcState.selPlatforms.indexOf(p.v) >= 0 ? ' sel' : ''
        return '<div class="ugc-platform-check'+sel+'" id="ugcpc-'+p.v+'" onclick="ugcTogglePlat(\''+p.v+'\')">'+p.i+' '+p.l+'</div>'
      }).join('')
    + '</div></div>'
    + '<button class="btn-primary" id="ugcpBtnGen" onclick="ugcGenPost(this)" style="width:100%;justify-content:center">⚡ 生成社群贴文</button></div>'
    + '<div id="ugcpErr" style="display:none;background:#fff0f0;border:1px solid #fca5a5;border-radius:8px;padding:12px;color:#dc2626;font-size:12px;margin-bottom:12px"></div>'
    + '<div id="ugcpResult"></div>'
  el.innerHTML = html
  if (_ugcState.posts) ugcRenderPostResult()
}

function ugcTogglePlat(v) {
  var el = document.getElementById('ugcpc-'+v)
  if (!el) return
  var idx = _ugcState.selPlatforms.indexOf(v)
  if (idx >= 0) { _ugcState.selPlatforms.splice(idx,1); el.classList.remove('sel') }
  else {
    if (_ugcState.selPlatforms.length >= 3) { ugcShowErr('ugcpErr','每次最多选3个平台。'); return }
    _ugcState.selPlatforms.push(v); el.classList.add('sel')
  }
  ugcHideErr('ugcpErr')
  var cnt = document.getElementById('ugcpCnt')
  if (cnt) cnt.textContent = '已选 '+_ugcState.selPlatforms.length+'/3'
}

async function ugcGenPost(btn) {
  var ta = document.getElementById('ugcPostInput')
  if (!ta || !ta.value.trim()) { ugcShowErr('ugcpErr','请先贴入内容。'); return }
  if (!_ugcState.selPlatforms.length) { ugcShowErr('ugcpErr','请至少选一个平台。'); return }
  var prod = document.getElementById('ugcpProd'), aud = document.getElementById('ugcpAud')
  btn.disabled = true; btn.textContent = '生成中…'
  ugcHideErr('ugcpErr')
  try {
    var r = await fetch(EDGE_URL, {method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+SUPABASE_ANON},
      body:JSON.stringify(orchBody({action:'ugc_generate', type:'post',
        product:prod?prod.value:'ultra_cleaning', audience:aud?aud.value:'general',
        content:ta.value.trim(), platforms:_ugcState.selPlatforms}))})
    var d = await r.json()
    if (!d.ok) throw new Error(d.error||'生成失败')
    _ugcState.posts = {data:ugcParseJSON(d.result), platforms:_ugcState.selPlatforms.slice()}
    ugcRenderPostResult()
  } catch(e) { ugcShowErr('ugcpErr', e.message) }
  btn.disabled = false; btn.textContent = '⚡ 生成社群贴文'
}

function ugcRenderPostResult() {
  var el = document.getElementById('ugcpResult')
  if (!el || !_ugcState.posts) return
  var pdata = _ugcState.posts.data, pplats = _ugcState.posts.platforms || []
  var html = ''
  pplats.forEach(function(pv) {
    var pInfo = UGC_PLATFORMS.find(function(p){ return p.v===pv }) || {l:pv,i:''}
    html += '<div class="ugc-card"><div class="ugc-card-header"><span class="ugc-card-label">'+pInfo.i+' '+pInfo.l+'</span></div>'
      + '<div class="ugc-lang-tabs">'
      + UGC_LANGS.map(function(l,i){ return '<button class="ugc-lang-tab'+(i===0?' active':'')+'" onclick="ugcLangSwitch(this,\'ugcp-'+pv+'\',\''+l.v+'\')">' + l.f+' '+l.n+'</button>' }).join('')
      + '</div>'
    UGC_LANGS.forEach(function(lang, i) {
      var text = ''
      try { text = pdata[lang.v][pv] || '' } catch(e) {}
      var active = i===0 ? ' active' : ''
      var safeTxt = text.replace(/\\/g,'\\\\').replace(/'/g,'&#x27;').replace(/\n/g,'\\n')
      html += '<div class="ugc-lang-panel'+active+'" id="ugcp-'+pv+'-'+lang.v+'">'
        + '<div class="ugc-result"><div class="ugc-result-head"><span class="ugc-result-tag">贴文内容</span>'
        + '<button class="btn-secondary btn-sm" onclick="ugcCopy(\''+safeTxt+'\'.replace(/\\\\n/g,\'\\n\'),this)">复制</button></div>'
        + '<div class="ugc-result-body"><div class="ugc-post-body">'+esc(text).replace(/\n/g,'<br>')+'</div></div></div></div>'
    })
    html += '</div>'
  })
  el.innerHTML = html
}

// ── Preview ──
function ugcBuildPreview(el) {
  var has = _ugcState.script || _ugcState.covers || _ugcState.posts
  if (!has) { el.innerHTML = '<div style="text-align:center;padding:60px 20px;color:var(--ink-5)"><div style="font-size:40px;margin-bottom:12px">📄</div><p>还没有生成任何内容。先到各 Tab 生成后再回来。</p></div>'; return }
  var html = '<div class="ugc-section-title">📄 完整预览</div>'
    + '<div style="display:flex;gap:10px;margin-bottom:20px">'
    + '<button class="btn-secondary" style="font-size:12px;padding:7px 14px" onclick="window.print()">🖨️ 打印 / PDF</button>'
    + '<button class="btn-secondary" style="font-size:12px;padding:7px 14px" onclick="ugcCopyAll()">📋 复制全部</button>'
    + '</div>'
  if (_ugcState.script) {
    html += '<div style="margin-bottom:20px"><div style="font-size:14px;font-weight:700;color:#da0d15;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #e5e5e5">✍️ 旁白脚本</div>'
      + '<div class="ugc-script-body" style="border:1px solid #e5e5e5;border-radius:8px">'+_ugcState.script.replace(/\n/g,'<br>')+'</div>'
    if (_ugcState.captions.length) {
      html += '<div class="ugc-caption-list" style="margin-top:8px">'
        + _ugcState.captions.map(function(c){ return '<div class="ugc-caption-item">▸ '+esc(c)+'</div>' }).join('')
        + '</div>'
    }
    html += '</div>'
  }
  if (_ugcState.covers) {
    html += '<div style="margin-bottom:20px"><div style="font-size:14px;font-weight:700;color:#da0d15;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #e5e5e5">🎨 封面套件</div>'
    UGC_LANGS.forEach(function(lang) {
      var d = _ugcState.covers[lang.v] || {}
      html += '<div class="ugc-card" style="margin-bottom:8px"><div style="font-size:11px;font-weight:600;color:var(--ink-5);margin-bottom:8px">'+lang.f+' '+lang.n+'</div>'
        + '<div style="font-size:13px;line-height:1.8;white-space:pre-wrap;color:#111">'
        + (d.covers||[]).map(function(c,i){ return 'V'+(i+1)+' 大标：'+esc(c.main||'')+'\nV'+(i+1)+' 小标：'+esc(c.sub||'') }).join('\n')
        + (d.hook ? '\nHook：'+esc(d.hook) : '')
        + '</div></div>'
    })
    html += '</div>'
  }
  if (_ugcState.posts && _ugcState.posts.data) {
    html += '<div style="margin-bottom:20px"><div style="font-size:14px;font-weight:700;color:#da0d15;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #e5e5e5">📱 社群贴文</div>';
    (_ugcState.posts.platforms||[]).forEach(function(pv) {
      var pInfo = UGC_PLATFORMS.find(function(p){ return p.v===pv }) || {l:pv,i:''}
      html += '<div style="margin-bottom:14px"><div style="font-size:12px;font-weight:600;color:#555;margin-bottom:8px">'+pInfo.i+' '+pInfo.l+'</div>'
      UGC_LANGS.forEach(function(lang) {
        var text = ''
        try { text = _ugcState.posts.data[lang.v][pv] || '' } catch(e) {}
        if (!text) return
        html += '<div class="ugc-card" style="margin-bottom:8px"><div style="font-size:11px;font-weight:600;color:var(--ink-5);margin-bottom:8px">'+lang.f+' '+lang.n+'</div>'
          + '<div style="font-size:13px;line-height:1.8;white-space:pre-wrap;color:#111">'+esc(text)+'</div></div>'
      })
      html += '</div>'
    })
    html += '</div>'
  }
  el.innerHTML = html
}

// ── Shared helpers ──
function ugcLangSwitch(btn, prefix, lang) {
  var parent = btn.closest('.ugc-card')
  if (!parent) return
  parent.querySelectorAll('.ugc-lang-tab').forEach(function(t){ t.classList.remove('active') })
  parent.querySelectorAll('.ugc-lang-panel').forEach(function(p){ p.classList.remove('active') })
  btn.classList.add('active')
  var panel = document.getElementById(prefix+'-'+lang)
  if (panel) panel.classList.add('active')
}

function ugcParseJSON(raw) {
  var s = String(raw).replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim()
  var start = s.search(/[{[]/)
  if (start < 0) return {}
  var open = s[start], close = open==='{' ? '}' : ']', depth=0, end=-1
  for (var i=start;i<s.length;i++) {
    if (s[i]===open) depth++
    else if (s[i]===close) { depth--; if(depth===0){ end=i; break } }
  }
  var chunk = end >= 0 ? s.slice(start, end+1) : s.slice(start)
  try { return JSON.parse(chunk) } catch(e1) {
    try {
      var out='', inStr=false, esc2=false
      for (var j=0;j<chunk.length;j++) {
        var ch=chunk[j]
        if (esc2){ out+=ch; esc2=false; continue }
        if (ch==='\\'){ out+=ch; esc2=true; continue }
        if (ch==='"') {
          if (inStr) {
            var rest=chunk.slice(j+1).replace(/^[\s\n\r]*/,'')
            if (rest[0]===':'||rest[0]===','||rest[0]==='}'||rest[0]===']'){ inStr=false; out+=ch }
            else out+='\\"'
            continue
          } else { inStr=true; out+=ch; continue }
        }
        if (inStr){ if(ch==='\n')out+='\\n'; else if(ch==='\r')out+='\\r'; else if(ch==='\t')out+='\\t'; else out+=ch }
        else out+=ch
      }
      return JSON.parse(out.replace(/,\s*([}\]])/g,'$1'))
    } catch(e2) { return {} }
  }
}

function ugcShowErr(id, msg) { var el=document.getElementById(id); if(el){ el.textContent=msg; el.style.display='block' } }
function ugcHideErr(id) { var el=document.getElementById(id); if(el) el.style.display='none' }

function ugcCopy(text, btn) {
  navigator.clipboard.writeText(text).then(function() {
    var orig=btn.textContent; btn.textContent='✓ 已复制'
    setTimeout(function(){ btn.textContent=orig }, 1500)
  })
}

function ugcCopyAll() {
  var lines = []
  if (_ugcState.script) {
    lines.push('=== 旁白脚本 ===\n'+_ugcState.script)
    if (_ugcState.captions.length) lines.push('\n--- 字幕关键句 ---\n'+_ugcState.captions.map(function(c){ return '▸ '+c }).join('\n'))
  }
  if (_ugcState.covers) {
    lines.push('\n=== 封面套件 ===')
    UGC_LANGS.forEach(function(l) {
      var d=_ugcState.covers[l.v]||{}
      lines.push(l.f+' '+l.n)
      if (d.covers) d.covers.forEach(function(c,i){ lines.push('V'+(i+1)+' 大标：'+c.main+' | 小标：'+c.sub) })
      if (d.hook) lines.push('Hook：'+d.hook)
    })
  }
  if (_ugcState.posts && _ugcState.posts.data) {
    lines.push('\n=== 社群贴文 ===');
    (_ugcState.posts.platforms||[]).forEach(function(pv) {
      var pInfo=UGC_PLATFORMS.find(function(p){ return p.v===pv })||{l:pv,i:''}
      lines.push('\n'+pInfo.i+' '+pInfo.l)
      UGC_LANGS.forEach(function(l) {
        var t=''; try{ t=_ugcState.posts.data[l.v][pv]||'' }catch(e){}
        if (t) lines.push('\n'+l.f+' '+l.n+'\n'+t)
      })
    })
  }
  navigator.clipboard.writeText(lines.join('\n')).then(function(){ toast('已复制全部内容！','success') })
}

// ── Toast notifications ──────────────────────────────────────────────
function toast(msg, type='success') {
  let t = document.getElementById('toastEl')
  if (!t) {
    t = document.createElement('div')
    t.id = 'toastEl'
    t.style.cssText = 'position:fixed;bottom:28px;right:28px;padding:10px 18px;border-radius:8px;font-size:13px;z-index:9999;transition:opacity .3s;pointer-events:none;font-family:inherit'
    document.body.appendChild(t)
  }
  t.textContent = msg
  const colors = { error:['#ef444422','#ef4444','#ef444440'], info:['#3b82f622','#3b82f6','#3b82f640'], success:['#22c55e22','#22c55e','#22c55e40'] }
  const [bg,fg,bd] = colors[type] || colors.success
  t.style.background = bg; t.style.color = fg; t.style.border = `1px solid ${bd}`
  t.style.opacity = '1'
  clearTimeout(t._timer)
  t._timer = setTimeout(() => { t.style.opacity = '0' }, 2500)
}

// ── Tasks ─────────────────────────────────────────────────────────────
const STATUS_LABEL = { todo:'待办', in_progress:'进行中', done:'完成' }
const PRIORITY_NEXT = { todo:'in_progress', in_progress:'done', done:'todo' }
const PRIORITY_ICON = { high:'🔴', normal:'⚪', low:'🟢' }

async function loadTasks() {
  const el = document.getElementById('tasksContent')
  const sf = document.getElementById('taskStatusFilter')?.value
  const af = document.getElementById('taskAssigneeFilter')?.value
  el.innerHTML = '<p style="color:var(--ink-5);font-size:13px">加载中…</p>'
  // Pre-load staff into dropdowns on first call
  if (!_msgStaff.length) {
    const { data } = await db.from('staff').select('id,name,avatar').eq('active',true).order('name')
    _msgStaff = data || []
    const af2 = document.getElementById('taskAssigneeFilter')
    const as2 = document.getElementById('taskAssignee')
    if (af2) af2.innerHTML = '<option value="">全部负责人</option>' + _msgStaff.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')
    if (as2) as2.innerHTML = '<option value="">未分配</option>' + _msgStaff.map(s=>`<option value="${s.id}">${s.avatar||'👤'} ${esc(s.name)}</option>`).join('')
  }
  let q = db.from('tasks').select('*,assignee:assignee_id(id,name,avatar),creator:created_by(id,name)').order('created_at', {ascending:false})
  if (sf) q = q.eq('status', sf)
  if (af) q = q.eq('assignee_id', af)
  const { data, error } = await q
  if (error) { el.innerHTML = `<p style="color:#da0d15;font-size:13px">加载失败：${esc(error.message)}</p>`; return }
  const tasks = data || []
  document.getElementById('tasksCount').textContent = tasks.length ? `共 ${tasks.length} 条` : ''
  if (!tasks.length) { el.innerHTML = '<p style="color:var(--ink-5);font-size:13px;padding:20px 0">暂无任务，点击「创建任务」开始</p>'; return }
  el.innerHTML = tasks.map(t => {
    const due = t.due_date ? new Date(t.due_date) : null
    const overdue = due && t.status !== 'done' && due < new Date()
    const dueStr = due ? due.toLocaleDateString('zh-CN',{month:'short',day:'numeric'}) : ''
    const assigneeName = t.assignee?.name || '未分配'
    const assigneeAvatar = t.assignee?.avatar || '👤'
    return `<div class="task-item">
      <div class="task-check ${t.status}" onclick="cycleTaskStatus('${t.id}','${t.status}')" title="点击切换状态">
        ${t.status==='done' ? '✓' : t.status==='in_progress' ? '…' : ''}
      </div>
      <div class="task-main">
        <div class="task-title ${t.status==='done'?'done':''}">${esc(t.title)}</div>
        <div class="task-meta">
          <span class="task-badge priority-${t.priority}">${PRIORITY_ICON[t.priority]||''} ${t.priority==='high'?'高':t.priority==='low'?'低':'普通'}</span>
          <span style="font-size:11px;color:var(--ink-5)">${assigneeAvatar} ${esc(assigneeName)}</span>
          ${dueStr ? `<span style="font-size:11px;color:${overdue?'#da0d15':'#aaa'}">${overdue?'⚠️ ':'📅 '}${dueStr}</span>` : ''}
          <span style="font-size:11px;color:var(--ink-4)">${STATUS_LABEL[t.status]||t.status}</span>
        </div>
        ${t.description ? `<div style="font-size:12px;color:var(--ink-3);margin-top:3px">${esc(t.description)}</div>` : ''}
      </div>
      <div class="task-actions">
        <button onclick='editTask(${JSON.stringify(t).replace(/'/g,"&#x27;")})' style="background:#f5f5f5;border:1px solid #e0e0e0;border-radius:6px;padding:4px 10px;color:#555;font-size:11px;cursor:pointer">编辑</button>
        <button onclick="deleteTask('${t.id}')" style="background:#fff5f5;border:1px solid #fca5a5;border-radius:6px;padding:4px 10px;color:#dc2626;font-size:11px;cursor:pointer">删除</button>
      </div>
    </div>`
  }).join('')
}

async function cycleTaskStatus(id, current) {
  const next = PRIORITY_NEXT[current] || 'todo'
  await db.from('tasks').update({ status: next, updated_at: new Date().toISOString() }).eq('id', id)
  loadTasks()
}

function showTaskModal() {
  document.getElementById('taskId').value = ''
  document.getElementById('taskTitle').value = ''
  document.getElementById('taskDesc').value = ''
  document.getElementById('taskAssignee').value = ''
  document.getElementById('taskPriority').value = 'normal'
  document.getElementById('taskDue').value = ''
  document.getElementById('taskErr').textContent = ''
  document.getElementById('taskModalTitle').textContent = '创建任务'
  document.getElementById('taskModal').style.display = 'flex'
}

function editTask(t) {
  document.getElementById('taskId').value = t.id
  document.getElementById('taskTitle').value = t.title || ''
  document.getElementById('taskDesc').value = t.description || ''
  document.getElementById('taskAssignee').value = t.assignee_id || ''
  document.getElementById('taskPriority').value = t.priority || 'normal'
  document.getElementById('taskDue').value = t.due_date || ''
  document.getElementById('taskErr').textContent = ''
  document.getElementById('taskModalTitle').textContent = '编辑任务'
  document.getElementById('taskModal').style.display = 'flex'
}

async function saveTask() {
  const id    = document.getElementById('taskId').value
  const title = document.getElementById('taskTitle').value.trim()
  const errEl = document.getElementById('taskErr')
  if (!title) { errEl.textContent = '请填写任务标题'; return }
  errEl.textContent = '保存中…'
  const payload = {
    title,
    description:  document.getElementById('taskDesc').value.trim() || null,
    assignee_id:  document.getElementById('taskAssignee').value || null,
    priority:     document.getElementById('taskPriority').value,
    due_date:     document.getElementById('taskDue').value || null,
    updated_at:   new Date().toISOString(),
    created_by:   _msgMyId || null,
    tenant_id:    'default',
  }
  const { error } = id
    ? await db.from('tasks').update(payload).eq('id', id)
    : await db.from('tasks').insert(payload)
  if (error) { errEl.textContent = error.message; return }
  document.getElementById('taskModal').style.display = 'none'
  toast('任务已保存', 'success')
  loadTasks()
}

async function deleteTask(id) {
  if (!confirm('确定删除此任务？')) return
  await db.from('tasks').delete().eq('id', id)
  toast('已删除', 'success')
  loadTasks()
}

// ── Staff ─────────────────────────────────────────────────────────────
async function loadStaffPage() {
  const el = document.getElementById('staffContent')
  const { data, error } = await db.from('staff').select('*').order('name')
  if (error) { el.innerHTML = `<p style="color:#da0d15;font-size:13px">${esc(error.message)}</p>`; return }
  const staff = data || []
  if (!staff.length) { el.innerHTML = '<p style="color:var(--ink-5);font-size:13px">暂无员工，点击「添加员工」</p>'; return }
  el.innerHTML = `<div style="background:#fff;border:1px solid #e5e5e5;border-radius:10px;overflow:hidden">` +
    staff.map((s, i) => `
    <div class="staff-item" style="${i < staff.length-1 ? 'border-bottom:1px solid #f0f0f0' : ''}">
      <div class="msg-avatar" style="font-size:20px">${s.avatar||'👤'}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:#111">${esc(s.name)}</div>
        <div style="font-size:12px;color:var(--ink-3);margin-top:2px">${esc(s.role||'')}${s.role&&s.department?' · ':''}${esc(s.department||'')}</div>
        <div style="font-size:11px;color:var(--ink-4);margin-top:1px">${s.id}</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
        <span style="width:8px;height:8px;border-radius:50%;background:${s.active?'#16a34a':'#e5e5e5'};display:inline-block"></span>
        <button onclick='editStaff(${JSON.stringify(s)})' style="background:#f5f5f5;border:1px solid #e0e0e0;border-radius:6px;padding:4px 12px;color:#555;font-size:12px;cursor:pointer">编辑</button>
        <button onclick="toggleStaffActive('${s.id}',${!s.active})" style="background:#f5f5f5;border:1px solid #e0e0e0;border-radius:6px;padding:4px 12px;color:#555;font-size:12px;cursor:pointer">${s.active?'停用':'启用'}</button>
      </div>
    </div>`).join('') + `</div>`
}

function showStaffModal() {
  document.getElementById('staffIdField').value = ''
  document.getElementById('staffAvatar').value = ''
  document.getElementById('staffName').value = ''
  document.getElementById('staffRole').value = ''
  document.getElementById('staffDept').value = ''
  document.getElementById('staffErr').textContent = ''
  document.getElementById('staffModalTitle').textContent = '添加员工'
  document.getElementById('staffModal').style.display = 'flex'
}

function editStaff(s) {
  document.getElementById('staffIdField').value = s.id
  document.getElementById('staffAvatar').value = s.avatar || ''
  document.getElementById('staffName').value = s.name || ''
  document.getElementById('staffRole').value = s.role || ''
  document.getElementById('staffDept').value = s.department || ''
  document.getElementById('staffErr').textContent = ''
  document.getElementById('staffModalTitle').textContent = '编辑员工'
  document.getElementById('staffModal').style.display = 'flex'
}

async function saveStaff() {
  const id   = document.getElementById('staffIdField').value
  const name = document.getElementById('staffName').value.trim()
  const errEl = document.getElementById('staffErr')
  if (!name) { errEl.textContent = '请填写姓名'; return }
  errEl.textContent = '保存中…'
  const payload = {
    name,
    avatar:     document.getElementById('staffAvatar').value.trim() || null,
    role:       document.getElementById('staffRole').value.trim() || null,
    department: document.getElementById('staffDept').value.trim() || null,
    tenant_id:  'default',
  }
  const { error } = id
    ? await db.from('staff').update(payload).eq('id', id)
    : await db.from('staff').insert(payload)
  if (error) { errEl.textContent = error.message; return }
  document.getElementById('staffModal').style.display = 'none'
  toast('员工已保存', 'success')
  loadStaffPage()
  // Refresh staff lists elsewhere
  _msgStaff = []
}

async function toggleStaffActive(id, active) {
  await db.from('staff').update({ active }).eq('id', id)
  loadStaffPage()
  _msgStaff = []
}

// ── Messaging ────────────────────────────────────────────────────────
let _msgStaff = []
let _msgMyId  = null
let _msgPeerId = null
let _dmChannel = null

async function loadMsgPage() {
  const { data } = await db.from('staff').select('*').eq('active', true).order('name')
  _msgStaff = data || []
  const sel = document.getElementById('msgMyId')
  sel.innerHTML = _msgStaff.map(s => `<option value="${s.id}">${s.avatar||'👤'} ${esc(s.name)}</option>`).join('')
  _msgMyId = _msgStaff[0]?.id || null
  renderMsgContacts()
  subscribeRealtime()
}

function switchMsgIdentity() {
  _msgMyId = document.getElementById('msgMyId').value
  _msgPeerId = null
  renderMsgContacts()
  document.getElementById('msgThreadWrap').innerHTML = `<div class="msg-no-contact"><span style="font-size:32px">💬</span><span>选择联系人开始对话</span></div>`
  subscribeRealtime()
}

function renderMsgContacts() {
  const contacts = _msgStaff.filter(s => s.id !== _msgMyId)
  const el = document.getElementById('msgContacts')
  if (!contacts.length) { el.innerHTML = '<p style="color:var(--ink-4);font-size:12px;padding:12px 10px">暂无联系人</p>'; return }
  el.innerHTML = contacts.map(s => `
    <div class="msg-contact-item${s.id === _msgPeerId ? ' active' : ''}" onclick="openDM('${s.id}')">
      <div class="msg-avatar">${s.avatar||'👤'}</div>
      <div>
        <div class="msg-contact-name">${esc(s.name)}</div>
        <div class="msg-contact-sub">${esc(s.role||s.department||'')}</div>
      </div>
    </div>`).join('')
}

async function openDM(peerId) {
  _msgPeerId = peerId
  const peer = _msgStaff.find(s => s.id === peerId)
  renderMsgContacts()
  // Build conversation UI
  document.getElementById('msgThreadWrap').innerHTML = `
    <div class="msg-thread-hd">
      <span>${peer?.avatar||'👤'}</span>
      <span>${esc(peer?.name||'')}</span>
      <span style="font-size:11px;color:var(--ink-5);font-weight:400;margin-left:4px">${esc(peer?.role||peer?.department||'')}</span>
    </div>
    <div class="msg-thread" id="msgThread"><p class="msg-empty">加载中…</p></div>
    <div class="msg-input-bar">
      <textarea id="msgInput" placeholder="输入消息… Enter 发送" rows="1"
        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendDM()}"
        oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px'"></textarea>
      <button class="msg-send-btn" onclick="sendDM()">发送</button>
    </div>`
  await loadMessages()
}

async function loadMessages() {
  if (!_msgMyId || !_msgPeerId) return
  const { data } = await db.from('direct_messages')
    .select('*')
    .or(`and(from_id.eq.${_msgMyId},to_id.eq.${_msgPeerId}),and(from_id.eq.${_msgPeerId},to_id.eq.${_msgMyId})`)
    .order('created_at', { ascending: true })
    .limit(100)
  renderMessages(data || [])
  await db.from('direct_messages').update({ read_at: new Date().toISOString() })
    .eq('to_id', _msgMyId).eq('from_id', _msgPeerId).is('read_at', null)
}

function renderMessages(msgs) {
  const el = document.getElementById('msgThread')
  if (!el) return
  if (!msgs.length) { el.innerHTML = '<p class="msg-empty">还没有消息，发一条试试 👋</p>'; return }
  el.innerHTML = msgs.map(m => dmBubble(m)).join('')
  el.scrollTop = el.scrollHeight
}

function dmBubble(m) {
  const sent = m.from_id === _msgMyId
  const time = new Date(m.created_at).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' })
  return `<div class="dm-row ${sent?'sent':'recv'}">
    <div class="dm-bubble">${esc(m.content)}<div class="dm-time">${time}</div></div>
  </div>`
}

function appendDM(msg) {
  const el = document.getElementById('msgThread')
  if (!el) return
  const empty = el.querySelector('.msg-empty')
  if (empty) empty.remove()
  const div = document.createElement('div')
  div.innerHTML = dmBubble(msg)
  el.appendChild(div.firstElementChild)
  el.scrollTop = el.scrollHeight
}

async function sendDM() {
  const input = document.getElementById('msgInput')
  if (!input) return
  const content = input.value.trim()
  if (!content || !_msgMyId || !_msgPeerId) return
  input.value = ''; input.style.height = 'auto'
  const { data, error } = await db.from('direct_messages')
    .insert({ from_id: _msgMyId, to_id: _msgPeerId, content, tenant_id: 'default' })
    .select().single()
  if (!error && data) appendDM(data)
}

function subscribeRealtime() {
  if (_dmChannel) { db.removeChannel(_dmChannel); _dmChannel = null }
  if (!_msgMyId) return
  _dmChannel = db.channel('dm_inbox_' + _msgMyId)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'direct_messages',
      filter: `to_id=eq.${_msgMyId}`
    }, payload => {
      const msg = payload.new
      if (_msgPeerId && msg.from_id === _msgPeerId) {
        appendDM(msg)
        db.from('direct_messages').update({ read_at: new Date().toISOString() }).eq('id', msg.id)
      } else {
        // Show unread badge for a different contact
        const badge = document.getElementById('msgUnreadBadge')
        if (badge) { badge.style.display = ''; badge.textContent = '●' }
      }
    })
    .subscribe()
}

// ── Skills Page ──────────────────────────────────────────────────────
const AGENT_META = {
  chat:      { icon: '💬', label: 'Chat Agent' },
  crm:       { icon: '👥', label: 'CRM Agent' },
  account:   { icon: '💰', label: 'Account Agent' },
  code:      { icon: '💻', label: 'Code Agent' },
  cpl:       { icon: '📊', label: 'CPL Agent' },
  cpr:       { icon: '📈', label: 'CPR Agent' },
  frequency: { icon: '🔁', label: 'Frequency Agent' },
}
let skillsCurrentAgent = null
let skillsData = {}   // { agentId: [skill rows] }

async function loadSkillsPage() {
  const listEl = document.getElementById('skillsAgentList')
  listEl.innerHTML = '<div style="padding:20px;text-align:center;color:#333;font-size:12px">加载中…</div>'

  // Load all agents + all skills in parallel
  const [{ data: agents }, { data: skills }] = await Promise.all([
    db.from('agents').select('id,name,active').order('id'),
    db.from('agent_skills').select('id,agent,skill,created_at').order('created_at', { ascending: false })
  ])

  // Group skills by agent
  skillsData = {}
  ;(skills || []).forEach(s => {
    if (!skillsData[s.agent]) skillsData[s.agent] = []
    skillsData[s.agent].push(s)
  })

  // Render agent list
  listEl.innerHTML = ''
  ;(agents || []).forEach(a => {
    const cnt = (skillsData[a.id] || []).length
    const meta = AGENT_META[a.id] || { icon: '🤖', label: a.name }
    const btn = document.createElement('button')
    btn.className = 'skills-agent-btn' + (skillsCurrentAgent === a.id ? ' active' : '')
    btn.dataset.id = a.id
    btn.innerHTML = `
      <span class="skills-agent-icon">${meta.icon}</span>
      <span class="skills-agent-name">${meta.label}</span>
      <span class="skills-badge${cnt > 0 ? ' has' : ''}">${cnt}</span>`
    btn.onclick = () => selectSkillsAgent(a.id, meta, btn)
    listEl.appendChild(btn)
  })

  // If an agent was previously selected, re-render its panel
  if (skillsCurrentAgent) {
    const activeBtn = listEl.querySelector(`[data-id="${skillsCurrentAgent}"]`)
    if (activeBtn) renderSkillsPanel(skillsCurrentAgent, AGENT_META[skillsCurrentAgent] || { icon: '🤖', label: skillsCurrentAgent })
  }
}

function selectSkillsAgent(agentId, meta, btn) {
  document.querySelectorAll('.skills-agent-btn').forEach(b => b.classList.remove('active'))
  btn.classList.add('active')
  skillsCurrentAgent = agentId
  renderSkillsPanel(agentId, meta)
}

function renderSkillsPanel(agentId, meta) {
  const panel = document.getElementById('skillsPanel')
  const list = skillsData[agentId] || []

  const clearBtn = list.length > 0
    ? `<button class="btn-danger" style="font-size:12px;padding:6px 14px" onclick="clearAgentSkills('${agentId}')">清空全部</button>`
    : ''

  panel.innerHTML = `
    <div class="skills-toolbar">
      <h3>${meta.icon} ${meta.label} <span style="font-size:12px;color:#444;font-weight:400">— ${list.length} 条技能</span></h3>
      ${clearBtn}
    </div>
    <div class="skills-body" id="skillsBody-${agentId}">
      ${list.length === 0
        ? `<div class="skills-empty"><span>🌱</span><p>还没有积累任何技能</p><p style="font-size:11px;color:#222">给对话评分后自动学习</p></div>`
        : list.map(s => renderSkillCard(s)).join('')
      }
    </div>`
}

function renderSkillCard(s) {
  const lower = s.skill.toLowerCase()
  const isAvoid   = lower.startsWith('avoid')
  const isRouting = lower.startsWith('when ')
  const icon  = isRouting ? '🔀' : isAvoid ? '⚠️' : '✅'
  const label = isRouting ? 'routing' : isAvoid ? 'avoid' : 'skill'
  const date  = new Date(s.created_at).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return `
    <div class="skill-card" id="skill-${s.id}" style="${isRouting ? 'border-left:3px solid #ffd405;background:#fffdf0' : ''}">
      <span class="skill-type" title="${label}">${icon}</span>
      <div class="skill-content">
        <div class="skill-text">${esc(s.skill)}</div>
        <div class="skill-meta">${date}${isRouting ? ' · <span style="color:#6366f1;font-weight:500">路由规则</span>' : ''}</div>
      </div>
      <button class="skill-del" onclick="deleteSkill(${s.id},'${s.agent}')">删除</button>
    </div>`
}

async function deleteSkill(id, agentId) {
  const card = document.getElementById('skill-'+id)
  if (card) { card.style.opacity='0.4'; card.style.pointerEvents='none' }
  const { error } = await db.from('agent_skills').delete().eq('id', id)
  if (error) {
    toast('删除失败', 'error')
    if (card) { card.style.opacity=''; card.style.pointerEvents='' }
    return
  }
  // Remove from local cache
  if (skillsData[agentId]) {
    skillsData[agentId] = skillsData[agentId].filter(s => s.id !== id)
  }
  // Re-render panel + update badge
  const meta = AGENT_META[agentId] || { icon: '🤖', label: agentId }
  renderSkillsPanel(agentId, meta)
  updateSkillsBadge(agentId)
  toast('技能已删除', 'success')
}

async function clearAgentSkills(agentId) {
  if (!confirm(`确定清空 ${AGENT_META[agentId]?.label || agentId} 的全部技能？此操作不可撤销。`)) return
  const { error } = await db.from('agent_skills').delete().eq('agent', agentId)
  if (error) { toast('清空失败', 'error'); return }
  skillsData[agentId] = []
  const meta = AGENT_META[agentId] || { icon: '🤖', label: agentId }
  renderSkillsPanel(agentId, meta)
  updateSkillsBadge(agentId)
  toast('已清空技能库', 'success')
}

function updateSkillsBadge(agentId) {
  const btn = document.querySelector(`.skills-agent-btn[data-id="${agentId}"] .skills-badge`)
  if (!btn) return
  const cnt = (skillsData[agentId] || []).length
  btn.textContent = cnt
  btn.className = 'skills-badge' + (cnt > 0 ? ' has' : '')
}

// duplicate loadTenantsPage removed — definition kept at top of file
function showCreateTenantModal() {
  document.getElementById('newTenantName').value = ''
  document.getElementById('newTenantContact').value = ''
  document.getElementById('newTenantEmail').value = ''
  document.getElementById('createTenantErr').textContent = ''
  document.getElementById('createTenantModal').style.display = 'flex'
}
async function createTenant() {
  const name = document.getElementById('newTenantName').value.trim()
  const contact_name = document.getElementById('newTenantContact').value.trim()
  const contact_email = document.getElementById('newTenantEmail').value.trim()
  const errEl = document.getElementById('createTenantErr')
  if (!name) { errEl.textContent = '客户名称必填'; return }
  errEl.textContent = '创建中…'
  const r = await fetch(EDGE_URL, { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(orchBody({ action:'create_tenant', name, contact_name, contact_email })) })
  const d = await r.json()
  if (d.ok) {
    document.getElementById('createTenantModal').style.display = 'none'
    toast('客户已创建', 'success')
    loadTenantsPage()
  } else { errEl.textContent = d.error || '创建失败' }
}
async function toggleTenant(id, active) {
  const r = await fetch(EDGE_URL, { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(orchBody({ action:'update_tenant', tenant_id: id, active })) })
  const d = await r.json()
  if (d.ok) { toast(active?'已启用':'已停用', 'success'); loadTenantsPage() }
  else toast(d.error||'操作失败', 'error')
}

// ── Document Approval System ──────────────────────────────────────────
const DOC_STATUS = { pending:'⏳ 待审批', partial:'🔄 部分批准', approved:'✅ 已批准', rejected:'❌ 已拒绝' }
const DOC_STATUS_COLOR = { pending:'#f59e0b', partial:'#3b82f6', approved:'#16a34a', rejected:'#dc2626' }
const DOC_STATUS_BG = { pending:'#fffbeb', partial:'#eff6ff', approved:'#f0fdf4', rejected:'#fff5f5' }
let _docReviewers = []   // [{name,contact}] for upload form
let _currentDocId  = null // for detail modal
let _currentDoc    = null // full doc object (for notifications)

// ── Load list ─────────────────────────────────────────────────────────
async function loadDocs() {
  const wrap = document.getElementById('docsListWrap')
  if (!wrap) return
  wrap.innerHTML = '<p style="color:var(--ink-5);font-size:13px">加载中…</p>'
  const sf = document.getElementById('docStatusFilter')?.value || ''
  try {
    let q = db.from('documents').select('id,title,file_name,file_url,file_type,status,uploaded_by,notes,created_at')
               .order('created_at', { ascending: false }).limit(100)
    if (_session.tenant_id) q = q.eq('tenant_id', _session.tenant_id)
    if (sf) q = q.eq('status', sf)
    const { data: allDocs, error } = await q
    if (error) throw error
    // Member 只能看自己上传 + 自己是审批人的文件
    let docs = allDocs || []
    if (_session.role === 'member' && _session.email) {
      const { data: myRevDocs } = await db.from('document_reviewers')
        .select('document_id').eq('contact', _session.email)
      const myRevIds = new Set((myRevDocs || []).map(r => r.document_id))
      docs = docs.filter(d => d.uploaded_by === _session.email || myRevIds.has(d.id))
    }
    const badge = document.getElementById('docsCountBadge')
    if (badge) badge.textContent = docs?.length ? `共 ${docs.length} 条` : ''
    if (!docs || !docs.length) {
      wrap.innerHTML = '<div style="text-align:center;padding:48px 0;color:var(--ink-5);font-size:13px">暂无文件记录<br><span style="font-size:11px">点击「+ 上传文件」开始</span></div>'
      return
    }
    // load reviewer counts per doc
    const ids = docs.map(d => d.id)
    const { data: revs } = await db.from('document_reviewers')
      .select('document_id,decision').in('document_id', ids)
    const revMap = {}
    ;(revs || []).forEach(r => {
      if (!revMap[r.document_id]) revMap[r.document_id] = []
      revMap[r.document_id].push(r.decision)
    })
    wrap.innerHTML = `<div style="background:#fff;border:1px solid #e5e5e5;border-radius:10px;overflow:hidden">`
      + docs.map((doc, i) => {
        const revList = revMap[doc.id] || []
        const total = revList.length
        const approved = revList.filter(d => d === 'approved').length
        const rejected = revList.filter(d => d === 'rejected').length
        const revSummary = total ? `${approved}/${total} 批准${rejected ? '，'+rejected+' 拒绝' : ''}` : '无审批人'
        const ext = (doc.file_name || '').split('.').pop().toUpperCase() || '—'
        const st = doc.status || 'pending'
        return `<div style="display:flex;align-items:center;gap:14px;padding:14px 16px;${i < docs.length-1 ? 'border-bottom:1px solid #f0f0f0' : ''};cursor:pointer;transition:background .12s" onmouseover="this.style.background='#fafafa'" onmouseout="this.style.background=''" onclick="openDocDetail('${doc.id}')">
          <span style="font-size:22px;flex-shrink:0">${_docIcon(doc.file_type)}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:#111;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(doc.title)}</div>
            <div style="font-size:11px;color:var(--ink-5);margin-top:2px;display:flex;gap:8px;flex-wrap:wrap">
              <span>${ext}</span>
              ${doc.uploaded_by ? `<span>上传：${esc(doc.uploaded_by)}</span>` : ''}
              <span>${revSummary}</span>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0">
            <span style="padding:2px 9px;border-radius:4px;font-size:11px;font-weight:500;background:${DOC_STATUS_BG[st]};color:${DOC_STATUS_COLOR[st]}">${DOC_STATUS[st]||st}</span>
            <span style="font-size:11px;color:var(--ink-5)">${fmtTime(doc.created_at)}</span>
          </div>
        </div>`
      }).join('')
      + `</div>`
  } catch(e) {
    wrap.innerHTML = `<p style="color:#d11a13;font-size:13px">加载失败：${esc(e.message)}</p>`
  }
}

function _docIcon(mime) {
  if (!mime) return '📄'
  if (mime.includes('pdf')) return '📕'
  if (mime.includes('word') || mime.includes('document')) return '📝'
  if (mime.includes('excel') || mime.includes('sheet')) return '📊'
  if (mime.includes('image')) return '🖼️'
  if (mime.includes('text')) return '📃'
  return '📄'
}

// ── Upload modal ──────────────────────────────────────────────────────
let _uploadDocFile = null

function openUploadDocModal() {
  _uploadDocFile = null; _docReviewers = []
  ;['uploadDocTitle','uploadDocNotes','addReviewerName','addReviewerContact'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = ''
  })
  document.getElementById('uploadDocFileInfo').style.display = 'none'
  document.getElementById('uploadDocDropzone').style.display = 'block'
  document.getElementById('uploadDocErr').style.display = 'none'
  renderReviewerChips()
  document.getElementById('uploadDocModalBg').classList.add('open')
}

function closeUploadDocModal() {
  document.getElementById('uploadDocModalBg').classList.remove('open')
  _uploadDocFile = null; _docReviewers = []
}

function onUploadDocFileSelected(e) {
  const file = e.target.files[0]; if (!file) return
  _uploadDocFile = file
  document.getElementById('uploadDocDropzone').style.display = 'none'
  const info = document.getElementById('uploadDocFileInfo')
  info.style.display = 'flex'
  document.getElementById('uploadDocFileName').textContent = file.name
  document.getElementById('uploadDocFileSize').textContent = (file.size / 1024 / 1024).toFixed(1) + ' MB'
  if (!document.getElementById('uploadDocTitle').value) {
    document.getElementById('uploadDocTitle').value = file.name.replace(/\.[^.]+$/, '')
  }
}

function clearUploadDocFile() {
  _uploadDocFile = null
  document.getElementById('uploadDocFileInput').value = ''
  document.getElementById('uploadDocFileInfo').style.display = 'none'
  document.getElementById('uploadDocDropzone').style.display = 'block'
}

function addDocReviewer() {
  const name    = (document.getElementById('addReviewerName')?.value    || '').trim()
  const contact = (document.getElementById('addReviewerContact')?.value || '').trim()
  if (!name) { toast('请填写审批人姓名', 'error'); return }
  _docReviewers.push({ name, contact })
  document.getElementById('addReviewerName').value = ''
  document.getElementById('addReviewerContact').value = ''
  renderReviewerChips()
}

function removeDocReviewer(idx) {
  _docReviewers.splice(idx, 1)
  renderReviewerChips()
}

function renderReviewerChips() {
  const wrap = document.getElementById('reviewerChips')
  if (!wrap) return
  wrap.innerHTML = _docReviewers.map((r, i) =>
    `<span style="display:inline-flex;align-items:center;gap:5px;background:#f5f5f5;border:1px solid #e0e0e0;border-radius:20px;padding:3px 10px;font-size:12px;color:#333">
      <span>👤 ${esc(r.name)}${r.contact ? ' · '+esc(r.contact) : ''}</span>
      <button onclick="removeDocReviewer(${i})" style="border:none;background:none;color:var(--ink-5);cursor:pointer;font-size:13px;padding:0;line-height:1">✕</button>
    </span>`
  ).join('')
}

async function submitDocUpload() {
  const title = (document.getElementById('uploadDocTitle')?.value || '').trim()
  const notes = (document.getElementById('uploadDocNotes')?.value  || '').trim()
  const errEl = document.getElementById('uploadDocErr')
  const btn   = document.getElementById('submitDocBtn')
  if (!title)  { showDocErr('请填写文件标题'); return }
  if (!_docReviewers.length) { showDocErr('请至少添加一位审批人'); return }
  errEl.style.display = 'none'
  btn.disabled = true; btn.textContent = '上传中…'
  try {
    let file_url = null, file_name = null, file_type = null, file_size = null
    // 1. upload file to Storage (optional — can submit without file)
    if (_uploadDocFile) {
      const safeName = `${Date.now()}_${_uploadDocFile.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
      const { data: upData, error: upErr } = await db.storage.from('documents').upload(safeName, _uploadDocFile, { contentType: _uploadDocFile.type, upsert: false })
      if (upErr) throw new Error('文件上传失败：' + upErr.message)
      const { data: { publicUrl } } = db.storage.from('documents').getPublicUrl(upData.path)
      file_url  = publicUrl
      file_name = _uploadDocFile.name
      file_type = _uploadDocFile.type
      file_size = _uploadDocFile.size
    }
    // 2. insert document
    const { data: doc, error: dErr } = await db.from('documents')
      .insert({ title, notes: notes || null, file_url, file_name, file_type, file_size, status: 'pending',
                tenant_id: _session.tenant_id || null, uploaded_by: _session.email || null })
      .select('id').single()
    if (dErr) throw new Error(dErr.message)
    // 3. insert reviewers
    const reviewerRows = _docReviewers.map(r => ({ document_id: doc.id, name: r.name, contact: r.contact || null }))
    const { error: rErr } = await db.from('document_reviewers').insert(reviewerRows)
    if (rErr) throw new Error(rErr.message)
    toast('文件已提交审批！', 'success')
    closeUploadDocModal()
    pageLoaded['review'] = false
    loadDocs()
    // 异步推送通知（不阻塞主流程）
    fetch(EDGE_URL, { method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+SUPABASE_ANON},
      body: JSON.stringify(orchBody({
        action:'notify_doc_reviewers',
        doc_id: doc.id,
        doc_title: title,
        uploaded_by: _session.email || null,
        reviewers: _docReviewers
      }))
    }).then(r=>r.json()).then(d=>{
      if (d.sent > 0) toast(`已通知 ${d.sent} 位审批人`, 'info')
    }).catch(()=>{})
  } catch(e) {
    showDocErr(e.message)
  } finally {
    btn.disabled = false; btn.textContent = '✓ 提交审批'
  }
}

function showDocErr(msg) {
  const el = document.getElementById('uploadDocErr')
  if (el) { el.textContent = msg; el.style.display = 'block' }
}

// ── Detail modal ──────────────────────────────────────────────────────
async function openDocDetail(id) {
  _currentDocId = id
  document.getElementById('docDetailModalBg').classList.add('open')
  document.getElementById('ddTitle').textContent = '加载中…'
  document.getElementById('ddMeta').innerHTML = ''
  document.getElementById('ddReviewers').innerHTML = '<p style="color:var(--ink-5);font-size:12px">加载中…</p>'
  try {
    const [{ data: doc, error: dErr }, { data: revs, error: rErr }] = await Promise.all([
      db.from('documents').select('*').eq('id', id).single(),
      db.from('document_reviewers').select('*').eq('document_id', id).order('created_at')
    ])
    if (dErr) throw dErr
    _currentDoc = doc  // store for notification calls
    // Delete button visibility: uploader or admin/master only
    const canDelete = _session.role === 'admin' || _session.role === 'master'
      || (doc.uploaded_by && _session.email && doc.uploaded_by.toLowerCase() === _session.email.toLowerCase())
    const delBtn = document.getElementById('ddDeleteBtn')
    if (delBtn) delBtn.style.display = canDelete ? '' : 'none'
    // Title
    document.getElementById('ddTitle').textContent = '📁 ' + (doc.title || '—')
    // Meta
    const st = doc.status || 'pending'
    document.getElementById('ddMeta').innerHTML = [
      `<span style="padding:2px 9px;border-radius:4px;font-size:11px;font-weight:500;background:${DOC_STATUS_BG[st]};color:${DOC_STATUS_COLOR[st]}">${DOC_STATUS[st]||st}</span>`,
      doc.file_type ? `<span>${_docIcon(doc.file_type)} ${(doc.file_name||'').split('.').pop().toUpperCase()}</span>` : '',
      doc.file_size ? `<span>${(doc.file_size/1024/1024).toFixed(1)} MB</span>` : '',
      doc.uploaded_by ? `<span>上传：${esc(doc.uploaded_by)}</span>` : '',
      `<span>${fmtTime(doc.created_at)}</span>`
    ].filter(Boolean).join('')
    // File link
    const flEl = document.getElementById('ddFileLink')
    flEl.innerHTML = doc.file_url
      ? `<a href="${esc(doc.file_url)}" target="_blank" style="display:inline-flex;align-items:center;gap:6px;background:#f5f5f5;border:1px solid #e0e0e0;border-radius:6px;padding:7px 14px;font-size:12px;color:#555;text-decoration:none">⬇ 下载 / 预览文件</a>`
      : `<span style="font-size:12px;color:var(--ink-5)">（无附件）</span>`
    // Notes
    const notesEl = document.getElementById('ddNotes')
    if (doc.notes) { notesEl.textContent = doc.notes; notesEl.style.display = 'block' }
    else notesEl.style.display = 'none'
    // Reviewers
    const revWrap = document.getElementById('ddReviewers')
    if (!revs || !revs.length) {
      revWrap.innerHTML = '<p style="color:var(--ink-5);font-size:12px">暂无审批人</p>'
    } else {
      revWrap.innerHTML = revs.map(r => {
        const dec = r.decision
        const decColor  = dec === 'approved' ? '#16a34a' : dec === 'rejected' ? '#dc2626' : '#77787b'
        const decBg     = dec === 'approved' ? '#f0fdf4' : dec === 'rejected' ? '#fff5f5' : '#f5f5f5'
        const decBorder = dec === 'approved' ? '#86efac' : dec === 'rejected' ? '#fca5a5' : '#e0e0e0'
        const decLabel  = dec === 'approved' ? '✅ 已批准' : dec === 'rejected' ? '❌ 已拒绝' : '⏳ 待决定'
        return `<div style="background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:12px 14px">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:600;color:#111">${esc(r.name)}</div>
              ${r.contact ? `<div style="font-size:11px;color:var(--ink-5);margin-top:2px">${esc(r.contact)}</div>` : ''}
              ${r.comment ? `<div style="font-size:12px;color:#555;margin-top:5px;font-style:italic">"${esc(r.comment)}"</div>` : ''}
              ${r.decided_at ? `<div style="font-size:11px;color:var(--ink-5);margin-top:2px">${fmtTime(r.decided_at)}</div>` : ''}
            </div>
            <span style="padding:3px 10px;border-radius:5px;font-size:12px;font-weight:500;background:${decBg};color:${decColor};border:1px solid ${decBorder};flex-shrink:0">${decLabel}</span>
          </div>
          ${(() => {
            const _isAdmin = _session.role === 'admin' || _session.role === 'master'
            const _isMyRow = r.contact && _session.email && r.contact.toLowerCase() === _session.email.toLowerCase()
            return !dec && (_isAdmin || _isMyRow) ? `<div style="display:flex;gap:7px;margin-top:10px;flex-wrap:wrap;align-items:center">
              <input type="text" id="cmt_${r.id}" placeholder="留言（可选）" style="flex:1;min-width:120px;background:#f5f5f5;border:1px solid #e0e0e0;border-radius:5px;padding:5px 9px;font-size:12px;color:#333;outline:none">
              <button onclick="makeDocDecision('${r.id}','approved')" style="background:#f0fdf4;border:1px solid #86efac;border-radius:5px;padding:5px 12px;color:#16a34a;font-size:12px;cursor:pointer;font-weight:500">批准</button>
              <button onclick="makeDocDecision('${r.id}','rejected')" style="background:#fff5f5;border:1px solid #fca5a5;border-radius:5px;padding:5px 12px;color:#dc2626;font-size:12px;cursor:pointer;font-weight:500">拒绝</button>
            </div>` : ''
          })()}
        </div>`
      }).join('')
    }
  } catch(e) {
    document.getElementById('ddTitle').textContent = '加载失败'
    document.getElementById('ddReviewers').innerHTML = `<p style="color:#d11a13;font-size:12px">${esc(e.message)}</p>`
  }
}

function closeDocDetail() {
  document.getElementById('docDetailModalBg').classList.remove('open')
  _currentDocId = null
}

async function makeDocDecision(reviewerId, decision) {
  const comment = (document.getElementById('cmt_' + reviewerId)?.value || '').trim()
  const { error } = await db.from('document_reviewers')
    .update({ decision, comment: comment || null, decided_at: new Date().toISOString() })
    .eq('id', reviewerId)
  if (error) { toast('操作失败：' + error.message, 'error'); return }
  // recalculate document status
  await _recalcDocStatus(_currentDocId)
  toast(decision === 'approved' ? '已批准' : '已拒绝', decision === 'approved' ? 'success' : 'error')
  openDocDetail(_currentDocId) // refresh detail
  loadDocs()                   // refresh list
  // 通知上传者（异步，不阻塞）
  if (_currentDoc?.uploaded_by && _currentDoc.uploaded_by !== _session.email) {
    const revRow = document.querySelector(`[id^="cmt_${reviewerId}"]`)
    const revName = revRow?.closest('[style*="border:1px solid #e5e5e5"]')?.querySelector('[style*="font-weight:600"]')?.textContent || _session.email || '审批人'
    fetch(EDGE_URL, { method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+SUPABASE_ANON},
      body: JSON.stringify(orchBody({
        action:'notify_doc_decision',
        doc_title: _currentDoc.title,
        decision,
        reviewer_name: revName,
        uploaded_by: _currentDoc.uploaded_by
      }))
    }).catch(()=>{})
  }
}

async function _recalcDocStatus(docId) {
  const { data: revs } = await db.from('document_reviewers')
    .select('decision').eq('document_id', docId)
  if (!revs || !revs.length) return
  const total    = revs.length
  const approved = revs.filter(r => r.decision === 'approved').length
  const rejected = revs.filter(r => r.decision === 'rejected').length
  let status = 'pending'
  if (rejected > 0)                    status = 'rejected'
  else if (approved === total)         status = 'approved'
  else if (approved > 0)               status = 'partial'
  await db.from('documents').update({ status }).eq('id', docId)
}

async function deleteDoc() {
  if (!_currentDocId) return
  if (!confirm('确定删除此文件及所有审批记录？此操作不可恢复。')) return
  const btn = document.getElementById('ddDeleteBtn')
  if (btn) btn.disabled = true
  try {
    // get file path to delete from storage
    const { data: doc } = await db.from('documents').select('file_url,file_name').eq('id', _currentDocId).single()
    const { error } = await db.from('documents').delete().eq('id', _currentDocId)
    if (error) throw error
    // try delete from storage (best effort)
    if (doc?.file_url) {
      const path = doc.file_url.split('/documents/')[1]
      if (path) await db.storage.from('documents').remove([path])
    }
    toast('文件已删除', 'success')
    closeDocDetail()
    loadDocs()
  } catch(e) {
    toast('删除失败：' + e.message, 'error')
    if (btn) btn.disabled = false
  }
}

// ── Agent Version History ─────────────────────────────────────────────
async function showAgentVersions(agentId) {
  const res = await fetch(EDGE_URL, { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'list_agent_versions', agent_id: agentId }) }).then(r=>r.json())
  const versions = res.versions || []
  if (!versions.length) { toast('暂无版本历史', 'info'); return }
  const html = `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:300;display:flex;align-items:center;justify-content:center" onclick="if(event.target===this)this.remove()">
    <div style="background:#fff;border-radius:12px;padding:24px;width:520px;max-height:70vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.2)">
      <h3 style="margin:0 0 16px">📜 版本历史 — ${esc(agentId)}</h3>
      ${versions.map(v=>`<div style="border:1px solid #e5e5e5;border-radius:8px;padding:12px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <span style="font-weight:600">v${v.version}</span>
          <span style="font-size:11px;color:var(--ink-4)">${fmtTime(v.saved_at)}</span>
        </div>
        <div style="font-size:12px;color:#666;margin-bottom:8px">${esc(v.note||'')} ${v.provider?'· '+v.provider:''}${v.model?' / '+v.model:''}</div>
        <button style="font-size:12px;padding:4px 12px;border:1px solid #da0d15;color:#da0d15;background:none;border-radius:6px;cursor:pointer"
          onclick="restoreAgentVersion('${esc(agentId)}',${v.version},this.closest('[onclick]'))">↩ 恢复此版本</button>
      </div>`).join('')}
    </div>
  </div>`
  document.body.insertAdjacentHTML('beforeend', html)
}
async function restoreAgentVersion(agentId, version, overlay) {
  if (!confirm(`确定恢复 v${version}？当前 Prompt 将被覆盖。`)) return
  const res = await fetch(EDGE_URL, { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'restore_agent_version', agent_id: agentId, version }) }).then(r=>r.json())
  if (res.ok) { toast('已恢复 v'+version,'success'); overlay?.remove(); await loadAgents() }
  else toast(res.error||'恢复失败','error')
}

// ── 工作流调度页 (workflowsPage) ─────────────────────────────────────
async function loadWorkflowsPage() {
  const el = document.getElementById('wfBody')
  if (!el) return
  el.innerHTML = '<div style="padding:20px;color:var(--ink-4);font-size:13px">加载中…</div>'
  try {
    const res = await apiCall('list_workflows')
    const wfs = (res.workflows || []).filter(w => w.active !== false)
    if (!wfs.length) {
      el.innerHTML = '<div style="padding:40px;text-align:center;color:var(--ink-5)"><div style="font-size:32px;margin-bottom:12px">⏰</div><p style="font-size:13px">暂无工作流<br>点击右上角「+ 新建」创建定时任务</p></div>'
      return
    }
    el.innerHTML = wfs.map(w => `
      <div style="background:#fff;border:1px solid #e5e5e5;border-radius:10px;padding:16px 18px;margin-bottom:10px;display:flex;align-items:center;gap:16px">
        <div style="flex:1">
          <div style="font-weight:600;font-size:14px;color:#111;margin-bottom:4px">${esc(w.name)}</div>
          <div style="font-size:12px;color:var(--ink-4)">${esc(w.description||'无描述')}</div>
        </div>
        <span style="font-size:11px;padding:3px 10px;border-radius:12px;${w.active?'background:#dcfce7;color:#16a34a':'background:#f3f4f6;color:var(--ink-4)'}">${w.active?'启用':'停用'}</span>
      </div>`).join('')
  } catch(e) {
    el.innerHTML = `<div style="padding:20px;color:#d11a13;font-size:13px">加载失败：${esc(e.message)}</div>`
  }
}
function showWorkflowModal() {
  alert('请使用「⚡ 工作流」页面创建和管理工作流节点')
}

// ── 工作流 ────────────────────────────────────────────────────────────
let _currentWfId = null
const WF_NODE_TYPES = { agent:'🤖 Agent节点', condition:'🔀 条件判断', output:'📤 输出节点', self_learn:'🧠 自我学习', skill_audit:'🔍 技能库审计', prefs_compact:'🗜️ 偏好压缩' }
async function loadWorkflowPage() {
  const list = document.getElementById('wfList')
  list.innerHTML = '<p style="color:var(--ink-5);font-size:12px">加载中…</p>'
  try {
    const res = await apiCall('list_workflows')
    const wfs = res.workflows || []
    list.innerHTML = wfs.length ? wfs.map(wf=>`
      <div style="padding:10px;border-radius:8px;cursor:pointer;border:1px solid ${_currentWfId===wf.id?'#da0d15':'#e5e5e5'};margin-bottom:6px;background:${_currentWfId===wf.id?'#fff5f5':'#fff'}"
        onclick="selectWorkflow('${wf.id}')">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-weight:600;font-size:13px">${esc(wf.name)}</span>
          <span style="font-size:10px;color:${wf.active?'#22c55e':'#888'}">${wf.active?'启用':'停用'}</span>
        </div>
        <div style="font-size:11px;color:var(--ink-4);margin-top:2px">${esc(wf.description||'')}</div>
      </div>`).join('') : '<p style="color:var(--ink-5);font-size:12px;text-align:center;margin-top:20px">暂无工作流<br>点击右上角新建</p>'
  } catch(e) {
    list.innerHTML = `<p style="color:#d11a13;font-size:12px">${esc(e.message)}</p>`
  }
}
async function selectWorkflow(id) {
  _currentWfId = id
  await loadWorkflowPage()
  try {
    const res = await apiCall('list_workflows')
    const wf = (res.workflows||[]).find(w=>w.id===id)
    if (!wf) return
    const {data:agents} = await db.from('agents').select('id,name').order('id')
    const editor = document.getElementById('wfEditor')
    editor.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
        <h3 style="margin:0">${esc(wf.name)}</h3>
        <div style="display:flex;gap:8px">
          <button class="btn-secondary" style="font-size:12px;padding:6px 12px" onclick="editWorkflow('${wf.id}')">✏️ 编辑</button>
          <button class="btn-primary" style="font-size:12px;padding:6px 12px" onclick="runWorkflow('${wf.id}')">▶ 运行</button>
          <button class="btn-danger" style="font-size:12px;padding:6px 12px" onclick="deleteWorkflow('${wf.id}')">删除</button>
        </div>
      </div>
      <div style="font-size:13px;color:#555;margin-bottom:12px">${esc(wf.description||'无描述')}</div>
      ${wf.schedule?`<div style="font-size:12px;color:var(--ink-4);margin-bottom:16px;display:flex;align-items:center;gap:6px"><span style="background:#ffd405;color:#000;font-size:10px;font-weight:700;border-radius:4px;padding:2px 7px">定时</span>${esc(wf.schedule)}</div>`:''}
      <div style="font-weight:600;margin-bottom:12px;font-size:13px">节点流程</div>
      <div style="display:flex;flex-direction:column;gap:0">
        ${(wf.nodes||[]).map((n,i)=>`
          <div style="display:flex;align-items:center;gap:0;flex-direction:column">
            <div style="border:1px solid #e5e5e5;border-radius:10px;padding:12px 16px;background:#fff;width:320px;text-align:center">
              <div style="font-size:13px;font-weight:600">${WF_NODE_TYPES[n.type]||n.type}</div>
              ${n.type==='agent'?`<div style="font-size:12px;color:var(--ink-4);margin-top:4px">Agent: ${esc(n.config?.agent_id||'—')}</div><div style="font-size:11px;color:var(--ink-5);margin-top:2px">Prompt: ${esc((n.config?.prompt||'').slice(0,50))}</div>`:''}
              ${n.type==='condition'?`<div style="font-size:12px;color:var(--ink-4);margin-top:4px">关键词: ${esc(n.config?.keyword||'—')}</div>`:''}
              ${n.type==='self_learn'?`<div style="font-size:11px;color:var(--ink-4);margin-top:4px">分析未解答问题 · 生成路由规则 · 自动去重</div>`:''}
              ${n.type==='skill_audit'?`<div style="font-size:11px;color:var(--ink-4);margin-top:4px">扫描路由规则 · 删除重复/矛盾条目</div>`:''}
              ${n.type==='prefs_compact'?`<div style="font-size:11px;color:var(--ink-4);margin-top:4px">合并相近偏好 · 删除低置信度冗余</div>`:''}
            </div>
            ${i<(wf.nodes||[]).length-1?'<div style="width:2px;height:24px;background:#e5e5e5"></div>':''}
          </div>`).join('')}
      </div>
      <div id="wfRunResult" style="margin-top:20px"></div>
      <div style="margin-top:28px">
        <div style="font-weight:600;font-size:13px;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between">
          <span>执行历史</span>
          <button onclick="loadWfRuns('${wf.id}')" style="font-size:11px;color:#da0d15;background:none;border:none;cursor:pointer;padding:0">刷新</button>
        </div>
        <div id="wfRunHistory" style="font-size:12px;color:var(--ink-5)">加载中…</div>
      </div>`
    loadWfRuns(wf.id)
  } catch(e) {
    document.getElementById('wfEditor').innerHTML = `<p style="color:#d11a13">${esc(e.message)}</p>`
  }
}
function runWorkflow(id) {
  document.getElementById('wfRunId').value = id
  document.getElementById('wfRunInput').value = ''
  document.getElementById('wfRunModal').style.display = 'flex'
  setTimeout(() => document.getElementById('wfRunInput').focus(), 50)
}
async function confirmRunWorkflow() {
  const id = document.getElementById('wfRunId').value
  const inputStr = document.getElementById('wfRunInput').value.trim()
  let input = {}
  try { input = JSON.parse(inputStr||'{}') } catch { input = inputStr ? { text: inputStr } : {} }
  document.getElementById('wfRunModal').style.display = 'none'
  document.getElementById('wfRunResult').innerHTML = '<p style="color:var(--ink-5);font-size:13px">⏳ 运行中…</p>'
  try {
    const res = await apiCall('run_workflow', { id, input })
    document.getElementById('wfRunResult').innerHTML = `
      <div style="border:1px solid ${res.ok?'#22c55e':'#ef4444'};border-radius:8px;padding:16px;background:${res.ok?'#f0fdf4':'#fef2f2'}">
        <div style="font-weight:600;margin-bottom:8px">${res.ok?'✅ 运行成功':'❌ 运行失败'}</div>
        ${res.error?`<div style="color:#d11a13;margin-bottom:8px">${esc(res.error)}</div>`:''}
        ${res.output?.final_output||res.output?.last_output?(()=>{const out=String(res.output?.final_output||res.output?.last_output||'');const rendered=typeof marked!=='undefined'?marked.parse(out):esc(out);return`<div style="font-size:13px"><strong>输出：</strong><div class="md" style="margin-top:8px;line-height:1.7">${rendered}</div></div>`})():''}
      </div>`
  } catch(e) {
    document.getElementById('wfRunResult').innerHTML = `<div style="color:#d11a13">运行出错：${esc(e.message)}</div>`
  }
}
const CRON_LABELS = {
  '': '不自动执行，仅手动触发',
  '0 8 * * *': '每天 08:00',
  '0 12 * * *': '每天 12:00',
  '0 18 * * *': '每天 18:00',
  '0 22 * * *': '每天 22:00',
  '0 0 * * *': '每天 00:00（凌晨）',
  '0 9 * * 1': '每周一 09:00',
  '0 18 * * 5': '每周五 18:00',
  '0 * * * *': '每小时整点',
  '*/30 * * * *': '每30分钟',
  '*/15 * * * *': '每15分钟',
  '0 0 1 * *': '每月1日 00:00',
}
function setCronPreset(val) {
  document.getElementById('wfSchedule').value = val
  wfCronHint()
}
function getWfSchedule() {
  return document.getElementById('wfSchedule').value.trim()
}
function setWfSchedule(val) {
  document.getElementById('wfSchedule').value = val || ''
  wfCronHint()
}
function wfCronHint() {
  const val = document.getElementById('wfSchedule').value.trim()
  const hint = document.getElementById('wfCronHintText')
  // update chip active state
  document.querySelectorAll('.cron-chip').forEach(btn => {
    const preset = btn.getAttribute('onclick').match(/setCronPreset\('(.*)'\)/)?.[1] ?? ''
    btn.classList.toggle('active', preset === val)
  })
  const known = CRON_LABELS[val]
  if (known !== undefined) { hint.textContent = known ? '📅 ' + known : '留空 = 不自动执行，仅手动触发 · 格式：分 时 日 月 周(0=周日)'; return }
  const parts = val.split(/\s+/)
  if (parts.length === 5) hint.textContent = '✓ 有效 cron 表达式  ·  格式：分(0-59) 时(0-23) 日(1-31) 月(1-12) 周(0-6,0=周日)'
  else hint.textContent = '⚠ 需要5个字段：分 时 日 月 周  ·  示例：0 8 * * *'
}
function showWfCreate() {
  document.getElementById('wfEditId').value=''
  document.getElementById('wfModalTitle').textContent='新建工作流'
  document.getElementById('wfName').value=''; document.getElementById('wfDesc').value=''
  document.getElementById('wfNodesEditor').innerHTML=''
  setWfSchedule('')
  document.getElementById('wfCreateModal').classList.add('open')
  document.getElementById('wfDrawerBg').classList.add('open')
}
function hideWfCreate() {
  document.getElementById('wfCreateModal').classList.remove('open')
  document.getElementById('wfDrawerBg').classList.remove('open')
}
async function editWorkflow(id) {
  try {
    const res = await apiCall('list_workflows')
    const wf = (res.workflows||[]).find(w=>w.id===id); if (!wf) return
    document.getElementById('wfEditId').value=wf.id
    document.getElementById('wfModalTitle').textContent='编辑工作流'
    document.getElementById('wfName').value=wf.name; document.getElementById('wfDesc').value=wf.description||''
    document.getElementById('wfNodesEditor').innerHTML=''
    ;(wf.nodes||[]).forEach(n=>addWfNode(n))
    setWfSchedule(wf.schedule||'')
    document.getElementById('wfCreateModal').classList.add('open')
    document.getElementById('wfDrawerBg').classList.add('open')
  } catch(e) {
    toast(e.message || '加载失败', 'error')
  }
}
let _wfNodeCount = 0
const WF_NODE_COLORS = { agent:'#3b82f6', condition:'#f59e0b', output:'#22c55e', self_learn:'#8b5cf6', skill_audit:'#14b8a6', prefs_compact:'#ec4899' }
async function addWfNode(existing) {
  const {data:agents} = await db.from('agents').select('id,name').order('id')
  const agOpts = (agents||[]).map(a=>`<option value="${esc(a.id)}"${existing?.config?.agent_id===a.id?' selected':''}>${esc(a.name)}</option>`).join('')
  const idx = _wfNodeCount++
  const type = existing?.type || 'agent'
  const color = WF_NODE_COLORS[type] || '#999'
  const div = document.createElement('div')
  div.id = 'wfNode_'+idx
  div.className = 'wf-node-card'
  div.innerHTML = `
    <div class="wf-node-wrap">
      <div class="wf-node-accent" id="wfNodeAccent_${idx}" style="background:${color}"></div>
      <div class="wf-node-body">
        <div class="wf-node-top">
          <select class="wf-node-sel" onchange="wfNodeTypeChange(this,'wfNode_${idx}')">
            ${Object.entries(WF_NODE_TYPES).map(([k,v])=>`<option value="${k}"${type===k?' selected':''}>${v}</option>`).join('')}
          </select>
          <button class="wf-node-del" onclick="document.getElementById('wfNode_${idx}').remove()">✕</button>
        </div>
        <div class="wfNodeConfig_${idx}">
          ${type==='agent'?`<select class="form-input" style="font-size:12px;padding:5px 8px;margin-bottom:6px" id="wfNAgent_${idx}">${agOpts}</select><input class="form-input" style="font-size:12px" placeholder="Prompt（用 {{input}} 引用上一步输出）" id="wfNPrompt_${idx}" value="${esc(existing?.config?.prompt||'')}">`:
            type==='condition'?`<input class="form-input" style="font-size:12px" placeholder="输出包含此关键词时继续" id="wfNKeyword_${idx}" value="${esc(existing?.config?.keyword||'')}">`:
            type==='output'?`<span style="font-size:12px;color:var(--ink-4)">将前一步的输出标记为最终结果</span>`:
            type==='self_learn'?`<span style="font-size:12px;color:var(--ink-4)">分析未解答问题 · 生成路由规则 · 自动去重</span>`:
            type==='skill_audit'?`<span style="font-size:12px;color:var(--ink-4)">扫描路由规则库 · 删除重复/矛盾条目</span>`:
            type==='prefs_compact'?`<span style="font-size:12px;color:var(--ink-4)">合并相近用户偏好 · 删除低置信度冗余</span>`:''}
        </div>
      </div>
    </div>`
  document.getElementById('wfNodesEditor').appendChild(div)
}
async function wfNodeTypeChange(sel, nodeId) {
  const div = document.getElementById(nodeId); const type = sel.value
  const cfg = div.querySelector('[class^=wfNodeConfig]')
  const accent = div.querySelector('[id^=wfNodeAccent]')
  if (accent) accent.style.background = WF_NODE_COLORS[type] || '#999'
  if (type === 'agent') {
    cfg.innerHTML = `<select class="form-input" style="font-size:12px;padding:5px 8px;margin-bottom:6px"><option value="">加载中…</option></select><input class="form-input" style="font-size:12px" placeholder="Prompt（用 {{input}} 引用上一步输出）">`
    try {
      const {data:agents} = await db.from('agents').select('id,name').order('id')
      const agSel = cfg.querySelector('select')
      if (agSel) agSel.innerHTML = (agents||[]).map(a=>`<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')
    } catch(e) {}
  } else if (type === 'condition') {
    cfg.innerHTML = `<input class="form-input" style="font-size:12px" placeholder="输出包含此关键词时继续">`
  } else if (type === 'output') {
    cfg.innerHTML = '<span style="font-size:12px;color:var(--ink-4)">将前一步的输出标记为最终结果</span>'
  } else if (type === 'self_learn') {
    cfg.innerHTML = '<span style="font-size:12px;color:var(--ink-4)">分析未解答问题 · 生成路由规则 · 自动去重</span>'
  } else if (type === 'skill_audit') {
    cfg.innerHTML = '<span style="font-size:12px;color:var(--ink-4)">扫描路由规则库 · 删除重复/矛盾条目</span>'
  } else if (type === 'prefs_compact') {
    cfg.innerHTML = '<span style="font-size:12px;color:var(--ink-4)">合并相近用户偏好 · 删除低置信度冗余</span>'
  }
}
async function saveWorkflow() {
  const name = document.getElementById('wfName').value.trim(); if (!name){toast('请输入名称','error');return}
  const id = document.getElementById('wfEditId').value || null
  const nodeDivs = Array.from(document.getElementById('wfNodesEditor').children)
  const nodes = nodeDivs.map((div,i)=>{
    const sel = div.querySelector('select'); const type = sel?.value || 'agent'
    const config = {}
    if (type==='agent') { config.agent_id=div.querySelector('[id^=wfNAgent]')?.value||''; config.prompt=div.querySelector('[id^=wfNPrompt]')?.value||'{{input}}' }
    if (type==='condition') config.keyword = div.querySelector('[id^=wfNKeyword]')?.value||''
    return { id:'node_'+i, type, config }
  })
  const edges = nodes.slice(0,-1).map((n,i)=>({from:n.id,to:nodes[i+1].id}))
  try {
    const res = await apiCall('save_workflow', { id, name, description: document.getElementById('wfDesc').value.trim(), nodes, edges, schedule: getWfSchedule() })
    if (res.ok) {
      toast('工作流已保存','success')
      hideWfCreate()
      await loadWorkflowPage()
      if(res.id) selectWorkflow(res.id)
    }
  } catch(e) {
    toast(e.message || '保存失败', 'error')
  }
}
async function loadWfRuns(wfId) {
  const el = document.getElementById('wfRunHistory')
  if (!el) return
  try {
    const { data } = await db.from('workflow_runs')
      .select('ran_at,response,error')
      .eq('workflow_id', wfId)
      .order('ran_at', { ascending: false })
      .limit(10)
    if (!data || !data.length) { el.innerHTML = '<span style="color:var(--ink-5)">暂无记录</span>'; return }
    el.innerHTML = data.map(r => {
      const ok = !r.error
      const time = new Date(r.ran_at).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})
      const preview = ok ? (r.response||'').slice(0,80) : r.error
      return `<div style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid #f0f0f0">
        <span style="font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;flex-shrink:0;margin-top:1px;${ok?'background:#dcfce7;color:#16a34a':'background:#fef2f2;color:#dc2626'}">${ok?'✓':'✗'}</span>
        <div style="min-width:0">
          <div style="color:var(--ink-4);font-size:11px;margin-bottom:2px">${time}</div>
          <div style="color:#444;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(preview||'—')}</div>
        </div>
      </div>`
    }).join('')
  } catch(e) { el.innerHTML = '<span style="color:#d11a13">加载失败</span>' }
}
async function deleteWorkflow(id) {
  if (!confirm('确定删除此工作流？')) return
  try {
    const res = await apiCall('delete_workflow', { id })
    if (res.ok) {
      toast('已删除','success')
      _currentWfId = null
      document.getElementById('wfEditor').innerHTML = '<div style="color:var(--ink-5);text-align:center;margin-top:80px">← 选择或新建工作流</div>'
      await loadWorkflowPage()
    }
  } catch(e) {
    toast(e.message || '删除失败', 'error')
  }
}

// ── API 页 Slack (testSlackWebhook defined near loadIntegrations) ─────

// ── Analytics ─────────────────────────────────────────────────────────
function toggleAnalyticsChart() {
  const wrap = document.getElementById('anChartsWrap')
  const bar  = document.getElementById('anBenchmarkBar')
  const btn  = document.getElementById('dAnChartBtn')
  if (!wrap) return
  const isOpen = wrap.classList.toggle('open')
  if (bar) bar.style.display = isOpen ? 'block' : 'none'
  if (btn) {
    btn.style.background = isOpen ? 'var(--red)' : 'var(--bg-2)'
    btn.style.color      = isOpen ? '#fff'       : 'var(--ink-2)'
    btn.style.border     = isOpen ? '1px solid var(--red)' : '1px solid var(--border)'
  }
  if (isOpen && _anData.length) renderAnCharts()
}

async function loadAnalytics() {
  const from = document.getElementById('dAnFrom')?.value
  const to   = document.getElementById('dAnTo')?.value
  const grp  = document.getElementById('dAnGroup')?.value || 'campaign'
  const head = document.getElementById('analyticsHead')
  const body = document.getElementById('analyticsBody')
  const cnt  = document.getElementById('dAnCount')
  if (!body) return
  body.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--ink-5);padding:40px">加载中…</td></tr>'
  try {
    let q = db.from('analytics_daily').select('*').order('date', { ascending: false })
    if (from) q = q.gte('date', from)
    if (to)   q = q.lte('date', to)
    const { data, error } = await q
    if (error) throw error
    const rows = data || []
    // Aggregate
    const agg = {}
    rows.forEach(r => {
      const key = grp === 'day' ? r.date : (r.campaign_name || '未知')
      if (!agg[key]) agg[key] = { key, spend:0, results:0, new_contacts:0, impressions:0, link_clicks:0, lead_count:0 }
      const a = agg[key]
      a.spend        += Number(r.spend_myr)    || 0
      a.results      += Number(r.results)      || 0
      a.new_contacts += Number(r.new_contacts) || 0
      a.impressions  += Number(r.impressions)  || 0
      a.link_clicks  += Number(r.link_clicks)  || 0
      a.lead_count   += Number(r.lead_count)   || 0
    })
    const items = Object.values(agg).sort((a, b) => b.spend - a.spend)
    items.forEach(a => {
      a.cpr = a.results    ? +(a.spend / a.results   ).toFixed(2) : 0
      a.cpl = a.lead_count ? +(a.spend / a.lead_count).toFixed(2) : 0
      a.cpm = a.impressions ? +(a.spend / a.impressions * 1000).toFixed(2) : 0
      a.ctr = a.impressions ? +(a.link_clicks / a.impressions * 100).toFixed(3) : 0
    })
    _anData = items
    if (cnt) cnt.textContent = `共 ${items.length} 条`
    // Table
    const grpLabel = grp === 'day' ? '日期' : 'Campaign'
    if (head) head.innerHTML = `<tr>${['',grpLabel,'花费(RM)','结果','CPR','新联系','潜在客户','CPL','CPM','CTR%'].map(h=>`<th>${h}</th>`).join('')}</tr>`
    body.innerHTML = items.length ? items.map((a, i) => {
      const cplStyle = a.cpl ? (a.cpl > AN_BENCHMARKS.cpl ? 'color:#d11a13;font-weight:600' : 'color:var(--green-ink);font-weight:600') : ''
      const ctrStyle = a.ctr && a.ctr < AN_BENCHMARKS.ctr ? 'color:#f59e0b' : ''
      return `<tr>
        <td style="color:var(--ink-5);font-size:11px">${i+1}</td>
        <td style="font-weight:500;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(a.key)}">${esc(a.key)}</td>
        <td>RM ${a.spend.toFixed(0)}</td>
        <td>${a.results}</td>
        <td>RM ${a.cpr}</td>
        <td>${a.new_contacts}</td>
        <td>${a.lead_count}</td>
        <td style="${cplStyle}">RM ${a.cpl}</td>
        <td>RM ${a.cpm}</td>
        <td style="${ctrStyle}">${a.ctr.toFixed(2)}%</td>
      </tr>`
    }).join('') : '<tr><td colspan="10" style="text-align:center;color:var(--ink-5);padding:30px">暂无数据</td></tr>'
    // Re-render charts if visible
    const wrap = document.getElementById('anChartsWrap')
    if (wrap && wrap.classList.contains('open') && _anData.length) renderAnCharts()
  } catch(e) {
    body.innerHTML = `<tr><td colspan="10" style="text-align:center;color:#d11a13;padding:30px">加载失败：${esc(e.message)}</td></tr>`
  }
}

function renderAnCharts() {
  const items  = _anData.slice(0, 10)
  const labels = items.map(a => a.key.length > 12 ? a.key.slice(0, 12) + '…' : a.key)
  const defs = [
    { id:'chartSpend', key:'spend', label:'花费 (RM)', color:'#da0d15', bm:null },
    { id:'chartCPL',   key:'cpl',   label:'CPL (RM)', color:'#3b82f6',
      bm:{ value:AN_BENCHMARKS.cpl, label:'行业均值 RM'+AN_BENCHMARKS.cpl, color:'#ffd405' } },
    { id:'chartCTR',   key:'ctr',   label:'CTR (%)',  color:'#22c55e',
      bm:{ value:AN_BENCHMARKS.ctr, label:'行业均值 '+AN_BENCHMARKS.ctr+'%', color:'#ffd405' } }
  ]
  defs.forEach(def => {
    const ctx = document.getElementById(def.id)
    if (!ctx) return
    if (_anCharts[def.id]) { _anCharts[def.id].destroy(); delete _anCharts[def.id] }
    const datasets = [{
      type:'bar', label:def.label,
      data: items.map(a => a[def.key] || null),
      backgroundColor: def.color + '44',
      borderColor: def.color, borderWidth:1.5, borderRadius:4
    }]
    if (def.bm) datasets.push({
      type:'line', label:def.bm.label,
      data: items.map(() => def.bm.value),
      borderColor: def.bm.color, borderWidth:2,
      borderDash:[5,4], pointRadius:0, tension:0, fill:false
    })
    _anCharts[def.id] = new Chart(ctx, {
      type:'bar',
      data:{ labels, datasets },
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ display:!!def.bm, labels:{ boxWidth:10, font:{ size:10 } } } },
        scales:{ y:{ beginAtZero:true } }
      }
    })
  })
}

// ── Knowledge Base ─────────────────────────────────────────────────────
let _kbSelected = null

async function loadKbPage() {
  const list = document.getElementById('kbList')
  if (!list) return
  list.innerHTML = '<p style="color:var(--ink-5);font-size:12px;text-align:center;padding-top:40px">加载中…</p>'
  try {
    const q = db.from('knowledge_bases').select('*').order('created_at', { ascending:false })
    if (_session?.tenant_id) q.eq('tenant_id', _session.tenant_id)
    const { data, error } = await q
    if (error) throw error
    const kbs = data || []
    if (!kbs.length) {
      list.innerHTML = '<p style="color:var(--ink-5);font-size:12px;text-align:center;padding-top:40px">暂无知识库<br><small style=\'color:var(--ink-4)\'>点击右上角新建</small></p>'
      return
    }
    list.innerHTML = kbs.map(kb => {
      const active = _kbSelected?.id === kb.id ? ' active' : ''
      const kbJson = JSON.stringify(kb).replace(/"/g,'&quot;')
      return `<div class="kb-item${active}" onclick="selectKb(JSON.parse(this.dataset.kb))" data-kb="${kbJson}">
        <div style="font-size:13px;font-weight:600;color:#111;margin-bottom:3px">${esc(kb.name)}</div>
        ${kb.description ? `<div style="font-size:11px;color:var(--ink-5)">${esc(kb.description)}</div>` : ''}
        <div style="font-size:10px;color:var(--ink-4);margin-top:4px">${fmtTime(kb.created_at)}</div>
      </div>`
    }).join('')
  } catch(e) {
    list.innerHTML = `<p style="color:#d11a13;font-size:12px;padding:16px">加载失败：${esc(e.message)}</p>`
  }
}

function showCreateKb() {
  const html = `<div id="kbCreateModal" onclick="if(event.target===this)this.remove()" style="position:fixed;inset:0;background:#00000055;z-index:300;display:flex;align-items:center;justify-content:center">
    <div style="background:#fff;border-radius:12px;padding:24px;width:400px;max-width:92vw;box-shadow:0 8px 32px #0002">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <h3 style="font-size:14px;font-weight:700">新建知识库</h3>
        <button onclick="document.getElementById('kbCreateModal').remove()" style="background:none;border:none;font-size:18px;color:var(--ink-5);cursor:pointer">&#x2715;</button>
      </div>
      <label style="font-size:12px;color:#555;display:block;margin-bottom:6px">名称 *</label>
      <input id="kbNewName" type="text" placeholder="例：产品手册" style="width:100%;padding:9px 12px;border:1px solid #e5e5e5;border-radius:8px;font-size:13px;outline:none;margin-bottom:12px;box-sizing:border-box">
      <label style="font-size:12px;color:#555;display:block;margin-bottom:6px">描述（选填）</label>
      <textarea id="kbNewDesc" rows="2" placeholder="简述用途…" style="width:100%;padding:9px 12px;border:1px solid #e5e5e5;border-radius:8px;font-size:13px;outline:none;resize:none;box-sizing:border-box;margin-bottom:16px"></textarea>
      <button class="btn-primary" style="width:100%;justify-content:center" onclick="confirmCreateKb()">创建</button>
    </div>
  </div>`
  document.body.insertAdjacentHTML('beforeend', html)
  setTimeout(() => document.getElementById('kbNewName')?.focus(), 50)
}

async function confirmCreateKb() {
  const name = document.getElementById('kbNewName')?.value.trim()
  const desc = document.getElementById('kbNewDesc')?.value.trim()
  if (!name) { toast('请输入知识库名称', 'error'); return }
  try {
    const { error } = await db.from('knowledge_bases').insert({ name, description:desc||null, tenant_id:_session.tenant_id })
    if (error) throw error
    document.getElementById('kbCreateModal')?.remove()
    toast('知识库已创建', 'success')
    loadKbPage()
  } catch(e) { toast('创建失败：' + e.message, 'error') }
}

async function selectKb(kb) {
  _kbSelected = kb
  document.querySelectorAll('.kb-item').forEach(el => el.classList.remove('active'))
  document.querySelectorAll('.kb-item').forEach(el => {
    try { if (JSON.parse(el.dataset.kb).id === kb.id) el.classList.add('active') } catch {}
  })
  const detail = document.getElementById('kbDetail')
  if (!detail) return
  detail.innerHTML = '<p style="color:var(--ink-5);font-size:12px;text-align:center;padding:40px">加载中…</p>'
  const { count } = await db.from('kb_chunks').select('*', { count:'exact', head:true }).eq('kb_id', kb.id)
  detail.innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:20px">
      <div style="flex:1">
        <h3 style="font-size:16px;font-weight:700;color:#111">${esc(kb.name)}</h3>
        ${kb.description ? `<p style="font-size:12px;color:var(--ink-5);margin-top:4px">${esc(kb.description)}</p>` : ''}
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0">
        <span style="background:#f0f9ff;color:#0369a1;border:1px solid #bae6fd;border-radius:6px;padding:4px 10px;font-size:12px">&#x1F4C4; ${count||0} 块</span>
        <button onclick="deleteKb('${kb.id}')" style="background:#fff;border:1px solid #fca5a5;border-radius:6px;padding:4px 10px;font-size:12px;color:#d11a13;cursor:pointer">删除</button>
      </div>
    </div>
    <div style="background:#f9f9f9;border:1px solid #e5e5e5;border-radius:10px;padding:16px;margin-bottom:14px">
      <h4 style="font-size:13px;font-weight:600;margin-bottom:10px">&#x1F4E5; 录入文档</h4>
      <input id="kbIngestTitle" type="text" placeholder="文档标题（必填）" style="width:100%;padding:9px 12px;border:1px solid #e5e5e5;border-radius:8px;font-size:13px;outline:none;margin-bottom:8px;box-sizing:border-box">
      <textarea id="kbIngestContent" rows="6" placeholder="贴入文档内容…（或点击下方上传文件自动填入）" style="width:100%;padding:9px 12px;border:1px solid #e5e5e5;border-radius:8px;font-size:13px;outline:none;resize:vertical;margin-bottom:10px;box-sizing:border-box"></textarea>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn-primary" style="font-size:12px;padding:8px 20px" onclick="ingestDoc('${kb.id}')">&#x26A1; 录入 + 向量化</button>
        <button onclick="document.getElementById('kbFileInput').click()" style="background:#f3f4f6;border:1px solid #e5e5e5;border-radius:8px;padding:8px 16px;font-size:12px;color:#555;cursor:pointer">&#x1F4C1; 上传文件</button>
        <input id="kbFileInput" type="file" accept=".pdf,.docx,.doc,.txt" style="display:none" onchange="onKbFileSelected(event,'${kb.id}')">
        <span id="kbFileLabel" style="font-size:11px;color:var(--ink-5)"></span>
      </div>
      <div id="kbIngestMsg" style="font-size:12px;margin-top:8px;color:var(--ink-5)"></div>
    </div>
    <div style="background:#f9f9f9;border:1px solid #e5e5e5;border-radius:10px;padding:16px">
      <h4 style="font-size:13px;font-weight:600;margin-bottom:10px">&#x1F50D; 语义搜索</h4>
      <div style="display:flex;gap:8px">
        <input id="kbSearchQuery" type="text" placeholder="输入搜索词…" style="flex:1;padding:9px 12px;border:1px solid #e5e5e5;border-radius:8px;font-size:13px;outline:none" onkeydown="if(event.key==='Enter')searchKb('${kb.id}')">
        <button class="btn-primary" style="font-size:12px;padding:8px 16px" onclick="searchKb('${kb.id}')">搜索</button>
      </div>
      <div id="kbSearchResult" style="margin-top:12px"></div>
    </div>`
}

async function onKbFileSelected(event, kbId) {
  const file = event.target.files[0]; if (!file) return
  const ext  = (file.name.split('.').pop() || '').toLowerCase()
  const msg  = document.getElementById('kbIngestMsg')
  const lbl  = document.getElementById('kbFileLabel')
  const titleEl   = document.getElementById('kbIngestTitle')
  const contentEl = document.getElementById('kbIngestContent')
  if (msg) { msg.style.color = '#aaa'; msg.textContent = '解析中…' }
  if (lbl) lbl.textContent = file.name
  try {
    let text = ''
    if (ext === 'txt') {
      text = await file.text()
    } else if (ext === 'pdf') {
      if (typeof pdfjsLib === 'undefined') throw new Error('PDF.js 未加载，请刷新页面重试')
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
      const buf = await file.arrayBuffer()
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
      const pages = []
      for (let i = 1; i <= pdf.numPages; i++) {
        const page    = await pdf.getPage(i)
        const content = await page.getTextContent()
        pages.push(content.items.map(it => it.str).join(' '))
      }
      text = pages.join('\n\n')
    } else if (ext === 'docx' || ext === 'doc') {
      if (typeof mammoth === 'undefined') throw new Error('Mammoth.js 未加载，请刷新页面重试')
      const buf    = await file.arrayBuffer()
      const result = await mammoth.extractRawText({ arrayBuffer: buf })
      text = result.value
    } else {
      throw new Error('不支持的文件格式，请上传 PDF / DOCX / TXT')
    }
    text = text.trim()
    if (!text) throw new Error('文件内容为空，无法录入')
    if (titleEl && !titleEl.value.trim()) titleEl.value = file.name.replace(/\.[^.]+$/, '')
    if (contentEl) contentEl.value = text
    if (msg) { msg.style.color = '#22c55e'; msg.textContent = `✓ 已解析 ${text.length} 字符，请检查内容后点击「录入 + 向量化」` }
  } catch(e) {
    if (msg) { msg.style.color = '#ef4444'; msg.textContent = '解析失败：' + e.message }
  }
  event.target.value = ''
}

async function ingestDoc(kbId) {
  const title   = document.getElementById('kbIngestTitle')?.value.trim()
  const content = document.getElementById('kbIngestContent')?.value.trim()
  const msg     = document.getElementById('kbIngestMsg')
  if (!title)   { if (msg) { msg.style.color='#ef4444'; msg.textContent='请填写文档标题' }; return }
  if (!content) { if (msg) { msg.style.color='#ef4444'; msg.textContent='请填写文档内容' }; return }
  if (msg) { msg.style.color='#aaa'; msg.textContent='处理中…' }
  try {
    const r = await fetch(EDGE_URL, { method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+SUPABASE_ANON},
      body: JSON.stringify(orchBody({ action:'kb_ingest', kb_id:kbId, source_name:title, content }))
    })
    const d = await r.json()
    if (!d.ok) throw new Error(d.error || '录入失败')
    if (msg) { msg.style.color='#22c55e'; msg.textContent=`&#x2713; 已拆分 ${d.chunks||''} 块并向量化` }
    document.getElementById('kbIngestTitle').value = ''
    document.getElementById('kbIngestContent').value = ''
    if (_kbSelected?.id === kbId) setTimeout(() => selectKb(_kbSelected), 600)
  } catch(e) {
    if (msg) { msg.style.color='#ef4444'; msg.textContent='失败：'+e.message }
  }
}

async function searchKb(kbId) {
  const query  = document.getElementById('kbSearchQuery')?.value.trim()
  const result = document.getElementById('kbSearchResult')
  if (!query || !result) return
  result.innerHTML = '<p style="color:var(--ink-5);font-size:12px">搜索中…</p>'
  try {
    const r = await fetch(EDGE_URL, { method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+SUPABASE_ANON},
      body: JSON.stringify(orchBody({ action:'kb_search', kb_id:kbId, query, limit:5 }))
    })
    const d = await r.json()
    if (d.error) throw new Error(d.error)
    const items = d.results || []
    if (!items.length) {
      result.innerHTML = '<p style="color:var(--ink-5);font-size:12px;text-align:center;padding:20px">未找到相关内容</p>'
      return
    }
    result.innerHTML = items.map((item, i) => `
      <div style="background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:12px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;margin-bottom:6px">
          <span style="font-size:11px;font-weight:600;color:#555">${esc(item.source_name||'#'+(i+1))}</span>
          ${item.similarity !== undefined ? `<span style="font-size:10px;color:var(--ink-5)">相似度 ${(item.similarity*100).toFixed(1)}%</span>` : ''}
        </div>
        <p style="font-size:12px;color:#333;line-height:1.6;margin:0">${esc((item.content||'').slice(0,300))}${(item.content||'').length>300?'…':''}</p>
      </div>`).join('')
  } catch(e) {
    result.innerHTML = `<p style="color:#d11a13;font-size:12px">搜索失败：${esc(e.message)}</p>`
  }
}

async function deleteKb(kbId) {
  if (!confirm('确定删除此知识库及全部 Chunks？此操作不可撤销。')) return
  try {
    const chunksQ = db.from('kb_chunks').delete().eq('kb_id', kbId)
    if (_session?.tenant_id) chunksQ.eq('tenant_id', _session.tenant_id)
    await chunksQ
    const kbQ = db.from('knowledge_bases').delete().eq('id', kbId)
    if (_session?.tenant_id) kbQ.eq('tenant_id', _session.tenant_id)
    const { error } = await kbQ
    if (error) throw error
    toast('知识库已删除', 'success')
    _kbSelected = null
    const detail = document.getElementById('kbDetail')
    if (detail) detail.innerHTML = '<div style="text-align:center;color:var(--ink-5);padding:60px 0"><div style="font-size:40px;margin-bottom:12px">&#x1F4DA;</div><p>&#x2190; 选择知识库开始使用</p></div>'
    loadKbPage()
  } catch(e) { toast('删除失败：' + e.message, 'error') }
}

// ── Alert badge ───────────────────────────────────────────────────────
async function loadAlertBadge() {
  try {
    const q = db.from('automation_logs').select('id', { count:'exact', head:true }).eq('read', false)
    if (_session?.tenant_id) q.eq('tenant_id', _session.tenant_id)
    const { count } = await q
    const el = document.getElementById('alertBadge')
    if (!el) return
    if (count > 0) { el.textContent = count > 9 ? '9+' : String(count); el.style.display = 'inline-block' }
    else el.style.display = 'none'
  } catch {}
}
function clearAlertBadge() {
  const el = document.getElementById('alertBadge')
  if (el) el.style.display = 'none'
}

// ── Automation Rules UI ────────────────────────────────────────────────
function onAlrTypeChange() {
  const t = document.getElementById('alrTriggerType')?.value
  document.getElementById('alrThresholdFields').style.display = t === 'threshold' ? '' : 'none'
  document.getElementById('alrScheduleFields').style.display  = t === 'schedule'  ? '' : 'none'
  document.getElementById('alrEventFields').style.display     = t === 'event'     ? '' : 'none'
  document.getElementById('alrAnomalyFields').style.display   = t === 'anomaly'   ? '' : 'none'
  document.getElementById('alrPatternFields').style.display   = t === 'pattern'   ? '' : 'none'
}

const _alrTriggerLbl = { threshold:'📊 超标', schedule:'⏰ 定时', event:'📋 事件', pattern:'🔍 模式', anomaly:'⚠️ 异常' }
const _alrActionLbl  = { dashboard_alert:'📌 Dashboard', chat_message:'💬 对话', whatsapp_push:'📱 WhatsApp', draft_message:'📝 草稿', daily_report:'📋 每日摘要' }

async function loadAlertRules() {
  const el = document.getElementById('alertRulesBody')
  if (!el) return
  el.innerHTML = '<p style="color:var(--ink-5);font-size:12px;padding:8px">加载中…</p>'
  try {
    const r = await fetch(EDGE_URL, { method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+SUPABASE_ANON},
      body: JSON.stringify(orchBody({ action:'automation_crud', method:'list' })) })
    const d = await r.json()
    const rules = d.rules || []
    el.innerHTML = rules.length
      ? rules.map(function(rule) {
          const tLbl = _alrTriggerLbl[rule.trigger_type] || rule.trigger_type
          const aLbl = _alrActionLbl[rule.action_type]   || rule.action_type
          const lastT = rule.last_triggered_at ? '上次：' + fmtTime(rule.last_triggered_at) : '从未触发'
          return '<div class="alr-card" style="' + (!rule.enabled ? 'opacity:.5' : '') + '">' +
            '<div class="alr-card-info">' +
              '<div class="alr-name">' + esc(rule.name) + '</div>' +
              '<div class="alr-meta">' + tLbl + ' → ' + aLbl + ' · ' + lastT + '</div>' +
            '</div>' +
            '<button onclick="toggleAutoRule(\'' + rule.id + '\',' + !rule.enabled + ')" class="alr-del" title="' + (rule.enabled?'停用':'启用') + '" style="margin-right:4px">' + (rule.enabled?'⏸':'▶') + '</button>' +
            '<button onclick="deleteAutoRule(\'' + rule.id + '\')" class="alr-del" title="删除">✕</button>' +
          '</div>'
        }).join('')
      : '<p style="color:var(--ink-5);font-size:12px;padding:8px">暂无规则，在下方添加</p>'
  } catch(e) { el.innerHTML = '<p style="color:#d11a13;font-size:12px;padding:8px">加载失败：' + esc(e.message) + '</p>' }
}

async function toggleAutoRule(ruleId, enabled) {
  const r = await fetch(EDGE_URL, { method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+SUPABASE_ANON},
    body: JSON.stringify(orchBody({ action:'automation_crud', method:'update', rule_id: ruleId, data:{ enabled } })) })
  const d = await r.json()
  if (d.ok) { toast(enabled ? '规则已启用' : '规则已停用', 'success'); loadAlertRules() }
  else toast(d.error||'操作失败', 'error')
}

async function deleteAutoRule(ruleId) {
  if (!confirm('确定删除此自动化规则？')) return
  const r = await fetch(EDGE_URL, { method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+SUPABASE_ANON},
    body: JSON.stringify(orchBody({ action:'automation_crud', method:'delete', rule_id: ruleId })) })
  const d = await r.json()
  if (d.ok) { toast('规则已删除', 'success'); loadAlertRules() }
  else toast(d.error||'删除失败', 'error')
}

async function loadAlertHistory() {
  const el  = document.getElementById('alertHistoryBody')
  const cnt = document.getElementById('alertHistCount')
  if (!el) return
  try {
    const q = db.from('automation_logs').select('id,rule_id,triggered_at,action_taken,message,status,read')
      .order('triggered_at', { ascending: false }).limit(50)
    if (_session?.tenant_id) q.eq('tenant_id', _session.tenant_id)
    const { data } = await q
    const rows = data || []
    if (cnt) cnt.textContent = `共 ${rows.length} 条`
    el.innerHTML = rows.length
      ? rows.map(r => `<div class="alert-row" style="grid-template-columns:100px 1fr 90px 32px;${!r.read ? 'background:#fffbeb' : ''}">
          <span style="color:var(--ink-4)">${fmtTime(r.triggered_at)}</span>
          <span style="font-size:11px;white-space:pre-wrap;word-break:break-word">${esc((r.message||'').slice(0,120))}${(r.message||'').length>120?'…':''}</span>
          <span><span style="background:#f3f4f6;border-radius:4px;padding:2px 6px;font-size:10px">${esc(_alrActionLbl[r.action_taken]||r.action_taken||'—')}</span></span>
          <span>${!r.read ? '<button onclick="markLogRead(\''+r.id+'\')" style="background:none;border:none;color:#f59e0b;cursor:pointer;font-size:13px;padding:0" title="标为已读">●</button>' : ''}</span>
        </div>`).join('')
      : '<p style="color:var(--ink-5);font-size:12px;padding:20px;text-align:center">暂无触发记录</p>'
  } catch(e) { el.innerHTML = '<p style="color:var(--ink-5);font-size:12px;padding:20px;text-align:center">加载失败</p>' }
}

async function markLogRead(logId) {
  await fetch(EDGE_URL, { method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+SUPABASE_ANON},
    body: JSON.stringify(orchBody({ action:'automation_crud', method:'mark_read', rule_id: logId })) })
  loadAlertHistory()
}

async function saveAlertRule() {
  const name        = document.getElementById('alrName')?.value.trim()
  const triggerType = document.getElementById('alrTriggerType')?.value
  const actionType  = document.getElementById('alrAction')?.value
  const msg         = document.getElementById('alrSaveMsg')
  if (!name) { toast('请填写规则名称', 'error'); return }
  let trigger_config = {}
  if (triggerType === 'threshold') {
    const threshold = document.getElementById('alrThreshold')?.value
    if (!threshold) { toast('请填写阈值', 'error'); return }
    trigger_config = {
      metric:   document.getElementById('alrMetric')?.value || 'cpl',
      operator: document.getElementById('alrOp')?.value     || 'gt',
      value:    +threshold,
      days:     +(document.getElementById('alrDays')?.value) || 3,
    }
  } else if (triggerType === 'schedule') {
    trigger_config = { interval_hours: +(document.getElementById('alrInterval')?.value) || 24 }
  } else if (triggerType === 'event') {
    trigger_config = {
      event: document.getElementById('alrEvent')?.value || 'uncontacted_leads',
      hours: +(document.getElementById('alrEventHours')?.value) || 24,
    }
  } else if (triggerType === 'anomaly') {
    const pct = +(document.getElementById('alrAnomalyPct')?.value) || 50
    trigger_config = {
      metric:        document.getElementById('alrAnomalyMetric')?.value || 'cpl',
      deviation_pct: pct,
      direction:     document.getElementById('alrAnomalyDir')?.value    || 'above',
    }
  } else if (triggerType === 'pattern') {
    const pct = +(document.getElementById('alrPatternPct')?.value) || 30
    trigger_config = {
      metric:        document.getElementById('alrPatternMetric')?.value || 'cpl',
      day_of_week:   +(document.getElementById('alrPatternDOW')?.value),
      threshold_pct: pct,
      direction:     document.getElementById('alrPatternDir')?.value    || 'above',
    }
  }
  if (msg) { msg.className = 'status-txt'; msg.textContent = '保存中…' }
  try {
    const r = await fetch(EDGE_URL, { method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+SUPABASE_ANON},
      body: JSON.stringify(orchBody({ action:'automation_crud', method:'create', data:{
        name, trigger_type: triggerType, trigger_config,
        action_type: actionType, action_config: {}, enabled: true, created_by: 'user',
      }}))
    })
    const d = await r.json()
    if (!d.ok) throw new Error(d.error||'保存失败')
    if (msg) { msg.className = 'status-txt ok'; msg.textContent = '✓ 规则已添加' }
    document.getElementById('alrName').value = ''
    const thEl = document.getElementById('alrThreshold'); if (thEl) thEl.value = ''
    loadAlertRules()
    toast('自动化规则已保存', 'success')
  } catch(e) {
    if (msg) { msg.className = 'status-txt err'; msg.textContent = '失败：' + e.message }
    toast('保存失败：' + e.message, 'error')
  }
}

async function checkAlertsNow() {
  toast('触发检测中…', 'info')
  try {
    const r = await fetch(EDGE_URL, { method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+SUPABASE_ANON},
      body: JSON.stringify(orchBody({ action:'automation_run', tenant_id: _session?.tenant_id || undefined }))
    })
    const d = await r.json()
    toast(d.ok ? `检测完成，触发 ${d.triggered||0} 条规则` : (d.error||'检测失败'), d.ok ? 'success' : 'error')
    if (d.ok) loadAlertHistory()
  } catch(e) { toast('检测失败：'+e.message, 'error') }
}

// ── Usage & Cost Page ────────────────────────────────────────────────
async function loadUsagePage() {
  const days = Number(document.getElementById('usageDays')?.value || 30)

  // Reset cards to loading state
  ;['uTotalCost','uTotalTokens','uTotalCalls','uAvgCost'].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = '…'
  })
  document.getElementById('usageByAgent').innerHTML = '<div style="color:var(--ink-5)">加载中…</div>'
  document.getElementById('usageByDay').innerHTML   = '<div style="color:var(--ink-5)">加载中…</div>'

  try {
    // Fetch raw conversation data with tokens/cost
    const since = new Date(Date.now() - days * 86400000).toISOString()
    const { data, error } = await db
      .from('conversations')
      .select('agent, tokens_in, tokens_out, cost_usd, created_at')
      .eq('role', 'assistant')
      .gte('created_at', since)
      .order('created_at', { ascending: true })

    if (error) throw error
    const rows = data || []

    // ── Summary cards ─────────────────────────────────────────────────
    const totalCost   = rows.reduce((s, r) => s + (Number(r.cost_usd)   || 0), 0)
    const totalTokIn  = rows.reduce((s, r) => s + (Number(r.tokens_in)  || 0), 0)
    const totalTokOut = rows.reduce((s, r) => s + (Number(r.tokens_out) || 0), 0)
    const totalCalls  = rows.length
    const avgCost     = totalCalls ? totalCost / totalCalls : 0

    function fmtNum(n) { return n >= 1000000 ? (n/1000000).toFixed(1)+'M' : n >= 1000 ? (n/1000).toFixed(1)+'K' : String(n) }

    document.getElementById('uTotalCost').textContent   = '$' + totalCost.toFixed(4)
    document.getElementById('uTotalTokens').textContent = fmtNum(totalTokIn + totalTokOut)
    document.getElementById('uTotalCalls').textContent  = totalCalls
    document.getElementById('uAvgCost').textContent     = '$' + avgCost.toFixed(5)

    // ── By agent ──────────────────────────────────────────────────────
    const byAgent = {}
    rows.forEach(r => {
      const a = r.agent || 'unknown'
      if (!byAgent[a]) byAgent[a] = { cost: 0, calls: 0, tokIn: 0, tokOut: 0 }
      byAgent[a].cost   += Number(r.cost_usd)   || 0
      byAgent[a].calls  += 1
      byAgent[a].tokIn  += Number(r.tokens_in)  || 0
      byAgent[a].tokOut += Number(r.tokens_out) || 0
    })
    const agentRows = Object.entries(byAgent).sort((a,b) => b[1].cost - a[1].cost)
    const maxCost = agentRows[0]?.[1].cost || 1
    document.getElementById('usageByAgent').innerHTML = agentRows.length ? agentRows.map(([agent, d]) => `
      <div style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
          <span style="font-weight:600">${agent}</span>
          <span style="color:var(--green-ink)">$${d.cost.toFixed(4)}</span>
        </div>
        <div style="background:#f3f4f6;border-radius:4px;height:6px;overflow:hidden">
          <div style="background:#22c55e;height:100%;width:${Math.round(d.cost/maxCost*100)}%;border-radius:4px;transition:width .3s"></div>
        </div>
        <div style="font-size:10px;color:var(--ink-5);margin-top:3px">${d.calls} 次对话 · ↑${fmtNum(d.tokIn)} ↓${fmtNum(d.tokOut)} tokens</div>
      </div>`).join('') : '<div style="color:var(--ink-5);font-size:12px">暂无数据</div>'

    // ── By day trend ──────────────────────────────────────────────────
    const byDay = {}
    rows.forEach(r => {
      const day = (r.created_at||'').slice(0,10)
      if (!byDay[day]) byDay[day] = 0
      byDay[day] += Number(r.cost_usd) || 0
    })
    const dayEntries = Object.entries(byDay).sort((a,b) => a[0].localeCompare(b[0]))
    const maxDay = Math.max(...dayEntries.map(([,v])=>v), 0.0001)
    document.getElementById('usageByDay').innerHTML = dayEntries.length ? `
      <div style="display:flex;align-items:flex-end;gap:3px;height:80px;margin-bottom:8px">
        ${dayEntries.map(([day,cost]) => `
          <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px" title="${day}: $${cost.toFixed(4)}">
            <div style="width:100%;background:#3b82f6;border-radius:2px 2px 0 0;min-height:2px;height:${Math.round(cost/maxDay*72)}px"></div>
          </div>`).join('')}
      </div>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--ink-5)">
        <span>${dayEntries[0]?.[0]?.slice(5)||''}</span>
        <span>${dayEntries[dayEntries.length-1]?.[0]?.slice(5)||''}</span>
      </div>
    ` : '<div style="color:var(--ink-5);font-size:12px;padding-top:30px;text-align:center">暂无数据</div>'

  } catch (e) {
    document.getElementById('usageByAgent').innerHTML = `<div style="color:#d11a13;font-size:12px">加载失败：${e.message}</div>`
  }
}

// ── Init ──────────────────────────────────────────────────────────────
