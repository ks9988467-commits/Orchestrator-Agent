// CORS (allowed origins) and in-memory rate limiting for the orchestrator HTTP handler.

// ── CORS ─────────────────────────────────────────────────────────────
// Browsers may call the backend only from these origins (ORCH_ALLOWED_ORIGINS,
// comma-separated). Requests without an Origin header (schedulers, webhooks,
// curl) are not subject to CORS and are unaffected.
export const ALLOWED_ORIGINS = (Deno.env.get('ORCH_ALLOWED_ORIGINS') || 'https://orchestrator-agent.ks9988467.workers.dev,http://localhost:4444')
  .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean)

export const CORS_HEADERS = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-file-name',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Vary': 'Origin',
}

// Per-request CORS headers: the caller's origin is echoed only when it is allowed
export function corsFor(req: Request): Record<string, string> {
  const origin = (req.headers.get('origin') || '').replace(/\/+$/, '')
  return origin && ALLOWED_ORIGINS.includes(origin) ? { ...CORS_HEADERS, 'Access-Control-Allow-Origin': origin } : { ...CORS_HEADERS }
}

// ── Rate limiting ─────────────────────────────────────────────────────
// Fixed one-minute windows per key, kept in memory. On Supabase Edge Functions
// each isolate counts separately, so the effective limit is per isolate — good
// enough to stop a single client from hammering the API, not a hard global cap.
const RATE_WINDOW_MS = 60_000
const _rate = new Map<string, { n: number; reset: number }>()

// Returns the seconds to wait when `key` has exceeded `limit` requests in the current window, else 0
export function rateLimited(key: string, limit: number): number {
  const now = Date.now()
  if (_rate.size > 10_000) for (const [k, v] of _rate) if (v.reset <= now) _rate.delete(k)
  const cur = _rate.get(key)
  if (!cur || cur.reset <= now) { _rate.set(key, { n: 1, reset: now + RATE_WINDOW_MS }); return 0 }
  cur.n++
  return cur.n > limit ? Math.ceil((cur.reset - now) / 1000) : 0
}

export function clientIp(req: Request): string {
  return (req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    || req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || 'unknown'
}

export function tooManyRequests(retryAfter: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: '请求太频繁，请稍后再试' }),
    { status: 429, headers: { ...cors, 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) } })
}
