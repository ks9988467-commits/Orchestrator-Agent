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
