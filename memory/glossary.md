# Glossary

## System Terms
| Term | Meaning |
|------|---------|
| Orchestrator | The main brain that routes user messages to the right Agent |
| Edge Function | Supabase serverless function (Deno/TypeScript), always-on |
| soul.md | Behavior directive file for the brain only (voice, judgment, rhythm rules) |
| provider | LLM provider: Anthropic, OpenAI, or Google |
| fallback | Auto-switch to next provider if current one fails |
| RLS | Row Level Security — Supabase database access control |

## Agents
| Term | Meaning |
|------|---------|
| Chat Agent | General-purpose conversation agent |
| CRM Agent | Customer relationship management agent |
| Account Agent | Financial/accounting agent |
| Code Agent | Software engineering agent |

## Integrations
| Term | Meaning |
|------|---------|
| WhatsApp | Meta Cloud API integration |
| SMTP | Email via direct server connection |
| SendGrid | Email via SendGrid API |
| Telegram | Telegram Bot API |
