#!/usr/bin/env bash
# SHIVANSH one-shot production fix
# Run as root on EACH VPS:  bash /tmp/fix-production.sh
# Safe to run multiple times.
set -euo pipefail

APP=/opt/shivansh
ENV_FILE="$APP/deploy/.env"

echo ""
echo "════════════════════════════════════════════════════"
echo "  SHIVANSH Production Fix — $(hostname)"
echo "════════════════════════════════════════════════════"

# ── 1. Patch missing env vars in .env ─────────────────
echo ""
echo "── Step 1: Patching $ENV_FILE"
touch "$ENV_FILE"

set_env_var() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
    echo "   updated: $key"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
    echo "   added:   $key"
  fi
}

# Values can be overridden by passing them as env vars:
#   VAPI_API_KEY=xxx VAPI_WEBHOOK_SECRET=xxx bash fix-production.sh
VAPI_API_KEY_VAL="${VAPI_API_KEY:-__VAPI_API_KEY__}"
VAPI_WEBHOOK_SECRET_VAL="${VAPI_WEBHOOK_SECRET:-__VAPI_WEBHOOK_SECRET__}"

set_env_var VAPI_API_KEY          "$VAPI_API_KEY_VAL"
set_env_var VAPI_WEBHOOK_SECRET   "$VAPI_WEBHOOK_SECRET_VAL"
echo "   .env patched"

# ── 2. Pull latest code ───────────────────────────────
echo ""
echo "── Step 2: Pull latest code from git"
cd "$APP"
git fetch --all --quiet
git checkout main
git pull origin main

# ── 3. Install dependencies ───────────────────────────
echo ""
echo "── Step 3: Install dependencies"
pnpm install --frozen-lockfile --silent

# ── 4. Build api-server ───────────────────────────────
echo ""
echo "── Step 4: Build api-server"
pnpm --filter @workspace/api-server run build

# ── 5. Build dashboard ────────────────────────────────
echo ""
echo "── Step 5: Build dashboard"
pnpm --filter @workspace/dashboard run build

# ── 6. Apply DB schema patch ──────────────────────────
echo ""
echo "── Step 6: Apply DB schema patch"
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
if [ -z "${DATABASE_URL:-}" ]; then
  echo "   WARNING: DATABASE_URL not in .env — skipping auto SQL patch"
  echo "   Paste the SQL from deploy/production_db_patch.sql into Supabase manually."
else
  psql "$DATABASE_URL" <<'SQLEOF'
DO $$ BEGIN
  CREATE TYPE dialing_mode AS ENUM ('manual','progressive','predictive','preview');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE routing_strategy AS ENUM ('round_robin','priority','sequential');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

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

DO $$ BEGIN
  ALTER TABLE campaigns ADD COLUMN dialing_mode dialing_mode NOT NULL DEFAULT 'progressive';
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE campaigns ADD COLUMN routing_strategy routing_strategy NOT NULL DEFAULT 'round_robin';
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

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

ALTER TABLE campaign_agents
  ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 1;

SELECT 'DB patch applied successfully' AS result;
SQLEOF
  echo "   DB patch complete"
fi

# ── 7. Restart PM2 ────────────────────────────────────
echo ""
echo "── Step 7: Restart PM2 with updated env"
pm2 reload "$APP/deploy/ecosystem.config.cjs" --update-env
pm2 save

# ── 8. Health check ───────────────────────────────────
echo ""
echo "── Step 8: Health check"
sleep 4
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/api/health)
if [ "$HTTP_STATUS" = "200" ]; then
  echo "   OK — API is healthy (HTTP 200)"
else
  echo "   FAIL — API returned HTTP $HTTP_STATUS"
  echo "   Check logs: pm2 logs shivansh-api --lines 50"
  exit 1
fi

echo ""
echo "════════════════════════════════════════════════════"
echo "  All done on $(hostname) — run on the other VPS too"
echo "════════════════════════════════════════════════════"
