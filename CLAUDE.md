# Memory

## Project
Orchestrator Agent (codename **UCG**) — a multi-agent AI brain.
**Architecture direction (changed):** local-first & portable — run locally first, then deploy anywhere (self-host / cloud / or back to Supabase). **Not locked to Supabase.** Supabase is now ONE possible backend, not the only one.

## Architecture
> ⚠️ **Production still runs on Supabase** (Edge Functions + Postgres). Migration status:
> - ✅ DB layer portable — all backend DB access goes through `supabase/functions/orchestrator/db.ts` (`DB_DRIVER=rest` default | `postgres`); postgres mode matches PostgREST's filters and value types
> - ✅ Local stack — `local/docker-compose.yml` (Postgres 17 + pgvector), schema `local/initdb/01–03`; tests `local/smoke-db.ts` (DB layer) and `local/smoke-api.ts` (backend actions)
> - ✅ Backend runs locally — `.claude/launch.json` → `backend` (reads `local/.env`, template `local/.env.example`)
> - ✅ Frontend talks only to the backend — no supabase-js, no direct database or storage access. Pages use explicit backend actions (`<domain>_crud`): logs / LLM config / API integrations / agents (editor, skills, knowledge gaps, workflow agent pickers) / home overview + sidebar provider dots / data page (accounts, leads, ad reports, data entries, analytics, CSV/Excel import & export) / tasks + staff / direct messages (polling every 3 s while the page is open, replacing Supabase Realtime) / document approval + file uploads / knowledge bases, workflow run history, automation logs + unread badge. The only Supabase detail left in the frontend is the default backend URL in `app-core.js`
> - ✅ File storage portable — `supabase/functions/orchestrator/storage.ts` (`STORAGE_DRIVER=supabase` default | `local`); the local driver writes to `FILE_STORAGE_DIR` (default `local/storage`, gitignored) and the backend serves it at `/files/<bucket>/<name>`. Uploads always go through the backend (`POST /files/<bucket>`), never straight to Supabase
> - ✅ **Authentication — done locally, not deployed.** The dashboard logs in on its lock screen, keeps the token in localStorage (`_orch_token`) and goes back to the lock screen on any 401. The hosted Edge Function must be deployed with `--no-verify-jwt` — the session token is not a Supabase JWT. Every action except `send_otp` / `verify_otp` (and the WhatsApp webhook) needs `Authorization: Bearer <session token>` — issued by `verify_otp`, valid 7 days, only its SHA-256 hash stored in `sessions`, revoked by `logout` — or the `x-orch-internal` header = `ORCH_INTERNAL_SECRET` (self-invokes, schedulers). Identity (tenant / role) comes from the session, never the request body; a non-master is pinned to its own tenant. Master = the `MASTER_EMAILS` env var; other emails need a `tenant_users` row. OTP codes are stored hashed, limited to 1/min and 5/h per email, and used up after 5 wrong tries; `OTP_DEV_ECHO=true` (local only) prints them to the backend console. Schema: `local/initdb/04-auth.sql`. Roles: `ACTION_ROLES` in index.ts — member = everyday use and reads; admin = every configuration change and any action the dashboard never calls; master = client (tenant) management; members can only open, decide on and delete their own documents. File downloads (local driver) need an HMAC-signed, expiring link (1 h in dashboard responses, 7 days in reviewer notifications); the Supabase driver uses Supabase signed URLs, which only protect files in private buckets. Before any production deploy: run `04-auth.sql` there, set `MASTER_EMAILS` and `ORCH_INTERNAL_SECRET`, put the secret into the pg_cron job header, deploy the function with `--no-verify-jwt`, make the storage buckets private, and deploy backend and frontend together.
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

**Before writing code, climb this ladder. Stop at the first rung that holds:**

1. **Does this need to exist at all?** Speculative need → skip it, say so in one line.
2. **Does this codebase already have it?** A helper, pattern or backend action that already exists → reuse it. Re-implementing what lives a few files over is the most common waste.
3. **Does the standard library do it?**
4. **Does a native platform feature cover it?** DB constraint over app code, CSS over JS, `<input type="date">` over a picker library.
5. **Does an already-installed dependency solve it?** Never add a dependency for what a few lines can do.
6. **Can it be one line?**
7. **Only then:** the minimum code that works.

The ladder shortens the solution, never the reading — trace the whole flow the change touches first. The smallest change in the wrong place is a second bug, not a lazy win.

**Fix bugs at the root, not the symptom.** Before editing, check every caller of the function being changed: one guard in the shared function is smaller than a guard in each caller, and patching only the reported path leaves every sibling caller broken.

**Never simplify away:** input validation at trust boundaries, error handling that prevents data loss, security measures, accessibility basics, or anything explicitly requested.

**No padding.** No unrequested prose, no essay defending a simplification, no comment restating the code. Requested reporting — what changed, what was verified, what is still open — is not padding.

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
