// ── Lock Screen ───────────────────────────────────────────────────────
// Login is email + one-time code. verify_otp returns a session token, kept in
// localStorage and sent as "Authorization: Bearer <token>" on every request.
// Identity (tenant / role) always comes from the backend — whoami after load.
const TOKEN_KEY = '_orch_token'
function getToken() { try { return localStorage.getItem(TOKEN_KEY) || '' } catch { return '' } }
function showLockScreen() { document.getElementById('lockScreen')?.classList.remove('hidden') }
// With a token, stay unlocked until the backend says otherwise (any 401 → lock screen)
if (getToken()) document.getElementById('lockScreen')?.classList.add('hidden')

// The session is missing, expired or revoked: forget it and ask to log in again
function handleUnauthorized() {
  try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem('_orch_session') } catch {}
  showLockScreen()
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
      errEl.textContent = ''
      document.getElementById('lockOtpStep1').style.display = 'none'
      document.getElementById('lockOtpStep2').style.display = 'block'
    } else { errEl.textContent = d.error || '发送失败' }
  } catch(e) { clearTimeout(timer); errEl.textContent = e.name === 'AbortError' ? '请求超时，请重试' : '网络错误，请重试' }
}
function backToEmailStep() {
  document.getElementById('lockOtpStep2').style.display = 'none'
  document.getElementById('lockOtpStep1').style.display = 'block'
  document.getElementById('lockCodeInput').value = ''
  document.getElementById('lockCodeErr').textContent = ''
}
async function logout() {
  try { await apiCall('logout') } catch {}
  handleUnauthorized()
  location.reload()
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
      localStorage.setItem(TOKEN_KEY, d.token)
      localStorage.setItem('_orch_session', JSON.stringify({ tenant_id: d.tenant_id || null, role: d.role || 'member', tenant_name: d.tenant_name || '', email: d.email || email || '' }))
      // Reload so every page loads its data with the new token
      location.reload()
    } else { errEl.textContent = d.error || '验证码错误' }
  } catch(e) { clearTimeout(timer); errEl.textContent = e.name === 'AbortError' ? '请求超时，请重试' : '网络错误，请重试' }
}
// ─────────────────────────────────────────────────────────────────────

// ── Backend config (portable) ─────────────────────────────────────────
// The dashboard talks only to the backend — no direct database or storage access.
// Default backend = the hosted Supabase Edge Function. To use a local or
// self-hosted backend WITHOUT editing code, set either (checked in this order):
//   1. window.ORCH_CONFIG = { backendUrl: 'http://localhost:8000' }
//      (define it before app-core.js loads)
//   2. localStorage.setItem('_orch_backend', 'http://localhost:8000')
const DEFAULT_BACKEND_URL  = 'https://ontumerafhimxvqtsijr.supabase.co/functions/v1/orchestrator'
function resolveBackendUrl() {
  try {
    if (window.ORCH_CONFIG && window.ORCH_CONFIG.backendUrl) return window.ORCH_CONFIG.backendUrl
    const override = localStorage.getItem('_orch_backend')
    if (override) return override
  } catch {}
  return DEFAULT_BACKEND_URL
}
const EDGE_URL      = resolveBackendUrl()
// The session token, once logged in. The hosted Edge Function must be deployed with
// --no-verify-jwt: this token is not a Supabase JWT.
function backendAuthHeaders() {
  const token = getToken()
  return token ? { 'Authorization': 'Bearer ' + token } : {}
}
// URL of another function deployed next to the orchestrator (e.g. 'lark-webhook').
// Only Edge Function style URLs (…/orchestrator) have siblings; null otherwise.
function siblingFunctionUrl(name) {
  return /\/orchestrator\/?$/.test(EDGE_URL) ? EDGE_URL.replace(/\/orchestrator\/?$/, '/' + name) : null
}
// Show the backend actually in use wherever the page displays its URL
;(function fillBackendUrls() {
  const wa = document.getElementById('wa-webhook-url')
  if (wa) wa.value = EDGE_URL
  document.querySelectorAll('.js-backend-url').forEach(el => { el.textContent = EDGE_URL })
  const lark = siblingFunctionUrl('lark-webhook')
  document.querySelectorAll('.js-lark-webhook-url').forEach(el => { el.textContent = lark || '（当前后端没有部署 lark-webhook）' })
})()
const AGENT_ICONS   = {chat:'💬', crm:'🤝', account:'📊', code:'💻', cpl:'💰', cpr:'🎯', frequency:'🔁', marketing:'📣'}
const PROVIDER_LABELS = {anthropic:'Anthropic · Claude', openai:'OpenAI · GPT', google:'Google · Gemini'}

let sessionId = crypto.randomUUID()

// ── Tenant session (populated after OTP login) ─────────────────────
// For the UI only (what to show a role); the backend decides from the session token.
// Taken from localStorage at once, then refreshed from whoami once the page has loaded.
let _session = { tenant_id: null, role: 'member', tenant_name: '', email: '' }
;(function() {
  try {
    const s = localStorage.getItem('_orch_session')
    if (s) _session = JSON.parse(s)
  } catch {}
})()
document.addEventListener('DOMContentLoaded', async () => {
  if (!getToken()) return
  try {
    const d = await apiCall('whoami')
    _session = { tenant_id: d.tenant_id || null, role: d.role || 'member', tenant_name: d.tenant_name || '', email: d.email || '' }
    localStorage.setItem('_orch_session', JSON.stringify(_session))
    applySessionUI()
  } catch {}   // a 401 has already brought up the lock screen
})
// Request body for an action. Identity is never sent — the backend takes it from the token.
function orchBody(extra) {
  return Object.assign({}, extra)
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
      headers: { 'Content-Type': 'application/json', ...backendAuthHeaders() },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    clearTimeout(timer);

    if (res.status === 401) { handleUnauthorized(); throw new Error('请先登录'); }
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

// Drop-in for the raw `fetch(EDGE_URL, {...})` pattern: returns the Response
// (so downstream .json()/.ok/.body keep working, streaming-safe) but centralizes
// endpoint + auth header + orchBody wrapping in one place.
function apiRaw(payload) {
  return fetch(EDGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...backendAuthHeaders() },
    body: JSON.stringify(orchBody(payload)),
  }).then(res => {
    if (res.status === 401) handleUnauthorized()
    return res
  })
}

// Upload a file through the backend, which stores it on local disk or in
// Supabase Storage (its STORAGE_DRIVER). bucket: 'documents' | 'review-files'.
// Resolves to { url, name, size, type }.
async function uploadFile(bucket, file) {
  const res = await fetch(EDGE_URL.replace(/\/+$/, '') + '/files/' + bucket, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name), ...backendAuthHeaders() },
    body: file,
  })
  if (res.status === 401) { handleUnauthorized(); throw new Error('请先登录') }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
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
let _logsRefreshTimer = null  // logs page auto-refresh; showPage clears it when leaving

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
  // Direct messages are polled only while the messaging page is open
  if (id === 'msg') startDmPolling(); else stopDmPolling()
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
