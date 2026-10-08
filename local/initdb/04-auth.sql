-- ══════════════════════════════════════════════════════════════════════
-- Backend-issued login sessions + OTP hardening. Idempotent: safe to re-run
-- on an existing database (and to apply to production before deploying the
-- backend that uses it).
-- ══════════════════════════════════════════════════════════════════════

-- A session is created by verify_otp. The browser holds the token and sends it
-- as "Authorization: Bearer <token>"; only its SHA-256 hash is stored here.
create table if not exists sessions (
  id          uuid primary key default gen_random_uuid(),
  token_hash  text not null unique,
  email       text not null,
  tenant_id   text,
  role        text not null,               -- master | admin | member, fixed at login
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz                  -- set by logout
);
create index if not exists sessions_email_idx on sessions (email);

-- otp_requests.code now holds sha256("<email>:<code>"), not the code itself.
-- Wrong guesses are counted; five use the code up.
alter table otp_requests add column if not exists attempts int not null default 0;
