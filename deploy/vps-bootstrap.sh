#!/usr/bin/env bash
# One-time setup for a fresh Hostinger VPS (Ubuntu 22.04+).
# Usage on the VPS:
#   curl -fsSL https://raw.githubusercontent.com/<your-org>/<your-repo>/main/deploy/vps-bootstrap.sh | sudo bash -s -- <ROLE> <REPO_URL>
# where ROLE = primary | secondary
#
# Or copy this file up and run:
#   sudo bash vps-bootstrap.sh primary https://github.com/<your-org>/<your-repo>.git

set -euo pipefail

ROLE="${1:-primary}"
REPO_URL="${2:?Usage: vps-bootstrap.sh <primary|secondary> <git-repo-url>}"
APP_USER="shivansh"
APP_DIR="/opt/shivansh"
LOG_DIR="/var/log/shivansh"

echo "==> [1/8] Updating apt + base packages"
apt-get update -y
apt-get install -y curl git build-essential ca-certificates ufw

echo "==> [2/8] Installing Node 20 LTS via NodeSource"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "node: $(node -v) | npm: $(npm -v)"

echo "==> [3/8] Installing pnpm + pm2 globally"
npm install -g pnpm@9 pm2@latest

echo "==> [4/8] Creating app user + directories"
id -u "$APP_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$APP_USER"
mkdir -p "$APP_DIR" "$LOG_DIR"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR" "$LOG_DIR"

echo "==> [5/8] Cloning repo (if absent)"
if [[ ! -d "$APP_DIR/.git" ]]; then
  sudo -u "$APP_USER" git clone "$REPO_URL" "$APP_DIR"
fi

echo "==> [6/8] Writing role marker"
echo "$ROLE" > "$APP_DIR/deploy/.vps-role"
chown "$APP_USER":"$APP_USER" "$APP_DIR/deploy/.vps-role"

echo "==> [7/8] Configuring firewall (allow SSH + 8080)"
ufw allow 22/tcp >/dev/null
ufw allow 8080/tcp >/dev/null
ufw --force enable >/dev/null || true

echo "==> [8/8] Configuring PM2 startup on boot"
sudo -u "$APP_USER" bash -c "pm2 startup systemd -u $APP_USER --hp /home/$APP_USER" \
  | grep -E '^sudo' | bash || true

echo ""
echo "✓ Bootstrap complete on this VPS as role: $ROLE"
echo ""
echo "Next steps (do these manually once):"
echo "  1. Copy production .env to: $APP_DIR/deploy/.env  (chmod 600, owner $APP_USER)"
echo "  2. Run: sudo -u $APP_USER bash $APP_DIR/deploy/install-and-start.sh"
echo "  3. From Replit run: bash deploy/deploy.sh   to push updates"
