#!/usr/bin/env node
// End-to-end smoke tests against the deployed orchestrator.
// Run: node tests/smoke.mjs   (exit 0 = all pass, 1 = failure → CI-friendly)
const URL  = process.env.ORCH_URL  || 'https://ontumerafhimxvqtsijr.supabase.co/functions/v1/orchestrator'
const ANON = process.env.ORCH_ANON || 'sb_publishable_P7e8IrOK4FI-IW09rqj8rA_XYYL1LXC'
const KB   = process.env.ORCH_KB   || '6066cdd7-7381-4a65-8f02-3b3c6d9aa037'

let pass = 0, fail = 0
function ok(name, cond, detail='') { (cond?pass++:fail++); console.log(`${cond?'✓':'✗ FAIL'}  ${name}${cond?'':'  — '+detail}`) }

async function call(body) {
  const r = await fetch(URL, { method:'POST',
    headers:{'Content-Type':'application/json','apikey':ANON,'Authorization':'Bearer '+ANON},
    body: JSON.stringify(body) })
  const t = await r.text()
  try { return { status:r.status, json: JSON.parse(t) } } catch { return { status:r.status, text:t } }
}

const SIM = 0.45
const tests = {
  async 'RAG: relevant query returns a hit above threshold'() {
    const r = await call({ action:'kb_search', kb_id:KB, query:'新线索进来后多久内必须联系？', limit:3 })
    const top = (r.json?.results||[])[0]
    ok('RAG relevant hit', !!top && top.similarity >= SIM, `top=${top?.similarity}`)
  },
  async 'RAG: irrelevant query falls below threshold (would be filtered)'() {
    const r = await call({ action:'kb_search', kb_id:KB, query:'比特币价格和股票投资策略', limit:3 })
    const top = (r.json?.results||[])[0]
    ok('RAG irrelevant filtered', !top || top.similarity < SIM, `top=${top?.similarity}`)
  },
  async 'channel_metrics: returns funnel structure with leads'() {
    const r = await call({ action:'channel_metrics', spend_by_source:{Facebook:3200}, ltv_per_customer:1850, margin_pct:40 })
    ok('channel_metrics ok', r.json?.ok === true && Array.isArray(r.json.channels) && typeof r.json.totals?.leads === 'number', `leads=${r.json?.totals?.leads}`)
  },
  async 'UGC: script generation returns valid JSON with voiceover'() {
    const r = await call({ action:'ugc_generate', type:'script', product:'hour_clean', audience:'忙碌上班族', duration:30, content:'钟点清洁，2小时全屋' })
    let parsed=null; try { parsed = JSON.parse(r.json?.result||'') } catch {}
    ok('UGC script JSON', r.json?.ok===true && parsed && typeof parsed.voiceover==='string' && parsed.voiceover.length>0)
  },
  async 'automation_run: responds ok and reports checked count'() {
    const r = await call({ action:'automation_run', tenant_id:'6d18a0fd-2b36-4f36-a940-c2510c7fd2c6' })
    ok('automation_run ok', r.json?.ok===true && typeof r.json.checked==='number')
  },
}

const t0 = Date.now()
for (const [name, fn] of Object.entries(tests)) {
  try { await fn() } catch (e) { fail++; console.log(`✗ FAIL  ${name}  — threw: ${e.message}`) }
}
console.log(`\n${pass} passed, ${fail} failed  (${((Date.now()-t0)/1000).toFixed(1)}s)`)
process.exit(fail ? 1 : 0)
