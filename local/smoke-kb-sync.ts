// ══════════════════════════════════════════════════════════════════════
// Tests for the folder → knowledge base sync (kb-sync.ts) against the local
// database, with a stand-in ingest step (no embedding provider needed).
//
//   deno run --allow-net --allow-env --allow-read --allow-write --env-file=local/.env local/smoke-kb-sync.ts
// ══════════════════════════════════════════════════════════════════════

import { dbDelete, dbGet, dbInsert } from '../supabase/functions/orchestrator/db.ts'
import { type IngestFn, summarize, syncFolder, syncKbId } from '../supabase/functions/orchestrator/kb-sync.ts'

if (Deno.env.get('DB_DRIVER') !== 'postgres') {
  console.error('Refusing to run: DB_DRIVER must be "postgres" (never run this against production).')
  Deno.exit(2)
}

let pass = 0, fail = 0
function check(name: string, ok: boolean, detail: unknown = '') {
  if (ok) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}`, detail) }
}

const MARK = `kbsync_${Date.now()}`
const root = (await Deno.makeTempDir({ prefix: 'kbsync_' })).replace(/\\/g, '/')
const write = async (rel: string, text: string) => {
  const p = `${root}/${rel}`
  await Deno.mkdir(p.slice(0, p.lastIndexOf('/')), { recursive: true })
  await Deno.writeTextFile(p, text)
}

// Stand-in ingest: replaces the source's chunks with one row; fails for names containing "fail"
let failNames = true
const ingested: string[] = []
const ingest: IngestFn = async (kbId, source, text) => {
  if (failNames && source.includes('fail')) return { ok: false, error: 'simulated failure' }
  ingested.push(source)
  await dbDelete('kb_chunks', { kb_id: `eq.${kbId}`, source_name: `eq.${source}` })
  const r = await dbInsert('kb_chunks', { kb_id: kbId, source_name: source, chunk_index: 0, content: text.slice(0, 200) })
  return r.ok ? { ok: true } : { ok: false, error: r.error }
}
const chunkSources = async (kbId: string) =>
  (await dbGet('kb_chunks', 'source_name', { kb_id: `eq.${kbId}` }) as { source_name: string }[]).map(r => r.source_name).sort()

const kbId = await syncKbId(`${MARK} kb`, root)
try {
  console.log('\n[1] first run')
  await write('a.md', '# A\nalpha')
  await write('sub/b.md', '# B\nbeta')
  await write('c.txt', 'gamma')
  await write('img.png', 'not text')
  await write('.obsidian/workspace.md', 'editor state')
  await write('big.md', 'x'.repeat(1024 * 1024 + 1))
  await write('fail.md', 'will fail')
  const r1 = await syncFolder(root, kbId, ingest)
  check('scans .md / .txt only, skipping dot-folders and other extensions', r1.scanned === 5, r1)
  check('ingests new files; >1 MB and failing files reported, not ingested',
    r1.ingested === 3 && r1.failed.length === 2 && r1.failed.some(f => f.startsWith('big.md')) && r1.failed.some(f => f.startsWith('fail.md')), r1)
  check('chunks exist for the ingested files only', JSON.stringify(await chunkSources(kbId)) === JSON.stringify(['a.md', 'c.txt', 'sub/b.md']), await chunkSources(kbId))
  check('summary names the counts and failures', summarize(r1).startsWith('扫描 5 个文件：更新 3，未变 0，删除 0，失败 2') && summarize(r1).includes('fail.md'), summarize(r1))

  console.log('\n[2] unchanged run')
  ingested.length = 0
  const r2 = await syncFolder(root, kbId, ingest)
  check('unchanged files are skipped; the failed one is retried', r2.unchanged === 3 && r2.ingested === 0 && ingested.length === 0 && r2.failed.length === 2, r2)

  console.log('\n[3] edit, delete, recover')
  await write('a.md', '# A\nalpha edited')
  await Deno.remove(`${root}/sub/b.md`)
  failNames = false
  const r3 = await syncFolder(root, kbId, ingest)
  check('an edited file is re-ingested, a previously failed one recovers',
    r3.ingested === 2 && ingested.includes('a.md') && ingested.includes('fail.md'), { r3, ingested })
  check('a deleted file loses its chunks and sync record', r3.removed === 1 && !(await chunkSources(kbId)).includes('sub/b.md') &&
    (await dbGet('kb_sync_files', 'path', { kb_id: `eq.${kbId}`, path: 'eq.sub/b.md' })).length === 0, r3)

  console.log('\n[4] safety')
  for await (const e of Deno.readDir(root)) await Deno.remove(`${root}/${e.name}`, { recursive: true })
  const before = await chunkSources(kbId)
  const r4 = await syncFolder(root, kbId, ingest)
  check('an empty folder deletes nothing', r4.removed === 0 && JSON.stringify(await chunkSources(kbId)) === JSON.stringify(before) && r4.failed.some(f => f.includes('跳过删除')), r4)
  let threw = false
  try { await syncFolder(`${root}/does-not-exist`, kbId, ingest) } catch { threw = true }
  check('a missing folder throws and deletes nothing', threw && JSON.stringify(await chunkSources(kbId)) === JSON.stringify(before))
  check('syncKbId reuses the knowledge base with the same name', (await syncKbId(`${MARK} kb`, root)) === kbId)
} finally {
  console.log('\n[cleanup]')
  await dbDelete('kb_chunks', { kb_id: `eq.${kbId}` })
  await dbDelete('kb_sync_files', { kb_id: `eq.${kbId}` })
  await dbDelete('knowledge_bases', { id: `eq.${kbId}` })
  await Deno.remove(root, { recursive: true }).catch(() => {})
  check('cleanup removed test rows', (await dbGet('knowledge_bases', 'id', { id: `eq.${kbId}` })).length === 0)
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed`)
Deno.exit(fail === 0 ? 0 : 1)
