-- ─────────────────────────────────────────────────────────────────────────────
-- SHIVANSH Production DB Patch
-- Run this ONCE in your Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- All statements use "IF NOT EXISTS" / "DO $$ ... END $$" so it is safe to
-- re-run multiple times without errors.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Enum types (create only if not present)
DO $$ BEGIN
  CREATE TYPE dialing_mode AS ENUM ('manual','progressive','predictive','preview');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE routing_strategy AS ENUM ('round_robin','priority','sequential');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. campaigns table — add every column that was added after the initial deploy
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS voice_provider            TEXT DEFAULT 'elevenlabs',
  ADD COLUMN IF NOT EXISTS use_vapi                  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS transfer_mode             TEXT DEFAULT 'blind',
  ADD COLUMN IF NOT EXISTS background_sound          TEXT DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS hold_music                TEXT DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS human_like                TEXT DEFAULT 'true',
  ADD COLUMN IF NOT EXISTS dialing_ratio             INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS dialing_speed             INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS drop_rate_limit           INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS retry_attempts            INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS retry_interval_minutes    INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS working_hours_start       TEXT,
  ADD COLUMN IF NOT EXISTS working_hours_end         TEXT,
  ADD COLUMN IF NOT EXISTS working_hours_timezone    TEXT DEFAULT 'UTC',
  ADD COLUMN IF NOT EXISTS amd_enabled               BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS vm_drop_message           TEXT,
  ADD COLUMN IF NOT EXISTS tcpa_enabled              BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS region                    TEXT,
  ADD COLUMN IF NOT EXISTS accent                    TEXT,
  ADD COLUMN IF NOT EXISTS voice_profile             TEXT;

-- dialing_mode and routing_strategy use pg enums, must be separate statements
DO $$ BEGIN
  ALTER TABLE campaigns ADD COLUMN dialing_mode dialing_mode NOT NULL DEFAULT 'progressive';
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE campaigns ADD COLUMN routing_strategy routing_strategy NOT NULL DEFAULT 'round_robin';
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- 3. human_agents table (the new Human Agents page needs this)
DO $$ BEGIN
  CREATE TYPE human_agent_status AS ENUM ('available','busy');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS human_agents (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  phone_number TEXT NOT NULL UNIQUE,
  status       human_agent_status NOT NULL DEFAULT 'available',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. campaign_agents — priority column for routing strategies
ALTER TABLE campaign_agents
  ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 1;

SELECT 'Patch applied successfully — all columns and tables are in sync' AS result;
