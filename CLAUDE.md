# Memory

## Project
Orchestrator Agent (codename **UCG**) — a multi-agent AI brain.
**Architecture direction (changed):** local-first & portable — run locally first, then deploy anywhere (self-host / cloud / or back to Supabase). **Not locked to Supabase.** Supabase is now ONE possible backend, not the only one.

## Architecture
> ⚠️ **Production still runs on Supabase** (Edge Functions + Postgres). Migration status:
> - ✅ DB layer portable — all backend DB access goes through `supabase/functions/orchestrator/db.ts` (`DB_DRIVER=rest` default | `postgres`); postgres mode matches PostgREST's filters and value types
> - ✅ Local stack — `local/docker-compose.yml` (Postgres 17 + pgvector), schema `local/initdb/01–03`; tests `local/smoke-db.ts` (DB layer) and `local/smoke-api.ts` (backend actions)
> - ✅ Backend runs locally — `.claude/launch.json` → `backend` (reads `local/.env`, template `local/.env.example`)
> - 🔄 Frontend moving off direct supabase-js calls to explicit backend actions (`<domain>_crud`), page by page. Done: logs / LLM config / API integrations / agents (editor, skills, knowledge gaps, workflow agent pickers) / home overview + sidebar provider dots / data page (accounts, leads, ad reports, data entries, analytics, CSV/Excel import & export) / tasks + staff / direct messages (polling every 3 s while the page is open, replacing Supabase Realtime). Remaining: documents, KB / workflow / automation pages, file storage
> - ⚠️ **No authentication.** The backend trusts `tenant_id` / `role` from the request body, and the dashboard password lock was removed (it was a hardcoded client-side password). Local use only — real auth (backend-issued session tokens) must exist before any public deploy.
>
> Start Docker on this machine with `local/start-docker.ps1` — Docker Desktop crashes at startup on stale sockets otherwise.
> The schema in `local/initdb/` is **reconstructed from code**, not dumped from Supabase.

| Layer | Current (Supabase) | Target (portable / local-first) |
|-------|--------------------|----------------------------------|
| Frontend | `dashboard.html` — standalone HTML | same, backend URL configurable |
| Backend | Supabase Edge Function `orchestrator` (Deno/TS) | portable server (local dev → deploy anywhere), storage-agnostic |
| Database | Supabase Postgres (28 tables) | pluggable store — local Postgres + pgvector ready in `local/`, Supabase = one option |
| LLM | Anthropic / OpenAI / Google / OpenRouter — switchable per-agent | same |
| CDN | Cloudflare Worker (static asset serving) | same / optional |

## Agents
| ID | Name | Role |
|----|------|------|
| chat | Chat Agent | General conversation |
| crm | CRM Agent | Customer relationships — will connect to CRM data |
| account | Account Agent | Finance/billing — will connect to financial data |
| code | Code Agent | Programming, debug |

## Supabase (current backend — being decoupled)
- Project: `ontumerafhimxvqtsijr`
- URL: `https://ontumerafhimxvqtsijr.supabase.co`
- Edge Function: `/functions/v1/orchestrator`
- Note: keep backend URL/keys configurable (env/config), not hardcoded, so the backend can be swapped for a local or self-hosted one.

## Tables
| Table | Purpose |
|-------|---------|
| agents | Agent definitions (system_prompt, provider, model, active) |
| conversations | Chat history |
| user_prefs | Auto-learned user preferences |
| agent_skills | Skills agents learn over time |
| provider_config | LLM API keys (Anthropic/OpenAI/Google/OpenRouter) |
| api_integrations | WhatsApp / Email / Telegram credentials |
| documents | 文件审批元数据（标题、状态、上传者、file_url）|
| document_reviewers | 审批人记录（决定、留言、时间）|

## Key Files
| File | Purpose |
|------|---------|
| `dashboard.html` | Full UI — open directly in browser |
| `soul.md` | Brain behavior rules (<1KB) |
| `TASKS.md` | Task tracker |

## Preferences
- **Local-first & portable** — get it running locally first, then deploy/migrate anywhere; do NOT lock to Supabase. (Changed from the old "no local server, everything on Supabase" rule.)
- Chinese UI, English code
- soul.md kept under 1KB
- **先讨论确认，再动手实现**（多步骤任务先对齐再写代码）
- **往深的想，一步到位**（不要浅尝辄止）

---

# Coding Guidelines (Karpathy Skills)

Behavioral guidelines to reduce common LLM coding mistakes.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" that wasn't requested.
- If you write 200 lines and it could be 50, rewrite it.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

- Don't "improve" adjacent code or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

- Transform tasks into verifiable goals before starting.
- For multi-step tasks, state a brief plan with verify steps.
- Clarifying questions come BEFORE implementation, not after mistakes.
