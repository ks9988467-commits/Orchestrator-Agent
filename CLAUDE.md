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
