# Project: Orchestrator Agent

## What
Multi-agent AI brain that routes user messages to specialized agents and learns user preferences over time.

## Status
Infrastructure complete. Awaiting API keys to test end-to-end.

## Stack
- Supabase Edge Functions (Deno/TypeScript)
- Supabase Postgres
- Vanilla HTML/JS dashboard (no framework)
- LLM: Anthropic Claude / OpenAI GPT / Google Gemini

## Design Decisions
- No local server — mirrors how existing CRM works on Supabase
- soul.md kept under 1KB, brain-only behavior rules
- Per-agent LLM assignment with automatic fallback chain
- Skills learned from interactions stored in agent_skills table
- Dashboard is a single HTML file, open directly in browser

## Pending Connections
- CRM Agent → user's existing CRM data in Supabase
- Account Agent → financial data
- WhatsApp / Email → api_integrations table (credentials stored, Edge Function logic TBD)
