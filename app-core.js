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
