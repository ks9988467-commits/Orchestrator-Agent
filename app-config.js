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
    apiRaw({ action: 'learn', conversation_id: id, feedback: current }).catch(() => {})
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
    const res  = await apiRaw({action:'list_models', provider:p, api_key:key})
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
    const r = await apiRaw({ action:'test_llm', provider:p })
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
    const r = await apiRaw({ action:'test_email_smtp' })
    const d = await r.json()
    if (d.ok) { msg.className='status-txt ok'; msg.textContent='✓ 测试邮件已发送（发往 From Address）'; toast('SMTP 测试邮件已发送', 'success') }
    else { msg.className='status-txt err'; msg.textContent = d.error||'发送失败'; toast(d.error||'SMTP 测试失败', 'error') }
  } catch(e) { msg.className='status-txt err'; msg.textContent='网络错误'; toast('SMTP 连接失败', 'error') }
}
async function testWhatsApp() {
  const msg = document.getElementById('imsg-whatsapp')
  msg.className = 'status-txt'; msg.textContent = '发送测试消息中…'
  try {
    const r = await apiRaw({ action:'test_whatsapp' })
    const d = await r.json()
    if (d.ok) { msg.className='status-txt ok'; msg.textContent='✓ 测试消息已发送，请检查手机 WhatsApp'; toast('WhatsApp 测试消息已发送', 'success') }
    else { msg.className='status-txt err'; msg.textContent = d.error||'发送失败'; toast(d.error||'WhatsApp 测试失败', 'error') }
  } catch(e) { msg.className='status-txt err'; msg.textContent='网络错误'; toast('WhatsApp 连接失败', 'error') }
}
async function testSendGrid() {
  const msg = document.getElementById('imsg-sendgrid')
  msg.className = 'status-txt'; msg.textContent = '发送测试邮件中…'
  try {
    const r = await apiRaw({ action:'test_sendgrid' })
    const d = await r.json()
    if (d.ok) { msg.className='status-txt ok'; msg.textContent='✓ 测试邮件已发送（发往 From Address）'; toast('SendGrid 测试邮件已发送', 'success') }
    else { msg.className='status-txt err'; msg.textContent = d.error||'发送失败'; toast(d.error||'SendGrid 测试失败', 'error') }
  } catch(e) { msg.className='status-txt err'; msg.textContent='网络错误'; toast('SendGrid 连接失败', 'error') }
}
async function testTelegram() {
  const msg = document.getElementById('imsg-telegram')
  msg.className = 'status-txt'; msg.textContent = '发送测试消息中…'
  try {
    const r = await apiRaw({ action:'test_telegram' })
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
  const r = await apiRaw({ action:'test_lark', webhook_url: url })
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
      var r = await apiRaw({action:'ugc_get_rules'})
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
    await apiRaw({action:'ugc_save_rule', platform:v, max_words:rule.maxWords, style:rule.style, special:rule.special})
    var ok = document.getElementById('ugcok-'+v)
    if (ok) { ok.style.display='inline'; setTimeout(function(){ ok.style.display='none' }, 1500) }
    toast('规则已保存', 'success')
  } catch(e) { toast('保存失败：'+e.message, 'error') }
}

async function ugcResetRule(v) {
  var def = UGC_DEFAULT_RULES[v] || {}
  if (_ugcRules) _ugcRules[v] = def
  try {
    await apiRaw({action:'ugc_reset_rule', platform:v})
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
    var r = await apiRaw({action:'ugc_generate', type:'script',
        product:prod?prod.value:'ultra_cleaning', audience:aud?aud.value:'general',
        duration:dur?dur.value:'30', content:ta.value.trim()})
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
    var r = await apiRaw({action:'ugc_generate', type:'cover',
        product:prod?prod.value:'ultra_cleaning', audience:aud?aud.value:'general',
        content:ta.value.trim()})
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
    var r = await apiRaw({action:'ugc_generate', type:'post',
        product:prod?prod.value:'ultra_cleaning', audience:aud?aud.value:'general',
        content:ta.value.trim(), platforms:_ugcState.selPlatforms})
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
