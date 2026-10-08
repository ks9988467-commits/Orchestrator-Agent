// Authentication (session tokens, internal secret) and the per-action role table.
import { dbGet } from './db.ts'

// ── Authentication helpers ───────────────────────────────────────────
export const INTERNAL_SECRET = Deno.env.get('ORCH_INTERNAL_SECRET') || ''

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// Emails that log in as master (MASTER_EMAILS, comma-separated), lower-cased
export function masterEmailList(): string[] {
  return (Deno.env.get('MASTER_EMAILS') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
}

export type AuthContext =
  | { kind: 'internal' }
  | { kind: 'session'; email: string; tenantId: string | null; role: string; tokenHash: string }

// Who is calling: a backend-internal caller (x-orch-internal header = ORCH_INTERNAL_SECRET —
// self-invokes and schedulers) or a logged-in user (Authorization: Bearer <session token>).
// null = not authenticated.
export async function authenticate(req: Request): Promise<AuthContext | null> {
  const internal = req.headers.get('x-orch-internal') || ''
  if (INTERNAL_SECRET && internal && constantTimeEqual(internal, INTERNAL_SECRET)) return { kind: 'internal' }
  const m = (req.headers.get('authorization') || '').match(/^Bearer\s+(\S+)$/i)
  if (!m) return null
  const tokenHash = await sha256Hex(m[1])
  const rows = await dbGet('sessions', 'email,tenant_id,role',
    { token_hash: `eq.${tokenHash}`, revoked_at: 'is.null', expires_at: `gt.${new Date().toISOString()}` }, undefined, 1)
  if (!rows.length) return null
  return { kind: 'session', email: String(rows[0].email), tenantId: rows[0].tenant_id ?? null, role: String(rows[0].role), tokenHash }
}

// ── Role requirements ────────────────────────────────────────────────
// Minimum role per action, or per action + method ('*' = any other method). Actions not
// listed — including everything the dashboard never calls — need admin. Internal callers
// count as master; chat messages (no action) are open to every logged-in user.
export const ROLE_RANK: Record<string, number> = { member: 1, admin: 2, master: 3 }

export const ACTION_ROLES: Record<string, string | Record<string, string>> = {
  // everyday use
  whoami: 'member', logout: 'member', home_summary: 'member', channel_metrics: 'member',
  account_crud: 'member', lead_crud: 'member', ad_report_crud: 'member', data_entry_crud: 'member', analytics_crud: 'member',
  staff_task_crud: 'member', direct_message_crud: 'member',
  document_crud: 'member',                       // decide / delete / get also check the member's own rows
  notify_doc_reviewers: 'member', notify_doc_decision: 'member',
  list_kbs: 'member', count_kb_chunks: 'member', kb_ingest: 'member', kb_search: 'member',
  kb_sync: { status: 'member', '*': 'admin' },
  list_workflows: 'member', list_workflow_runs: 'member', run_workflow: 'member',
  list_agent_versions: 'member', learn: 'member', ugc_generate: 'member', ugc_get_rules: 'member',
  // everyone reads, admins change
  agent_crud: { list: 'member', '*': 'admin' },
  agent_skill_crud: { list: 'member', '*': 'admin' },
  agent_suggestion_crud: { list: 'member', mark_handled: 'member', '*': 'admin' },
  staff_crud: { list: 'member', '*': 'admin' },
  provider_config_crud: { list: 'member', '*': 'admin' },   // list returns no keys (sidebar status dots)
  automation_crud: { list: 'member', get_logs: 'member', mark_read: 'member', unread_count: 'member', '*': 'admin' },
  conversation_crud: { list: 'member', set_feedback: 'member', '*': 'admin' },
  booking_crud: { list: 'member', create: 'member', '*': 'admin' },
  // client (tenant) management
  list_tenants: 'master', create_tenant: 'master', update_tenant: 'master', add_tenant_user: 'master', get_master_summary: 'master',
}

export function requiredRole(action: string, method: string): string {
  if (!action) return 'member'
  const rule = ACTION_ROLES[action]
  if (rule === undefined) return 'admin'
  if (typeof rule === 'string') return rule
  return rule[method] ?? rule['*'] ?? 'admin'
}
