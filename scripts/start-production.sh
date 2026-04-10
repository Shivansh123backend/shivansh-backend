#!/usr/bin/env bash
set -e

echo "[start] Pushing database schema..."
pnpm --filter @workspace/db run push-force

echo "[start] Starting API server..."
exec node --enable-source-maps ./artifacts/api-server/dist/index.mjs
