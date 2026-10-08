// Knowledge base actions: list / create / delete, ingest, search, folder sync.
import { dbDelete, dbGet, dbGetPage, dbInsertReturning, dbRpc } from '../db.ts'
import { SYNC_DIR, SYNC_INTERVAL_DAYS, summarize, syncKbId } from '../kb-sync.ts'
import { ingestText, runKbSync } from '../kb.ts'
import { getEmbedding, loadProviders } from '../llm.ts'
import { type Body, R, shared, tenantFilters } from '../state.ts'

// Returns the response for one of this module's actions, or undefined for any other action
export async function handleKbActions(body: Body, CORS: Record<string, string>): Promise<Response | undefined> {
  // ── RAG: ingest document chunks ─────────────────────────────────
  if (body.action === 'kb_ingest') {
    const { kb_id, source_name, content: rawContent } = body
    if (!kb_id || !rawContent) return new Response(JSON.stringify({ error:'kb_id and content required' }), { status:400, headers:{...CORS,'Content-Type':'application/json'} })
    // Re-ingesting the same source replaces its chunks rather than duplicating them
    const r = await ingestText(String(kb_id), String(source_name || 'upload'), String(rawContent), R.tenantId)
    if (r.error) return new Response(JSON.stringify({ error: r.error }), { status:500, headers:{...CORS,'Content-Type':'application/json'} })
    return new Response(JSON.stringify({ ok:true, chunks: r.chunks, saved: r.saved, model: r.model, errors: r.errors }), { headers:{...CORS,'Content-Type':'application/json'} })
  }

  // ── Folder sync status / run now ─────────────────────────────────
  if (body.action === 'kb_sync') {
    const m = String(body.method || 'status')
    if (!SYNC_DIR) return new Response(JSON.stringify({ ok: true, enabled: false }), { headers:{...CORS,'Content-Type':'application/json'} })
    if (m === 'status') {
      const kbId = await syncKbId()
      const [kb] = await dbGet('knowledge_bases', 'id,name,synced_at,sync_attempted_at,sync_result', { id: `eq.${kbId}` }, undefined, 1)
      const { count } = await dbGetPage('kb_sync_files', 'path', { kb_id: `eq.${kbId}` }, undefined, 0)
      return new Response(JSON.stringify({
        ok: true, enabled: true, dir: SYNC_DIR, interval_days: SYNC_INTERVAL_DAYS, running: shared.kbSyncRunning,
        kb_id: kbId, kb_name: kb?.name, synced_at: kb?.synced_at ?? null, attempted_at: kb?.sync_attempted_at ?? null,
        result: kb?.sync_result ?? null, files: count,
      }), { headers:{...CORS,'Content-Type':'application/json'} })
    }
    if (m === 'run') {
      const r = await runKbSync()
      if (!r.ok) return new Response(JSON.stringify({ error: r.error }), { status: r.error === '同步正在进行中' ? 409 : 500, headers:{...CORS,'Content-Type':'application/json'} })
      return new Response(JSON.stringify({ ok: true, result: r.result, summary: summarize(r.result!) }), { headers:{...CORS,'Content-Type':'application/json'} })
    }
    return new Response(JSON.stringify({ error: 'unknown method' }), { status: 400, headers:{...CORS,'Content-Type':'application/json'} })
  }

  // ── RAG: semantic search ─────────────────────────────────────────
  if (body.action === 'kb_search') {
    const { kb_id, query, limit: kLimit } = body
    if (!kb_id || !query) return new Response(JSON.stringify({ error:'kb_id and query required' }), { status:400, headers:{...CORS,'Content-Type':'application/json'} })
    const providers = await loadProviders()
    // Pin query embedding to the KB's model so vectors are comparable
    const kbRows = await dbGet('knowledge_bases', 'embed_model', { id: `eq.${kb_id}` }) as {embed_model?:string}[]
    const er = await getEmbedding(String(query).slice(0, 500), providers, kbRows[0]?.embed_model || undefined)
    if (!er) return new Response(JSON.stringify({ error:'Embedding failed: no provider available' }), { status:500, headers:{...CORS,'Content-Type':'application/json'} })
    const n = Math.min(Number(kLimit)||5, 20)
    const rows = await dbRpc('kb_match', { query_embedding: er.vector, match_kb_id: kb_id, match_count: n })
    return new Response(JSON.stringify({ results: rows }), { headers:{...CORS,'Content-Type':'application/json'} })
  }

  // ── KB CRUD ──────────────────────────────────────────────────────
  if (body.action === 'list_kbs') {
    const rows = await dbGet('knowledge_bases','id,name,description,agent_id,created_at',tenantFilters(),'created_at.desc',50)
    return new Response(JSON.stringify({ kbs: rows }), { headers:{...CORS,'Content-Type':'application/json'} })
  }

  if (body.action === 'create_kb') {
    const { name, description, agent_id } = body
    if (!name) return new Response(JSON.stringify({ error:'name required' }), { status:400, headers:{...CORS,'Content-Type':'application/json'} })
    const row = await dbInsertReturning('knowledge_bases',{ name, description:description||'', agent_id:agent_id||null, tenant_id:R.tenantId })
    return new Response(JSON.stringify({ ok:true, kb: row }), { headers:{...CORS,'Content-Type':'application/json'} })
  }

  if (body.action === 'delete_kb') {
    const { kb_id } = body
    if (!kb_id) return new Response(JSON.stringify({ error:'kb_id required' }), { status:400, headers:{...CORS,'Content-Type':'application/json'} })
    const own = await dbGet('knowledge_bases','id',tenantFilters({ id: `eq.${kb_id}` }),undefined,1)
    if (!own.length) return new Response(JSON.stringify({ error:'not found' }), { status:404, headers:{...CORS,'Content-Type':'application/json'} })
    await dbDelete('kb_chunks', { kb_id: `eq.${kb_id}` })   // kb_chunks has no foreign key to cascade from
    await dbDelete('kb_sync_files', { kb_id: `eq.${kb_id}` })
    await dbDelete('knowledge_bases', { id: `eq.${kb_id}` })
    return new Response(JSON.stringify({ ok:true }), { headers:{...CORS,'Content-Type':'application/json'} })
  }

  if (body.action === 'count_kb_chunks') {
    const { kb_id } = body
    if (!kb_id) return new Response(JSON.stringify({ error:'kb_id required' }), { status:400, headers:{...CORS,'Content-Type':'application/json'} })
    const { count } = await dbGetPage('kb_chunks','id',{ kb_id:`eq.${kb_id}` },undefined,0)
    return new Response(JSON.stringify({ count }), { headers:{...CORS,'Content-Type':'application/json'} })
  }
}
