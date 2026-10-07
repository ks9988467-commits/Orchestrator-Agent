// ══════════════════════════════════════════════════════════════════════
// Mutable state shared by the orchestrator's modules. Kept in objects so every
// module can update it (an imported `let` binding is read-only elsewhere).
// ══════════════════════════════════════════════════════════════════════

export interface ProviderRow { provider: string; api_key: string; model: string; active: boolean }
export interface AgentRow    { id: string; name: string; system_prompt: string; provider: string|null; model: string|null; active: boolean; uses_tools?: boolean }

interface CacheEntry<T> { data: T; expires: number }
export const CACHE_TTL = 60_000 // 60 s

// Per-request context, reset at the start of every request in index.ts
export const R = {
  // tenant / identity (from the authenticated session)
  tenantId: null as string | null,
  isMaster: false,
  role: 'member',
  email: '',
  authHash: '',                // SHA-256 of the caller's session token (for logout)
  // LLM context (for use inside executeTool)
  providers: [] as ProviderRow[],
  agents: [] as AgentRow[],
  defaultProvider: '',
  delegated: false,            // true when delegate_to_agent was called this request
  sessionId: '',               // current request session_id (for delegate history lookup)
  delegatedId: '',             // agent_id that was delegated to
  delegatedName: '',           // agent display name that was delegated to
  hermesMode: false,           // true when calling agent is 'chat' (Hermes) — limits tools to delegation-only
  delegationContext: '',       // accumulated context from previous delegations this request
}

// Token accumulator for the LLM call in progress (reset per call by resetUsage)
export const llmUsage = { tokens_in: 0, tokens_out: 0, used_model: '' }

// Shared across requests in the same isolate
export const shared = {
  providers: null as CacheEntry<ProviderRow[]> | null,
  agents:    null as CacheEntry<AgentRow[]> | null,
  defProv:   null as CacheEntry<string> | null,
  kbSyncRunning: false,
}

export function tenantFilters(extra: Record<string,string> = {}): Record<string,string> {
  if (!R.isMaster && R.tenantId) return { ...extra, tenant_id: `eq.${R.tenantId}` }
  return extra
}
