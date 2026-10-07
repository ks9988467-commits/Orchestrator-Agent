-- ══════════════════════════════════════════════════════════════════════
-- Folder → knowledge base sync (local backend, KB_SYNC_DIR). Idempotent.
-- ══════════════════════════════════════════════════════════════════════

-- One row per synced file: its content hash at the last successful ingest.
-- A file whose hash is unchanged is skipped; a row whose file is gone has its
-- chunks removed.
create table if not exists kb_sync_files (
  kb_id     uuid not null,
  path      text not null,                 -- relative to KB_SYNC_DIR, forward slashes
  hash      text not null,                 -- sha256 of the file text
  synced_at timestamptz not null default now(),
  primary key (kb_id, path)
);

alter table knowledge_bases add column if not exists synced_at         timestamptz;  -- last run with no failures
alter table knowledge_bases add column if not exists sync_attempted_at timestamptz;  -- last run, any outcome
alter table knowledge_bases add column if not exists sync_result       text;         -- summary shown in the dashboard
