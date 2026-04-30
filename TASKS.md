# Tasks — Orchestrator Agent System

## In Progress
- [ ] Fill in LLM API Key and test chat routing

## Up Next
- [ ] Test all 4 agents (Chat / CRM / Account / Code)
- [ ] Connect WhatsApp integration
- [ ] Connect Email (SMTP or SendGrid)
- [ ] Connect CRM Agent to real Supabase CRM data
- [ ] Connect Account Agent to real financial data
- [ ] Deploy dashboard to Cloudflare Pages for team access

## Done
- [x] Project structure defined (no local server, all cloud)
- [x] Supabase tables: agents, conversations, user_prefs, agent_skills, provider_config, api_integrations
- [x] Edge Function `orchestrator` deployed (v4, ACTIVE)
- [x] Dashboard HTML: sidebar nav, Chat / Agents / LLM配置 / API对接 pages
- [x] Agent management page with inline editor drawer
- [x] Per-agent LLM assignment
- [x] LLM fallback chain (agent-specific → default → others)
- [x] Model picker: fetch available models from API key
- [x] soul.md behavior file (brain only, <1KB guard)
- [x] Removed FastAPI / local backend entirely
