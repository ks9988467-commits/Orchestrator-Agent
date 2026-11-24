// ══════════════════════════════════════════════════════════════════════
// Folder → knowledge base sync. Reads .md / .txt files under KB_SYNC_DIR
// (e.g. an Obsidian vault folder; several folders separated by ";") and keeps
// one knowledge base in step:
// new or changed files are ingested, deleted files lose their chunks,
// unchanged files are skipped. Local backend only — a hosted function cannot
// see the user's disk, so the feature is off unless KB_SYNC_DIR is set.
// ══════════════════════════════════════════════════════════════════════

import { dbDelete, dbGet, dbInsertReturning, dbUpsert } from './db.ts'

// One folder, or several separated by ";" (e.g. a notes vault plus a meeting-notes folder)
export const SYNC_DIR = (Deno.env.get('KB_SYNC_DIR') || '').trim()
export const SYNC_DIRS = parseDirs(SYNC_DIR)

export type SyncRoot = { dir: string; prefix: string }

// A single folder keeps its paths as they are; with several, each folder's paths are
// prefixed by its folder name ("04-讨论/会议.md") so they cannot collide. Repeated
// folder names get "-2", "-3"…
export function parseDirs(value: string): SyncRoot[] {
  const dirs = value.split(';').map(d => d.trim().replace(/\\/g, '/').replace(/\/+$/, '')).filter(Boolean)
  if (dirs.length <= 1) return dirs.map(dir => ({ dir, prefix: '' }))
  const used = new Set<string>()
  return dirs.map(dir => {
    const base = dir.slice(dir.lastIndexOf('/') + 1) || 'folder'
    let name = base
    for (let i = 2; used.has(name); i++) name = `${base}-${i}`
    used.add(name)
    return { dir, prefix: `${name}/` }
  })
}
export const SYNC_KB_NAME = Deno.env.get('KB_SYNC_KB') || '笔记同步'
export const SYNC_INTERVAL_DAYS = Math.max(Number(Deno.env.get('KB_SYNC_INTERVAL_DAYS')) || 7, 1)

const FILE_EXT = /\.(md|txt)$/i
const MAX_BYTES = 1024 * 1024

// Ingests one document; ok=false leaves the file to be retried on the next run
export type IngestFn = (kbId: string, source: string, text: string) => Promise<{ ok: boolean; error?: string }>
export type SyncResult = { scanned: number; ingested: number; unchanged: number; removed: number; failed: string[] }

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// Relative paths (forward slashes) of the files to sync; dot-folders such as .obsidian are skipped
async function listFiles(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(rel: string) {
    for await (const e of Deno.readDir(rel ? `${root}/${rel}` : root)) {
      if (e.name.startsWith('.')) continue
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory) await walk(p)
      else if (e.isFile && FILE_EXT.test(e.name)) out.push(p)
    }
  }
  await walk('')
  return out.sort()
}

// The knowledge base the folder syncs into, created on first use
export async function syncKbId(name = SYNC_KB_NAME, dir = SYNC_DIR): Promise<string> {
  const rows = await dbGet('knowledge_bases', 'id', { name: `eq.${name}` }, 'created_at.asc', 1)
  if (rows.length) return String(rows[0].id)
  const kb = await dbInsertReturning('knowledge_bases', { name, description: `自动同步自 ${dir}` })
  return String(kb.id)
}

async function removePath(kbId: string, path: string) {
  await dbDelete('kb_chunks', { kb_id: `eq.${kbId}`, source_name: `eq.${path}` })
  await dbDelete('kb_sync_files', { kb_id: `eq.${kbId}`, path: `eq.${path}` })
}

// Throws if the folder cannot be read — nothing is removed in that case.
// With a prefix, only the rows under that prefix belong to this folder.
export async function syncFolder(root: string, kbId: string, ingest: IngestFn, prefix = ''): Promise<SyncResult> {
  const res: SyncResult = { scanned: 0, ingested: 0, unchanged: 0, removed: 0, failed: [] }
  const files = await listFiles(root)
  const knownRows = await dbGet('kb_sync_files', 'path,hash', { kb_id: `eq.${kbId}` }) as { path: string; hash: string }[]
  const known = new Map(knownRows.filter(r => r.path.startsWith(prefix)).map(r => [r.path, r.hash]))

  for (const rel of files) {
    const path = prefix + rel
    res.scanned++
    try {
      const { size } = await Deno.stat(`${root}/${rel}`)
      if (size > MAX_BYTES) { res.failed.push(`${path}：超过 1 MB，未同步`); continue }
      const text = await Deno.readTextFile(`${root}/${rel}`)
      const hash = await sha256Hex(text)
      if (known.get(path) === hash) { res.unchanged++; continue }
      const r = await ingest(kbId, path, text)
      if (!r.ok) { res.failed.push(`${path}：${r.error || '录入失败'}`); continue }
      await dbUpsert('kb_sync_files', { kb_id: kbId, path, hash, synced_at: new Date().toISOString() }, 'kb_id,path')
      res.ingested++
    } catch (e) {
      res.failed.push(`${path}：${(e as Error).message}`)
    }
  }

  // An empty listing while files were synced before is more likely a folder that is
  // unavailable (e.g. not yet downloaded by OneDrive) than a real mass deletion
  if (!files.length && known.size) {
    res.failed.push('文件夹为空，已跳过删除（之前同步的内容保留）')
    return res
  }
  const present = new Set(files.map(f => prefix + f))
  for (const path of known.keys()) {
    if (present.has(path)) continue
    await removePath(kbId, path)
    res.removed++
  }
  return res
}

// Syncs every configured folder into one knowledge base. A folder that cannot be read
// is reported and its files are kept; the call throws only when no folder can be read.
// Files of a folder that was taken out of the list are removed.
export async function syncFolders(roots: SyncRoot[], kbId: string, ingest: IngestFn): Promise<SyncResult> {
  if (roots.length === 1 && !roots[0].prefix) return await syncFolder(roots[0].dir, kbId, ingest)
  const total: SyncResult = { scanned: 0, ingested: 0, unchanged: 0, removed: 0, failed: [] }
  const errors: string[] = []
  for (const { dir, prefix } of roots) {
    try {
      const r = await syncFolder(dir, kbId, ingest, prefix)
      total.scanned += r.scanned; total.ingested += r.ingested; total.unchanged += r.unchanged; total.removed += r.removed
      total.failed.push(...r.failed.map(f => f.includes('：') ? f : `${prefix.slice(0, -1)}：${f}`))
    } catch (e) {
      errors.push(`${dir}：${(e as Error).message}`)
      total.failed.push(`${prefix.slice(0, -1)}：读取文件夹失败`)
    }
  }
  if (errors.length === roots.length) throw new Error(errors.join('；'))
  const rows = await dbGet('kb_sync_files', 'path', { kb_id: `eq.${kbId}` }) as { path: string }[]
  for (const { path } of rows) {
    if (roots.some(r => path.startsWith(r.prefix))) continue
    await removePath(kbId, path)
    total.removed++
  }
  return total
}

// Summary for the dashboard: counts, then one line per distinct failure reason
// with up to three of the affected files ("path：reason" entries are grouped by reason)
export function summarize(r: SyncResult): string {
  const head = `扫描 ${r.scanned} 个文件：更新 ${r.ingested}，未变 ${r.unchanged}，删除 ${r.removed}` +
    (r.failed.length ? `，失败 ${r.failed.length}` : '')
  const byReason = new Map<string, string[]>()
  for (const f of r.failed) {
    const i = f.indexOf('：')
    const [path, reason] = i === -1 ? ['', f] : [f.slice(0, i), f.slice(i + 1)]
    byReason.set(reason, [...(byReason.get(reason) || []), ...(path ? [path] : [])])
  }
  const lines = [...byReason].map(([reason, paths]) => !paths.length ? reason
    : `${reason}（${paths.length} 个：${paths.slice(0, 3).join('、')}${paths.length > 3 ? ' 等' : ''}）`)
  return [head, ...lines].join('\n')
}
