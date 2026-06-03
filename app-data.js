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
