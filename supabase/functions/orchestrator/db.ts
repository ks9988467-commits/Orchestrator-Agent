// ══════════════════════════════════════════════════════════════════════
// db.ts — Portable DB layer (Step 1 of Supabase decoupling)
// ----------------------------------------------------------------------
// Drop-in replacement for the 5 REST helpers that lived in index.ts.
// Same function signatures → the ~160 call sites do NOT change.
//
// Two backends, switched by env DB_DRIVER:
//   • DB_DRIVER=rest      (DEFAULT) → legacy Supabase PostgREST. Behavior
//                          identical to before. Deploying this change to
//                          production changes NOTHING until you opt in.
//   • DB_DRIVER=postgres  → direct Postgres via deno-postgres against
//                          DATABASE_URL (local docker / self-hosted).
//
// The `filters` arg keeps PostgREST semantics ("col": "eq.x" / "gte.x" /
// "lte.x" / "lt.x" / "gt.x" / "ilike.x" / "neq.x" / "in.(a,b)" / "is.null").
// A trailing digit on a filter key is stripped so two filters can target
// the same column, e.g. { created_at:'gte.x', created_at2:'lte.y' }.
// ══════════════════════════════════════════════════════════════════════

// deno-postgres is loaded lazily (dynamic import) ONLY when DB_DRIVER=postgres,
// so rest mode (production default) pulls zero new dependencies.
// deno-lint-ignore no-explicit-any
type PgPool = any

const DB_DRIVER  = (Deno.env.get('DB_DRIVER') || 'rest').toLowerCase()
const USE_PG     = DB_DRIVER === 'postgres'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// ── Postgres pool (lazy, only when DB_DRIVER=postgres) ─────────────────
// PostgREST serializes dates/timestamps as ISO strings and int8/numeric as JSON
// numbers. deno-postgres defaults differ (Date objects shifted into the machine's
// local timezone; BigInt / string for int8 / numeric — BigInt even breaks
// JSON.stringify), so decode those types the way PostgREST does. Both drivers must
// hand callers identical values. Keys are Postgres type OIDs.
const PG_DECODERS = {
  1082: (v: string) => v,                                                    // date        → 'YYYY-MM-DD'
  1114: (v: string) => v.replace(' ', 'T'),                                  // timestamp   → 'YYYY-MM-DDTHH:MM:SS[.f]'
  1184: (v: string) => v.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'),  // timestamptz → '…+00:00'
  20:   (v: string) => Number(v),                                            // int8 (bigserial ids)
  1700: (v: string) => Number(v),                                            // numeric
}

let _pool: PgPool | null = null
async function pool(): Promise<PgPool> {
  if (!_pool) {
    const raw = Deno.env.get('DATABASE_URL')
    if (!raw) throw new Error('DB_DRIVER=postgres but DATABASE_URL is not set')
    // Pool takes either a URL string or an options object — decoders need the object form.
    const url = new URL(raw)
    const { Pool } = await import('https://deno.land/x/postgres@v0.19.3/mod.ts')
    _pool = new Pool({
      hostname: url.hostname,
      port: url.port || '5432',
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ''),
      controls: { decoders: PG_DECODERS },
    }, 5, true) // 5 connections, lazy
  }
  return _pool
}

async function pg<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const p = await pool()
  const client = await p.connect()
  try {
    const r = await client.queryObject({ text: sql, args: params })
    return r.rows as T[]
  } finally {
    client.release()
  }
}

// ── identifier quoting (values are code literals, but quote defensively) ─
function qid(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"'
}

// ── PostgREST filter operator → SQL ────────────────────────────────────
// Returns { clause, params } for a WHERE built from a filters record.
// Mirrors PostgREST so both drivers return the same rows:
//   • like/ilike use * as the wildcard (translated to %)
//   • `or` / `and` keys hold a logical group: "(a.eq.1,b.ilike.*x*,and(c.gte.2,c.lte.5))"
//   • values may be double-quoted to contain commas or parentheses: labels.eq."vip,hot"
type WhereCtx = { params: unknown[]; idx: number }

// Split on commas that are not inside parentheses or double quotes.
function splitTopLevel(s: string): string[] {
  const out: string[] = []
  let depth = 0, quoted = false, cur = ''
  for (const ch of s) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch === '(') depth++
    else if (!quoted && ch === ')') depth--
    if (ch === ',' && depth === 0 && !quoted) { out.push(cur); cur = '' } else cur += ch
  }
  if (cur.length) out.push(cur)
  return out
}

function unquote(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s
}

// One condition: column + "op.value"
function condToSql(column: string, opAndVal: string, ctx: WhereCtx): string {
  const col = qid(column)
  const dot = opAndVal.indexOf('.')
  const op = dot === -1 ? 'eq' : opAndVal.slice(0, dot)
  const val = unquote(dot === -1 ? opAndVal : opAndVal.slice(dot + 1))
  const p = (v: unknown) => { ctx.params.push(v); return `$${ctx.idx++}` }

  switch (op) {
    case 'eq':    return `${col} = ${p(val)}`
    case 'neq':   return `${col} <> ${p(val)}`
    case 'gt':    return `${col} > ${p(val)}`
    case 'gte':   return `${col} >= ${p(val)}`
    case 'lt':    return `${col} < ${p(val)}`
    case 'lte':   return `${col} <= ${p(val)}`
    case 'like':  return `${col} LIKE ${p(val.replaceAll('*', '%'))}`
    case 'ilike': return `${col} ILIKE ${p(val.replaceAll('*', '%'))}`
    case 'is':
      if (val === 'null')  return `${col} IS NULL`
      if (val === 'true')  return `${col} IS TRUE`
      if (val === 'false') return `${col} IS FALSE`
      return `${col} = ${p(val)}`
    case 'in': {
      const items = splitTopLevel(val.replace(/^\(/, '').replace(/\)$/, '')).map(unquote)
      return items.length ? `${col} IN (${items.map(p).join(', ')})` : 'false'
    }
    default:
      // unknown operator → equality on the raw value (defensive)
      return `${col} = ${p(opAndVal)}`
  }
}

// A logical group "(item,item,…)" where an item is a condition or a nested and(…)/or(…)
function groupToSql(joiner: 'AND' | 'OR', group: string, ctx: WhereCtx): string {
  const inner = group.trim().replace(/^\(/, '').replace(/\)$/, '')
  const parts = splitTopLevel(inner).map((item) => {
    const nested = item.match(/^(and|or)(\(.*\))$/s)
    if (nested) return groupToSql(nested[1] === 'and' ? 'AND' : 'OR', nested[2], ctx)
    const dot = item.indexOf('.')
    if (dot === -1) throw new Error(`invalid filter condition: ${item}`)
    return condToSql(item.slice(0, dot), item.slice(dot + 1), ctx)
  })
  return parts.length ? `(${parts.join(` ${joiner} `)})` : 'true'
}

function buildWhere(
  filters: Record<string, string>,
  startIdx = 1,
): { clause: string; params: unknown[]; nextIdx: number } {
  const ctx: WhereCtx = { params: [], idx: startIdx }
  const parts: string[] = []
  for (const [rawKey, rawVal] of Object.entries(filters)) {
    const key = rawKey.replace(/\d+$/, '') // strip trailing digit (dedup trick)
    if (key === 'or' || key === 'and') parts.push(groupToSql(key === 'or' ? 'OR' : 'AND', rawVal, ctx))
    else parts.push(condToSql(key, rawVal, ctx))
  }
  return { clause: parts.length ? ' WHERE ' + parts.join(' AND ') : '', params: ctx.params, nextIdx: ctx.idx }
}

// ══════════════════════════════════════════════════════════════════════
// The 5 drop-in helpers
// ══════════════════════════════════════════════════════════════════════

// ── dbPatch: UPDATE <table> SET <data> WHERE id = <id> ─────────────────
export async function dbPatch(table: string, id: string, data: object) {
  if (!USE_PG) {
    await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
      method: 'PATCH',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(data),
    })
    return
  }
  const entries = Object.entries(data as Record<string, unknown>)
  if (entries.length === 0) return
  const sets = entries.map(([k], i) => `${qid(k)} = $${i + 1}`)
  const params = entries.map(([, v]) => serialize(v))
  params.push(id)
  try {
    await pg(`UPDATE ${qid(table)} SET ${sets.join(', ')} WHERE "id" = $${entries.length + 1}`, params)
  } catch (e) { console.error('dbPatch', table, e) }
}

// ── dbGet: SELECT <select> FROM <table> WHERE <filters> ORDER/LIMIT ─────
// Return type kept loose (any[]) to match the original helper's inferred
// `Promise<any>` — preserves the existing `as XxxRow[]` casts at call sites.
export async function dbGet(
  table: string,
  select = '*',
  filters: Record<string, string> = {},
  order?: string,
  limit?: number,
  // deno-lint-ignore no-explicit-any
): Promise<any[]> {
  if (!USE_PG) {
    const params = new URLSearchParams({ select })
    if (order) params.set('order', order)
    if (limit) params.set('limit', String(limit))
    appendRestFilters(params, filters)
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    })
    if (!r.ok) return []
    return r.json()
  }
  try {
    const { clause, params } = buildWhere(filters)
    let sql = `SELECT ${selectSql(select)} FROM ${qid(table)}${clause}${orderSql(order)}`
    if (limit) sql += ` LIMIT ${Number(limit)}`
    return await pg(sql, params)
  } catch (e) {
    console.error('dbGet', table, e)
    return []
  }
}

// ── dbGetPage: one page of rows + the total count ignoring limit/offset ─
// For paginated lists. rest mode uses PostgREST `Prefer: count=exact` + offset.
// limit = 0 → count only, no rows.
export async function dbGetPage(
  table: string,
  select = '*',
  filters: Record<string, string> = {},
  order?: string,
  limit = 50,
  offset = 0,
  // deno-lint-ignore no-explicit-any
): Promise<{ rows: any[]; count: number }> {
  if (!USE_PG) {
    const params = new URLSearchParams({ select })
    if (order) params.set('order', order)
    params.set('limit', String(limit))
    if (offset) params.set('offset', String(offset))
    appendRestFilters(params, filters)
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'count=exact' },
    })
    if (!r.ok) return { rows: [], count: 0 }
    const rows = await r.json()
    // Content-Range: "0-49/1234", or "*/0" when nothing matches
    const count = Number((r.headers.get('content-range') || '').split('/')[1]) || 0
    return { rows: limit === 0 ? [] : rows, count }
  }
  try {
    const { clause, params } = buildWhere(filters)
    const counted = await pg<{ n: number }>(`SELECT count(*)::int AS n FROM ${qid(table)}${clause}`, params)
    const count = counted[0]?.n ?? 0
    if (limit === 0) return { rows: [], count }
    const sql = `SELECT ${selectSql(select)} FROM ${qid(table)}${clause}${orderSql(order)} LIMIT ${Number(limit)} OFFSET ${Number(offset)}`
    return { rows: await pg(sql, params), count }
  } catch (e) {
    console.error('dbGetPage', table, e)
    return { rows: [], count: 0 }
  }
}

function selectSql(select: string): string {
  return select === '*' ? '*' : select.split(',').map((c) => qid(c.trim())).join(', ')
}

// "col.desc" / "col.asc" (default asc)
function orderSql(order?: string): string {
  if (!order) return ''
  const [ocol, odir] = order.split('.')
  return ` ORDER BY ${qid(ocol)} ${String(odir).toLowerCase() === 'desc' ? 'DESC' : 'ASC'}`
}

// rest mode: strip the trailing-digit dedup suffix (created_at2 → created_at) and
// append instead of set, so one column can carry two filters (PostgREST ANDs them).
// Sending "created_at2=…" as-is makes PostgREST reject the query (unknown column).
function appendRestFilters(params: URLSearchParams, filters: Record<string, string>) {
  for (const [k, v] of Object.entries(filters)) params.append(k.replace(/\d+$/, ''), v)
}

// ── dbInsert: INSERT INTO <table> (...) VALUES (...) ───────────────────
// Returns a result object so callers that need it can detect failure.
// Existing callers ignore the return value — this stays backward compatible.
export async function dbInsert(table: string, data: object): Promise<{ ok: boolean; error?: string }> {
  if (!USE_PG) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(data),
    })
    if (!r.ok) return { ok: false, error: `${r.status}:${await r.text()}` }
    return { ok: true }
  }
  try {
    const rows = Array.isArray(data) ? data : [data]
    if (rows.length === 0) return { ok: true }
    const { sql, params } = buildInsert(table, rows as Record<string, unknown>[])
    await pg(sql, params)
    return { ok: true }
  } catch (e) {
    console.error('dbInsert', table, e)
    return { ok: false, error: String(e) }
  }
}

// ── dbUpsert: INSERT ... ON CONFLICT (<cols>) DO UPDATE ────────────────
export async function dbUpsert(table: string, data: object, onConflict: string) {
  if (!USE_PG) {
    await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(data),
    })
    return
  }
  try {
    const rows = Array.isArray(data) ? data : [data]
    if (rows.length === 0) return
    const { sql, params, cols } = buildInsert(table, rows as Record<string, unknown>[])
    const conflictCols = onConflict.split(',').map((c) => qid(c.trim())).join(', ')
    const updates = cols
      .filter((c) => !onConflict.split(',').map((x) => x.trim()).includes(c))
      .map((c) => `${qid(c)} = EXCLUDED.${qid(c)}`)
    const doClause = updates.length
      ? `DO UPDATE SET ${updates.join(', ')}`
      : 'DO NOTHING'
    await pg(`${sql} ON CONFLICT (${conflictCols}) ${doClause}`, params)
  } catch (e) { console.error('dbUpsert', table, e) }
}

// ── dbInsertReturning: INSERT ... RETURNING * → first row ──────────────
export async function dbInsertReturning(table: string, data: object): Promise<Record<string, unknown>> {
  if (!USE_PG) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify(data),
    })
    if (!r.ok) return {}
    const rows = await r.json()
    return Array.isArray(rows) ? (rows[0] ?? {}) : rows
  }
  try {
    const rows = Array.isArray(data) ? data : [data]
    if (rows.length === 0) return {}
    const { sql, params } = buildInsert(table, rows as Record<string, unknown>[])
    const out = await pg(`${sql} RETURNING *`, params)
    return out[0] ?? {}
  } catch (e) {
    console.error('dbInsertReturning', table, e)
    return {}
  }
}

// ══════════════════════════════════════════════════════════════════════
// Step 2 additions — cover the inline REST calls that the 5 helpers above
// could not express (arbitrary-filter PATCH/DELETE, and Postgres RPC).
// ══════════════════════════════════════════════════════════════════════

// Build a PostgREST query string from a filters record (rest branch).
// Encodes the value after the operator, mirroring the original call sites
// (which did `eq.${encodeURIComponent(x)}` / raw `in.(a,b)`).
function restFilterQS(filters: Record<string, string>): string {
  return Object.entries(filters).map(([k, v]) => {
    const col = k.replace(/\d+$/, '')
    const dot = v.indexOf('.')
    if (dot === -1) return `${col}=${encodeURIComponent(v)}`
    const op = v.slice(0, dot)
    const val = v.slice(dot + 1)
    if (op === 'in') {
      const inner = val.replace(/^\(/, '').replace(/\)$/, '')
      const items = inner ? inner.split(',').map(encodeURIComponent) : []
      return `${col}=in.(${items.join(',')})`
    }
    return `${col}=${op}.${encodeURIComponent(val)}`
  }).join('&')
}

// ── dbPatchWhere: UPDATE with arbitrary filters (not just id) ──────────
export async function dbPatchWhere(table: string, filters: Record<string, string>, data: object) {
  if (!USE_PG) {
    await fetch(`${SUPABASE_URL}/rest/v1/${table}?${restFilterQS(filters)}`, {
      method: 'PATCH',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(data),
    })
    return
  }
  const entries = Object.entries(data as Record<string, unknown>)
  if (entries.length === 0) return
  try {
    const sets = entries.map(([k], i) => `${qid(k)} = $${i + 1}`)
    const params = entries.map(([, v]) => serialize(v))
    const { clause, params: wParams } = buildWhere(filters, entries.length + 1)
    await pg(`UPDATE ${qid(table)} SET ${sets.join(', ')}${clause}`, [...params, ...wParams])
  } catch (e) { console.error('dbPatchWhere', table, e) }
}

// ── dbDelete: DELETE with arbitrary filters ────────────────────────────
export async function dbDelete(table: string, filters: Record<string, string>) {
  if (!USE_PG) {
    await fetch(`${SUPABASE_URL}/rest/v1/${table}?${restFilterQS(filters)}`, {
      method: 'DELETE',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'return=minimal' },
    })
    return
  }
  try {
    const { clause, params } = buildWhere(filters)
    if (!clause) { console.error('dbDelete refused: empty filters', table); return }
    await pg(`DELETE FROM ${qid(table)}${clause}`, params)
  } catch (e) { console.error('dbDelete', table, e) }
}

// ── dbRpc: call a Postgres function; returns rows ([] on failure) ──────
// NOTE: pgvector args (number[]) are passed as a vector literal with an
// explicit ::vector cast. Unverified until a local Postgres exists (step 3).
// deno-lint-ignore no-explicit-any
export async function dbRpc(fn: string, args: Record<string, unknown> = {}): Promise<any[]> {
  if (!USE_PG) {
    return await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    }).then((r) => r.ok ? r.json() : []).catch(() => [])
  }
  try {
    const names = Object.keys(args)
    const params: unknown[] = []
    const named = names.map((n, i) => {
      const v = args[n]
      if (Array.isArray(v) && v.every((x) => typeof x === 'number')) {
        params.push(`[${v.join(',')}]`)        // pgvector literal
        return `${n} => $${i + 1}::vector`
      }
      params.push(serialize(v))
      return `${n} => $${i + 1}`
    })
    return await pg(`SELECT * FROM ${qid(fn)}(${named.join(', ')})`, params)
  } catch (e) {
    console.error('dbRpc', fn, e)
    return []
  }
}

// ── shared INSERT builder (union of keys across rows) ──────────────────
function buildInsert(table: string, rows: Record<string, unknown>[]): { sql: string; params: unknown[]; cols: string[] } {
  const colSet = new Set<string>()
  for (const row of rows) for (const k of Object.keys(row)) colSet.add(k)
  const cols = [...colSet]
  const params: unknown[] = []
  let idx = 1
  const valueTuples = rows.map((row) => {
    const ph = cols.map((c) => {
      params.push(serialize(row[c]))
      return `$${idx++}`
    })
    return `(${ph.join(', ')})`
  })
  const sql = `INSERT INTO ${qid(table)} (${cols.map(qid).join(', ')}) VALUES ${valueTuples.join(', ')}`
  return { sql, params, cols }
}

// ── serialize a JS value for a Postgres param ──────────────────────────
// Objects/arrays → JSON (for jsonb columns). Primitives pass through.
function serialize(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === 'object') return JSON.stringify(v)
  return v
}
