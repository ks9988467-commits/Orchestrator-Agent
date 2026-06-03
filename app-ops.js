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
