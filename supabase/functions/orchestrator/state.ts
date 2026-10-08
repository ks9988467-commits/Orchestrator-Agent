// ══════════════════════════════════════════════════════════════════════
// Mutable state used across the orchestrator's modules.
// R and llmUsage are per request: each request runs in its own context
// (withRequestContext), so concurrent requests cannot see each other's
// identity or token counts. `shared` holds caches meant for all requests.
// ══════════════════════════════════════════════════════════════════════

import { AsyncLocalStorage } from 'node:async_hooks'

export interface ProviderRow { provider: string; api_key: string; model: string; active: boolean }
export interface AgentRow    { id: string; name: string; system_prompt: string; provider: string|null; model: string|null; active: boolean; uses_tools?: boolean }

// Parsed JSON body of a request: untyped, each action reads its own fields
// deno-lint-ignore no-explicit-any
export type Body = Record<string, any>

interface CacheEntry<T> { data: T; expires: number }
export const CACHE_TTL = 60_000 // 60 s

function newRequestContext() {
  return {
    r: {
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
    },
    // Token accumulator for the LLM call in progress (reset per call by resetUsage)
    usage: { tokens_in: 0, tokens_out: 0, used_model: '' },
  }
}
type RequestContext = ReturnType<typeof newRequestContext>

const requestContext = new AsyncLocalStorage<RequestContext>()
// Code running outside any request (startup, the hourly KB-sync check) shares this one
const outsideRequest = newRequestContext()
const current = () => requestContext.getStore() ?? outsideRequest

// Runs fn in a fresh context; everything it awaits, schedules or streams keeps that context
export function withRequestContext<T>(fn: () => T): T {
  return requestContext.run(newRequestContext(), fn)
}

// A stable object whose properties read and write the current request's context
function contextView<T extends object>(pick: () => T): T {
  return new Proxy({} as T, {
    get: (_t, k) => Reflect.get(pick(), k),
    set: (_t, k, v) => Reflect.set(pick(), k, v),
    has: (_t, k) => Reflect.has(pick(), k),
    ownKeys: () => Reflect.ownKeys(pick()),
    getOwnPropertyDescriptor: (_t, k) => {
      const d = Reflect.getOwnPropertyDescriptor(pick(), k)
      return d ? { ...d, configurable: true } : undefined
    },
  })
}

// Per-request identity and LLM context
export const R = contextView(() => current().r)
// Per-request token accumulator
export const llmUsage = contextView(() => current().usage)

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
