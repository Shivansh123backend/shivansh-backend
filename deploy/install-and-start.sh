#!/usr/bin/env bash
# Run on the VPS as the shivansh user from /opt/shivansh.
# Installs deps, builds, starts PM2 processes, saves the dump.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

echo "==> Installing deps with pnpm"
pnpm install --frozen-lockfile

echo "==> Building API server"
pnpm --filter @workspace/api-server run build

echo "==> Starting PM2 processes"
pm2 start "$APP_DIR/deploy/ecosystem.config.cjs" --update-env
pm2 save

echo "==> Status:"
pm2 status

echo ""
echo "✓ Services running. Tail logs with:  pm2 logs"
echo "  Health check:  curl -s http://localhost:8080/api/health"
