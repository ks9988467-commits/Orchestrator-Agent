// Knowledge base ingest (chunk + embed + replace) and the hourly folder-sync check.
import { dbDelete, dbGet, dbInsert, dbPatch } from './db.ts'
import { SYNC_DIR, SYNC_INTERVAL_DAYS, type SyncResult, summarize, syncFolder, syncKbId } from './kb-sync.ts'
import { chunkText, getEmbedding, loadProviders } from './llm.ts'
import { shared } from './state.ts'

// ── Knowledge base ingest ────────────────────────────────────────────
// Splits text into chunks, embeds them, then replaces the source's existing chunks.
// Embedding happens first, so a failure leaves the previous version in place.
// error = nothing was written; errors = some chunks failed to insert.
export async function ingestText(kbId: string, src: string, text: string, tenantId: string | null):
    Promise<{ chunks: number; saved: number; model?: string; errors: string[]; error?: string }> {
  const chunks = chunkText(text, 500, 50)
  if (!chunks.length) {
    await dbDelete('kb_chunks', { kb_id: `eq.${kbId}`, source_name: `eq.${src}` })
    return { chunks: 0, saved: 0, errors: [] }
  }
  // One embedding model per knowledge base, so all chunks (and later queries) share a vector space
  const providers = await loadProviders()
  const kbRows = await dbGet('knowledge_bases', 'embed_model', { id: `eq.${kbId}` }) as { embed_model?: string }[]
  let kbModel = kbRows[0]?.embed_model || ''
  const vectors: number[][] = []
  for (const chunk of chunks) {
    const er = await getEmbedding(chunk, providers, kbModel || undefined)
    if (!er) return { chunks: chunks.length, saved: 0, errors: [], error: kbModel ? `向量模型 ${kbModel} 不可用` : '没有可用的向量模型（需要 OpenAI / OpenRouter / Google 的 API Key）' }
    kbModel = er.model
    vectors.push(er.vector)
  }
  await dbDelete('kb_chunks', { kb_id: `eq.${kbId}`, source_name: `eq.${src}` })
  const errs: string[] = []
  for (let i = 0; i < chunks.length; i++) {
    const ir = await dbInsert('kb_chunks', { kb_id: kbId, source_name: src, chunk_index: i, content: chunks[i], embedding: `[${vectors[i].join(',')}]`, tenant_id: tenantId })
    if (!ir.ok) errs.push(`insert_${i}:${ir.error}`)
  }
  if (!kbRows[0]?.embed_model) await dbPatch('knowledge_bases', kbId, { embed_model: kbModel })
  return { chunks: chunks.length, saved: chunks.length - errs.length, model: kbModel, errors: errs }
}

// ── Folder → knowledge base sync (local backend only, KB_SYNC_DIR) ───
export async function runKbSync(): Promise<{ ok: boolean; result?: SyncResult; error?: string }> {
  if (!SYNC_DIR) return { ok: false, error: '未配置 KB_SYNC_DIR' }
  if (shared.kbSyncRunning) return { ok: false, error: '同步正在进行中' }
  shared.kbSyncRunning = true
  try {
    const kbId = await syncKbId()
    const now = new Date().toISOString()
    try {
      const result = await syncFolder(SYNC_DIR, kbId, async (id, src, text) => {
        const r = await ingestText(id, src, text, null)
        return r.error || r.errors.length ? { ok: false, error: r.error || r.errors[0] } : { ok: true }
      })
      // synced_at only moves on a clean run, so failed files are retried at the next hourly check
      await dbPatch('knowledge_bases', kbId, { sync_attempted_at: now, sync_result: summarize(result), ...(result.failed.length ? {} : { synced_at: now }) })
      return { ok: true, result }
    } catch (e) {
      const msg = (e as Error).message
      await dbPatch('knowledge_bases', kbId, { sync_attempted_at: now, sync_result: `读取文件夹失败：${msg}` })
      return { ok: false, error: msg }
    }
  } finally {
    shared.kbSyncRunning = false
  }
}

if (SYNC_DIR) {
  // Hourly: sync when the last clean run is older than KB_SYNC_INTERVAL_DAYS (or never happened)
  const checkKbSync = async () => {
    try {
      const [kb] = await dbGet('knowledge_bases', 'synced_at', { id: `eq.${await syncKbId()}` }, undefined, 1)
      const last = kb?.synced_at ? Date.parse(String(kb.synced_at)) : 0
      if (Date.now() - last >= SYNC_INTERVAL_DAYS * 86_400_000) await runKbSync()
    } catch (e) { console.error('kb sync check', e) }
  }
  setTimeout(checkKbSync, 60_000)
  setInterval(checkKbSync, 3_600_000)
}
