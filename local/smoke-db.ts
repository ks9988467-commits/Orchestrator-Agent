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
  dbDelete, dbGet, dbInsert, dbInsertReturning, dbPatch, dbPatchWhere, dbRpc, dbUpsert,
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
