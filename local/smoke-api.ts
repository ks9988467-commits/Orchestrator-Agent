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

import { dbDelete, dbGet, dbInsert } from '../supabase/functions/orchestrator/db.ts'

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

// ── cleanup ────────────────────────────────────────────────────────────
console.log('\n[cleanup]')
await dbDelete('conversations', { session_id: `eq.${MARK}` })
await dbDelete('agents', { id: `eq.${MARK}_a` })
await dbDelete('agent_skills', { agent: `in.(${skA},${skB})` })
await dbDelete('agent_suggestions', { session_id: `eq.${MARK}` })
const leftover = [
  ...await dbGet('conversations', 'id', { session_id: `eq.${MARK}` }),
  ...await dbGet('agents', 'id', { id: `like.${MARK}*` }),
  ...await dbGet('agent_skills', 'id', { agent: `like.${MARK}*` }),
  ...await dbGet('agent_suggestions', 'id', { session_id: `eq.${MARK}` }),
]
check('cleanup removed test rows', leftover.length === 0, leftover)

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed`)
Deno.exit(fail === 0 ? 0 : 1)
