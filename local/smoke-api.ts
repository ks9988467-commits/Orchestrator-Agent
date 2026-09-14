// ══════════════════════════════════════════════════════════════════════
// API smoke test: the backend actions that replace the dashboard's direct
// supabase-js calls, exercised over HTTP against a locally running backend.
//
// Run from the project root, with the backend on :8000 (e.g. the `backend`
// launch config) — PowerShell:
//   $env:DB_DRIVER="postgres"
//   $env:DATABASE_URL="postgresql://ucg:ucg_local_dev@localhost:5433/ucg"
//   deno run --allow-net --allow-env --allow-read local/smoke-api.ts
//
// Test rows carry a unique marker and are removed at the end. Sections that
// would touch real configuration (an existing provider / default provider)
// are skipped instead.
// ══════════════════════════════════════════════════════════════════════

import { dbDelete, dbGet, dbInsert, dbInsertReturning } from '../supabase/functions/orchestrator/db.ts'

if (Deno.env.get('DB_DRIVER') !== 'postgres') {
  console.error('Refusing to run: DB_DRIVER must be "postgres" (never run this against production).')
  Deno.exit(2)
}

const BASE = Deno.env.get('ORCH_BASE_URL') || 'http://localhost:8000'
const MARK = `apismoke_${Date.now()}`
let pass = 0, fail = 0
function check(name: string, ok: boolean, detail: unknown = '') {
  if (ok) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}`, detail) }
}

// Mirrors the dashboard's apiCall/orchBody: every body carries the session role.
async function api(action: string, payload: Record<string, unknown> = {}) {
  const r = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'member', action, ...payload }),
  })
  const text = await r.text()
  // deno-lint-ignore no-explicit-any
  let json: any = {}
  try { json = JSON.parse(text) } catch { /* non-JSON body stays in text */ }
  return { status: r.status, json, text }
}

// ── 1. agent_crud ──────────────────────────────────────────────────────
console.log('\n[1] agent_crud')
await dbInsert('agents', { id: `${MARK}_a`, name: 'Smoke Agent', active: true })
const al = await api('agent_crud', { method: 'list' })
check('list includes the agent', al.status === 200 && al.json.agents?.some((a: { id: string }) => a.id === `${MARK}_a`), al.json)
const au = await api('agent_crud', { method: 'update', id: `${MARK}_a`, data: { provider: 'openai', model: '', uses_tools: 1, bogus: 'x' } })
check('update returns ok', au.status === 200 && au.json.ok === true, au.json)
const ag = await dbGet('agents', 'provider,model,uses_tools,updated_at', { id: `eq.${MARK}_a` })
check("update: provider set, '' model → null, uses_tools → boolean, updated_at set, unknown field ignored",
  ag[0]?.provider === 'openai' && ag[0]?.model === null && ag[0]?.uses_tools === true && !!ag[0]?.updated_at, ag)
const an = await api('agent_crud', { method: 'update', data: { name: 'x' } })
check('update without id → 400', an.status === 400, an.json)
const ae = await api('agent_crud', { method: 'update', id: `${MARK}_a`, data: { bogus: 1 } })
check('update with no allowed fields → 400', ae.status === 400, ae.json)

// ── 2. provider_config_crud ────────────────────────────────────────────
console.log('\n[2] provider_config_crud')
const existingProvider = await dbGet('provider_config', 'provider', { provider: 'eq.openrouter' })
if (existingProvider.length) {
  console.log('  (skipped key tests: a real openrouter row exists)')
} else {
  const FAKE_KEY = 'sk-smoke-0123456789abcd'
  const ps = await api('provider_config_crud', { method: 'save', provider: 'openrouter', api_key: FAKE_KEY, model: ' m1 ', active: true })
  check('save returns ok', ps.status === 200 && ps.json.ok === true, ps.json)
  const pl = await api('provider_config_crud', { method: 'list' })
  const row = pl.json.providers?.find((p: { provider: string }) => p.provider === 'openrouter')
  check('list: has_key true, key_hint = last 4 chars, model trimmed', row?.has_key === true && row?.key_hint === 'abcd' && row?.model === 'm1', row)
  check('list response never contains the raw key', !pl.text.includes(FAKE_KEY), '(raw key present in response)')
  await api('provider_config_crud', { method: 'save', provider: 'openrouter', active: false })
  const s1 = await dbGet('provider_config', 'api_key,active,model', { provider: 'eq.openrouter' })
  check('partial save (active only) keeps api_key and model', s1[0]?.api_key === FAKE_KEY && s1[0]?.active === false && s1[0]?.model === 'm1', s1)
  await api('provider_config_crud', { method: 'save', provider: 'openrouter', api_key: '   ' })
  const s2 = await dbGet('provider_config', 'api_key', { provider: 'eq.openrouter' })
  check('blank api_key keeps the stored key', s2[0]?.api_key === FAKE_KEY, s2)
  const bad = await api('provider_config_crud', { method: 'save', provider: 'nope' })
  check('unknown provider → 400', bad.status === 400, bad.json)
  await dbDelete('provider_config', { provider: 'eq.openrouter' })
}
const existingDefault = await dbGet('user_prefs', 'value', { key: 'eq.default_provider' })
if (existingDefault.length) {
  console.log('  (skipped set_default: a real default_provider exists)')
} else {
  const sd = await api('provider_config_crud', { method: 'set_default', provider: 'google' })
  const pl2 = await api('provider_config_crud', { method: 'list' })
  check('set_default, then list returns it', sd.status === 200 && pl2.json.default_provider === 'google', pl2.json)
  const sdBad = await api('provider_config_crud', { method: 'set_default', provider: 'x' })
  check('set_default with unknown provider → 400', sdBad.status === 400, sdBad.json)
  await dbDelete('user_prefs', { key: 'eq.default_provider' })
}

// ── 3. integration_crud ────────────────────────────────────────────────
console.log('\n[3] integration_crud')
const svc = `${MARK}_svc`
const SECRET = 'supersecret-token-9876'
await api('integration_crud', {
  method: 'save', service: svc, active: true,
  credentials: { api_key: SECRET, password: 'pw123', host: 'smtp.example.com', webhook_url: 'https://hooks.example/abc' },
})
const il = await api('integration_crud', { method: 'list' })
const creds = (il.json.integrations?.find((i: { service: string }) => i.service === svc)?.credentials || {}) as Record<string, string>
check('list masks long secrets, keeping the last 4 chars', creds.api_key === '••••••••9876', creds)
check('list fully masks short secrets', creds.password === '••••••••', creds)
check('list leaves non-secret fields and webhook_url visible', creds.host === 'smtp.example.com' && creds.webhook_url === 'https://hooks.example/abc', creds)
check('list response never contains the raw secrets', !il.text.includes(SECRET) && !il.text.includes('pw123'), '(secret present in response)')
// the dashboard re-submits every input, masked values included
await api('integration_crud', { method: 'save', service: svc, credentials: { ...creds, host: 'smtp.changed.com' } })
const st = await dbGet('api_integrations', 'credentials,active', { service: `eq.${svc}` })
const sc = (st[0]?.credentials || {}) as Record<string, string>
check('re-saving masked values keeps stored secrets and applies real edits',
  sc.api_key === SECRET && sc.password === 'pw123' && sc.host === 'smtp.changed.com' && st[0]?.active === true, st)
const noSvc = await api('integration_crud', { method: 'save' })
check('save without service → 400', noSvc.status === 400, noSvc.json)
await dbDelete('api_integrations', { service: `eq.${svc}` })

// ── 4. conversation_crud ───────────────────────────────────────────────
console.log('\n[4] conversation_crud')
const agentId = `${MARK}_agent`
await dbInsert('conversations', [
  { session_id: MARK, role: 'user',      content: 'q1', agent: agentId },
  { session_id: MARK, role: 'assistant', content: 'a1', agent: agentId, cost_usd: 0.0012, tokens_in: 10, tokens_out: 20 },
  { session_id: MARK, role: 'assistant', content: 'a2', agent: agentId },
])
const cl = await api('conversation_crud', { method: 'list', agent: agentId, limit: 2 })
check('list: page of 2 rows, total count 3', cl.status === 200 && cl.json.rows?.length === 2 && cl.json.count === 3, cl.json)
check('ids and cost_usd are JSON numbers',
  cl.json.rows?.every((r: { id: unknown }) => typeof r.id === 'number') &&
  cl.json.rows?.some((r: { cost_usd: unknown }) => r.cost_usd === null || typeof r.cost_usd === 'number'), cl.json.rows)
const clr = await api('conversation_crud', { method: 'list', agent: agentId, log_role: 'assistant' })
check('log_role filter works while the body also carries role:"member"', clr.json.count === 2, clr.json)
const target = clr.json.rows?.find((r: { content: string }) => r.content === 'a1')
await api('conversation_crud', { method: 'set_feedback', id: target?.id, feedback: 'good' })
const good = await api('conversation_crud', { method: 'list', agent: agentId, feedback: 'good' })
const none = await api('conversation_crud', { method: 'list', agent: agentId, feedback: 'none' })
check('set_feedback + feedback filters (good / none)', good.json.count === 1 && none.json.count === 2, { good: good.json.count, none: none.json.count })
await api('conversation_crud', { method: 'set_feedback', id: target?.id, feedback: null })
const cleared = await api('conversation_crud', { method: 'list', agent: agentId, feedback: 'good' })
check('feedback null clears it', cleared.json.count === 0, cleared.json)
const noId = await api('conversation_crud', { method: 'set_feedback', feedback: 'good' })
check('set_feedback without id → 400', noId.status === 400, noId.json)
const otherAgent = `${MARK}_other`
await dbInsert('conversations', { session_id: MARK, role: 'user', content: 'keep me', agent: otherAgent })
await api('conversation_crud', { method: 'delete_all', agent: agentId })
const left = await dbGet('conversations', 'agent', { session_id: `eq.${MARK}` })
check('delete_all with agent removes only that agent', left.length === 1 && left[0].agent === otherAgent, left)
const badMethod = await api('conversation_crud', { method: 'nope' })
check('unknown method → 400', badMethod.status === 400, badMethod.json)

// ── 5. agent_crud create / delete ──────────────────────────────────────
console.log('\n[5] agent_crud create / delete')
const newId = `${MARK}_new`
const cr = await api('agent_crud', { method: 'create', data: { id: newId, name: '新 Agent', provider: '', uses_tools: 0, bogus: 'x' } })
check('create returns ok with the id', cr.status === 200 && cr.json.ok === true && cr.json.id === newId, cr.json)
const cg = await dbGet('agents', 'name,active,provider,uses_tools', { id: `eq.${newId}` })
check("create: active defaults true, '' provider → null, uses_tools boolean",
  cg[0]?.name === '新 Agent' && cg[0]?.active === true && cg[0]?.provider === null && cg[0]?.uses_tools === false, cg)
const dup = await api('agent_crud', { method: 'create', data: { id: newId, name: 'overwrite attempt' } })
const cg2 = await dbGet('agents', 'name', { id: `eq.${newId}` })
check('create with an existing id → 409 and the row is untouched', dup.status === 409 && cg2[0]?.name === '新 Agent', { dup: dup.json, row: cg2 })
const noCid = await api('agent_crud', { method: 'create', data: { name: 'x' } })
check('create without id → 400', noCid.status === 400, noCid.json)
const del = await api('agent_crud', { method: 'delete', id: newId })
const gone = await dbGet('agents', 'id', { id: `eq.${newId}` })
check('delete removes the agent', del.status === 200 && gone.length === 0, gone)
const noDid = await api('agent_crud', { method: 'delete' })
check('delete without id → 400', noDid.status === 400, noDid.json)

// ── 6. agent_skill_crud ────────────────────────────────────────────────
console.log('\n[6] agent_skill_crud')
const skA = `${MARK}_skA`, skB = `${MARK}_skB`
await dbInsert('agent_skills', [
  { agent: skA, skill: 'skill one' }, { agent: skA, skill: 'skill two' }, { agent: skB, skill: 'keep me' },
])
const sl = await api('agent_skill_crud', { method: 'list' })
const mine = (sl.json.skills || []).filter((s: { agent: string }) => s.agent === skA)
check('list returns the skills with numeric ids', sl.status === 200 && mine.length === 2 && typeof mine[0]?.id === 'number', mine)
await api('agent_skill_crud', { method: 'delete', id: mine[0]?.id })
const afterOne = await dbGet('agent_skills', 'id', { agent: `eq.${skA}` })
check('delete removes one skill', afterOne.length === 1, afterOne)
await api('agent_skill_crud', { method: 'delete_agent', agent: skA })
const afterA = await dbGet('agent_skills', 'agent', { agent: `in.(${skA},${skB})` })
check('delete_agent removes only that agent’s skills', afterA.length === 1 && afterA[0].agent === skB, afterA)
const noAgent = await api('agent_skill_crud', { method: 'delete_agent' })
check('delete_agent without agent → 400 (never deletes everything)', noAgent.status === 400, noAgent.json)

// ── 7. agent_suggestion_crud ───────────────────────────────────────────
console.log('\n[7] agent_suggestion_crud')
await dbInsert('agent_suggestions', [{ message: `${MARK} gap 1`, session_id: MARK }, { message: `${MARK} gap 2`, session_id: MARK }])
const gl = await api('agent_suggestion_crud', { method: 'list', limit: 500 })
const gaps = (gl.json.suggestions || []).filter((s: { session_id: string }) => s.session_id === MARK)
check('list returns the suggestions, unhandled', gl.status === 200 && gaps.length === 2 && gaps.every((g: { handled: boolean }) => g.handled === false), gaps)
await api('agent_suggestion_crud', { method: 'mark_handled', id: gaps[0]?.id })
await api('agent_suggestion_crud', { method: 'delete', id: gaps[1]?.id })
const gRows = await dbGet('agent_suggestions', 'id,handled', { session_id: `eq.${MARK}` })
check('mark_handled sets handled; delete removes the other', gRows.length === 1 && gRows[0].handled === true && gRows[0].id === gaps[0]?.id, gRows)
const noGid = await api('agent_suggestion_crud', { method: 'mark_handled' })
check('mark_handled without id → 400', noGid.status === 400, noGid.json)

// ── 8. home_summary ────────────────────────────────────────────────────
// Asserts on before/after differences, so existing rows don't matter.
console.log('\n[8] home_summary')
const nowD = new Date()
const monthStart = `${nowD.getUTCFullYear()}-${String(nowD.getUTCMonth() + 1).padStart(2, '0')}-01`
const dayBefore = new Date(Date.parse(monthStart + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10)
const todayStart = new Date(nowD.getTime() - 3600000).toISOString()   // one hour ago
const hs = { month_start: monthStart, today_start: todayStart }
const h0 = await api('home_summary', hs)
check('home_summary returns ok', h0.status === 200 && h0.json.ok === true, h0.json)
await dbInsert('leads', [{ name: MARK, date: monthStart }, { name: MARK, date: monthStart }, { name: MARK, date: dayBefore }])
// every row in a batch insert needs the same keys (PostgREST rejects mixed keys)
const nowIso = nowD.toISOString()
await dbInsert('conversations', [
  { session_id: MARK, role: 'user', content: `${MARK} today`, agent: 'chat', created_at: nowIso },
  { session_id: MARK, role: 'assistant', content: `${MARK} reply`, agent: 'chat', created_at: nowIso },
  { session_id: MARK, role: 'user', content: `${MARK} old`, agent: 'chat', created_at: new Date(nowD.getTime() - 2 * 86400000).toISOString() },
])
await dbInsert('agent_suggestions', [{ message: MARK, session_id: MARK, handled: false }, { message: MARK, session_id: MARK, handled: true }])
await dbInsert('agent_skills', { agent: `${MARK}_hs`, skill: 'x' })
await dbInsert('agents', [{ id: `${MARK}_on`, name: 'On', active: true }, { id: `${MARK}_off`, name: 'Off', active: false }])
await dbInsert('analytics_daily', [
  { campaign_name: MARK, date: monthStart, spend_myr: 12.5 },
  { campaign_name: MARK, date: dayBefore, spend_myr: 99 },
])
await dbInsert('alerts', { rule_name: MARK, campaign_name: MARK, metric: 'cpl', value: 1.5 })
const h1 = await api('home_summary', hs)
const d = (k: string) => h1.json[k] - h0.json[k]
check('lead_count counts only leads from month_start on', d('lead_count') === 2, { delta: d('lead_count') })
check('today_conv_count counts user messages since today_start only', d('today_conv_count') === 1, { delta: d('today_conv_count') })
check('gap_count counts unhandled suggestions only', d('gap_count') === 1, { delta: d('gap_count') })
check('skill_count counts skills', d('skill_count') === 1, { delta: d('skill_count') })
const agentIds = (h1.json.active_agents || []).map((a: { id: string }) => a.id)
check('active_agents includes active and excludes inactive', agentIds.includes(`${MARK}_on`) && !agentIds.includes(`${MARK}_off`), agentIds)
const hsAnal = (h1.json.analytics || []).filter((r: { campaign_name: string }) => r.campaign_name === MARK)
check('analytics: only this month, spend_myr as a number', hsAnal.length === 1 && hsAnal[0].spend_myr === 12.5, hsAnal)
check('alerts: newest first, value as a number', h1.json.alerts?.[0]?.rule_name === MARK && h1.json.alerts[0].value === 1.5, h1.json.alerts?.[0])
check('recent_convs: user messages only, newest first', h1.json.recent_convs?.[0]?.content === `${MARK} today` &&
  (h1.json.recent_convs || []).every((c: { role: string }) => c.role === 'user'), h1.json.recent_convs)
const hBad = await api('home_summary', { month_start: '2026-9-1', today_start: todayStart })
check('bad month_start → 400', hBad.status === 400, hBad.json)
await dbDelete('leads', { name: `eq.${MARK}` })   // section 9 searches leads by MARK

// ── 9. data page: accounts / leads / ad reports / data entries / analytics ──
// Every test row's name / campaign / file name starts with MARK (cleanup relies on it).
console.log('\n[9] data page')
const P = `9${String(Date.now()).slice(-7)}`   // phone prefix unique to this run
await dbInsert('accounts', [{ id: `${MARK}_acc1`, name: 'B acct', active: true }, { id: `${MARK}_acc2`, name: 'A acct', active: false }])
const acc = await api('account_crud', { method: 'list' })
const accIds = (acc.json.accounts || []).map((a: { id: string }) => a.id)
check('account_crud list: active accounts only', acc.status === 200 && accIds.includes(`${MARK}_acc1`) && !accIds.includes(`${MARK}_acc2`), acc.json)

const imp = await api('lead_crud', { method: 'import', mode: 'insert', rows: [
  { name: `${MARK} one`, phone: `${P}01`, date: '2026-01-05', labels: '[Google] x' },
  { name: `${MARK} two`, phone: `${P}02`, date: '', email: 'a@b.c', bogus: 'x' },
  { name: `${MARK}, three (x)`, phone: `${P}03`, date: '2026-01-20' },
] })
check('lead import (insert): rows with different keys and an unknown column', imp.status === 200 && imp.json.inserted === 3, imp.json)
const two = await dbGet('leads', 'date,email', { phone: `eq.${P}02` })
check("lead import: '' date stored as null", two.length === 1 && two[0].date === null && two[0].email === 'a@b.c', two)

const lp = await api('lead_crud', { method: 'list', search: MARK, page: 2, limit: 2 })
check('lead list: search + page 2 of size 2 → 1 row, total 3', lp.json.rows?.length === 1 && lp.json.count === 3, lp.json)
const lc = await api('lead_crud', { method: 'list', search: `${MARK}, three (x)"` })
check('lead list: search text with comma, parentheses and a quote', lc.status === 200 && lc.json.count === 1, lc.json)
const lph = await api('lead_crud', { method: 'list', search: `${P}03` })
check('lead list: search matches phone', lph.json.count === 1, lph.json)
const ld = await api('lead_crud', { method: 'list', search: MARK, from: '2026-01-01', to: '2026-01-10' })
check('lead list: date range', ld.json.count === 1 && ld.json.rows?.[0]?.name === `${MARK} one`, ld.json)
const ll = await api('lead_crud', { method: 'list', search: MARK, label: 'google' })
check('lead list: label filter (case-insensitive)', ll.json.count === 1, ll.json)
const lx = await api('lead_crud', { method: 'export', search: MARK })
check('lead export: all matching rows', lx.status === 200 && lx.json.rows?.length === 3, lx.json)

const cp = await api('lead_crud', { method: 'check_phones', phones: [`${P}01`, `${P}99`] })
check('check_phones: returns only existing phones', Object.keys(cp.json.conflicts || {}).join() === `${P}01`, cp.json)
const sk = await api('lead_crud', { method: 'import', mode: 'skip', rows: [
  { name: `${MARK} dup`, phone: `${P}01` }, { name: `${MARK} four`, phone: `${P}04` },
] })
const p01 = await dbGet('leads', 'name', { phone: `eq.${P}01` })
check('import skip: new row added, existing phone untouched', sk.json.inserted === 1 && sk.json.skipped === 1 && p01.length === 1 && p01[0].name === `${MARK} one`, { res: sk.json, p01 })
const ow = await api('lead_crud', { method: 'import', mode: 'overwrite', rows: [
  { name: `${MARK} replaced`, phone: `${P}02` }, { name: `${MARK} dup in file`, phone: `${P}02` }, { name: `${MARK} five`, phone: `${P}05` },
] })
const p02 = await dbGet('leads', 'name', { phone: `eq.${P}02` })
check('import overwrite: old lead replaced, first row per phone wins, new row added',
  ow.json.overwritten === 1 && ow.json.inserted === 2 && p02.length === 1 && p02[0].name === `${MARK} replaced`, { res: ow.json, p02 })
const badMode = await api('lead_crud', { method: 'import', mode: 'nope', rows: [{ name: MARK }] })
const noRows = await api('lead_crud', { method: 'import', rows: [{ bogus: 1 }, { name: '' }] })
check('import: unknown mode → 400; no valid rows → 400', badMode.status === 400 && noRows.status === 400, { badMode: badMode.json, noRows: noRows.json })

const ai = await api('ad_report_crud', { method: 'import', rows: [
  { campaign_name: `${MARK} camp A`, day: '2026-02-01', amount_spent_myr: '120.5', results: '4', frequency: '' },
  { campaign_name: `${MARK} camp B`, day: '2026-02-02', amount_spent_myr: 80 },
] })
check('ad import: 2 rows', ai.status === 200 && ai.json.inserted === 2, ai.json)
const alist = await api('ad_report_crud', { method: 'list', search: MARK })
check('ad list: highest spend first, numbers as numbers, blank → null',
  alist.json.count === 2 && alist.json.rows?.[0]?.campaign_name === `${MARK} camp A` && alist.json.rows[0].amount_spent_myr === 120.5 && alist.json.rows[0].frequency === null, alist.json.rows)
const adup = await api('ad_report_crud', { method: 'import', rows: [{ campaign_name: `${MARK} camp A`, day: '2026-02-01' }] })
check('ad import: duplicate campaign + day → error returned', adup.status === 500 && !!adup.json.error, adup.json)
const ax = await api('ad_report_crud', { method: 'export', search: MARK, from: '2026-02-02' })
check('ad export: filters apply', ax.json.rows?.length === 1 && ax.json.rows[0].campaign_name === `${MARK} camp B`, ax.json)

await dbInsert('data_entries', [
  { file_name: `${MARK}.pdf`, file_type: 'pdf', structured_data: { total: 1 } },
  { file_name: `${MARK}.png`, file_type: 'image', structured_data: null },
])
const de = await api('data_entry_crud', { method: 'list', search: MARK, file_type: 'pdf' })
check('data_entry list: search + type filter, jsonb returned as object', de.json.count === 1 && de.json.rows?.[0]?.structured_data?.total === 1, de.json)

await dbInsert('analytics_daily', [
  { campaign_name: MARK, date: '2026-03-01', spend_myr: 10 },
  { campaign_name: MARK, date: '2026-03-05', spend_myr: 20 },
])
const anl = await api('analytics_crud', { method: 'list', from: '2026-03-02', to: '2026-03-31' })
const anMine = (anl.json.rows || []).filter((r: { campaign_name: string }) => r.campaign_name === MARK)
check('analytics list: date range', anl.status === 200 && anMine.length === 1 && anMine[0].spend_myr === 20, anMine)

// ── 10. staff / team tasks ─────────────────────────────────────────────
console.log('\n[10] staff / tasks')
// deno-lint-ignore no-explicit-any
type R = Record<string, any>
await api('staff_crud', { method: 'save', data: { name: `${MARK} Alice`, avatar: '🦊', role: ' PM ', department: '' } })
await api('staff_crud', { method: 'save', data: { name: `${MARK} Bob` } })
const sAll = (await api('staff_crud', { method: 'list' })).json.staff as R[]
const alice = sAll.find(s => s.name === `${MARK} Alice`), bob = sAll.find(s => s.name === `${MARK} Bob`)
check('staff save creates; role trimmed, blank department → null, active by default',
  !!alice && !!bob && alice.role === 'PM' && alice.department === null && alice.active === true, { alice, bob })
const noName = await api('staff_crud', { method: 'save', data: { name: ' ' } })
check('staff save without name → 400', noName.status === 400, noName.json)
await api('staff_crud', { method: 'save', id: bob?.id, data: { name: `${MARK} Bobby`, role: 'Dev' } })
await api('staff_crud', { method: 'set_active', id: bob?.id, active: false })
const bobRow = ((await api('staff_crud', { method: 'list' })).json.staff as R[]).find(s => s.id === bob?.id)
const activeOnly = (await api('staff_crud', { method: 'list', active_only: true })).json.staff as R[]
check('staff update + set_active; active_only hides inactive staff',
  bobRow?.name === `${MARK} Bobby` && bobRow?.active === false && !activeOnly.some(s => s.id === bob?.id) && activeOnly.some(s => s.id === alice?.id), bobRow)

const tsv = await api('staff_task_crud', { method: 'save', data: { title: `${MARK} task 1`, assignee_id: alice?.id, created_by: bob?.id, priority: 'high', due_date: '2026-10-01', description: '' } })
check('task save (create) → ok', tsv.status === 200 && tsv.json.ok === true, tsv.json)
await api('staff_task_crud', { method: 'save', data: { title: `${MARK} task 2`, priority: 'bogus' } })
const myTasks = ((await api('staff_task_crud', { method: 'list' })).json.tasks as R[]).filter(t => String(t.title).startsWith(MARK))
const t1 = myTasks.find(t => t.title === `${MARK} task 1`), t2 = myTasks.find(t => t.title === `${MARK} task 2`)
check('task list attaches assignee and creator', t1?.assignee?.name === `${MARK} Alice` && t1?.assignee?.avatar === '🦊' &&
  t1?.creator?.name === `${MARK} Bobby` && t1?.due_date === '2026-10-01' && t1?.description === null, t1)
check('task defaults: status todo, unknown priority → normal, no assignee → null', t2?.status === 'todo' && t2?.priority === 'normal' && t2?.assignee === null, t2)
const byAssignee = (await api('staff_task_crud', { method: 'list', assignee_id: alice?.id })).json.tasks as R[]
check('task list: assignee filter', byAssignee.length >= 1 && byAssignee.every(t => t.assignee_id === alice?.id), byAssignee)
await api('staff_task_crud', { method: 'set_status', id: t1?.id, status: 'in_progress' })
const inProg = (await api('staff_task_crud', { method: 'list', status: 'in_progress' })).json.tasks as R[]
check('set_status + status filter', inProg.some(t => t.id === t1?.id) && inProg.every(t => t.status === 'in_progress'), inProg)
const badStatus = await api('staff_task_crud', { method: 'set_status', id: t1?.id, status: 'nope' })
check('set_status with unknown status → 400', badStatus.status === 400, badStatus.json)
await api('staff_task_crud', { method: 'save', id: t1?.id, data: { title: `${MARK} task 1 edited`, assignee_id: '', priority: 'low' } })
const t1r = await dbGet('tasks', 'title,assignee_id,created_by,priority,status', { id: `eq.${t1?.id}` })
check('task edit: creator and status kept, assignee cleared',
  t1r[0]?.title === `${MARK} task 1 edited` && t1r[0]?.assignee_id === null && t1r[0]?.created_by === bob?.id && t1r[0]?.priority === 'low' && t1r[0]?.status === 'in_progress', t1r)
await api('staff_task_crud', { method: 'delete', id: t2?.id })
const t2r = await dbGet('tasks', 'id', { id: `eq.${t2?.id}` })
check('task delete', t2r.length === 0, t2r)

// ── 11. direct messages ────────────────────────────────────────────────
console.log('\n[11] direct messages')
const A = String((await dbInsertReturning('staff', { name: `${MARK} dmA` })).id)
const B = String((await dbInsertReturning('staff', { name: `${MARK} dmB` })).id)
const C = String((await dbInsertReturning('staff', { name: `${MARK} dmC` })).id)
const send = (me: string, peer: string, content: string) => api('direct_message_crud', { method: 'send', me, peer, content })
const sd = await send(A, B, `${MARK} hi B`)
check('send returns the stored message', sd.status === 200 && !!sd.json.message?.id && sd.json.message.from_id === A && sd.json.message.content === `${MARK} hi B`, sd.json)
const blank = await send(A, B, '   ')
const badId = await send('not-a-uuid', B, 'x')
check('send: blank content → 400; invalid staff id → 400', blank.status === 400 && badId.status === 400, { blank: blank.json, badId: badId.json })
const pNone = await api('direct_message_crud', { method: 'poll', me: B })
check('poll with no open thread: no messages, sender listed in unread_from', pNone.json.messages?.length === 0 && pNone.json.unread_from?.includes(A), pNone.json)
await send(C, B, `${MARK} hi from C`)
const pA = await api('direct_message_crud', { method: 'poll', me: B, peer: A })
check("poll with A's thread open: A's unread message returned; C in unread_from",
  pA.json.messages?.length === 1 && pA.json.messages[0].from_id === A && pA.json.unread_from?.join() === C, pA.json)
const pA2 = await api('direct_message_crud', { method: 'poll', me: B, peer: A })
check('poll again: that message was marked read and is not returned twice', pA2.json.messages?.length === 0, pA2.json)
// 105 messages between A and C; C's thread view must show the newest 100
const base = Date.now() - 300_000
await dbInsert('direct_messages', Array.from({ length: 105 }, (_, i) => ({
  from_id: i % 2 ? A : C, to_id: i % 2 ? C : A, content: `${MARK} #${i}`, created_at: new Date(base + i * 1000).toISOString(),
})))
const hist = await api('direct_message_crud', { method: 'list', me: C, peer: A })
const hc = ((hist.json.messages || []) as R[]).map(x => x.content)
check('list: the newest 100 messages, oldest first', hc.length === 100 && hc[0] === `${MARK} #5` && hc[99] === `${MARK} #104`, { n: hc.length, first: hc[0], last: hc[99] })
const stillUnread = (await dbGet('direct_messages', 'content', { to_id: `eq.${C}`, read_at: 'is.null' }) as R[]).map(x => x.content).sort()
check('list marks read only the messages it returned', stillUnread.join() === [`${MARK} #1`, `${MARK} #3`].join(), stillUnread)
const noPeer = await api('direct_message_crud', { method: 'list', me: C })
check('list without peer → 400', noPeer.status === 400, noPeer.json)

// ── 12. file storage + document approval ───────────────────────────────
console.log('\n[12] file storage / documents')
// With the local driver a missing file is a 404; the Supabase driver has no GET route (405)
const probe = await fetch(`${BASE}/files/documents/apismoke_probe_missing.txt`)
await probe.body?.cancel()
const storageIsLocal = probe.status === 404
let docFileUrl = '', htmlFileUrl = ''
if (!storageIsLocal) {
  console.log(`  (skipped file storage tests: backend is not on STORAGE_DRIVER=local — probe returned ${probe.status})`)
} else {
  const upload = (bucket: string, name: string | null, body: string, type = 'text/plain') => fetch(`${BASE}/files/${bucket}`, {
    method: 'POST', headers: { 'Content-Type': type, ...(name === null ? {} : { 'x-file-name': encodeURIComponent(name) }) }, body,
  })
  const up = await upload('documents', `${MARK} 报告.txt`, 'hello 文件')
  const upj = await up.json()
  check('upload: backend URL, sanitized object name, byte size', up.status === 200 && String(upj.url).startsWith(`${BASE}/files/documents/`) &&
    /^[A-Za-z0-9._-]+$/.test(upj.name) && upj.size === new TextEncoder().encode('hello 文件').length, upj)
  const dl = await fetch(upj.url)
  const dlText = await dl.text()
  check('download: same content, text/plain inline, nosniff + sandbox CSP', dl.status === 200 && dlText === 'hello 文件' &&
    (dl.headers.get('content-type') || '').startsWith('text/plain') && dl.headers.get('x-content-type-options') === 'nosniff' &&
    dl.headers.get('content-security-policy') === 'sandbox' && (dl.headers.get('content-disposition') || '').startsWith('inline'), Object.fromEntries(dl.headers))
  const upHtml = await (await upload('documents', `${MARK}.html`, '<script>alert(1)</script>', 'text/html')).json()
  const dlHtml = await fetch(upHtml.url)
  await dlHtml.body?.cancel()
  check('download: an HTML upload is served as an attachment, never inline', dlHtml.status === 200 &&
    (dlHtml.headers.get('content-disposition') || '').startsWith('attachment') && dlHtml.headers.get('content-type') === 'application/octet-stream', Object.fromEntries(dlHtml.headers))
  const badBucket = await upload('secrets', 'a.txt', 'x'); await badBucket.body?.cancel()
  const noFileName = await upload('documents', null, 'x'); await noFileName.body?.cancel()
  const emptyFile = await upload('documents', 'a.txt', ''); await emptyFile.body?.cancel()
  check('upload: unknown bucket → 404, no file name → 400, empty file → 400', badBucket.status === 404 && noFileName.status === 400 && emptyFile.status === 400,
    { badBucket: badBucket.status, noFileName: noFileName.status, emptyFile: emptyFile.status })
  const traversal = await fetch(`${BASE}/files/documents/..%2F..%2Fdeno.json`)
  await traversal.body?.cancel()
  check('download: path traversal → 404', traversal.status === 404, traversal.status)
  docFileUrl = upj.url
  htmlFileUrl = upHtml.url
}

const noReviewer = await api('document_crud', { method: 'create', data: { title: `${MARK} doc` }, reviewers: [{ name: ' ' }] })
check('document create without a named reviewer → 400', noReviewer.status === 400, noReviewer.json)
const dc = await api('document_crud', {
  method: 'create',
  data: { title: `${MARK} 合同`, notes: '  ', file_url: docFileUrl || null, file_name: 'x.txt', file_type: 'text/plain', file_size: 12, uploaded_by: 'up@example.com' },
  reviewers: [{ name: 'Rev A', contact: 'a@example.com' }, { name: 'Rev B', contact: '' }],
})
const docId = dc.json.id
check('document create → id', dc.status === 200 && !!docId, dc.json)
const listed = ((await api('document_crud', { method: 'list' })).json.documents as R[]).find(x => x.id === docId)
check('document list: pending, blank notes → null, one decision per reviewer', listed?.status === 'pending' && listed?.notes === null && listed?.decisions?.length === 2, listed)
const sees = async (email: string) => ((await api('document_crud', { method: 'list', viewer_email: email })).json.documents as R[]).some(x => x.id === docId)
const [asReviewer, asUploader, asOther] = [await sees('a@example.com'), await sees('up@example.com'), await sees('nobody@example.com')]
check('document list for a member: reviewer and uploader see it, others do not', asReviewer && asUploader && !asOther, { asReviewer, asUploader, asOther })
const dg = await api('document_crud', { method: 'get', id: docId })
const docRevs = (dg.json.reviewers || []) as R[]
check('document get: document + reviewers in order, blank contact → null',
  dg.json.document?.title === `${MARK} 合同` && docRevs.length === 2 && docRevs[0].name === 'Rev A' && docRevs[1].contact === null, dg.json)
const dec1 = await api('document_crud', { method: 'decide', reviewer_id: docRevs[0]?.id, decision: 'approved', comment: ' ok ' })
check('decide: 1 of 2 approved → partial', dec1.json.status === 'partial', dec1.json)
const dec2 = await api('document_crud', { method: 'decide', reviewer_id: docRevs[1]?.id, decision: 'rejected' })
const decided = await dbGet('document_reviewers', 'decision,comment,decided_at', { document_id: `eq.${docId}` }, 'created_at.asc')
check('decide: any rejection → rejected; comment trimmed; decided_at set', dec2.json.status === 'rejected' && decided[0]?.comment === 'ok' && !!decided[1]?.decided_at, decided)
const decBad = await api('document_crud', { method: 'decide', reviewer_id: docRevs[0]?.id, decision: 'maybe' })
check('decide with an unknown decision → 400', decBad.status === 400, decBad.json)
const dd = await api('document_crud', { method: 'delete', id: docId })
const docLeft = await dbGet('documents', 'id', { id: `eq.${docId}` })
const revLeft = await dbGet('document_reviewers', 'id', { document_id: `eq.${docId}` })
check('document delete: record and its reviewers removed', dd.status === 200 && docLeft.length === 0 && revLeft.length === 0, { dd: dd.json, docLeft, revLeft })
if (storageIsLocal) {
  const afterDelete = await fetch(docFileUrl)
  await afterDelete.body?.cancel()
  check('document delete: attached file removed as well', dd.json.file_deleted === true && afterDelete.status === 404, { file_deleted: dd.json.file_deleted, status: afterDelete.status })
  // remove the HTML test upload the same way
  const hd = await api('document_crud', { method: 'create', data: { title: `${MARK} html`, file_url: htmlFileUrl }, reviewers: [{ name: 'x' }] })
  await api('document_crud', { method: 'delete', id: hd.json.id })
}

// ── 13. workflow runs / knowledge bases / automation logs ───────────────
console.log('\n[13] workflow runs / knowledge bases / automation logs')
const WF = crypto.randomUUID()
const runBase = Date.now() - 100_000
await dbInsert('workflow_runs', Array.from({ length: 12 }, (_, i) => ({
  workflow_id: WF, response: i === 11 ? null : `${MARK} run ${i}`, error: i === 11 ? 'boom' : null, ran_at: new Date(runBase + i * 1000).toISOString(),
})))
const wr = await api('list_workflow_runs', { id: WF })
check('list_workflow_runs: the 10 newest, newest first', wr.json.runs?.length === 10 && wr.json.runs[0].error === 'boom' && wr.json.runs[9].response === `${MARK} run 2`, wr.json.runs?.map((r: R) => r.response ?? r.error))
const wrNoId = await api('list_workflow_runs', {})
check('list_workflow_runs without id → 400', wrNoId.status === 400, wrNoId.json)

const kbc = await api('create_kb', { name: `${MARK} kb`, description: 'd' })
const kbId = kbc.json.kb?.id
check('create_kb → id; list_kbs includes it', !!kbId && ((await api('list_kbs')).json.kbs as R[]).some(k => k.id === kbId), kbc.json)
await dbInsert('kb_chunks', [0, 1, 2].map(i => ({ kb_id: kbId, source_name: MARK, chunk_index: i, content: `${MARK} chunk ${i}` })))
const kcount = await api('count_kb_chunks', { kb_id: kbId })
check('count_kb_chunks', kcount.json.count === 3, kcount.json)
const kdel = await api('delete_kb', { kb_id: kbId })
const chunksLeft = await dbGet('kb_chunks', 'id', { kb_id: `eq.${kbId}` })
const kbLeft = await dbGet('knowledge_bases', 'id', { id: `eq.${kbId}` })
check('delete_kb removes the knowledge base and all its chunks', kdel.status === 200 && kbLeft.length === 0 && chunksLeft.length === 0, { kdel: kdel.json, kbLeft, chunksLeft })
const kdelMissing = await api('delete_kb', { kb_id: crypto.randomUUID() })
check('delete_kb for an unknown id → 404', kdelMissing.status === 404, kdelMissing.json)

const unread0 = (await api('automation_crud', { method: 'unread_count' })).json.count
await dbInsert('automation_logs', [
  { tenant_id: 'default', action_taken: 'dashboard_alert', message: `${MARK} log 1`, read: false },
  { tenant_id: 'default', action_taken: 'dashboard_alert', message: `${MARK} log 2`, read: false },
  { tenant_id: 'default', action_taken: 'dashboard_alert', message: `${MARK} log 3`, read: true },
])
const unread1 = (await api('automation_crud', { method: 'unread_count' })).json.count
check('automation unread_count counts unread logs only', unread1 - unread0 === 2, { unread0, unread1 })
const myLogs = ((await api('automation_crud', { method: 'get_logs' })).json.logs as R[]).filter(l => String(l.message).startsWith(MARK))
check('automation get_logs returns the logs', myLogs.length === 3, myLogs)
await api('automation_crud', { method: 'mark_read', rule_id: myLogs.find(l => !l.read)?.id })
const unread2 = (await api('automation_crud', { method: 'unread_count' })).json.count
check('mark_read lowers unread_count', unread2 - unread0 === 1, { unread0, unread2 })

// ── 14. OTP login roles / tenant endpoints ─────────────────────────────
// The backend must run without MASTER_EMAILS containing these test addresses.
console.log('\n[14] OTP login / tenant endpoints')
const tn = await dbInsertReturning('tenants', { name: `${MARK} tenant`, slug: `${MARK}-t` })
const TID = String(tn.id)
// A tenant named "Master" is what the old fallback used to hand out to unknown emails
await dbInsert('tenants', { name: 'Master', slug: `${MARK}-master` })
const memberEmail = `${MARK}@member.test`, strangerEmail = `${MARK}@stranger.test`
await dbInsert('tenant_users', { email: memberEmail, tenant_id: TID, role: 'admin' })
await dbInsert('otp_requests', [{ email: memberEmail, code: '123456' }, { email: strangerEmail, code: '654321' }])
const vKnown = await api('verify_otp', { email: memberEmail, code: '123456' })
check('verify_otp: a registered email gets its tenant and role', vKnown.json.ok === true && vKnown.json.role === 'admin' && vKnown.json.tenant_id === TID, vKnown.json)
const vStranger = await api('verify_otp', { email: strangerEmail, code: '654321' })
check('verify_otp: an unregistered email is refused, not made master', vStranger.status === 403 && vStranger.json.ok === false && !vStranger.json.role, vStranger.json)

const forbidden: Record<string, number> = {}
for (const [action, payload] of [
  ['list_tenants', {}], ['get_master_summary', {}], ['create_tenant', { name: `${MARK} nope` }],
  ['update_tenant', { tenant_id: TID, active: false }], ['add_tenant_user', { tenant_id: TID, email: `${MARK}@x.test` }],
] as [string, Record<string, unknown>][]) forbidden[action] = (await api(action, payload)).status
check('tenant endpoints refuse a non-master caller (403)', Object.values(forbidden).every(s => s === 403), forbidden)
const lt = await api('list_tenants', { role: 'master' })
check('list_tenants (master): ok, with total_spend and lead_count', lt.json.ok === true && (lt.json.tenants as R[]).some(t => t.id === TID && 'total_spend' in t && 'lead_count' in t), lt.json)
const msum = await api('get_master_summary', { role: 'master' })
check('get_master_summary (master): ok, with summary rows', msum.json.ok === true && Array.isArray(msum.json.summary), msum.json)
const ctn = await api('create_tenant', { role: 'master', name: `${MARK} created`, contact_name: 'c', contact_email: 'c@x.test' })
check("create_tenant accepts the dashboard's fields (name / contact only)", ctn.json.ok === true && !!ctn.json.tenant?.id, ctn.json)
const utn = await api('update_tenant', { role: 'master', tenant_id: TID, active: false, slug: 'hijacked' })
const tnRow = await dbGet('tenants', 'active,slug', { id: `eq.${TID}` })
check('update_tenant: toggles active, ignores fields outside its allowlist', utn.json.ok === true && tnRow[0]?.active === false && tnRow[0]?.slug === `${MARK}-t`, tnRow)
const newUser = `${MARK}@new.test`
const auMaster = await api('add_tenant_user', { role: 'master', tenant_id: TID, email: newUser, user_role: 'master' })
check('add_tenant_user: user_role "master" → 400, nothing stored', auMaster.status === 400 && (await dbGet('tenant_users', 'id', { email: `eq.${newUser}` })).length === 0, auMaster.json)
await api('add_tenant_user', { role: 'master', tenant_id: TID, email: newUser })
await api('add_tenant_user', { role: 'master', tenant_id: TID, email: newUser, user_role: 'admin' })
const auRows = await dbGet('tenant_users', 'role', { email: `eq.${newUser}` })
check("add_tenant_user: defaults to member (not the caller's role), repeat call updates the role", auRows.length === 1 && auRows[0].role === 'admin', auRows)

// ── cleanup ────────────────────────────────────────────────────────────
console.log('\n[cleanup]')
await dbDelete('tasks', { title: `like.${MARK}*` })
await dbDelete('documents', { title: `like.${MARK}*` })
await dbDelete('workflow_runs', { workflow_id: `eq.${WF}` })
await dbDelete('kb_chunks', { source_name: `eq.${MARK}` })
await dbDelete('knowledge_bases', { name: `like.${MARK}*` })
await dbDelete('automation_logs', { message: `like.${MARK}*` })
await dbDelete('tenant_users', { email: `like.${MARK}*` })
await dbDelete('otp_requests', { email: `like.${MARK}*` })
await dbDelete('tenants', { name: `like.${MARK}*` })
await dbDelete('tenants', { slug: `like.${MARK}*` })
await dbDelete('direct_messages', { content: `like.${MARK}*` })   // before staff: messages reference staff
await dbDelete('staff', { name: `like.${MARK}*` })
await dbDelete('conversations', { session_id: `eq.${MARK}` })
await dbDelete('agents', { id: `like.${MARK}*` })
await dbDelete('agent_skills', { agent: `like.${MARK}*` })
await dbDelete('agent_suggestions', { session_id: `eq.${MARK}` })
await dbDelete('leads', { name: `like.${MARK}*` })
await dbDelete('analytics_daily', { campaign_name: `eq.${MARK}` })
await dbDelete('alerts', { rule_name: `eq.${MARK}` })
await dbDelete('accounts', { id: `like.${MARK}*` })
await dbDelete('ad_reports', { campaign_name: `like.${MARK}*` })
await dbDelete('data_entries', { file_name: `like.${MARK}*` })
const leftover = [
  ...await dbGet('conversations', 'id', { session_id: `eq.${MARK}` }),
  ...await dbGet('agents', 'id', { id: `like.${MARK}*` }),
  ...await dbGet('agent_skills', 'id', { agent: `like.${MARK}*` }),
  ...await dbGet('agent_suggestions', 'id', { session_id: `eq.${MARK}` }),
  ...await dbGet('leads', 'id', { name: `like.${MARK}*` }),
  ...await dbGet('analytics_daily', 'id', { campaign_name: `eq.${MARK}` }),
  ...await dbGet('alerts', 'id', { rule_name: `eq.${MARK}` }),
  ...await dbGet('accounts', 'id', { id: `like.${MARK}*` }),
  ...await dbGet('ad_reports', 'id', { campaign_name: `like.${MARK}*` }),
  ...await dbGet('data_entries', 'id', { file_name: `like.${MARK}*` }),
]
check('cleanup removed test rows', leftover.length === 0, leftover)

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed`)
Deno.exit(fail === 0 ? 0 : 1)
