// Team actions: staff, team tasks, direct messages, document approval.
import { sendNotification } from '../automation.ts'
import { dbDelete, dbGet, dbInsert, dbInsertReturning, dbPatch, dbPatchWhere } from '../db.ts'
import { type Body, R, tenantFilters } from '../state.ts'
import { deleteFile, nameFromUrl, signedUrl } from '../storage.ts'

// Returns the response for one of this module's actions, or undefined for any other action
export async function handleTeamActions(body: Body, CORS: Record<string, string>): Promise<Response | undefined> {
  // ── Staff (员工) ─────────────────────────────────────────────────────
  if (body.action === 'staff_crud') {
    const m = String(body.method || 'list')
    if (m === 'list') {
      const filt: Record<string, string> = body.active_only ? { active: 'eq.true' } : {}
      const staff = await dbGet('staff', 'id,name,avatar,role,department,active', tenantFilters(filt), 'name.asc')
      return new Response(JSON.stringify({ ok: true, staff }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    if (m === 'save') {
      const d = (body.data || {}) as Record<string, unknown>
      const name = String(d.name ?? '').trim()
      if (!name) return new Response(JSON.stringify({ error: 'name required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const fields: Record<string, unknown> = { name }
      for (const k of ['avatar', 'role', 'department']) fields[k] = String(d[k] ?? '').trim() || null
      const id = String(body.id || '')
      if (id) {
        await dbPatchWhere('staff', tenantFilters({ id: `eq.${id}` }), fields)
      } else {
        const ins = await dbInsert('staff', { ...fields, tenant_id: R.tenantId || 'default' })
        if (!ins.ok) return new Response(JSON.stringify({ error: ins.error || 'insert failed' }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    if (m === 'set_active') {
      const id = String(body.id || '')
      if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      await dbPatchWhere('staff', tenantFilters({ id: `eq.${id}` }), { active: !!body.active })
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ error: 'unknown method' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  // ── Team tasks (任务) ─────────────────────────────────────────────────
  // Not `list_tasks` — that name belongs to the agent task runner.
  if (body.action === 'staff_task_crud') {
    const m = String(body.method || 'list')
    const STATUSES = ['todo', 'in_progress', 'done']
    const PRIORITIES = ['high', 'normal', 'low']

    if (m === 'list') {
      const filt: Record<string, string> = {}
      if (body.status)      filt['status']      = `eq.${String(body.status)}`
      if (body.assignee_id) filt['assignee_id'] = `eq.${String(body.assignee_id)}`
      const tasks = await dbGet('tasks', 'id,title,description,assignee_id,created_by,priority,status,due_date,updated_at,created_at',
        tenantFilters(filt), 'created_at.desc') as Record<string, unknown>[]
      // Attach assignee / creator here: postgres mode has no PostgREST resource embedding
      const ids = [...new Set(tasks.flatMap(t => [t.assignee_id, t.created_by]).filter(Boolean).map(String))]
      const people = ids.length ? await dbGet('staff', 'id,name,avatar', { id: `in.(${ids.join(',')})` }) as { id: string; name: string; avatar: string | null }[] : []
      const byId = new Map(people.map(p => [p.id, p]))
      for (const t of tasks) {
        const a = byId.get(String(t.assignee_id))
        const c = byId.get(String(t.created_by))
        t.assignee = a ? { id: a.id, name: a.name, avatar: a.avatar } : null
        t.creator  = c ? { id: c.id, name: c.name } : null
      }
      return new Response(JSON.stringify({ ok: true, tasks }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    if (m === 'save') {
      const d = (body.data || {}) as Record<string, unknown>
      const title = String(d.title ?? '').trim()
      if (!title) return new Response(JSON.stringify({ error: 'title required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const fields: Record<string, unknown> = {
        title,
        description: String(d.description ?? '').trim() || null,
        assignee_id: d.assignee_id || null,
        priority:    PRIORITIES.includes(String(d.priority)) ? String(d.priority) : 'normal',
        due_date:    d.due_date || null,
        updated_at:  new Date().toISOString(),
      }
      const id = String(body.id || '')
      if (id) {
        await dbPatchWhere('tasks', tenantFilters({ id: `eq.${id}` }), fields)   // creator is set once, on create
      } else {
        const ins = await dbInsert('tasks', { ...fields, created_by: d.created_by || null, tenant_id: R.tenantId || 'default' })
        if (!ins.ok) return new Response(JSON.stringify({ error: ins.error || 'insert failed' }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    if (m === 'set_status' || m === 'delete') {
      const id = String(body.id || '')
      if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      if (m === 'delete') {
        await dbDelete('tasks', tenantFilters({ id: `eq.${id}` }))
      } else {
        const status = String(body.status || '')
        if (!STATUSES.includes(status)) return new Response(JSON.stringify({ error: 'unknown status' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
        await dbPatchWhere('tasks', tenantFilters({ id: `eq.${id}` }), { status, updated_at: new Date().toISOString() })
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ error: 'unknown method' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  // ── Direct messages (消息) ────────────────────────────────────────────
  // The dashboard polls `poll` instead of subscribing to Supabase Realtime.
  if (body.action === 'direct_message_crud') {
    type DmRow = { id: string; from_id: string; to_id: string; content: string; read_at: string | null; created_at: string }
    const m = String(body.method || 'list')
    const isId = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
    const me = String(body.me || ''), peer = String(body.peer || '')
    const DM_COLS = 'id,from_id,to_id,content,read_at,created_at'
    // Marks only these rows read, so a message arriving mid-request stays unread for the next poll
    const markRead = async (rows: DmRow[]) => {
      const ids = rows.filter(r => r.to_id === me && !r.read_at).map(r => r.id)
      if (ids.length) await dbPatchWhere('direct_messages', { id: `in.(${ids.join(',')})` }, { read_at: new Date().toISOString() })
    }

    if (m === 'list') {
      if (!isId(me) || !isId(peer)) return new Response(JSON.stringify({ error: 'me and peer (staff ids) required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const rows = await dbGet('direct_messages', DM_COLS,
        tenantFilters({ or: `(and(from_id.eq.${me},to_id.eq.${peer}),and(from_id.eq.${peer},to_id.eq.${me}))` }), 'created_at.desc', 100) as DmRow[]
      rows.reverse()   // the newest 100, oldest first
      await markRead(rows)
      return new Response(JSON.stringify({ ok: true, messages: rows }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    if (m === 'send') {
      const content = String(body.content ?? '').trim()
      if (!isId(me) || !isId(peer) || !content) return new Response(JSON.stringify({ error: 'me, peer and content required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const message = await dbInsertReturning('direct_messages', { from_id: me, to_id: peer, content, tenant_id: R.tenantId || 'default' })
      return new Response(JSON.stringify({ ok: true, message }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    if (m === 'poll') {
      // messages: unread from the open thread's peer (now marked read); unread_from: other senders with unread messages
      if (!isId(me)) return new Response(JSON.stringify({ error: 'me (staff id) required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const unread = await dbGet('direct_messages', DM_COLS, tenantFilters({ to_id: `eq.${me}`, read_at: 'is.null' }), 'created_at.asc', 200) as DmRow[]
      const messages = isId(peer) ? unread.filter(r => r.from_id === peer) : []
      await markRead(messages)
      const unread_from = [...new Set(unread.filter(r => r.from_id !== peer).map(r => r.from_id))]
      return new Response(JSON.stringify({ ok: true, messages, unread_from }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ error: 'unknown method' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  // ── Document approval (文件审批) ─────────────────────────────────────
  // Attachments are uploaded first via POST <base>/files/documents. The
  // document status is recomputed here after every reviewer decision.
  if (body.action === 'document_crud') {
    const m = String(body.method || 'list')
    const DOC_COLS = 'id,title,notes,file_url,file_name,file_type,file_size,status,uploaded_by,tenant_id,created_at'

    if (m === 'list') {
      const filt: Record<string, string> = {}
      if (body.status) filt['status'] = `eq.${String(body.status)}`
      let docs = await dbGet('documents', DOC_COLS, tenantFilters(filt), 'created_at.desc', 100) as Record<string, unknown>[]
      // Members see only documents they uploaded or review
      const viewer = R.email
      if (R.role === 'member') {
        const mine = await dbGet('document_reviewers', 'document_id', { contact: `eq.${viewer}` }) as { document_id: string }[]
        const reviewing = new Set(mine.map(r => r.document_id))
        docs = docs.filter(d => d.uploaded_by === viewer || reviewing.has(String(d.id)))
      }
      const ids = docs.map(d => String(d.id))
      const revs = ids.length ? await dbGet('document_reviewers', 'document_id,decision', { document_id: `in.(${ids.join(',')})` }) as { document_id: string; decision: string | null }[] : []
      for (const d of docs) {
        d.decisions = revs.filter(r => r.document_id === d.id).map(r => r.decision)
        d.file_url = await signedUrl(d.file_url as string | null, 3600)
      }
      return new Response(JSON.stringify({ ok: true, documents: docs }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    if (m === 'get') {
      const id = String(body.id || '')
      if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const [doc] = await dbGet('documents', DOC_COLS, tenantFilters({ id: `eq.${id}` }), undefined, 1)
      if (!doc) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const reviewers = await dbGet('document_reviewers', 'id,document_id,name,contact,decision,comment,decided_at,created_at', { document_id: `eq.${id}` }, 'created_at.asc')
      // Same rule as list: a member sees only documents they uploaded or review
      if (R.role === 'member' && String(doc.uploaded_by || '').trim().toLowerCase() !== R.email
          && !reviewers.some((r: { contact: string | null }) => String(r.contact || '').trim().toLowerCase() === R.email)) {
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      doc.file_url = await signedUrl(doc.file_url, 3600)
      return new Response(JSON.stringify({ ok: true, document: doc, reviewers }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    if (m === 'create') {
      const d = (body.data || {}) as Record<string, unknown>
      const title = String(d.title ?? '').trim()
      const reviewers = (Array.isArray(body.reviewers) ? body.reviewers as Record<string, unknown>[] : [])
        .map(r => ({ name: String(r?.name ?? '').trim(), contact: String(r?.contact ?? '').trim() || null }))
        .filter(r => r.name)
      if (!title) return new Response(JSON.stringify({ error: 'title required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      if (!reviewers.length) return new Response(JSON.stringify({ error: 'at least one reviewer required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const doc = await dbInsertReturning('documents', {
        title, notes: String(d.notes ?? '').trim() || null,
        file_url: d.file_url || null, file_name: d.file_name || null, file_type: d.file_type || null,
        file_size: d.file_size ? Number(d.file_size) : null, status: 'pending',
        // the uploader is the logged-in user; only internal callers may name one
        tenant_id: R.tenantId, uploaded_by: R.email || d.uploaded_by || null,
      })
      const ins = await dbInsert('document_reviewers', reviewers.map(r => ({ document_id: doc.id, ...r })))
      if (!ins.ok) {
        await dbDelete('documents', { id: `eq.${doc.id}` })   // no document without reviewers
        return new Response(JSON.stringify({ error: ins.error || 'insert failed' }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: true, id: doc.id }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    if (m === 'decide') {
      const reviewerId = String(body.reviewer_id || '')
      const decision = String(body.decision || '')
      if (!reviewerId || !['approved', 'rejected'].includes(decision)) return new Response(JSON.stringify({ error: 'reviewer_id and decision (approved | rejected) required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const [rev] = await dbGet('document_reviewers', 'id,document_id,contact', { id: `eq.${reviewerId}` }, undefined, 1)
      if (!rev) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const [revDoc] = await dbGet('documents', 'id', tenantFilters({ id: `eq.${rev.document_id}` }), undefined, 1)
      if (!revDoc) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } })
      // A member may only record the decision on their own reviewer row
      if (R.role === 'member' && String(rev.contact || '').trim().toLowerCase() !== R.email) {
        return new Response(JSON.stringify({ error: '只能填写你自己的审批' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      await dbPatch('document_reviewers', reviewerId, { decision, comment: String(body.comment ?? '').trim() || null, decided_at: new Date().toISOString() })
      const all = await dbGet('document_reviewers', 'decision', { document_id: `eq.${rev.document_id}` }) as { decision: string | null }[]
      const approved = all.filter(r => r.decision === 'approved').length
      const rejected = all.filter(r => r.decision === 'rejected').length
      const status = rejected > 0 ? 'rejected' : approved === all.length ? 'approved' : approved > 0 ? 'partial' : 'pending'
      await dbPatch('documents', String(rev.document_id), { status })
      return new Response(JSON.stringify({ ok: true, status }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    if (m === 'delete') {
      const id = String(body.id || '')
      if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      const [doc] = await dbGet('documents', 'id,file_url,uploaded_by', tenantFilters({ id: `eq.${id}` }), undefined, 1)
      if (!doc) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } })
      // A member may only delete documents they uploaded
      if (R.role === 'member' && String(doc.uploaded_by || '').trim().toLowerCase() !== R.email) {
        return new Response(JSON.stringify({ error: '只能删除你自己上传的文件' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      await dbDelete('documents', { id: `eq.${id}` })   // reviewers go with it (ON DELETE CASCADE)
      // Best effort: the record is already gone, and a leftover file is harmless
      const name = doc.file_url ? nameFromUrl('documents', String(doc.file_url)) : null
      let file_deleted = false
      if (name) {
        try { await deleteFile('documents', name); file_deleted = true } catch (e) { console.error('deleteFile documents', name, e) }
      }
      return new Response(JSON.stringify({ ok: true, file_deleted }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ error: 'unknown method' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  // ── Document reviewer notifications ──────────────────────────────
  if (body.action === 'notify_doc_reviewers') {
    const { doc_id, doc_title, uploaded_by, reviewers } = body as any
    const revList: Array<{name:string;contact:string}> = reviewers || []
    const title    = String(doc_title || '文件')
    const uploader = String(uploaded_by || '系统')
    const dashUrl  = 'https://orchestrator-agent.ks9988467.workers.dev'
    const msg = `📋 文件审批请求\n\n文件：${title}\n上传人：${uploader}\n\n请登入系统进行审批。\n${dashUrl}`
    let sent = 0
    const results: any[] = []
    for (const rev of revList) {
      const contact = (rev.contact || '').trim()
      if (!contact) continue
      const isEmail = contact.includes('@')
      try {
        await sendNotification(isEmail ? 'sendgrid' : 'whatsapp', msg, contact)
        sent++
        results.push({ name: rev.name, channel: isEmail ? 'email' : 'whatsapp', status: 'sent' })
      } catch(e) {
        results.push({ name: rev.name, status: 'error', error: (e as Error).message })
      }
    }
    return new Response(JSON.stringify({ ok: true, sent, results }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  if (body.action === 'notify_doc_decision') {
    const { doc_title, decision, reviewer_name, uploaded_by } = body as any
    if (!uploaded_by) return new Response(JSON.stringify({ ok: true, sent: 0 }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    const decLabel = decision === 'approved' ? '✅ 已批准' : '❌ 已拒绝'
    const msg = `${decLabel}\n\n文件：${doc_title || '—'}\n审批人：${reviewer_name || '—'}\n\n请登入系统查看详情。`
    const isEmail = String(uploaded_by).includes('@')
    try {
      await sendNotification(isEmail ? 'sendgrid' : 'whatsapp', msg, String(uploaded_by))
      return new Response(JSON.stringify({ ok: true, sent: 1 }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    } catch(e) {
      return new Response(JSON.stringify({ ok: true, sent: 0, error: (e as Error).message }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
  }
}
