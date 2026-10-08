// ══════════════════════════════════════════════════════════════════════
// Smoke test: exercise db.ts in DB_DRIVER=postgres mode against the local
// docker database. First real execution of the SQL branches written in
// migration steps 1 & 2 (the rest branch is what production still uses).
//
// Run from the project root (PowerShell):
//   $env:DB_DRIVER="postgres"
//   $env:DATABASE_URL="postgresql://ucg:ucg_local_dev@localhost:5433/ucg"
//   deno run --allow-net --allow-env --allow-read local/smoke-db.ts
//
// All rows it creates carry the marker below and are deleted at the end.
// ══════════════════════════════════════════════════════════════════════

import {
  dbDelete, dbGet, dbGetPage, dbInsert, dbInsertReturning, dbPatch, dbPatchWhere, dbRpc, dbUpsert,
} from '../supabase/functions/orchestrator/db.ts'

if (Deno.env.get('DB_DRIVER') !== 'postgres') {
  console.error('Refusing to run: DB_DRIVER must be "postgres" (never run this against production REST).')
  Deno.exit(2)
}

const MARK = `smoke_${Date.now()}`
let pass = 0, fail = 0
function check(name: string, ok: boolean, detail: unknown = '') {
  if (ok) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}`, detail) }
}

// ── 1. dbInsert / dbInsertReturning (uuid default, returning *) ────────
console.log('\n[1] insert')
const ins = await dbInsert('tenants', { name: `${MARK}_a`, slug: `${MARK}_a` })
check('dbInsert returns {ok:true}', ins.ok === true, ins)
const t = await dbInsertReturning('tenants', { name: `${MARK}_b`, slug: `${MARK}_b`, contact_email: 'x@y.z' })
check('dbInsertReturning returns row with uuid id', typeof t.id === 'string' && /^[0-9a-f-]{36}$/.test(String(t.id)), t)

// ── 2. dbGet: eq / ilike / order / limit ───────────────────────────────
console.log('\n[2] dbGet filters')
const byEq = await dbGet('tenants', 'id,name', { slug: `eq.${MARK}_b` })
check('eq filter finds the row', byEq.length === 1 && byEq[0].id === t.id, byEq)
const byIlike = await dbGet('tenants', 'slug', { slug: `ilike.${MARK}%` }, 'slug.asc', 10)
check('ilike + order asc + limit', byIlike.length === 2 && byIlike[0].slug === `${MARK}_a`, byIlike)
const since = new Date(Date.now() - 60_000).toISOString()
const until = new Date(Date.now() + 60_000).toISOString()
const byRange = await dbGet('tenants', 'id', { slug: `ilike.${MARK}%`, created_at: `gte.${since}`, created_at2: `lte.${until}` })
check('dedup suffix: created_at gte + created_at2 lte', byRange.length === 2, byRange)

// ── 3. dbPatch by id ───────────────────────────────────────────────────
console.log('\n[3] dbPatch')
await dbPatch('tenants', String(t.id), { active: false, contact_name: 'patched' })
const afterPatch = await dbGet('tenants', 'active,contact_name', { id: `eq.${t.id}` })
check('boolean + text patched', afterPatch[0]?.active === false && afterPatch[0]?.contact_name === 'patched', afterPatch)

// ── 4. dbUpsert: single-column and composite on_conflict ───────────────
console.log('\n[4] dbUpsert')
const prefKey = `${MARK}_pref`
await dbUpsert('user_prefs', { key: prefKey, value: 'v1', confidence: 0.7 }, 'key')
await dbUpsert('user_prefs', { key: prefKey, value: 'v2', confidence: 0.9 }, 'key')
const prefs = await dbGet('user_prefs', 'value,confidence', { key: `eq.${prefKey}` })
check('on_conflict key → one row, updated', prefs.length === 1 && prefs[0].value === 'v2', prefs)
await dbUpsert('tenant_users', { email: `${MARK}@t.io`, tenant_id: String(t.id), role: 'member' }, 'email,tenant_id')
await dbUpsert('tenant_users', { email: `${MARK}@t.io`, tenant_id: String(t.id), role: 'admin' }, 'email,tenant_id')
const tu = await dbGet('tenant_users', 'role', { email: `eq.${MARK}@t.io` })
check('composite on_conflict email,tenant_id → one row, updated', tu.length === 1 && tu[0].role === 'admin', tu)

// ── 5. jsonb round-trip ────────────────────────────────────────────────
console.log('\n[5] jsonb')
const rule = await dbInsertReturning('automation_rules', {
  tenant_id: 'default', name: MARK, trigger_type: 'threshold',
  trigger_config: { metric: 'cpl', gt: 12.5, tags: ['a', 'b'] },
})
const ruleBack = await dbGet('automation_rules', 'trigger_config', { id: `eq.${rule.id}` })
const tc = ruleBack[0]?.trigger_config as Record<string, unknown> | undefined
check("tenant_id 'default' accepted (text column)", !!rule.id, rule)
check('jsonb object round-trips', tc?.metric === 'cpl' && Array.isArray(tc?.tags), ruleBack)

// ── 6. in.(…) on bigserial ids: dbPatchWhere + dbDelete ────────────────
console.log('\n[6] in.(…)')
const s1 = await dbInsertReturning('agent_suggestions', { message: `${MARK}_1` })
const s2 = await dbInsertReturning('agent_suggestions', { message: `${MARK}_2` })
await dbPatchWhere('agent_suggestions', { id: `in.(${s1.id},${s2.id})` }, { handled: true })
const handled = await dbGet('agent_suggestions', 'handled', { message: `ilike.${MARK}%` })
check('dbPatchWhere in.() updates both', handled.length === 2 && handled.every((r) => r.handled === true), handled)
const k1 = await dbInsertReturning('agent_skills', { agent: MARK, skill: 'x' })
const k2 = await dbInsertReturning('agent_skills', { agent: MARK, skill: 'y' })
await dbDelete('agent_skills', { id: `in.(${k1.id},${k2.id})` })
const skillsLeft = await dbGet('agent_skills', 'id', { agent: `eq.${MARK}` })
check('dbDelete in.() removes both', skillsLeft.length === 0, skillsLeft)

// ── 7. conversations: bigserial ordering + lt. ─────────────────────────
console.log('\n[7] conversations ordering')
const c1 = await dbInsertReturning('conversations', { session_id: MARK, role: 'user', content: 'q' })
const c2 = await dbInsertReturning('conversations', { session_id: MARK, role: 'assistant', content: 'a' })
const prev = await dbGet('conversations', 'id,role', { session_id: `eq.${MARK}`, id: `lt.${c2.id}` }, 'id.desc', 1)
check('lt.${id} + id.desc finds the preceding message', prev.length === 1 && String(prev[0].id) === String(c1.id), prev)

// ── 8. dbRpc: kb_match with a real 768-dim vector (the ::vector cast) ──
console.log('\n[8] dbRpc kb_match (pgvector)')
const kb = await dbInsertReturning('knowledge_bases', { name: MARK })
const unit = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0))
const other = Array.from({ length: 768 }, (_, i) => (i === 1 ? 1 : 0))
const ch1 = await dbInsert('kb_chunks', { kb_id: kb.id, source_name: 'same', chunk_index: 0, content: 'match me', embedding: `[${unit.join(',')}]` })
const ch2 = await dbInsert('kb_chunks', { kb_id: kb.id, source_name: 'orth', chunk_index: 1, content: 'orthogonal', embedding: `[${other.join(',')}]` })
check('insert embedding as "[…]" string literal', ch1.ok && ch2.ok, { ch1, ch2 })
const hits = await dbRpc('kb_match', { query_embedding: unit, match_kb_id: kb.id, match_count: 5 })
check('kb_match returns rows', hits.length === 2, hits)
check('nearest first, similarity ≈ 1', hits[0]?.source_name === 'same' && Math.abs(Number(hits[0]?.similarity) - 1) < 1e-6, hits[0])
check('orthogonal similarity ≈ 0', Math.abs(Number(hits[1]?.similarity)) < 1e-6, hits[1])

// ── 9. dbRpc: channel_funnel + refresh_analytics_daily ─────────────────
console.log('\n[9] dbRpc channel_funnel / refresh_analytics_daily')
await dbInsert('bookings', { tenant_id: MARK, campaign_source: `${MARK}_src`, amount_myr: 150, status: 'won' })
const funnel = await dbRpc('channel_funnel', { p_tenant: MARK, p_from: '-infinity', p_to: 'infinity' })
const src = funnel.find((r) => r.source === `${MARK}_src`)
check('channel_funnel aggregates won bookings', !!src && Number(src.customers) === 1 && Number(src.value) === 150, funnel)
await dbInsert('ad_reports', { campaign_name: MARK, day: new Date().toISOString().slice(0, 10), amount_spent_myr: 40, results: 4, new_messaging_contacts: 8, frequency: 1.5, tenant_id: MARK })
await dbInsert('ad_reports', { campaign_name: `${MARK}_blank`, day: '', amount_spent_myr: 1, tenant_id: MARK })
await dbRpc('refresh_analytics_daily', { days_back: 31 })
const daily = await dbGet('analytics_daily', 'spend_myr,cpr,cpl', { campaign_name: `eq.${MARK}` })
check("refresh_analytics_daily rolls up (and survives day = '')", daily.length === 1 && Number(daily[0].cpr) === 10 && Number(daily[0].cpl) === 5, daily)

// ── 10. Frontend tables (03-frontend-tables.sql) ───────────────────────
console.log('\n[10] frontend tables: staff / tasks / direct_messages / documents / integrations')
const st1 = await dbInsertReturning('staff', { name: `${MARK}_alice`, avatar: '🙂', tenant_id: 'default' })
const st2 = await dbInsertReturning('staff', { name: `${MARK}_bob`, tenant_id: 'default' })
const st3 = await dbInsertReturning('staff', { name: `${MARK}_tmp`, tenant_id: 'default' })
check('staff insert: uuid id + active defaults to true', typeof st1.id === 'string' && st1.active === true, st1)

const task = await dbInsertReturning('tasks', { title: `${MARK}_task`, assignee_id: st3.id, created_by: st1.id, due_date: '2026-09-30', tenant_id: 'default' })
check("tasks defaults: status 'todo', priority 'normal'", task.status === 'todo' && task.priority === 'normal', task)
const dd = task.due_date instanceof Date ? task.due_date.toISOString().slice(0, 10) : String(task.due_date)
check('tasks.due_date round-trips as 2026-09-30', dd === '2026-09-30', { raw: task.due_date, type: typeof task.due_date })
await dbDelete('staff', { id: `eq.${st3.id}` })
const taskAfter = await dbGet('tasks', 'assignee_id,created_by', { id: `eq.${task.id}` })
check('deleting a staff member sets tasks.assignee_id to null', taskAfter[0]?.assignee_id === null && taskAfter[0]?.created_by === st1.id, taskAfter)

const dm = await dbInsertReturning('direct_messages', { from_id: st1.id, to_id: st2.id, content: 'hi', tenant_id: 'default' })
check('direct_messages insert returns created_at', !!dm.created_at, dm)
const unread = await dbGet('direct_messages', 'id', { to_id: `eq.${st2.id}`, read_at: 'is.null' })
check('unread filter (read_at is.null)', unread.length === 1, unread)
await dbPatchWhere('direct_messages', { to_id: `eq.${st2.id}`, from_id: `eq.${st1.id}`, read_at: 'is.null' }, { read_at: new Date().toISOString() })
const unreadAfter = await dbGet('direct_messages', 'id', { to_id: `eq.${st2.id}`, read_at: 'is.null' })
check('mark read clears unread', unreadAfter.length === 0, unreadAfter)
console.log('  (the next dbDelete is expected to log an FK error)')
await dbDelete('staff', { id: `eq.${st1.id}` })
const stillThere = await dbGet('staff', 'id', { id: `eq.${st1.id}` })
check('staff with messages cannot be hard-deleted (FK restrict)', stillThere.length === 1, stillThere)

const doc = await dbInsertReturning('documents', { title: `${MARK}_doc`, file_size: 1234, uploaded_by: 'x@y.z', tenant_id: 'default' })
check("documents status defaults to 'pending'", doc.status === 'pending', doc)
await dbInsert('document_reviewers', [
  { document_id: doc.id, name: 'r1', contact: 'a@b.c' },
  { document_id: doc.id, name: 'r2', contact: 'd@e.f' },
])
const revs = await dbGet('document_reviewers', 'id', { document_id: `eq.${doc.id}` })
check('bulk insert of reviewers (array payload)', revs.length === 2, revs)
await dbDelete('documents', { id: `eq.${doc.id}` })
const revsAfter = await dbGet('document_reviewers', 'id', { document_id: `eq.${doc.id}` })
check('deleting a document cascades to its reviewers', revsAfter.length === 0, revsAfter)

const svc = `${MARK}_svc`
await dbUpsert('api_integrations', { service: svc, active: true, credentials: { token: 'a' } }, 'service')
await dbUpsert('api_integrations', { service: svc, active: false, updated_at: new Date().toISOString() }, 'service')
const integ = await dbGet('api_integrations', 'active,credentials', { service: `eq.${svc}` })
check('upsert on service: one row, partial update keeps credentials',
  integ.length === 1 && integ[0].active === false && (integ[0].credentials as Record<string, unknown>)?.token === 'a', integ)

const conv = await dbInsertReturning('conversations', { session_id: MARK, role: 'user', content: 'fb' })
await dbPatch('conversations', String(conv.id), { feedback: 'good' })
const fb = await dbGet('conversations', 'feedback', { id: `eq.${conv.id}` })
check('conversations.feedback is writable', fb[0]?.feedback === 'good', fb)

await dbInsert('accounts', { id: `${MARK}_acct`, name: 'Acct' })
await dbInsert('leads', { name: `${MARK}_lead`, account_id: `${MARK}_acct`, tenant_id: MARK })
const byAcct = await dbGet('leads', 'id', { account_id: `eq.${MARK}_acct` })
check('leads filter by account_id', byAcct.length === 1, byAcct)

await dbInsert('ad_reports', { campaign_name: `${MARK}_imp`, day: new Date().toISOString().slice(0, 10), amount_spent_myr: 10, impressions: 1000, link_clicks: 25, tenant_id: MARK })
await dbRpc('refresh_analytics_daily', { days_back: 31 })
const imp = await dbGet('analytics_daily', 'impressions,link_clicks', { campaign_name: `eq.${MARK}_imp` })
check('refresh_analytics_daily fills impressions + link_clicks',
  imp.length === 1 && Number(imp[0].impressions) === 1000 && Number(imp[0].link_clicks) === 25, imp)

// section cleanup (messages before staff because of the FK)
await dbDelete('direct_messages', { from_id: `eq.${st1.id}` })
await dbDelete('tasks', { id: `eq.${task.id}` })
await dbDelete('staff', { name: `ilike.${MARK}%` })
await dbDelete('api_integrations', { service: `eq.${svc}` })
await dbDelete('leads', { tenant_id: `eq.${MARK}` })
await dbDelete('accounts', { id: `eq.${MARK}_acct` })
const staffLeft = await dbGet('staff', 'id', { name: `ilike.${MARK}%` })
check('section 10 cleanup removed staff rows', staffLeft.length === 0, staffLeft)

// ── 11. PostgREST parity: * wildcard, or/and groups, date & time strings ─
console.log('\n[11] PostgREST parity: ilike *, or/and groups, date & timestamp strings')
await dbInsert('leads', [
  { name: `${MARK}_Alice Tan`, phone: '0111', email: 'alice@x.io', date: '2026-09-01', labels: 'vip,hot', tenant_id: MARK },
  { name: `${MARK}_Bob Lim`,   phone: '0222', email: 'bob@y.io',   date: '2026-09-10', labels: 'cold',    tenant_id: MARK },
  { name: `${MARK}_Carol`,     phone: '0333', email: 'carol@x.io', date: '2026-09-20', labels: 'vip',     tenant_id: MARK },
])
const tf = { tenant_id: `eq.${MARK}` }
const star = await dbGet('leads', 'name', { ...tf, labels: 'ilike.*vip*' })
check('ilike.*x* treats * as the wildcard', star.length === 2, star)
const orHit = await dbGet('leads', 'name', { ...tf, or: '(name.ilike.*bob*,email.ilike.*carol*)' }, 'name.asc')
check('or group matches either condition', orHit.length === 2 && String(orHit[0].name).includes('Bob'), orHit)
const andHit = await dbGet('leads', 'name', { ...tf, and: '(date.gte.2026-09-05,date.lte.2026-09-25)' }, 'date.asc')
check('and group applies a date range', andHit.length === 2 && String(andHit[0].name).includes('Bob'), andHit)
const nested = await dbGet('leads', 'name', { ...tf, or: '(and(phone.eq.0111,email.ilike.*x.io),and(phone.eq.0333,date.gte.2026-09-15))' })
check('nested and() inside or()', nested.length === 2, nested)
const inGroup = await dbGet('leads', 'name', { ...tf, or: '(phone.in.(0222,0333),labels.eq."vip,hot")' })
check('in.() plus a quoted value containing a comma, inside or()', inGroup.length === 3, inGroup)
const dateRow = await dbGet('leads', 'date,created_at', { ...tf, phone: 'eq.0111' })
check("date column returns the 'YYYY-MM-DD' string", dateRow[0]?.date === '2026-09-01',
  { raw: dateRow[0]?.date, type: typeof dateRow[0]?.date })
check('timestamptz returns an ISO string with +00:00 offset',
  typeof dateRow[0]?.created_at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?\+00:00$/.test(String(dateRow[0]?.created_at)),
  { raw: dateRow[0]?.created_at, type: typeof dateRow[0]?.created_at })
const convRows = await dbGet('conversations', 'id,cost_usd', { session_id: `eq.${MARK}` }, 'id.desc', 1)
const serializable = (() => { try { JSON.stringify(convRows); return true } catch { return false } })()
check('bigserial id decodes to a JS number and rows are JSON-serializable',
  convRows.length === 1 && typeof convRows[0]?.id === 'number' && serializable,
  { raw: convRows[0]?.id, type: typeof convRows[0]?.id, serializable })
const bookingRows = await dbGet('bookings', 'amount_myr', { tenant_id: `eq.${MARK}` })
check('numeric decodes to a JS number',
  typeof bookingRows[0]?.amount_myr === 'number' && bookingRows[0]?.amount_myr === 150,
  { raw: bookingRows[0]?.amount_myr, type: typeof bookingRows[0]?.amount_myr })
await dbDelete('leads', tf)

// ── 12. dbGetPage: page rows + total count ─────────────────────────────
console.log('\n[12] dbGetPage: page rows + total count')
await dbInsert('leads', [1, 2, 3, 4, 5].map((n) => ({
  name: `${MARK}_p${n}`, date: `2026-09-0${n}`, labels: n % 2 ? 'odd' : 'even', tenant_id: MARK,
})))
const pf = { tenant_id: `eq.${MARK}` }
const p1 = await dbGetPage('leads', 'name', pf, 'date.asc', 2, 0)
check('page 1: 2 rows, count 5', p1.rows.length === 2 && p1.count === 5 && String(p1.rows[0].name).endsWith('_p1'), p1)
const p3 = await dbGetPage('leads', 'name', pf, 'date.asc', 2, 4)
check('page 3 (offset 4): 1 row, count 5', p3.rows.length === 1 && p3.count === 5 && String(p3.rows[0].name).endsWith('_p5'), p3)
const past = await dbGetPage('leads', 'name', pf, 'date.asc', 2, 10)
check('offset past the end: 0 rows, count still 5', past.rows.length === 0 && past.count === 5, past)
const onlyCount = await dbGetPage('leads', 'id', { ...pf, labels: 'eq.odd' }, undefined, 0)
check('limit 0: count only (3 odd rows)', onlyCount.rows.length === 0 && onlyCount.count === 3, onlyCount)
const ranged = await dbGetPage('leads', 'name', { ...pf, date: 'gte.2026-09-02', date2: 'lte.2026-09-04' }, 'date.desc', 10)
check('same column filtered twice + desc order', ranged.count === 3 && String(ranged.rows[0].name).endsWith('_p4'), ranged)
const grouped = await dbGetPage('leads', 'name', { ...pf, or: '(name.ilike.*_p1,name.ilike.*_p5)' }, 'name.asc', 1)
check('or group with page size 1: count 2, 1 row', grouped.count === 2 && grouped.rows.length === 1, grouped)
await dbDelete('leads', pf)

// ── cleanup ────────────────────────────────────────────────────────────
console.log('\n[cleanup]')
await dbDelete('analytics_daily', { tenant_id: `eq.${MARK}` })
await dbDelete('ad_reports', { tenant_id: `eq.${MARK}` })
await dbDelete('bookings', { tenant_id: `eq.${MARK}` })
await dbDelete('kb_chunks', { kb_id: `eq.${kb.id}` })
await dbDelete('knowledge_bases', { id: `eq.${kb.id}` })
await dbDelete('conversations', { session_id: `eq.${MARK}` })
await dbDelete('agent_suggestions', { message: `ilike.${MARK}%` })
await dbDelete('automation_rules', { id: `eq.${rule.id}` })
await dbDelete('tenant_users', { email: `eq.${MARK}@t.io` })
await dbDelete('user_prefs', { key: `eq.${prefKey}` })
await dbDelete('tenants', { slug: `ilike.${MARK}%` })
const leftover = await dbGet('tenants', 'id', { slug: `ilike.${MARK}%` })
check('cleanup removed test rows', leftover.length === 0, leftover)

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed`)
Deno.exit(fail === 0 ? 0 : 1)
