# Memory

## Project
Orchestrator Agent — a multi-agent AI brain running fully on Supabase (no local server).

## Architecture
| Layer | What |
|-------|------|
| Frontend | `dashboard.html` — standalone HTML, open in browser |
| Backend | Supabase Edge Function `orchestrator` (always-on, Deno/TypeScript) |
| Database | Supabase Postgres (6 tables) |
| LLM | Anthropic / OpenAI / Google — switchable per-agent |

## Agents
| ID | Name | Role |
|----|------|------|
| chat | Chat Agent | General conversation |
| crm | CRM Agent | Customer relationships — will connect to CRM data |
| account | Account Agent | Finance/billing — will connect to financial data |
| code | Code Agent | Programming, debug |

## Supabase
- Project: `ontumerafhimxvqtsijr`
- URL: `https://ontumerafhimxvqtsijr.supabase.co`
- Edge Function: `/functions/v1/orchestrator`

## Tables
| Table | Purpose |
|-------|---------|
| agents | Agent definitions (system_prompt, provider, model, active) |
| conversations | Chat history |
| user_prefs | Auto-learned user preferences |
| agent_skills | Skills agents learn over time |
| provider_config | LLM API keys (Anthropic/OpenAI/Google) |
| api_integrations | WhatsApp / Email / Telegram credentials |

## Key Files
| File | Purpose |
|------|---------|
| `dashboard.html` | Full UI — open directly in browser |
| `soul.md` | Brain behavior rules (<1KB) |
| `TASKS.md` | Task tracker |

## Preferences
- No local server — everything runs on Supabase
- Same pattern as existing CRM (Supabase-native, bypass login for testing)
- Chinese UI, English code
- soul.md kept under 1KB

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
